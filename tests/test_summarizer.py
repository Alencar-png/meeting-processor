"""Testes do summarizer: factory, parsing, map-reduce e retry.

Nenhum toca a rede: o Ollama usa httpx.MockTransport; os demais exercitam
apenas a lógica pura (split/merge/parse) via _call_llm substituído.
"""


import httpx
import pytest

from meeting_processor.config import Settings
from meeting_processor.models import (
    ActionItem,
    MeetingSummary,
    TimeWindowSummary,
    Transcript,
    TranscriptSegment,
)
from meeting_processor.summarizer import (
    AnthropicSummarizer,
    GeminiSummarizer,
    MeetingSummarizer,
    OllamaSummarizer,
    OpenAISummarizer,
    SummaryParseError,
)

VALID_JSON = (
    '{"executive_summary":"ok","time_windows":[],"action_items":[],'
    '"participants":[],"key_topics":[]}'
)


def _bare(cls) -> AnthropicSummarizer:
    """Instância sem __init__ (não exige API key nem rede)."""
    s = cls.__new__(cls)
    s.provider_name = "test"
    return s


# --- Factory --------------------------------------------------------------


def test_factory_selects_ollama_for_local():
    assert isinstance(MeetingSummarizer(Settings(llm_provider="local")), OllamaSummarizer)


def test_factory_selects_openai(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "x")
    cfg = Settings(llm_provider="openai", openai_api_key="x")
    assert isinstance(MeetingSummarizer(cfg), OpenAISummarizer)


def test_factory_selects_gemini():
    cfg = Settings(llm_provider="gemini", gemini_api_key="x")
    assert isinstance(MeetingSummarizer(cfg), GeminiSummarizer)


def test_factory_rejects_none_provider():
    with pytest.raises(RuntimeError):
        MeetingSummarizer(Settings(llm_provider="none"))


# --- Parsing --------------------------------------------------------------


def test_parse_valid_json():
    summary = _bare(AnthropicSummarizer)._parse_response(VALID_JSON)
    assert summary.executive_summary == "ok"


def test_parse_strips_markdown_fences():
    fenced = "```json\n" + VALID_JSON + "\n```"
    assert _bare(AnthropicSummarizer)._parse_response(fenced).executive_summary == "ok"


def test_parse_extracts_embedded_json():
    noisy = "Aqui esta:\n" + VALID_JSON + "\nEspero ter ajudado."
    assert _bare(AnthropicSummarizer)._parse_response(noisy).executive_summary == "ok"


@pytest.mark.parametrize("bad", ["nao e json", '{"executive_summary": "trunc', ""])
def test_parse_invalid_raises(bad):
    with pytest.raises(SummaryParseError):
        _bare(AnthropicSummarizer)._parse_response(bad)


def test_parse_reads_detailed_summary_and_decisions():
    j = (
        '{"executive_summary":"exec","detailed_summary":"para 1","decisions":["d1","d2"],'
        '"time_windows":[],"action_items":[],"participants":[],"key_topics":[]}'
    )
    summary = _bare(AnthropicSummarizer)._parse_response(j)
    assert summary.detailed_summary == "para 1"
    assert summary.decisions == ["d1", "d2"]


def test_parse_tolerates_literal_newlines_in_strings():
    # LLMs emitem \n literais em resumos de vários parágrafos — strict=False.
    j = (
        '{"executive_summary":"e","detailed_summary":"Paragrafo 1.\n\nParagrafo 2.",'
        '"decisions":[],"time_windows":[],"action_items":[],"participants":[],"key_topics":[]}'
    )
    summary = _bare(AnthropicSummarizer)._parse_response(j)
    assert "Paragrafo 1." in summary.detailed_summary
    assert "Paragrafo 2." in summary.detailed_summary


def test_merge_consolidates_detailed_and_decisions():
    from meeting_processor.models import MeetingSummary

    partials = [
        MeetingSummary(
            executive_summary="A", detailed_summary="det A", decisions=["d1"],
            time_windows=[], action_items=[], participants=[], key_topics=[],
        ),
        MeetingSummary(
            executive_summary="B", detailed_summary="det B", decisions=["d1", "d2"],
            time_windows=[], action_items=[], participants=[], key_topics=[],
        ),
    ]
    merged = _bare(AnthropicSummarizer)._merge_partials(partials)
    assert "det A" in merged.detailed_summary and "det B" in merged.detailed_summary
    assert merged.decisions == ["d1", "d2"]  # dedup


# --- Map-reduce -----------------------------------------------------------


def _segments(n: int) -> list[TranscriptSegment]:
    return [TranscriptSegment(start=i * 5.0, end=i * 5.0 + 5, text=f"fala {i} texto") for i in range(n)]


def test_split_segments_yields_multiple_blocks():
    blocks = _bare(AnthropicSummarizer)._split_segments(_segments(200), max_chars=800, chunk_minutes=5)
    assert len(blocks) > 1


def test_split_empty_segments():
    assert _bare(AnthropicSummarizer)._split_segments([], 800, 5) == ["(Transcrição vazia)"]


def test_merge_partials_deduplicates_and_concatenates():
    partials = [
        MeetingSummary(
            executive_summary="A",
            time_windows=[TimeWindowSummary(start_minutes=0, end_minutes=5, summary="x")],
            action_items=[ActionItem(description="t1")],
            participants=["Ana", "Bob"],
            key_topics=["tema1"],
        ),
        MeetingSummary(
            executive_summary="B",
            time_windows=[TimeWindowSummary(start_minutes=5, end_minutes=10, summary="y")],
            action_items=[ActionItem(description="t2")],
            participants=["ana", "Carla"],
            key_topics=["tema1", "tema2"],
        ),
    ]
    merged = _bare(AnthropicSummarizer)._merge_partials(partials)
    assert len(merged.time_windows) == 2
    assert len(merged.action_items) == 2
    assert merged.participants == ["Ana", "Bob", "Carla"]  # dedup case-insensitive
    assert merged.key_topics == ["tema1", "tema2"]
    assert "A" in merged.executive_summary and "B" in merged.executive_summary


def test_short_transcript_uses_single_call():
    s = _bare(AnthropicSummarizer)
    s.config = Settings(summary_map_reduce_threshold_chars=999999)
    calls = []
    s._call_llm = lambda sp, up: (calls.append(1), VALID_JSON)[1]
    s.summarize(Transcript(segments=_segments(50), full_text="x", language="pt", duration=250.0), "x.mp4")
    assert len(calls) == 1


def test_long_transcript_uses_map_reduce():
    s = _bare(AnthropicSummarizer)
    s.config = Settings(
        summary_map_reduce_threshold_chars=500,
        summary_map_reduce_chunk_chars=800,
    )
    calls = []
    s._call_llm = lambda sp, up: (calls.append(1), VALID_JSON)[1]
    s.summarize(Transcript(segments=_segments(200), full_text="x", language="pt", duration=1000.0), "x.mp4")
    assert len(calls) > 1


# --- Ollama via MockTransport (sem rede real) -----------------------------


def test_ollama_call_parses_content():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"message": {"content": VALID_JSON}})

    cfg = Settings(llm_provider="local")
    s = OllamaSummarizer(cfg)
    # Injeta um transporte mockado monkeypatchando httpx.Client dentro do método.
    original_client = httpx.Client

    def mock_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return original_client(*args, **kwargs)

    import meeting_processor.summarizer as mod
    mod.httpx.Client = mock_client
    try:
        out = s._call_llm("sys", "user")
    finally:
        mod.httpx.Client = original_client
    assert "executive_summary" in out

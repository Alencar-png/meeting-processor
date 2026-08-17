"""Testes locais (sem rede) do summarizer.

Exercita:
- Parsing do JSON retornado por Ollama (caminho feliz e quando vem sujo).
- Erro de conexão quando o serviço local não está rodando.
- Factory escolhendo o provedor correto via env var.

Uso:
    python test_summarizer_mock.py
"""

from __future__ import annotations

import json
import os
import sys
from unittest.mock import patch

import httpx

from meeting_processor.config import load_config
from meeting_processor.models import Transcript, TranscriptSegment
from meeting_processor.summarizer import (
    AnthropicSummarizer,
    MeetingSummarizer,
    OllamaSummarizer,
)


def fake_transcript() -> Transcript:
    segs = [
        TranscriptSegment(start=0.0, end=5.0, text="Boa tarde, vamos comecar."),
        TranscriptSegment(start=5.0, end=12.0, text="Joao, atualize o status do Alpha."),
        TranscriptSegment(
            start=12.0, end=20.0, text="Maria fica responsavel pela apresentacao."
        ),
    ]
    return Transcript(
        segments=segs,
        full_text=" ".join(s.text for s in segs),
        language="pt",
        duration=segs[-1].end,
    )


def test_factory_selects_ollama() -> None:
    os.environ["MEETING_LLM_PROVIDER"] = "local"
    cfg = load_config()
    s = MeetingSummarizer(cfg)
    assert isinstance(s, OllamaSummarizer), type(s).__name__
    print("OK  factory -> OllamaSummarizer (env=local)")


def test_factory_selects_anthropic() -> None:
    os.environ["MEETING_LLM_PROVIDER"] = "anthropic"
    cfg = load_config()
    s = MeetingSummarizer(cfg)
    assert isinstance(s, AnthropicSummarizer), type(s).__name__
    print("OK  factory -> AnthropicSummarizer (env=anthropic)")


def test_ollama_happy_path() -> None:
    """Valida envio do payload correto e parsing da resposta."""
    os.environ["MEETING_LLM_PROVIDER"] = "local"
    cfg = load_config()
    summarizer = OllamaSummarizer(cfg)

    fake_response = {
        "model": cfg.ollama_model,
        "message": {
            "role": "assistant",
            "content": json.dumps(
                {
                    "executive_summary": "Reuniao de alinhamento sobre Alpha.",
                    "time_windows": [
                        {"start_minutes": 0, "end_minutes": 5, "summary": "Abertura."}
                    ],
                    "action_items": [
                        {
                            "description": "Atualizar status do Alpha",
                            "assignee": "Joao",
                            "priority": "alta",
                            "due_date": None,
                            "source_timestamp": "00:05",
                        },
                        {
                            "description": "Preparar apresentacao",
                            "assignee": "Maria",
                            "priority": None,
                            "due_date": None,
                            "source_timestamp": "00:12",
                        },
                    ],
                    "participants": ["Joao", "Maria"],
                    "key_topics": ["Alpha", "Apresentacao"],
                }
            ),
        },
        "done": True,
    }

    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["json"] = json.loads(request.content)
        return httpx.Response(200, json=fake_response)

    transport = httpx.MockTransport(handler)

    # Substitui o cliente httpx global pelo nosso transport
    real_client = httpx.Client

    def patched_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    with patch("meeting_processor.summarizer.httpx.Client", patched_client):
        summary = summarizer.summarize(fake_transcript(), "fake.mkv")

    assert "/api/chat" in captured["url"], captured["url"]
    payload = captured["json"]
    assert payload["model"] == cfg.ollama_model
    assert payload["format"] == "json"
    assert payload["stream"] is False
    assert payload["options"]["num_ctx"] == cfg.ollama_num_ctx
    assert payload["options"]["temperature"] == cfg.ollama_temperature
    assert len(payload["messages"]) == 2

    assert summary.executive_summary.startswith("Reuniao")
    assert len(summary.action_items) == 2
    assert summary.action_items[0].assignee == "Joao"
    assert summary.participants == ["Joao", "Maria"]
    print("OK  OllamaSummarizer payload + parsing")


def test_ollama_dirty_json() -> None:
    """Modelos locais às vezes vazam texto antes/depois do JSON."""
    os.environ["MEETING_LLM_PROVIDER"] = "local"
    cfg = load_config()
    summarizer = OllamaSummarizer(cfg)

    dirty = (
        "Aqui esta o JSON solicitado:\n"
        "```json\n"
        + json.dumps(
            {
                "executive_summary": "Resumo.",
                "time_windows": [],
                "action_items": [],
                "participants": [],
                "key_topics": [],
            }
        )
        + "\n```\nObrigado!"
    )
    fake_response = {"message": {"content": dirty}}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=fake_response)

    transport = httpx.MockTransport(handler)
    real_client = httpx.Client

    def patched_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    with patch("meeting_processor.summarizer.httpx.Client", patched_client):
        summary = summarizer.summarize(fake_transcript(), "fake.mkv")

    assert summary.executive_summary == "Resumo."
    print("OK  parser tolera markdown/texto extra ao redor do JSON")


def test_ollama_connect_error() -> None:
    """Mensagem amigável quando Ollama está desligado."""
    os.environ["MEETING_LLM_PROVIDER"] = "local"
    cfg = load_config()
    summarizer = OllamaSummarizer(cfg)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    transport = httpx.MockTransport(handler)
    real_client = httpx.Client

    def patched_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    try:
        with patch("meeting_processor.summarizer.httpx.Client", patched_client):
            summarizer.summarize(fake_transcript(), "fake.mkv")
    except RuntimeError as e:
        assert "Não foi possível conectar ao Ollama" in str(e), str(e)
        print("OK  erro de conexao -> mensagem amigavel")
        return

    raise AssertionError("Esperava RuntimeError com mensagem amigavel")


def test_ollama_404_model_missing() -> None:
    """Mensagem amigável quando o modelo não foi baixado."""
    os.environ["MEETING_LLM_PROVIDER"] = "local"
    cfg = load_config()
    summarizer = OllamaSummarizer(cfg)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": "model not found"})

    transport = httpx.MockTransport(handler)
    real_client = httpx.Client

    def patched_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    try:
        with patch("meeting_processor.summarizer.httpx.Client", patched_client):
            summarizer.summarize(fake_transcript(), "fake.mkv")
    except RuntimeError as e:
        assert "ollama pull" in str(e), str(e)
        print("OK  404 -> sugere `ollama pull`")
        return

    raise AssertionError("Esperava RuntimeError sugerindo ollama pull")


if __name__ == "__main__":
    failures = 0
    tests = [
        test_factory_selects_ollama,
        test_factory_selects_anthropic,
        test_ollama_happy_path,
        test_ollama_dirty_json,
        test_ollama_connect_error,
        test_ollama_404_model_missing,
    ]
    for t in tests:
        try:
            t()
        except AssertionError as e:
            failures += 1
            print(f"FAIL  {t.__name__}: {e}")
        except Exception as e:  # noqa: BLE001
            failures += 1
            print(f"ERRO  {t.__name__}: {type(e).__name__}: {e}")

    print(f"\n{len(tests) - failures}/{len(tests)} testes passaram.")
    sys.exit(0 if failures == 0 else 1)

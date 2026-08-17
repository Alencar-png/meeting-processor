"""Teste de integração do pipeline — sem rede, sem Whisper, sem LLM.

Mocka a extração de áudio e a transcrição; roda em modo llm_provider="none"
(só transcrição). Verifica que a transcrição é escrita no vault temporário.
"""

import pytest

import meeting_processor.pipeline as pipeline_mod
from meeting_processor.pipeline import MeetingPipeline


def test_pipeline_transcription_only(tmp_config, sample_transcript, monkeypatch):
    # Vídeo de entrada fake
    watch = tmp_config.watch_path
    watch.mkdir(parents=True, exist_ok=True)
    video = watch / "reuniao.mp4"
    video.write_bytes(b"fake video bytes")

    pipeline = MeetingPipeline(tmp_config)

    # Mocka extração de áudio: cria um WAV fake e devolve o caminho.
    def fake_extract(video_path, config):
        wav = config.temp_path / "fake.wav"
        wav.parent.mkdir(parents=True, exist_ok=True)
        wav.write_bytes(b"RIFF....")
        return wav

    monkeypatch.setattr(pipeline_mod, "extract_audio", fake_extract)
    # Mocka transcrição: devolve o transcript de exemplo.
    monkeypatch.setattr(pipeline.transcriber, "transcribe", lambda *a, **k: sample_transcript)

    result = pipeline.process(video)

    # Modo só transcrição: sem summary, mas com transcrição gravada.
    assert result.summary is None
    assert result.transcript.segments == sample_transcript.segments
    raw = tmp_config.reunioes_path
    transcricoes = list(raw.rglob("Transcricao - *.md"))
    assert len(transcricoes) == 1
    conteudo = transcricoes[0].read_text(encoding="utf-8")
    assert "Bom dia a todos." in conteudo


def test_pipeline_cleans_temp_audio(tmp_config, sample_transcript, monkeypatch):
    watch = tmp_config.watch_path
    watch.mkdir(parents=True, exist_ok=True)
    video = watch / "reuniao.mp4"
    video.write_bytes(b"fake")

    pipeline = MeetingPipeline(tmp_config)
    created = {}

    def fake_extract(video_path, config):
        wav = config.temp_path / "fake.wav"
        wav.parent.mkdir(parents=True, exist_ok=True)
        wav.write_bytes(b"x")
        created["wav"] = wav
        return wav

    monkeypatch.setattr(pipeline_mod, "extract_audio", fake_extract)
    monkeypatch.setattr(pipeline.transcriber, "transcribe", lambda *a, **k: sample_transcript)

    pipeline.process(video)
    # cleanup_temp=True → WAV removido ao final.
    assert not created["wav"].exists()


def test_pipeline_failure_does_not_crash_on_cleanup(tmp_config, monkeypatch):
    """Se a extração de áudio falhar, o finally não deve levantar UnboundLocalError."""
    watch = tmp_config.watch_path
    watch.mkdir(parents=True, exist_ok=True)
    video = watch / "reuniao.mp4"
    video.write_bytes(b"fake")

    pipeline = MeetingPipeline(tmp_config)

    def boom(video_path, config):
        raise RuntimeError("ffmpeg falhou")

    monkeypatch.setattr(pipeline_mod, "extract_audio", boom)

    # Deve propagar o RuntimeError original (não UnboundLocalError do finally).
    with pytest.raises(RuntimeError, match="ffmpeg falhou"):
        pipeline.process(video)

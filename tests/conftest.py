"""Fixtures compartilhadas — tudo isolado em tmp_path, sem rede, sem tocar
o .env/vault reais do usuário."""

from __future__ import annotations

import pytest

from meeting_processor.config import Settings
from meeting_processor.models import (
    ActionItem,
    MeetingSummary,
    TimeWindowSummary,
    Transcript,
    TranscriptSegment,
)


@pytest.fixture
def tmp_config(tmp_path) -> Settings:
    """Settings apontando 100% para um diretório temporário."""
    vault = tmp_path / "vault"
    (vault / "wiki" / "reunioes").mkdir(parents=True)
    return Settings(
        project_root=str(tmp_path),
        vault_dir="vault",
        watch_dir=str(tmp_path / "watch"),
        temp_dir="tmp",
        llm_provider="none",
        enable_wiki=False,
        cleanup_temp=True,
    )


@pytest.fixture
def sample_transcript() -> Transcript:
    segments = [
        TranscriptSegment(start=0.0, end=5.0, text="Bom dia a todos."),
        TranscriptSegment(start=5.0, end=12.0, text="Vamos falar do projeto."),
        TranscriptSegment(start=12.0, end=20.0, text="A Ana fica responsavel pela API."),
    ]
    return Transcript(
        segments=segments,
        full_text=" ".join(s.text for s in segments),
        language="pt",
        duration=20.0,
    )


@pytest.fixture
def sample_summary() -> MeetingSummary:
    return MeetingSummary(
        executive_summary="Reuniao sobre o projeto.",
        time_windows=[TimeWindowSummary(start_minutes=0, end_minutes=5, summary="Abertura")],
        action_items=[ActionItem(description="Construir a API", assignee="Ana", priority="alta")],
        participants=["Ana", "Bob"],
        key_topics=["projeto", "API"],
    )

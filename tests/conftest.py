"""Fixtures compartilhadas — tudo isolado em tmp_path, sem rede, sem tocar
a configuração real do usuário."""

from __future__ import annotations

import pytest

from meeting_processor.config import Settings
from meeting_processor.models import Transcript, TranscriptSegment


@pytest.fixture
def tmp_config(tmp_path) -> Settings:
    """Settings apontando 100% para um diretório temporário."""
    return Settings(
        project_root=str(tmp_path),
        temp_dir="tmp",
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

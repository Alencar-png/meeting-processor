"""Testes de validação de configuração (validators Pydantic)."""

import pytest
from pydantic import ValidationError

from meeting_processor.config import Settings


@pytest.mark.parametrize(
    "field,value",
    [
        ("whisper_backend", "turbo"),
        ("log_level", "LOUD"),
        ("ffmpeg_timeout", -1),
        ("whisper_timeout", 0),
    ],
)
def test_invalid_config_is_rejected(field, value):
    with pytest.raises(ValidationError):
        Settings(**{field: value})


def test_backend_is_normalized():
    assert Settings(whisper_backend="AUTO").whisper_backend == "auto"


def test_log_level_is_normalized_to_upper():
    assert Settings(log_level="info").log_level == "INFO"


def test_valid_defaults_load():
    s = Settings()
    assert s.whisper_backend == "auto"
    assert s.whisper_language == "pt"
    assert s.whisper_threads == 0   # 0 => todos os núcleos


def test_temp_path_fica_sob_o_project_root(tmp_path):
    s = Settings(project_root=str(tmp_path), temp_dir=".tmp")
    assert s.temp_path == tmp_path / ".tmp"

"""Testes de validação de configuração (validators Pydantic)."""

import pytest
from pydantic import ValidationError

from meeting_processor.config import Settings


@pytest.mark.parametrize(
    "field,value",
    [
        ("llm_provider", "xpto"),
        ("whisper_backend", "turbo"),
        ("log_level", "LOUD"),
        ("ffmpeg_timeout", -1),
        ("whisper_timeout", 0),
        ("watch_max_workers", 0),
    ],
)
def test_invalid_config_is_rejected(field, value):
    with pytest.raises(ValidationError):
        Settings(**{field: value})


def test_provider_is_normalized_to_lowercase():
    assert Settings(llm_provider="LOCAL").llm_provider == "local"


def test_backend_is_normalized():
    assert Settings(whisper_backend="AUTO").whisper_backend == "auto"


def test_log_level_is_normalized_to_upper():
    assert Settings(log_level="info").log_level == "INFO"


def test_valid_defaults_load():
    s = Settings()
    assert s.llm_provider == "anthropic"
    assert s.watch_max_workers >= 1


def test_steps_disabled_when_provider_none():
    steps = Settings(llm_provider="none").steps()
    assert steps == {"summary": False, "note": False, "kanban": False, "wiki": False}


def test_steps_cascade_from_summary_off():
    steps = Settings(enable_summary=False).steps()
    assert not any(steps.values())

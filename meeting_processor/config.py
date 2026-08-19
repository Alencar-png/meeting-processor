"""Carregamento e validação de configuração."""

import os
from pathlib import Path

import yaml
from dotenv import load_dotenv
from pydantic import BaseModel, field_validator

VALID_WHISPER_BACKENDS = {"auto", "cpp", "openai"}
VALID_LOG_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}


class Settings(BaseModel):
    # Whisper
    whisper_model: str = "large-v3-turbo"
    whisper_language: str = "pt"
    whisper_device: str = "auto"
    whisper_initial_prompt: str = "Transcrição de reunião em português brasileiro."
    # Backend de transcrição:
    #   "auto"   -> usa whisper.cpp se encontrado, senão openai-whisper (pip)
    #   "cpp"    -> força whisper.cpp (mais rápido com GPU)
    #   "openai" -> força openai-whisper (Python puro, baixa o modelo sozinho)
    whisper_backend: str = "auto"
    # Caminhos do whisper.cpp. Vazio => detecta automaticamente no PATH
    # do sistema e em .whisper-cpp/ e .models/ dentro do projeto.
    whisper_cli_path: str = ""
    whisper_model_path: str = ""
    # Threads do whisper.cpp. 0 => usa todos os núcleos disponíveis.
    # O padrão do próprio whisper.cpp é 4, o que desperdiça a maior parte
    # de uma CPU moderna — a transcrição é o gargalo.
    whisper_threads: int = 0

    # Processamento
    temp_dir: str = ".tmp"
    cleanup_temp: bool = True
    log_level: str = "INFO"

    # Timeouts de subprocess (segundos). Evitam trava permanente se o ffmpeg
    # ou o whisper.cpp ficarem presos num arquivo corrompido.
    ffmpeg_timeout: float = 3600.0     # 1h: extração de áudio raramente passa disso
    whisper_timeout: float = 14400.0   # 4h: transcrição longa em CPU pode ser lenta

    # Caminho resolvido
    project_root: str = ""

    @property
    def temp_path(self) -> Path:
        return Path(self.project_root) / self.temp_dir

    # -- Validação (falha cedo, com mensagem clara) ------------------------

    @field_validator("whisper_backend")
    @classmethod
    def _check_backend(cls, v: str) -> str:
        norm = (v or "auto").lower().strip()
        if norm not in VALID_WHISPER_BACKENDS:
            raise ValueError(
                f"whisper_backend inválido: {v!r}. "
                f"Válidos: {', '.join(sorted(VALID_WHISPER_BACKENDS))}."
            )
        return norm

    @field_validator("log_level")
    @classmethod
    def _check_log_level(cls, v: str) -> str:
        norm = (v or "INFO").upper().strip()
        if norm not in VALID_LOG_LEVELS:
            raise ValueError(
                f"log_level inválido: {v!r}. "
                f"Válidos: {', '.join(sorted(VALID_LOG_LEVELS))}."
            )
        return norm

    @field_validator("ffmpeg_timeout", "whisper_timeout")
    @classmethod
    def _check_positive_timeout(cls, v: float) -> float:
        if v <= 0:
            raise ValueError(f"timeout deve ser positivo, recebido: {v}")
        return v


def load_config(config_path: str | None = None) -> Settings:
    """Carrega configuração do YAML e variáveis de ambiente.

    O app desktop passa tudo por variáveis de ambiente (é ele quem sabe qual
    binário e qual modelo o usuário escolheu na interface); o ``config.yaml``
    serve a quem usa a linha de comando direto.
    """
    project_root = Path(__file__).parent.parent
    load_dotenv(project_root / ".env")

    if config_path is None:
        config_path = str(project_root / "config.yaml")

    config_data: dict = {}
    config_file = Path(config_path)
    if config_file.exists():
        with open(config_file, encoding="utf-8") as f:
            config_data = yaml.safe_load(f) or {}

    string_overrides = {
        "MEETING_WHISPER_MODEL": "whisper_model",
        "MEETING_WHISPER_LANGUAGE": "whisper_language",
        "MEETING_WHISPER_DEVICE": "whisper_device",
        "MEETING_WHISPER_BACKEND": "whisper_backend",
        "MEETING_WHISPER_CLI_PATH": "whisper_cli_path",
        "MEETING_WHISPER_MODEL_PATH": "whisper_model_path",
        "MEETING_LOG_LEVEL": "log_level",
    }
    for env_key, config_key in string_overrides.items():
        env_val = os.environ.get(env_key)
        if env_val is not None and env_val != "":
            config_data[config_key] = env_val

    int_overrides = {"MEETING_WHISPER_THREADS": "whisper_threads"}
    for env_key, config_key in int_overrides.items():
        env_val = os.environ.get(env_key)
        if env_val is not None and env_val != "":
            try:
                config_data[config_key] = int(env_val)
            except ValueError:
                pass

    config_data["project_root"] = str(project_root)

    settings = Settings(**config_data)
    settings.temp_path.mkdir(parents=True, exist_ok=True)
    return settings

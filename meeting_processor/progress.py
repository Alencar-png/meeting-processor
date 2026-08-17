"""Acompanhamento do processamento (headless).

Substitui o antigo dashboard visual do Obsidian: cada transição de etapa vai
para o log e para a fila persistente em SQLite (tabela ``jobs``, ver
``meeting_processor/db.py``), que qualquer script pode consultar sem depender
de interface.
"""

from __future__ import annotations

import logging
from pathlib import Path

from .config import Settings
from .db import JobsRepo, init_db

logger = logging.getLogger(__name__)

# Etapas do pipeline, na ordem de execução: (chave, rótulo legível).
STAGES: list[tuple[str, str]] = [
    ("audio", "Extraindo audio"),
    ("transcription", "Transcrevendo com Whisper"),
    ("summary", "Gerando resumo com LLM"),
    ("note", "Criando nota da reuniao"),
    ("kanban", "Criando quadro Kanban"),
    ("wiki", "Integrando com wiki"),
]

STAGE_KEYS = [key for key, _ in STAGES]
STAGE_LABELS = dict(STAGES)

# Status interno do job -> status persistido na fila (SQLite).
_STATUS_TO_QUEUE = {
    "waiting": "queued",
    "processing": "processing",
    "completed": "completed",
    "error": "error",
}


class ProcessingJob:
    """Estado de um job de processamento, espelhado na fila persistente.

    Cada mutação grava o estado atual no SQLite. Falhas de escrita no banco
    nunca interrompem o processamento — são apenas logadas em nível debug,
    porque o produto real (transcrição e notas) está no vault.
    """

    def __init__(self, repo: JobsRepo, source_file: str, db_id: int | None = None):
        self._repo = repo
        self.source_file = source_file
        self.db_id = db_id
        self.current_stage: int = -1
        self.total_stages: int = len(STAGES)
        self.status: str = "waiting"
        self.error_message: str = ""
        self.details: dict[str, str] = {}
        self.stage_progress: dict[str, int] = {}  # stage_key -> 0-100
        self.skipped: set[str] = set()

    # -- Transições --------------------------------------------------------

    def skip(self, stage_key: str, detail: str = "desativada") -> None:
        """Marca uma etapa como pulada (desligada na configuração)."""
        self.skipped.add(stage_key)
        if detail:
            self.details[stage_key] = detail

    def advance(self, stage_key: str, detail: str = "") -> None:
        """Entra numa etapa nova."""
        if stage_key in STAGE_KEYS:
            self.current_stage = STAGE_KEYS.index(stage_key)
        self.status = "processing"
        self.stage_progress[stage_key] = 0
        if detail:
            self.details[stage_key] = detail
        logger.info(
            "[%s] %s%s",
            self.source_file,
            STAGE_LABELS.get(stage_key, stage_key),
            f" — {detail}" if detail else "",
        )
        self._persist()

    def set_progress(self, stage_key: str, pct: int, detail: str = "") -> None:
        """Atualiza a porcentagem de progresso de uma etapa (0-100)."""
        self.stage_progress[stage_key] = min(pct, 100)
        if detail:
            self.details[stage_key] = detail
        logger.debug(
            "[%s] %s: %d%%%s",
            self.source_file,
            STAGE_LABELS.get(stage_key, stage_key),
            self.stage_progress[stage_key],
            f" — {detail}" if detail else "",
        )
        self._persist()

    def complete(self, detail: str = "") -> None:
        self.status = "completed"
        self.current_stage = self.total_stages
        if detail:
            self.details["result"] = detail
        self._persist()

    def fail(self, error: str) -> None:
        self.status = "error"
        self.error_message = error
        self._persist()

    # -- Persistência ------------------------------------------------------

    @property
    def overall_progress(self) -> int:
        """Progresso geral do job (0-100), derivado da etapa atual."""
        if self.status == "completed":
            return 100
        if self.current_stage < 0:
            return 0
        return min(100, int((self.current_stage + 1) / self.total_stages * 100))

    def _current_detail(self) -> str:
        if "result" in self.details:
            return self.details["result"]
        if 0 <= self.current_stage < len(STAGES):
            return self.details.get(STAGE_KEYS[self.current_stage], "")
        return ""

    def _current_label(self) -> str:
        if 0 <= self.current_stage < len(STAGES):
            return STAGES[self.current_stage][1]
        return ""

    def _persist(self) -> None:
        if self.db_id is None:
            return
        try:
            self._repo.update(
                self.db_id,
                status=_STATUS_TO_QUEUE.get(self.status, self.status),
                stage=self._current_label() or None,
                progress=self.overall_progress,
                detail=self._current_detail() or None,
                error=self.error_message or None,
            )
        except Exception:
            logger.debug("Falha ao atualizar job na fila (SQLite)", exc_info=True)


class JobTracker:
    """Cria e acompanha os jobs de processamento na fila persistente."""

    def __init__(self, config: Settings):
        self.config = config
        # init_db é idempotente: garante o schema mesmo se o pipeline for
        # usado como biblioteca, sem passar pelo CLI.
        init_db(config.project_root)
        self.repo = JobsRepo(config.project_root)

    def new_job(self, source_file: str) -> ProcessingJob:
        abs_path = None
        if self.config.watch_dir:
            abs_path = str(Path(self.config.watch_dir) / source_file)
        db_id: int | None = None
        try:
            db_id = self.repo.create(source_file, abs_path)
        except Exception:
            logger.debug("Falha ao criar job na fila (SQLite)", exc_info=True)
        return ProcessingJob(self.repo, source_file, db_id)

"""Eventos de progresso em JSONL (uma linha JSON por evento).

Formato de integração entre os scripts Python e qualquer processo que os
execute — hoje o app desktop (Electron), que faz spawn do container e lê o
stdout linha a linha. Deliberadamente simples: sem servidor, sem porta, sem
dependência extra.

Eventos emitidos:
    {"event": "start",    "file": str, "output_dir": str}
    {"event": "stage",    "key": str, "label": str, "progress": int, "detail": str}
    {"event": "done",     "files": [str], "segments": int, "duration": float,
                          "elapsed": float}
    {"event": "error",    "message": str}
"""

from __future__ import annotations

import json
import sys
from typing import Any, TextIO


class EventEmitter:
    """Escreve eventos JSONL. Desligado (no-op) quando ``enabled`` é falso."""

    def __init__(self, enabled: bool = False, stream: TextIO | None = None):
        self.enabled = enabled
        self._stream = stream or sys.stdout

    def emit(self, event: str, **fields: Any) -> None:
        if not self.enabled:
            return
        payload = {"event": event, **fields}
        self._stream.write(json.dumps(payload, ensure_ascii=False) + "\n")
        # Flush a cada evento: o consumidor lê em streaming e o buffer padrão
        # seguraria o progresso até o fim do processo.
        self._stream.flush()

    def start(self, file: str, output_dir: str) -> None:
        self.emit("start", file=file, output_dir=output_dir)

    def stage(self, key: str, label: str, progress: int = 0, detail: str = "") -> None:
        self.emit("stage", key=key, label=label, progress=progress, detail=detail)

    def done(
        self,
        files: list[str],
        segments: int,
        duration: float,
        elapsed: float,
    ) -> None:
        self.emit(
            "done",
            files=files,
            segments=segments,
            duration=duration,
            elapsed=elapsed,
        )

    def error(self, message: str) -> None:
        self.emit("error", message=message)

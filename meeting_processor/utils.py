"""Funções utilitárias compartilhadas.

Centraliza helpers usados por vários módulos (formatação de tempo,
parsing de timestamps, escrita atômica) para evitar duplicação — DRY.
"""

from __future__ import annotations

import os
from pathlib import Path


def atomic_write_text(path: Path, content: str, encoding: str = "utf-8") -> None:
    """Escreve texto de forma atômica (grava em ``.tmp`` e faz ``os.replace``).

    Evita que uma falha no meio da escrita deixe o arquivo truncado, e evita
    que um leitor concorrente (Obsidian, outra thread, a UI web) veja conteúdo
    parcial. ``os.replace`` é atômico dentro do mesmo filesystem.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(content, encoding=encoding)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def format_duration(seconds: float) -> str:
    """Formata segundos como ``HH:MM:SS``."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def format_timestamp(seconds: float) -> str:
    """Formata segundos como ``MM:SS`` (para marcação de falas)."""
    m = int(seconds // 60)
    s = int(seconds % 60)
    return f"{m:02d}:{s:02d}"


def parse_timestamp(ts: str) -> float:
    """Converte ``HH:MM:SS.mmm`` ou ``HH:MM:SS,mmm`` para segundos."""
    ts = ts.replace(",", ".")
    parts = ts.split(":")
    if len(parts) == 3:
        h, m, s = parts
        return int(h) * 3600 + int(m) * 60 + float(s)
    return 0.0

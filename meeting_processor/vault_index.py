"""Leitura das reuniões já gravadas no vault (Markdown/Obsidian).

O vault continua sendo a fonte de verdade do conteúdo; estas funções fazem a
varredura das pastas para reindexar os metadados no SQLite (comando
``reindex``) sem precisar reprocessar áudio.
"""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from typing import Any


def strip_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Remove frontmatter YAML simples e devolve (metadados, corpo)."""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    fm_block = text[3:end].strip()
    body = text[end + 4 :].lstrip("\n")
    meta: dict[str, str] = {}
    for line in fm_block.splitlines():
        if ":" in line and not line.startswith(" "):
            key, _, value = line.partition(":")
            meta[key.strip()] = value.strip().strip('"')
    return meta, body


def count_tasks(text: str) -> int:
    """Conta as tarefas (checkboxes markdown) de uma nota de tarefas."""
    pattern = re.compile(r"^\s*-\s*\[( |x|X)\]\s*(.+?)\s*$")
    return sum(1 for line in text.splitlines() if pattern.match(line))


def parse_meeting_datetime(folder_name: str) -> datetime | None:
    """Extrai o ``datetime`` do prefixo do nome da pasta (``YYYY-MM-DD HHhMM``)."""
    m = re.match(r"^\d{4}-\d{2}-\d{2} \d{2}h\d{2}", folder_name)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(0), "%Y-%m-%d %Hh%M")
    except ValueError:
        return None


def list_meetings(vault_path: Path) -> list[dict[str, Any]]:
    """Lista as reuniões em ``vault/wiki/reunioes/<pasta>/``.

    Inclui reuniões **apenas transcritas** (sem ``Resumo - *.md``) — elas
    aparecem com ``has_summary=False`` para que uma falha no resumo (ex.:
    créditos da IA esgotados) não faça a reunião sumir do índice.
    """
    base = vault_path / "wiki" / "reunioes"
    if not base.exists():
        return []

    meetings: list[dict[str, Any]] = []
    for entry in sorted(base.iterdir(), reverse=True):
        if not entry.is_dir():
            continue
        resumos = list(entry.glob("Resumo - *.md"))
        transcricoes = list(entry.glob("Transcricao - *.md"))
        # Sem resumo E sem transcrição não é uma reunião processável.
        if not resumos and not transcricoes:
            continue

        meta: dict[str, str] = {}
        if resumos:
            meta, _ = strip_frontmatter(resumos[0].read_text(encoding="utf-8"))

        tarefas_paths = list(entry.glob("Tarefas - *.md"))
        task_count = 0
        if tarefas_paths:
            task_count = count_tasks(tarefas_paths[0].read_text(encoding="utf-8"))

        # Sem frontmatter (reunião só-transcrição), deriva a data do nome.
        created = meta.get("created", "")
        if not created:
            dt = parse_meeting_datetime(entry.name)
            created = dt.strftime("%Y-%m-%d") if dt else ""

        meetings.append(
            {
                "id": entry.name,
                "title": entry.name,
                "created": created,
                "duration": meta.get("duration", ""),
                "task_count": task_count,
                "participants": meta.get("participants", ""),
                "source_file": meta.get("source_file", ""),
                "has_summary": bool(resumos),
            }
        )
    return meetings

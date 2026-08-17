"""Camada de estado estruturado (SQLite).

O vault/Obsidian continua sendo a fonte de verdade do CONTEÚDO (transcrição
e resumo em Markdown). Este módulo guarda os METADADOS/ESTADO que precisam de
consulta e agregação: a fila de processamento (jobs), o índice de reuniões
(para analytics/listagem sem rescan) e as tags.

Design deliberadamente simples: uma conexão por chamada, WAL habilitado para
leitura concorrente enquanto o watcher escreve. Sem ORM — `sqlite3` da stdlib
com repositórios finos.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DB_FILENAME = "meeting_processor.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    file        TEXT NOT NULL,
    abs_path    TEXT,
    status      TEXT NOT NULL DEFAULT 'queued',  -- queued|processing|completed|error|retrying
    stage       TEXT,
    progress    INTEGER NOT NULL DEFAULT 0,
    detail      TEXT,
    error       TEXT,
    retries     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);

CREATE TABLE IF NOT EXISTS meetings (
    id                  TEXT PRIMARY KEY,          -- folder_name (id estável da reunião)
    title               TEXT NOT NULL,
    created_at          TEXT,                      -- data da reunião (ISO ou YYYY-MM-DD)
    duration_seconds    REAL NOT NULL DEFAULT 0,
    source_file         TEXT,
    provider            TEXT,
    participants_count  INTEGER NOT NULL DEFAULT 0,
    task_count          INTEGER NOT NULL DEFAULT 0,
    indexed_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meetings_created ON meetings(created_at);

CREATE TABLE IF NOT EXISTS tags (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT NOT NULL UNIQUE,
    color   TEXT
);

CREATE TABLE IF NOT EXISTS meeting_tags (
    meeting_id  TEXT NOT NULL,
    tag_id      INTEGER NOT NULL,
    PRIMARY KEY (meeting_id, tag_id),
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
"""

# Serializa escritas no mesmo processo; entre processos, o WAL + busy_timeout
# do SQLite cuida da concorrência.
_write_lock = threading.Lock()


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def db_path(project_root: str | Path) -> Path:
    return Path(project_root) / DB_FILENAME


@contextmanager
def _connect(project_root: str | Path) -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(db_path(project_root), timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db(project_root: str | Path) -> None:
    """Cria o schema se necessário (idempotente)."""
    with _connect(project_root) as conn:
        conn.executescript(_SCHEMA)
    logger.debug("SQLite inicializado em %s", db_path(project_root))


# ---------------------------------------------------------------------------
# Jobs (fila de processamento)
# ---------------------------------------------------------------------------


class JobsRepo:
    def __init__(self, project_root: str | Path):
        self.root = project_root

    def create(self, file: str, abs_path: str | None = None) -> int:
        """Cria um job na fila (status=queued) e retorna o id."""
        with _write_lock, _connect(self.root) as conn:
            cur = conn.execute(
                "INSERT INTO jobs (file, abs_path, status, created_at, updated_at) "
                "VALUES (?, ?, 'queued', ?, ?)",
                (file, abs_path, _now(), _now()),
            )
            return int(cur.lastrowid)

    def update(
        self,
        job_id: int,
        *,
        status: str | None = None,
        stage: str | None = None,
        progress: int | None = None,
        detail: str | None = None,
        error: str | None = None,
        retries: int | None = None,
    ) -> None:
        fields: dict[str, Any] = {}
        if status is not None:
            fields["status"] = status
        if stage is not None:
            fields["stage"] = stage
        if progress is not None:
            fields["progress"] = progress
        if detail is not None:
            fields["detail"] = detail
        if error is not None:
            fields["error"] = error
        if retries is not None:
            fields["retries"] = retries
        if not fields:
            return
        fields["updated_at"] = _now()
        assignments = ", ".join(f"{k} = ?" for k in fields)
        with _write_lock, _connect(self.root) as conn:
            conn.execute(
                f"UPDATE jobs SET {assignments} WHERE id = ?",
                (*fields.values(), job_id),
            )

    def list(self, limit: int = 50) -> list[dict[str, Any]]:
        with _connect(self.root) as conn:
            rows = conn.execute(
                "SELECT * FROM jobs ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]

    def active(self) -> list[dict[str, Any]]:
        with _connect(self.root) as conn:
            rows = conn.execute(
                "SELECT * FROM jobs WHERE status IN ('queued','processing','retrying') "
                "ORDER BY id ASC"
            ).fetchall()
        return [dict(r) for r in rows]

    def counts(self) -> dict[str, int]:
        with _connect(self.root) as conn:
            rows = conn.execute(
                "SELECT status, COUNT(*) AS n FROM jobs GROUP BY status"
            ).fetchall()
        return {r["status"]: r["n"] for r in rows}


# ---------------------------------------------------------------------------
# Meetings (índice para analytics/listagem)
# ---------------------------------------------------------------------------


class MeetingsRepo:
    def __init__(self, project_root: str | Path):
        self.root = project_root

    def upsert(
        self,
        meeting_id: str,
        *,
        title: str,
        created_at: str | None,
        duration_seconds: float = 0.0,
        source_file: str | None = None,
        provider: str | None = None,
        participants_count: int = 0,
        task_count: int = 0,
    ) -> None:
        with _write_lock, _connect(self.root) as conn:
            conn.execute(
                """
                INSERT INTO meetings
                    (id, title, created_at, duration_seconds, source_file,
                     provider, participants_count, task_count, indexed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title=excluded.title,
                    created_at=excluded.created_at,
                    duration_seconds=excluded.duration_seconds,
                    source_file=excluded.source_file,
                    provider=excluded.provider,
                    participants_count=excluded.participants_count,
                    task_count=excluded.task_count,
                    indexed_at=excluded.indexed_at
                """,
                (
                    meeting_id, title, created_at, duration_seconds, source_file,
                    provider, participants_count, task_count, _now(),
                ),
            )

    def delete(self, meeting_id: str) -> None:
        with _write_lock, _connect(self.root) as conn:
            conn.execute("DELETE FROM meetings WHERE id = ?", (meeting_id,))

    def list(self, tag: str | None = None) -> list[dict[str, Any]]:
        with _connect(self.root) as conn:
            if tag:
                rows = conn.execute(
                    """
                    SELECT m.* FROM meetings m
                    JOIN meeting_tags mt ON mt.meeting_id = m.id
                    JOIN tags t ON t.id = mt.tag_id
                    WHERE t.name = ?
                    ORDER BY m.created_at DESC, m.id DESC
                    """,
                    (tag,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM meetings ORDER BY created_at DESC, id DESC"
                ).fetchall()
        return [dict(r) for r in rows]

    def count(self) -> int:
        with _connect(self.root) as conn:
            return int(conn.execute("SELECT COUNT(*) FROM meetings").fetchone()[0])

    def total_duration_seconds(self) -> float:
        with _connect(self.root) as conn:
            val = conn.execute("SELECT COALESCE(SUM(duration_seconds),0) FROM meetings").fetchone()[0]
        return float(val or 0.0)

    def by_provider(self) -> dict[str, int]:
        with _connect(self.root) as conn:
            rows = conn.execute(
                "SELECT COALESCE(provider,'?') AS p, COUNT(*) AS n FROM meetings GROUP BY p"
            ).fetchall()
        return {r["p"]: r["n"] for r in rows}

    def per_day(self, days: int = 30) -> list[dict[str, Any]]:
        """Contagem de reuniões por dia (para relatórios/analytics)."""
        with _connect(self.root) as conn:
            rows = conn.execute(
                """
                SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n
                FROM meetings
                WHERE created_at IS NOT NULL AND created_at != ''
                GROUP BY day ORDER BY day DESC LIMIT ?
                """,
                (days,),
            ).fetchall()
        return [{"day": r["day"], "count": r["n"]} for r in rows][::-1]


# ---------------------------------------------------------------------------
# Tags
# ---------------------------------------------------------------------------


class TagsRepo:
    def __init__(self, project_root: str | Path):
        self.root = project_root

    def _get_or_create_id(self, conn: sqlite3.Connection, name: str) -> int:
        name = name.strip()
        row = conn.execute("SELECT id FROM tags WHERE name = ?", (name,)).fetchone()
        if row:
            return int(row["id"])
        cur = conn.execute("INSERT INTO tags (name) VALUES (?)", (name,))
        return int(cur.lastrowid)

    def add_to_meeting(self, meeting_id: str, name: str) -> None:
        name = name.strip()
        if not name:
            return
        with _write_lock, _connect(self.root) as conn:
            tag_id = self._get_or_create_id(conn, name)
            conn.execute(
                "INSERT OR IGNORE INTO meeting_tags (meeting_id, tag_id) VALUES (?, ?)",
                (meeting_id, tag_id),
            )

    def remove_from_meeting(self, meeting_id: str, name: str) -> None:
        with _write_lock, _connect(self.root) as conn:
            conn.execute(
                """
                DELETE FROM meeting_tags
                WHERE meeting_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)
                """,
                (meeting_id, name.strip()),
            )

    def rename(self, old: str, new: str) -> list[str]:
        """Renomeia uma tag globalmente. Retorna os meeting_ids afetados.

        Se o novo nome já existir, funde as associações no tag existente.
        """
        old, new = old.strip(), new.strip()
        if not new or old == new:
            return []
        with _write_lock, _connect(self.root) as conn:
            row = conn.execute("SELECT id FROM tags WHERE name = ?", (old,)).fetchone()
            if not row:
                return []
            old_id = int(row["id"])
            affected = [
                r["meeting_id"]
                for r in conn.execute(
                    "SELECT meeting_id FROM meeting_tags WHERE tag_id = ?", (old_id,)
                ).fetchall()
            ]
            existing = conn.execute("SELECT id FROM tags WHERE name = ?", (new,)).fetchone()
            if existing:
                new_id = int(existing["id"])
                # Reaponta as associações para o tag existente (ignora duplicatas).
                for mid in affected:
                    conn.execute(
                        "INSERT OR IGNORE INTO meeting_tags (meeting_id, tag_id) VALUES (?, ?)",
                        (mid, new_id),
                    )
                conn.execute("DELETE FROM tags WHERE id = ?", (old_id,))
            else:
                conn.execute("UPDATE tags SET name = ? WHERE id = ?", (new, old_id))
            return affected

    def delete_tag(self, name: str) -> list[str]:
        """Remove uma tag globalmente. Retorna os meeting_ids afetados."""
        with _write_lock, _connect(self.root) as conn:
            row = conn.execute("SELECT id FROM tags WHERE name = ?", (name.strip(),)).fetchone()
            if not row:
                return []
            tag_id = int(row["id"])
            affected = [
                r["meeting_id"]
                for r in conn.execute(
                    "SELECT meeting_id FROM meeting_tags WHERE tag_id = ?", (tag_id,)
                ).fetchall()
            ]
            conn.execute("DELETE FROM tags WHERE id = ?", (tag_id,))  # cascade em meeting_tags
            return affected

    def for_meeting(self, meeting_id: str) -> list[str]:
        with _connect(self.root) as conn:
            rows = conn.execute(
                """
                SELECT t.name FROM tags t
                JOIN meeting_tags mt ON mt.tag_id = t.id
                WHERE mt.meeting_id = ? ORDER BY t.name
                """,
                (meeting_id,),
            ).fetchall()
        return [r["name"] for r in rows]

    def all_with_counts(self) -> list[dict[str, Any]]:
        with _connect(self.root) as conn:
            rows = conn.execute(
                """
                SELECT t.name, COUNT(mt.meeting_id) AS n
                FROM tags t LEFT JOIN meeting_tags mt ON mt.tag_id = t.id
                GROUP BY t.id ORDER BY n DESC, t.name
                """
            ).fetchall()
        return [{"name": r["name"], "count": r["n"]} for r in rows]

    def tags_by_meeting(self) -> dict[str, list[str]]:
        """Mapa meeting_id -> [tags], para enriquecer a listagem em uma query."""
        with _connect(self.root) as conn:
            rows = conn.execute(
                """
                SELECT mt.meeting_id AS mid, t.name AS name
                FROM meeting_tags mt JOIN tags t ON t.id = mt.tag_id
                ORDER BY t.name
                """
            ).fetchall()
        out: dict[str, list[str]] = {}
        for r in rows:
            out.setdefault(r["mid"], []).append(r["name"])
        return out

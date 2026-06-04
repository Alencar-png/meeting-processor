"""Aplicação FastAPI do frontend local.

Layout: sidebar com 4 módulos (Dashboard, Reuniões, Tarefas/Kanban,
Configuração). Lê os arquivos do vault diretamente, mesma fonte de
verdade que o Obsidian.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from ..config import Settings, load_config
from .runtime import (
    VALID_PROVIDERS,
    get_supervisor,
    set_llm_provider,
    set_pipeline_steps,
    set_watch_dir,
)
from .tasks_export import to_csv, to_json, to_markdown, to_txt
from .tasks_io import (
    COLUMN_DOING,
    COLUMN_DONE,
    COLUMN_LABEL,
    COLUMN_ORDER,
    COLUMN_TODO,
    kanban_path_for,
    list_all_tasks,
    move_task,
)

logger = logging.getLogger(__name__)

WEB_DIR = Path(__file__).parent
TEMPLATES_DIR = WEB_DIR / "templates"
STATIC_DIR = WEB_DIR / "static"

# Etapas do pipeline para o modal de progresso. (chave, rótulo)
# audio/transcription rodam sempre; as demais dependem da config.
PIPELINE_STAGES = [
    ("audio", "Extraindo áudio"),
    ("transcription", "Transcrevendo (Whisper)"),
    ("summary", "Resumo (LLM)"),
    ("note", "Nota no Obsidian"),
    ("kanban", "Quadro Kanban"),
    ("wiki", "Integração Wiki"),
]


def _attachment_response(body: str, filename: str, content_type: str) -> Response:
    """Resposta com Content-Disposition: attachment para forçar download."""
    return Response(
        content=body,
        media_type=content_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


# ---------------------------------------------------------------------------
# Helpers de leitura do vault
# ---------------------------------------------------------------------------


def _strip_frontmatter(text: str) -> tuple[dict[str, str], str]:
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


def _extract_tasks_simple(text: str) -> list[dict[str, Any]]:
    """Versão simples (sem coluna) usada na contagem rápida."""
    tasks = []
    pattern = re.compile(r"^\s*-\s*\[( |x|X)\]\s*(.+?)\s*$")
    for line in text.splitlines():
        m = pattern.match(line)
        if m:
            done = m.group(1).lower() == "x"
            description = m.group(2).strip().lstrip("*").rstrip("*").strip()
            tasks.append({"done": done, "description": description})
    return tasks


def _list_meetings(vault_path: Path) -> list[dict[str, Any]]:
    """Lista as reuniões em ``vault/wiki/reunioes/<pasta>/``."""
    base = vault_path / "wiki" / "reunioes"
    if not base.exists():
        return []

    meetings = []
    for entry in sorted(base.iterdir(), reverse=True):
        if not entry.is_dir():
            continue
        resumos = list(entry.glob("Resumo - *.md"))
        if not resumos:
            continue

        meta, _ = _strip_frontmatter(resumos[0].read_text(encoding="utf-8"))

        tarefas_paths = list(entry.glob("Tarefas - *.md"))
        task_count = 0
        if tarefas_paths:
            task_count = len(_extract_tasks_simple(tarefas_paths[0].read_text(encoding="utf-8")))

        meetings.append(
            {
                "id": entry.name,
                "title": entry.name,
                "created": meta.get("created", ""),
                "duration": meta.get("duration", ""),
                "task_count": task_count,
                "participants": meta.get("participants", ""),
                "source_file": meta.get("source_file", ""),
            }
        )
    return meetings


def _load_meeting(vault_path: Path, meeting_id: str) -> dict[str, Any]:
    base = vault_path / "wiki" / "reunioes" / meeting_id
    if not base.exists():
        raise FileNotFoundError(meeting_id)

    resumo_paths = list(base.glob("Resumo - *.md"))
    tarefas_paths = list(base.glob("Tarefas - *.md"))
    transcricao_paths = list(base.glob("Transcricao - *.md"))

    resumo_text = ""
    meta: dict[str, str] = {}
    if resumo_paths:
        raw = resumo_paths[0].read_text(encoding="utf-8")
        meta, resumo_text = _strip_frontmatter(raw)

    tasks = []
    if tarefas_paths:
        tasks = _extract_tasks_simple(tarefas_paths[0].read_text(encoding="utf-8"))

    transcricao_text = ""
    if transcricao_paths:
        transcricao_text = transcricao_paths[0].read_text(encoding="utf-8")
        transcricao_text = re.sub(r"^#\s*Transcricao\s*\n+", "", transcricao_text)

    return {
        "id": meeting_id,
        "title": meeting_id,
        "meta": meta,
        "resumo_md": resumo_text,
        "tasks": tasks,
        "transcricao_md": transcricao_text,
    }


def _delete_meeting(
    vault_path: Path,
    project_root: Path,
    meeting_id: str,
) -> dict[str, Any]:
    """Apaga uma reunião do vault e limpa todas as referências.

    Remove:
      - ``vault/wiki/reunioes/<meeting_id>/`` (pasta inteira, 4 arquivos).
      - Linhas em ``index.md`` referenciando ``[[<meeting_id>]]``.
      - Linhas em ``hot.md`` que mencionem o ID.
      - Bloco em ``log.md`` com cabeçalho ``## [data] ingest | <id>``.
      - Marcador ``.processed/<source_file>.done`` (permite reprocessar).

    NÃO toca no arquivo de vídeo original em ``watch_dir``.

    Returns:
        dict com ``ok`` e detalhes do que foi removido.
    """
    base = vault_path / "wiki" / "reunioes" / meeting_id
    if not base.exists() or not base.is_dir():
        return {"ok": False, "error": f"Reunião não encontrada: {meeting_id}"}

    # 1. Captura source_file do frontmatter (se possível) para limpar marker
    source_file: str | None = None
    resumos = list(base.glob("Resumo - *.md"))
    if resumos:
        try:
            text = resumos[0].read_text(encoding="utf-8")
            meta, _ = _strip_frontmatter(text)
            source_file = meta.get("source_file") or None
        except OSError:
            pass

    removed_files: list[str] = [
        str(p.relative_to(vault_path)) for p in base.rglob("*") if p.is_file()
    ]

    # 2. Apaga a pasta inteira
    try:
        shutil.rmtree(base)
    except OSError as e:
        logger.exception("Falha ao remover pasta da reunião")
        return {"ok": False, "error": f"Erro ao remover pasta: {e}"}

    # 3. Limpa referências em index.md / hot.md
    cleaned_refs: list[str] = []

    index_path = vault_path / "wiki" / "index.md"
    if index_path.exists():
        original = index_path.read_text(encoding="utf-8")
        # Remove linha que contém [[<meeting_id>]] (com ou sem alias)
        pattern = re.compile(
            r"^.*\[\[" + re.escape(meeting_id) + r"(?:\|[^\]]*)?\]\].*$\n?",
            re.MULTILINE,
        )
        new_index = pattern.sub("", original)
        if new_index != original:
            index_path.write_text(new_index, encoding="utf-8")
            cleaned_refs.append("index.md")

    hot_path = vault_path / "wiki" / "hot.md"
    if hot_path.exists():
        original = hot_path.read_text(encoding="utf-8")
        pattern = re.compile(
            r"^.*\[\[" + re.escape(meeting_id) + r"(?:\|[^\]]*)?\]\].*$\n?",
            re.MULTILINE,
        )
        new_hot = pattern.sub("", original)
        if new_hot != original:
            hot_path.write_text(new_hot, encoding="utf-8")
            cleaned_refs.append("hot.md")

    # 4. Remove bloco em log.md
    log_path = vault_path / "wiki" / "log.md"
    if log_path.exists():
        original = log_path.read_text(encoding="utf-8")
        # Captura "## [data] ingest | <meeting_id>" + linhas até próximo "##" ou EOF
        block_re = re.compile(
            r"\n##\s+\[[\d-]+\]\s+ingest\s*\|\s*"
            + re.escape(meeting_id)
            + r"\b.*?(?=\n##\s|\Z)",
            re.DOTALL,
        )
        new_log = block_re.sub("", original)
        if new_log != original:
            log_path.write_text(new_log, encoding="utf-8")
            cleaned_refs.append("log.md")

    # 5. Remove marcador de processado (permite reprocessar)
    marker_removed = False
    if source_file:
        marker = project_root / ".processed" / f"{source_file}.done"
        if marker.exists():
            try:
                marker.unlink()
                marker_removed = True
            except OSError:
                pass

    logger.info(
        "Reunião removida: %s (arquivos=%d, refs limpas=%s, marker=%s)",
        meeting_id,
        len(removed_files),
        cleaned_refs,
        marker_removed,
    )

    return {
        "ok": True,
        "removed_files": len(removed_files),
        "cleaned_refs": cleaned_refs,
        "marker_removed": marker_removed,
        "source_file": source_file,
    }


def _remove_history_entry(
    vault_path: Path,
    file_name: str,
    started_at: str | None = None,
) -> dict[str, Any]:
    """Remove uma entrada do ``.processing-history.json``.

    Usa ``(file_name, started_at)`` como identificador único — ``started_at``
    permite distinguir entre múltiplas tentativas do mesmo arquivo. Se
    ``started_at`` for None, remove a primeira entrada com aquele file.
    """
    history_path = vault_path / "wiki" / ".processing-history.json"
    if not history_path.exists():
        return {"ok": False, "error": "Histórico vazio"}

    try:
        data = json.loads(history_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"ok": False, "error": "Histórico corrompido"}

    new_data = []
    removed = 0
    for entry in data:
        if entry.get("file") == file_name:
            if started_at is None or entry.get("started") == started_at:
                if removed == 0:  # remove só a primeira que casa
                    removed += 1
                    continue
        new_data.append(entry)

    if removed == 0:
        return {"ok": False, "error": "Entrada não encontrada"}

    history_path.write_text(
        json.dumps(new_data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return {"ok": True, "removed": removed}


def _clear_history_errors(vault_path: Path) -> dict[str, Any]:
    """Remove todas as entradas com status=error do histórico."""
    history_path = vault_path / "wiki" / ".processing-history.json"
    if not history_path.exists():
        return {"ok": True, "removed": 0}

    try:
        data = json.loads(history_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"ok": False, "error": "Histórico corrompido"}

    new_data = [e for e in data if e.get("status") != "error"]
    removed = len(data) - len(new_data)

    history_path.write_text(
        json.dumps(new_data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return {"ok": True, "removed": removed}


def _read_status(vault_path: Path, watch_dir: str | None = None) -> dict[str, Any]:
    heartbeat = vault_path / "wiki" / ".watcher-heartbeat"
    history = vault_path / "wiki" / ".processing-history.json"

    watcher_alive = False
    last_heartbeat: str | None = None
    if heartbeat.exists():
        try:
            ts = datetime.fromisoformat(heartbeat.read_text(encoding="utf-8").strip())
            last_heartbeat = ts.strftime("%Y-%m-%d %H:%M:%S")
            watcher_alive = (datetime.now() - ts).total_seconds() < 15
        except (ValueError, OSError):
            pass

    history_entries: list[dict[str, Any]] = []
    active_jobs: list[dict[str, Any]] = []
    if history.exists():
        try:
            data = json.loads(history.read_text(encoding="utf-8"))
            for entry in data:
                if watch_dir:
                    candidate = Path(watch_dir) / entry.get("file", "")
                    if candidate.exists():
                        entry["absolute_path"] = str(candidate)
                if entry.get("status") in ("waiting", "processing"):
                    active_jobs.append(entry)
                else:
                    history_entries.append(entry)
        except json.JSONDecodeError:
            pass

    return {
        "watcher_alive": watcher_alive,
        "last_heartbeat": last_heartbeat,
        "active_jobs": active_jobs,
        "history": history_entries[-20:][::-1],
    }


def _kanban_grouped(
    vault_path: Path,
    filter_assignee: str | None = None,
    filter_meeting: str | None = None,
) -> dict[str, list]:
    """Agrupa todas as tarefas por coluna canônica."""
    base = vault_path / "wiki" / "reunioes"
    tasks = list_all_tasks(base)

    if filter_assignee:
        tasks = [t for t in tasks if (t.assignee or "").lower() == filter_assignee.lower()]
    if filter_meeting:
        tasks = [t for t in tasks if t.meeting_id == filter_meeting]

    grouped: dict[str, list] = {col: [] for col in COLUMN_ORDER}
    for t in tasks:
        if t.column in grouped:
            grouped[t.column].append(t)
    return grouped


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------


def create_app(config: Settings | None = None) -> FastAPI:
    """Cria a aplicação FastAPI."""
    if config is None:
        config = load_config()

    app = FastAPI(title="Meeting Processor", version="1.1.0")
    templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

    # Cache-busting: versão derivada do mtime dos estáticos. Muda sempre que
    # app.css/app.js são editados, forçando o navegador a rebaixar (evita
    # servir CSS/JS antigos do cache e "quebrar" o layout).
    def _static_version() -> str:
        latest = 0.0
        for name in ("app.css", "app.js"):
            f = STATIC_DIR / name
            if f.exists():
                latest = max(latest, f.stat().st_mtime)
        return str(int(latest))

    templates.env.globals["static_v"] = _static_version()

    if STATIC_DIR.exists():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    supervisor = get_supervisor(Path(config.project_root))

    def _provider_label() -> str:
        labels = {
            "anthropic": "Claude API",
            "openai": "OpenAI",
            "gemini": "Gemini",
            "local": "Ollama (local)",
            "ollama": "Ollama (local)",
            "none": "Sem IA (só transcrição)",
        }
        return labels.get(config.llm_provider, config.llm_provider)

    def _base_ctx() -> dict[str, Any]:
        """Contexto compartilhado por todas as páginas (para sidebar)."""
        meetings = _list_meetings(config.vault_path)
        tasks = list_all_tasks(config.vault_path / "wiki" / "reunioes")
        open_tasks = sum(1 for t in tasks if t.column != COLUMN_DONE)
        status = _read_status(config.vault_path, config.watch_dir)
        return {
            "total_meetings": len(meetings),
            "total_tasks_open": open_tasks,
            "sidebar_status": {
                "watcher_alive": status["watcher_alive"],
                "provider_label": _provider_label(),
            },
        }

    def _config_ctx() -> dict[str, Any]:
        return {
            "llm_provider": config.llm_provider,
            "provider_label": _provider_label(),
            "anthropic_model": config.anthropic_model,
            "openai_model": config.openai_model,
            "openai_base_url": config.openai_base_url,
            "openai_key_set": bool(config.openai_api_key),
            "gemini_model": config.gemini_model,
            "gemini_key_set": bool(config.gemini_api_key),
            "ollama_model": config.ollama_model,
            "ollama_base_url": config.ollama_base_url,
            "ollama_num_ctx": config.ollama_num_ctx,
            "ollama_temperature": config.ollama_temperature,
            "anthropic_key_set": bool(config.anthropic_api_key),
            "watch_dir": config.watch_dir,
            "vault_dir": str(config.vault_path),
            "whisper_model": config.whisper_model,
            "whisper_language": config.whisper_language,
            "whisper_device": config.whisper_device,
            "temp_dir": config.temp_dir,
            "enable_summary": config.enable_summary,
            "enable_note": config.enable_note,
            "enable_kanban": config.enable_kanban,
            "enable_wiki": config.enable_wiki,
        }

    # =====================================================================
    # PÁGINAS
    # =====================================================================

    @app.get("/", response_class=HTMLResponse)
    async def root_redirect():
        return RedirectResponse(url="/dashboard", status_code=302)

    # ---- Dashboard ------------------------------------------------------

    @app.get("/dashboard", response_class=HTMLResponse)
    async def dashboard(request: Request):
        meetings = _list_meetings(config.vault_path)
        status = _read_status(config.vault_path, config.watch_dir)
        tasks = list_all_tasks(config.vault_path / "wiki" / "reunioes")

        stats = {
            "meetings": len(meetings),
            "tasks_total": len(tasks),
            "tasks_open": sum(1 for t in tasks if t.column != COLUMN_DONE),
            "tasks_done": sum(1 for t in tasks if t.column == COLUMN_DONE),
        }

        # Próximas tarefas: pegar 5 mais recentes em A Fazer
        recent_open = [t for t in tasks if t.column == COLUMN_TODO][:6]

        return templates.TemplateResponse(
            request,
            "dashboard.html",
            {
                **_base_ctx(),
                "config": _config_ctx(),
                "supervisor": supervisor.info(),
                "status": status,
                "meetings": meetings[:5],
                "stats": stats,
                "recent_open": recent_open,
            },
        )

    # ---- Reuniões -------------------------------------------------------

    @app.get("/reunioes", response_class=HTMLResponse)
    async def reunioes(request: Request, filter: str = ""):
        meetings = _list_meetings(config.vault_path)
        status = _read_status(config.vault_path, config.watch_dir)

        # filtro por status (somente as com erro recente)
        if filter == "erros":
            error_files = {
                h["file"] for h in status["history"] if h.get("status") == "error"
            }
            # Nessas reuniões com erro, normalmente nem foi gerado o resumo,
            # então elas nem aparecem em `meetings`. Mostro a partir do histórico.
            return templates.TemplateResponse(
                request,
                "reunioes_erros.html",
                {
                    **_base_ctx(),
                    "errors": [h for h in status["history"] if h.get("status") == "error"],
                },
            )

        return templates.TemplateResponse(
            request,
            "reunioes.html",
            {**_base_ctx(), "meetings": meetings},
        )

    @app.get("/meetings/{meeting_id}", response_class=HTMLResponse)
    async def meeting_detail(request: Request, meeting_id: str):
        try:
            meeting = _load_meeting(config.vault_path, meeting_id)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="Reunião não encontrada")
        return templates.TemplateResponse(
            request,
            "meeting.html",
            {**_base_ctx(), "meeting": meeting},
        )

    # ---- Tarefas (Kanban) ----------------------------------------------

    @app.get("/tarefas", response_class=HTMLResponse)
    async def tarefas(
        request: Request,
        view: str = "kanban",
        assignee: str = "",
        meeting: str = "",
    ):
        grouped = _kanban_grouped(
            config.vault_path,
            filter_assignee=assignee or None,
            filter_meeting=meeting or None,
        )
        # Conjunto de assignees para filtro
        all_tasks = list_all_tasks(config.vault_path / "wiki" / "reunioes")
        assignees = sorted({t.assignee for t in all_tasks if t.assignee})
        meetings_idx = sorted({t.meeting_id for t in all_tasks})

        ctx = {
            **_base_ctx(),
            "grouped": grouped,
            "column_order": COLUMN_ORDER,
            "column_label": COLUMN_LABEL,
            "assignees": assignees,
            "meetings_idx": meetings_idx,
            "filter": {"assignee": assignee, "meeting": meeting, "view": view},
        }

        if view == "lista":
            ctx["all_tasks"] = all_tasks
            return templates.TemplateResponse(request, "tarefas_lista.html", ctx)
        return templates.TemplateResponse(request, "tarefas.html", ctx)

    # ---- Configuração ---------------------------------------------------

    @app.get("/configuracao", response_class=HTMLResponse)
    async def configuracao(request: Request):
        return templates.TemplateResponse(
            request,
            "configuracao.html",
            {
                **_base_ctx(),
                "config": _config_ctx(),
                "supervisor": supervisor.info(),
            },
        )

    @app.get("/settings")
    async def settings_redirect():
        return RedirectResponse(url="/configuracao", status_code=301)

    # =====================================================================
    # FRAGMENTOS HTMX
    # =====================================================================

    @app.get("/fragments/status", response_class=HTMLResponse)
    async def status_fragment(request: Request):
        status = _read_status(config.vault_path, config.watch_dir)
        return templates.TemplateResponse(
            request,
            "_status.html",
            {"status": status, "supervisor": supervisor.info()},
        )

    @app.get("/fragments/controls", response_class=HTMLResponse)
    async def controls_fragment(request: Request):
        return templates.TemplateResponse(
            request,
            "_controls.html",
            {"supervisor": supervisor.info(), "config": _config_ctx()},
        )

    @app.get("/fragments/kanban", response_class=HTMLResponse)
    async def kanban_fragment(request: Request, assignee: str = "", meeting: str = ""):
        grouped = _kanban_grouped(
            config.vault_path,
            filter_assignee=assignee or None,
            filter_meeting=meeting or None,
        )
        return templates.TemplateResponse(
            request,
            "_kanban_board.html",
            {
                "grouped": grouped,
                "column_order": COLUMN_ORDER,
                "column_label": COLUMN_LABEL,
            },
        )

    # =====================================================================
    # AÇÕES
    # =====================================================================

    @app.post("/actions/watcher/start", response_class=HTMLResponse)
    async def watcher_start(request: Request):
        result = supervisor.start()
        return templates.TemplateResponse(
            request,
            "_controls.html",
            {
                "supervisor": supervisor.info(),
                "flash": {
                    "type": "ok" if result["ok"] else "err",
                    "msg": "Watcher iniciado." if result["ok"] else f"Erro: {result.get('error')}",
                },
                "config": _config_ctx(),
            },
        )

    @app.post("/actions/watcher/stop", response_class=HTMLResponse)
    async def watcher_stop(request: Request):
        result = supervisor.stop()
        return templates.TemplateResponse(
            request,
            "_controls.html",
            {
                "supervisor": supervisor.info(),
                "flash": {
                    "type": "ok" if result["ok"] else "err",
                    "msg": "Watcher parado." if result["ok"] else f"Erro: {result.get('error')}",
                },
                "config": _config_ctx(),
            },
        )

    @app.post("/actions/watcher/restart", response_class=HTMLResponse)
    async def watcher_restart(request: Request):
        result = supervisor.restart()
        return templates.TemplateResponse(
            request,
            "_controls.html",
            {
                "supervisor": supervisor.info(),
                "flash": {
                    "type": "ok" if result["ok"] else "err",
                    "msg": "Watcher reiniciado." if result["ok"] else f"Erro: {result.get('error')}",
                },
                "config": _config_ctx(),
            },
        )

    @app.post("/actions/llm-provider", response_class=HTMLResponse)
    async def change_provider(request: Request, provider: str = Form(...)):
        result = set_llm_provider(config, provider)
        if not result["ok"]:
            return templates.TemplateResponse(
                request,
                "_controls.html",
                {
                    "supervisor": supervisor.info(),
                    "flash": {"type": "err", "msg": result.get("error", "Erro")},
                    "config": _config_ctx(),
                },
                status_code=400,
            )

        watcher_msg = ""
        if supervisor.is_running():
            supervisor.restart()
            watcher_msg = " Watcher reiniciado para aplicar."

        return templates.TemplateResponse(
            request,
            "_controls.html",
            {
                "supervisor": supervisor.info(),
                "flash": {
                    "type": "ok",
                    "msg": f"Provedor agora: {_provider_label()}.{watcher_msg}",
                },
                "config": _config_ctx(),
            },
        )

    @app.post("/actions/watch-dir", response_class=HTMLResponse)
    async def change_watch_dir(request: Request, watch_dir: str = Form(...)):
        result = set_watch_dir(config, watch_dir)
        if not result["ok"]:
            return templates.TemplateResponse(
                request,
                "_paths.html",
                {
                    "config": _config_ctx(),
                    "flash": {"type": "err", "msg": result.get("error", "Erro")},
                },
                status_code=400,
            )

        watcher_msg = ""
        if supervisor.is_running():
            supervisor.restart()
            watcher_msg = " Watcher reiniciado para aplicar."

        exists_msg = "" if result["exists"] else " (atenção: a pasta ainda não existe)"
        return templates.TemplateResponse(
            request,
            "_paths.html",
            {
                "config": _config_ctx(),
                "flash": {
                    "type": "ok",
                    "msg": f"Pasta monitorada salva.{exists_msg}{watcher_msg}",
                },
            },
        )

    @app.post("/actions/steps", response_class=HTMLResponse)
    async def change_steps(
        request: Request,
        summary: str = Form(None),
        note: str = Form(None),
        kanban: str = Form(None),
        wiki: str = Form(None),
    ):
        # Checkbox ausente no POST => desligado.
        set_pipeline_steps(
            config,
            summary=bool(summary),
            note=bool(note),
            kanban=bool(kanban),
            wiki=bool(wiki),
        )
        watcher_msg = ""
        if supervisor.is_running():
            supervisor.restart()
            watcher_msg = " Watcher reiniciado para aplicar."
        return templates.TemplateResponse(
            request,
            "_steps.html",
            {
                "config": _config_ctx(),
                "flash": {"type": "ok", "msg": f"Etapas salvas.{watcher_msg}"},
            },
        )

    def _build_steps(file_base: str) -> dict[str, Any]:
        """Monta o estado das etapas para o modal de progresso."""
        status = _read_status(config.vault_path, config.watch_dir)
        steps_cfg = config.steps()

        def enabled(key: str) -> bool:
            return True if key in ("audio", "transcription") else steps_cfg.get(key, True)

        job = next((j for j in status["active_jobs"] if j.get("file") == file_base), None)
        done_entry = None
        if job is None:
            done_entry = next((h for h in status["history"] if h.get("file") == file_base), None)

        rows = []
        if job is not None:
            state = "processing"
            cur = job.get("stage", 0)
            for i, (key, label) in enumerate(PIPELINE_STAGES):
                st = "skipped" if not enabled(key) else ("done" if i < cur else "active" if i == cur else "pending")
                rows.append({"label": label, "state": st})
        elif done_entry is not None:
            err = done_entry.get("status") == "error"
            state = "error" if err else "done"
            failed = done_entry.get("stage", len(PIPELINE_STAGES))
            for i, (key, label) in enumerate(PIPELINE_STAGES):
                if not enabled(key):
                    st = "skipped"
                elif err and i == failed:
                    st = "error"
                elif err and i > failed:
                    st = "pending"
                else:
                    st = "done"
                rows.append({"label": label, "state": st})
        else:
            state = "starting"
            for key, label in PIPELINE_STAGES:
                rows.append({"label": label, "state": "pending" if enabled(key) else "skipped"})

        return {
            "file": file_base,
            "state": state,
            "steps": rows,
            "result": (done_entry or {}).get("details", {}).get("result", "") if done_entry else "",
            "error_message": (done_entry or {}).get("error_message", "") if done_entry else "",
        }

    @app.get("/fragments/process-steps", response_class=HTMLResponse)
    async def process_steps_fragment(request: Request, file: str = ""):
        return templates.TemplateResponse(
            request, "_process_steps.html", {"ps": _build_steps(Path(file).name)}
        )

    @app.post("/actions/process", response_class=HTMLResponse)
    async def trigger_process(request: Request, file: str = Form(...)):
        path = Path(file)
        if not path.exists():
            return templates.TemplateResponse(
                request,
                "_process_modal.html",
                {"ps": {"file": file, "state": "error", "steps": [],
                        "result": "", "error_message": f"Arquivo não encontrado: {file}"}},
                status_code=400,
            )

        def _run():
            try:
                from ..pipeline import MeetingPipeline

                pipeline = MeetingPipeline(config)
                pipeline.process(path)
            except Exception:  # noqa: BLE001
                logger.exception("Falha ao processar via web")

        threading.Thread(target=_run, daemon=True).start()
        return templates.TemplateResponse(
            request, "_process_modal.html", {"ps": _build_steps(path.name)}
        )

    @app.post("/actions/meetings/{meeting_id}/delete")
    async def delete_meeting_action(meeting_id: str):
        """Apaga uma reunião e redireciona para a lista. Form-friendly."""
        result = _delete_meeting(
            config.vault_path,
            Path(config.project_root),
            meeting_id,
        )
        if not result["ok"]:
            raise HTTPException(status_code=404, detail=result.get("error", "Erro"))
        return RedirectResponse(url="/reunioes", status_code=303)

    @app.post("/actions/history/remove")
    async def history_remove(file: str = Form(...), started: str = Form("")):
        """Remove uma entrada específica do histórico de processamento."""
        result = _remove_history_entry(
            config.vault_path, file, started if started else None
        )
        if not result["ok"]:
            raise HTTPException(status_code=404, detail=result.get("error"))
        return RedirectResponse(url="/reunioes?filter=erros", status_code=303)

    @app.post("/actions/history/clear-errors")
    async def history_clear_errors():
        """Remove todas as entradas com status=error do histórico."""
        result = _clear_history_errors(config.vault_path)
        if not result["ok"]:
            raise HTTPException(status_code=500, detail=result.get("error"))
        return RedirectResponse(url="/reunioes?filter=erros", status_code=303)

    @app.delete("/api/history")
    async def api_clear_errors():
        """REST: limpa erros do histórico."""
        return _clear_history_errors(config.vault_path)

    @app.delete("/api/meetings/{meeting_id}")
    async def delete_meeting_api(meeting_id: str):
        """Versão REST do delete (para integrações)."""
        result = _delete_meeting(
            config.vault_path,
            Path(config.project_root),
            meeting_id,
        )
        if not result["ok"]:
            raise HTTPException(status_code=404, detail=result.get("error", "Erro"))
        return result

    @app.post("/actions/tasks/move")
    async def task_move(payload: dict):
        """Move uma tarefa entre colunas, persistindo no .md original."""
        task_id = payload.get("task_id")
        meeting_id = payload.get("meeting_id")
        to_column = payload.get("to_column")

        if not all([task_id, meeting_id, to_column]):
            raise HTTPException(
                status_code=400,
                detail="task_id, meeting_id e to_column são obrigatórios",
            )

        kanban_path = kanban_path_for(config.vault_path / "wiki" / "reunioes", meeting_id)
        if not kanban_path:
            raise HTTPException(status_code=404, detail="Reunião sem arquivo de Kanban")

        try:
            ok = move_task(kanban_path, task_id, meeting_id, to_column)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        if not ok:
            raise HTTPException(status_code=404, detail="Tarefa não encontrada")

        return JSONResponse({"ok": True, "moved_to": to_column})

    # =====================================================================
    # API JSON
    # =====================================================================

    @app.get("/api/health")
    async def health():
        return JSONResponse(
            {
                "status": "ok",
                "llm_provider": config.llm_provider,
                "vault": str(config.vault_path),
                "timestamp": datetime.now().isoformat(),
            }
        )

    @app.get("/api/meetings")
    async def api_meetings():
        return _list_meetings(config.vault_path)

    @app.get("/api/meetings/{meeting_id}")
    async def api_meeting(meeting_id: str):
        try:
            return _load_meeting(config.vault_path, meeting_id)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="Reunião não encontrada")

    @app.get("/api/watcher")
    async def api_watcher():
        return supervisor.info()

    @app.get("/api/llm")
    async def api_llm():
        return {
            "provider": config.llm_provider,
            "label": _provider_label(),
            "anthropic_model": config.anthropic_model,
            "ollama_model": config.ollama_model,
            "anthropic_key_set": bool(config.anthropic_api_key),
            "valid_providers": list(VALID_PROVIDERS),
        }

    # ---- Export de tarefas ---------------------------------------------

    def _filtered_tasks(assignee: str = "", meeting: str = "", column: str = ""):
        all_tasks = list_all_tasks(config.vault_path / "wiki" / "reunioes")
        if assignee:
            all_tasks = [t for t in all_tasks if (t.assignee or "").lower() == assignee.lower()]
        if meeting:
            all_tasks = [t for t in all_tasks if t.meeting_id == meeting]
        if column:
            if column == "open":
                all_tasks = [t for t in all_tasks if t.column != COLUMN_DONE]
            else:
                all_tasks = [t for t in all_tasks if t.column == column]
        return all_tasks

    def _export_filename(extension: str) -> str:
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        return f"tarefas-{ts}.{extension}"

    @app.get("/api/tasks/export.csv")
    async def export_csv(assignee: str = "", meeting: str = "", column: str = ""):
        tasks = _filtered_tasks(assignee, meeting, column)
        body = to_csv(tasks)
        return _attachment_response(body, _export_filename("csv"), "text/csv; charset=utf-8")

    @app.get("/api/tasks/export.json")
    async def export_json(assignee: str = "", meeting: str = "", column: str = ""):
        tasks = _filtered_tasks(assignee, meeting, column)
        body = to_json(tasks)
        return _attachment_response(body, _export_filename("json"), "application/json; charset=utf-8")

    @app.get("/api/tasks/export.md")
    async def export_md(assignee: str = "", meeting: str = "", column: str = ""):
        tasks = _filtered_tasks(assignee, meeting, column)
        body = to_markdown(tasks)
        return _attachment_response(body, _export_filename("md"), "text/markdown; charset=utf-8")

    @app.get("/api/tasks/export.txt")
    async def export_txt(assignee: str = "", meeting: str = "", column: str = ""):
        tasks = _filtered_tasks(assignee, meeting, column)
        body = to_txt(tasks)
        return _attachment_response(body, _export_filename("txt"), "text/plain; charset=utf-8")

    @app.get("/api/tasks")
    async def api_tasks():
        all_tasks = list_all_tasks(config.vault_path / "wiki" / "reunioes")
        return [
            {
                "task_id": t.task_id,
                "meeting_id": t.meeting_id,
                "column": t.column,
                "description": t.description,
                "done": t.done,
                "assignee": t.assignee,
                "priority": t.priority,
                "due_date": t.due_date,
                "timestamp": t.timestamp,
            }
            for t in all_tasks
        ]

    @app.on_event("shutdown")
    def _shutdown():
        if supervisor.is_running():
            logger.info("Frontend desligando — parando watcher também.")
            supervisor.stop()

    return app


def run(host: str = "127.0.0.1", port: int = 8765, reload: bool = False) -> None:
    """Sobe o servidor com uvicorn."""
    import uvicorn

    config = load_config()
    logger.info(
        "Frontend local em http://%s:%d  | LLM: %s",
        host,
        port,
        config.llm_provider,
    )

    if reload:
        uvicorn.run(
            "meeting_processor.web.app:create_app",
            host=host,
            port=port,
            reload=True,
            factory=True,
        )
    else:
        uvicorn.run(create_app(config), host=host, port=port)

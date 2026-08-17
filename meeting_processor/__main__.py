"""Ponto de entrada do Meeting Processor.

Uso:
    python -m meeting_processor watch              Monitora pasta OBS (padrão)
    python -m meeting_processor process <file>     Pipeline completo no vault
    python -m meeting_processor transcribe <file>  Só transcreve numa pasta
    python -m meeting_processor reindex            Reindexa o vault no SQLite
"""

import argparse
import logging
import sys
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import TextIO

from .config import Settings, load_config


def setup_logging(level: str, stream: TextIO | None = None) -> None:
    """Configura logging para console e arquivo (com rotação).

    ``stream`` permite mandar o console para stderr: no modo ``--json`` o
    stdout carrega só os eventos JSONL e não pode ser poluído por log.
    """
    log_format = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
    date_format = "%Y-%m-%d %H:%M:%S"

    handlers: list[logging.Handler] = [logging.StreamHandler(stream or sys.stdout)]
    try:
        # Rotação: evita que o log cresça indefinidamente (5 MB x 3 backups).
        handlers.append(
            RotatingFileHandler(
                "meeting_processor.log",
                maxBytes=5_000_000,
                backupCount=3,
                encoding="utf-8",
            )
        )
    except OSError:
        # Diretório de trabalho somente-leitura (ex.: container com volume ro):
        # segue só com o console em vez de abortar o processamento.
        pass

    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format=log_format,
        datefmt=date_format,
        handlers=handlers,
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Meeting Processor - Transcreve e resume reunioes gravadas",
    )
    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser("watch", help="Monitora pasta do OBS")
    subparsers.add_parser(
        "reindex", help="Reindexa as reunioes existentes do vault no banco (SQLite)"
    )

    process_parser = subparsers.add_parser(
        "process", help="Processa um video no vault (transcricao + resumo)"
    )
    process_parser.add_argument("file", type=str, help="Caminho do arquivo de video")
    process_parser.add_argument(
        "--only-transcribe",
        action="store_true",
        help="So transcreve (sem resumo, nota, kanban ou wiki)",
    )
    process_parser.add_argument("--no-summary", action="store_true", help="Nao gera resumo (LLM)")
    process_parser.add_argument("--no-note", action="store_true", help="Nao gera nota de resumo")
    process_parser.add_argument("--no-kanban", action="store_true", help="Nao cria Kanban")
    process_parser.add_argument("--no-wiki", action="store_true", help="Nao integra com a wiki")

    tr = subparsers.add_parser(
        "transcribe",
        help="So transcreve um video e grava os arquivos numa pasta de saida",
    )
    tr.add_argument("file", type=str, help="Caminho do arquivo de video")
    tr.add_argument(
        "--output-dir",
        type=str,
        default="",
        help="Pasta de saida (padrao: a pasta do proprio video)",
    )
    tr.add_argument(
        "--formats",
        type=str,
        default="md,txt",
        help="Formatos separados por virgula: md, txt (padrao: md,txt)",
    )
    tr.add_argument(
        "--name",
        type=str,
        default="",
        help="Nome da reuniao (vira o nome da pasta). Padrao: nome do arquivo",
    )
    tr.add_argument("--model", type=str, default="", help="Modelo do Whisper (ex.: small)")
    tr.add_argument("--language", type=str, default="", help="Idioma do audio (ex.: pt)")
    tr.add_argument(
        "--json",
        action="store_true",
        help="Emite eventos de progresso em JSONL no stdout (para o app desktop)",
    )
    return parser


def _run_transcribe(args: argparse.Namespace, config: Settings) -> int:
    """Transcreve um vídeo e grava os arquivos na pasta de saída.

    Caminho curto e independente do vault: áudio -> Whisper -> arquivos.
    """
    from .audio import extract_audio
    from .events import EventEmitter
    from .media_info import probe_media, to_utc_iso
    from .transcriber import WhisperTranscriber
    from .transcript_export import FORMATS, export

    events = EventEmitter(enabled=args.json)
    logger = logging.getLogger(__name__)

    video_path = Path(args.file).expanduser()
    if not video_path.exists():
        message = f"Arquivo nao encontrado: {video_path}"
        logger.error(message)
        events.error(message)
        return 1

    formats = [f.strip().lower() for f in args.formats.split(",") if f.strip()]
    invalid = [f for f in formats if f not in FORMATS]
    if not formats or invalid:
        message = (
            f"Formato invalido: {', '.join(invalid) or '(vazio)'}. "
            f"Validos: {', '.join(FORMATS)}."
        )
        logger.error(message)
        events.error(message)
        return 1

    output_dir = Path(args.output_dir).expanduser() if args.output_dir else video_path.parent

    # Overrides pontuais desta execução (a UI escolhe o modelo).
    if args.model:
        config.whisper_model = args.model
    if args.language:
        config.whisper_language = args.language

    events.start(str(video_path), str(output_dir))
    started = time.time()
    audio_path: Path | None = None

    try:
        # Data da gravação vem do próprio vídeo — é quando a reunião aconteceu,
        # não quando ela foi transcrita.
        media = probe_media(video_path)
        events.stage(
            "audio",
            "Extraindo audio",
            0,
            f"Gravado em {media.recorded_at.strftime('%d/%m/%Y %H:%M')}",
        )
        logger.info("Extraindo audio de %s...", video_path.name)
        audio_path = extract_audio(video_path, config)
        events.stage("audio", "Extraindo audio", 100, f"{audio_path.stat().st_size / 1_048_576:.1f} MB")

        # Com whisper.cpp o que vale é o arquivo .bin, não o nome do modelo.
        model_label = (
            Path(config.whisper_model_path).stem.replace("ggml-", "")
            if config.whisper_model_path
            else config.whisper_model
        )
        events.stage("transcription", "Transcrevendo", 0, f"Modelo: {model_label}")

        def on_progress(pct: int, detail: str = "") -> None:
            events.stage("transcription", "Transcrevendo", pct, detail)

        transcriber = WhisperTranscriber(config)
        transcript = transcriber.transcribe(audio_path, progress_callback=on_progress)

        events.stage("export", "Gravando arquivos", 0, str(output_dir))
        written = export(
            transcript,
            output_dir,
            video_path.name,
            formats,
            name=args.name,
            metadata={
                "recorded_at": to_utc_iso(media.recorded_at),
                "recorded_at_local": media.recorded_at,
                "date_source": "arquivo" if media.date_from_filesystem else "video",
                "video_duration_seconds": round(media.duration, 2),
                "model": model_label,
            },
        )
        events.stage("export", "Gravando arquivos", 100, f"{len(written)} arquivo(s)")

        elapsed = time.time() - started
        events.done(
            files=[str(p) for p in written],
            segments=len(transcript.segments),
            duration=transcript.duration,
            elapsed=elapsed,
        )
        if not args.json:
            print("\nTranscricao concluida!")
            for path in written:
                print(f"  {path}")
            print(f"  Segmentos: {len(transcript.segments)}")
            print(f"  Tempo: {elapsed:.1f}s")
        logger.info("Transcricao concluida em %.1fs", elapsed)
        return 0

    except Exception as e:
        logger.exception("Erro ao transcrever %s", video_path.name)
        events.error(str(e))
        return 1

    finally:
        if config.cleanup_temp and audio_path is not None and audio_path.exists():
            audio_path.unlink()


def main() -> None:
    args = _build_parser().parse_args()
    config = load_config()

    # No modo --json o stdout é reservado aos eventos; o log vai para stderr.
    json_mode = getattr(args, "json", False)
    setup_logging(config.log_level, stream=sys.stderr if json_mode else sys.stdout)

    logger = logging.getLogger(__name__)

    if args.command == "transcribe":
        sys.exit(_run_transcribe(args, config))

    # Comandos que usam o banco de estado (fila, índice de reuniões, tags).
    from .db import init_db

    init_db(config.project_root)

    if args.command == "process":
        video_path = Path(args.file)
        if not video_path.exists():
            logger.error("Arquivo nao encontrado: %s", video_path)
            sys.exit(1)

        # Flags de etapa sobrescrevem a config só nesta execução.
        if args.only_transcribe or args.no_summary:
            config.enable_summary = False
        if args.no_note:
            config.enable_note = False
        if args.no_kanban:
            config.enable_kanban = False
        if args.no_wiki:
            config.enable_wiki = False

        from .pipeline import MeetingPipeline

        pipeline = MeetingPipeline(config)
        try:
            result = pipeline.process(video_path)
            print("\nProcessamento concluido!")
            print(f"  Transcricao: {result.raw_path}")
            if result.note_path:
                print(f"  Nota: {result.note_path}")
            if result.summary is not None:
                print(f"  Tarefas: {len(result.summary.action_items)}")
            print(f"  Tempo: {result.processing_time:.1f}s")
        except Exception:
            logger.exception("Erro fatal ao processar arquivo")
            sys.exit(1)

    elif args.command == "reindex":
        from .db import MeetingsRepo
        from .utils import parse_timestamp
        from .vault_index import list_meetings

        repo = MeetingsRepo(config.project_root)
        meetings = list_meetings(config.vault_path)
        for m in meetings:
            duration = parse_timestamp(m["duration"]) if m["duration"] else 0.0
            participants = m["participants"] or ""
            p_count = len([p for p in participants.split(",") if p.strip()])
            repo.upsert(
                m["id"],
                title=m["title"],
                created_at=m["created"] or None,
                duration_seconds=duration,
                source_file=m["source_file"] or None,
                provider=config.llm_provider,
                participants_count=p_count,
                task_count=m["task_count"],
            )
        print(f"Reindexado: {len(meetings)} reuniao(oes) no banco.")

    else:
        # Padrão: modo watch
        from .watcher import start_watching

        logger.info("Meeting Processor iniciado em modo monitoramento.")
        start_watching(config)


if __name__ == "__main__":
    main()

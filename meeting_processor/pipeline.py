"""Orquestrador do pipeline de processamento de reuniões."""

import logging
import time
from datetime import datetime
from pathlib import Path

from .audio import extract_audio
from .config import Settings
from .db import MeetingsRepo
from .kanban import KanbanManager
from .models import MeetingSummary, ProcessingResult
from .note_generator import NoteGenerator
from .progress import JobTracker, ProcessingJob
from .summarizer import MeetingSummarizer
from .transcriber import WhisperTranscriber
from .utils import format_duration
from .wiki_integrator import WikiIntegrator

logger = logging.getLogger(__name__)


class MeetingPipeline:
    """Coordena todas as etapas do processamento de uma reunião gravada."""

    def __init__(self, config: Settings):
        self.config = config
        self.transcriber = WhisperTranscriber(config)
        # O summarizer é criado sob demanda (lazy): no modo só transcrição
        # ou com llm_provider="none" nenhuma LLM é instanciada.
        self.summarizer = None
        self.note_generator = NoteGenerator(config)
        self.kanban = KanbanManager(config)
        self.wiki = WikiIntegrator(config)
        self.jobs = JobTracker(config)
        self.meetings_repo = MeetingsRepo(config.project_root)

    def process(self, video_path: Path) -> ProcessingResult:
        """Processa um arquivo de vídeo de reunião completo.

        O progresso de cada etapa é registrado no log e na fila persistente
        (SQLite), consultável por scripts durante a execução.

        Args:
            video_path: Caminho do arquivo de vídeo.

        Returns:
            ProcessingResult com todos os caminhos e dados gerados.
        """
        start_time = time.time()
        steps = self.config.steps()
        mode = "completa" if steps["summary"] else "so transcricao"
        logger.info("=" * 60)
        logger.info("Processando reuniao (%s): %s", mode, video_path.name)
        logger.info("=" * 60)

        created_at = datetime.now()
        job = self.jobs.new_job(video_path.name)
        for key in ("summary", "note", "kanban", "wiki"):
            if not steps[key]:
                job.skip(key)

        # audio_path é inicializado antes do try para que o finally nunca
        # levante UnboundLocalError caso a extração de áudio falhe.
        audio_path: Path | None = None

        try:
            # Etapa 1: Extrair áudio (sempre)
            job.advance("audio", "Convertendo video para WAV 16kHz")
            audio_path = extract_audio(video_path, self.config)
            size_mb = audio_path.stat().st_size / 1_048_576
            job.set_progress("audio", 100, f"{size_mb:.1f} MB extraidos")

            # Etapa 2: Transcrever (sempre)
            job.advance("transcription", f"Modelo: {self.config.whisper_model}")
            job.set_progress("transcription", 5, "Carregando modelo...")
            transcript = self.transcriber.transcribe(
                audio_path, progress_callback=self._make_progress_cb(job)
            )
            duration_str = format_duration(transcript.duration)
            job.set_progress(
                "transcription",
                100,
                f"{len(transcript.segments)} segmentos, {duration_str}",
            )

            # Salvar transcrição no vault (sempre)
            paths = self.note_generator.prepare(video_path.name, created_at)
            self.note_generator.write_transcription(transcript, paths)

            title = f"Reuniao {created_at.strftime('%Y-%m-%d %Hh%M')}"
            date_str = created_at.strftime("%Y-%m-%d")
            summary: MeetingSummary | None = None
            note_path = ""

            # Etapa 3: Resumir (opcional)
            if steps["summary"]:
                provider_label, model_label = self._llm_labels()
                job.advance("summary", f"{provider_label}: {model_label}")
                job.set_progress("summary", 10, f"Enviando ao {provider_label}...")
                if self.summarizer is None:
                    self.summarizer = MeetingSummarizer(self.config)
                summary = self.summarizer.summarize(transcript, video_path.name)
                job.set_progress(
                    "summary",
                    100,
                    f"{len(summary.action_items)} tarefas, "
                    f"{len(summary.participants)} participantes",
                )

                # Etapa 4: Gerar nota de resumo (opcional)
                if steps["note"]:
                    job.advance("note", "Gerando markdown")
                    self.note_generator.write_summary_note(
                        transcript, summary, video_path.name, created_at, paths
                    )
                    note_path = str(paths.note_path)
                    job.set_progress("note", 100, f"{paths.meeting_dir.name}/")

                # Etapa 5: Criar Kanban da reunião (opcional)
                if steps["kanban"]:
                    job.advance("kanban", f"{len(summary.action_items)} tarefas")
                    try:
                        self.kanban.create_board(
                            meeting_dir=paths.meeting_dir,
                            tasks=summary.action_items,
                            meeting_title=title,
                        )
                        job.set_progress(
                            "kanban", 100, f"{len(summary.action_items)} tarefas criadas"
                        )
                    except Exception as e:
                        logger.warning("Falha ao criar Kanban (nao critico): %s", e)
                        job.set_progress("kanban", 100, f"Falha: {e}")

                # Etapa 6: Integrar com wiki (opcional)
                if steps["wiki"]:
                    duration = format_duration(transcript.duration)
                    job.advance("wiki", "Atualizando index, log e hot cache")
                    try:
                        self.wiki.register_meeting(
                            title=title,
                            date_str=date_str,
                            source_file=video_path.name,
                            duration=duration,
                            task_count=len(summary.action_items),
                            key_topics=summary.key_topics,
                        )
                        job.set_progress("wiki", 100, "index, log e hot cache atualizados")
                    except Exception as e:
                        logger.warning("Falha ao integrar com wiki (nao critico): %s", e)
                        job.set_progress("wiki", 100, f"Falha: {e}")

            # Nó central do grafo (liga só ao que foi gerado)
            self.note_generator.write_group_note(paths, has_summary=steps["note"])

            # Indexa a reunião no banco (analytics/listagem sem rescan do vault).
            try:
                self.meetings_repo.upsert(
                    paths.folder_name,
                    title=paths.folder_name,
                    created_at=created_at.strftime("%Y-%m-%d"),
                    duration_seconds=transcript.duration,
                    source_file=video_path.name,
                    provider=self.config.llm_provider,
                    participants_count=len(summary.participants) if summary else 0,
                    task_count=len(summary.action_items) if summary else 0,
                )
            except Exception:
                logger.warning("Falha ao indexar reunião no banco", exc_info=True)

            elapsed = time.time() - start_time
            if summary is not None:
                job.complete(
                    f"{len(summary.action_items)} tarefas | "
                    f"{len(summary.participants)} participantes | "
                    f"{elapsed:.0f}s"
                )
            else:
                job.complete(
                    f"So transcricao | {len(transcript.segments)} segmentos | "
                    f"{elapsed:.0f}s"
                )

            logger.info("=" * 60)
            logger.info("Processamento concluido em %.1f segundos!", elapsed)
            logger.info("  Transcricao: %s", paths.raw_path)
            if note_path:
                logger.info("  Nota: %s", note_path)
            if summary is not None:
                logger.info("  Tarefas: %d", len(summary.action_items))
            logger.info("=" * 60)

            return ProcessingResult(
                source_file=str(video_path),
                transcript=transcript,
                summary=summary,
                note_path=note_path,
                raw_path=str(paths.raw_path),
                processing_time=elapsed,
            )

        except Exception as e:
            job.fail(str(e))
            raise

        finally:
            # Limpar arquivo temporário de áudio (audio_path pode ser None
            # se a própria extração falhou).
            if self.config.cleanup_temp and audio_path is not None and audio_path.exists():
                audio_path.unlink()
                logger.debug("Arquivo temporario removido: %s", audio_path)

    def _llm_labels(self) -> tuple[str, str]:
        """Retorna (label do provedor, label do modelo) para os logs."""
        provider = (self.config.llm_provider or "anthropic").lower()
        if provider in ("local", "ollama"):
            return ("Ollama (local)", self.config.ollama_model)
        if provider == "openai":
            return ("OpenAI", self.config.openai_model)
        if provider == "gemini":
            return ("Gemini", self.config.gemini_model)
        return ("Claude API", self.config.anthropic_model)

    def _make_progress_cb(self, job: ProcessingJob):
        """Cria callback para registrar o progresso da transcrição."""
        def cb(pct: int, detail: str = ""):
            job.set_progress("transcription", pct, detail)
        return cb

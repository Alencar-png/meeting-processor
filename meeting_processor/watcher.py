"""Monitoramento de pasta para novas gravações do OBS."""

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from .config import Settings
from .pipeline import MeetingPipeline

logger = logging.getLogger(__name__)


class RecordingHandler(FileSystemEventHandler):
    """Detecta novas gravações e dispara o processamento."""

    def __init__(self, pipeline: MeetingPipeline, config: Settings):
        super().__init__()
        self.pipeline = pipeline
        self.config = config
        self.extensions = set(config.watch_extensions)
        self._pending: dict[str, float] = {}
        self._processing: set[str] = set()
        self._retries: dict[str, int] = {}
        # Protege _pending/_processing/_retries — mutados pela thread do
        # observador, pelas threads de estabilidade e pela thread do executor.
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(
            max_workers=max(1, config.watch_max_workers)
        )
        self._processed_dir = Path(config.project_root) / ".processed"
        self._processed_dir.mkdir(exist_ok=True)

    def on_created(self, event):
        if event.is_directory:
            return
        path = Path(event.src_path)
        if path.suffix.lower() in self.extensions:
            logger.info("Novo arquivo detectado: %s", path.name)
            self._schedule_stability_check(path)

    def on_modified(self, event):
        if event.is_directory:
            return
        path = Path(event.src_path)
        if path.suffix.lower() not in self.extensions:
            return
        try:
            size = path.stat().st_size
        except OSError:
            return
        with self._lock:
            if str(path) in self._pending:
                self._pending[str(path)] = size

    def _schedule_stability_check(self, path: Path) -> None:
        path_str = str(path)

        if self._is_already_processed(path):
            logger.debug("Arquivo ja processado: %s", path.name)
            return

        try:
            size = path.stat().st_size
        except OSError:
            return

        # Só uma thread de estabilidade por arquivo. Sob o lock: se já está
        # em processamento ou já há uma thread aguardando estabilização
        # (path em _pending), não cria outra. Evita threads duplicadas e a
        # race check-then-act original.
        with self._lock:
            if path_str in self._processing or path_str in self._pending:
                return
            self._pending[path_str] = size

        thread = threading.Thread(
            target=self._check_stable,
            args=(path,),
            daemon=True,
        )
        thread.start()

    def _check_stable(self, path: Path) -> None:
        path_str = str(path)
        stable_seconds = self.config.file_stable_seconds

        while True:
            time.sleep(stable_seconds)

            try:
                current_size = path.stat().st_size
            except OSError:
                with self._lock:
                    self._pending.pop(path_str, None)
                return

            with self._lock:
                last_size = self._pending.get(path_str, -1)
                stable = current_size == last_size and current_size > 0
                if stable:
                    self._pending.pop(path_str, None)
                else:
                    self._pending[path_str] = current_size

            if stable:
                self._submit_processing(path)
                return

    def _submit_processing(self, path: Path) -> None:
        path_str = str(path)

        # check-and-add atômico: garante que só um job por arquivo é enfileirado.
        with self._lock:
            if path_str in self._processing:
                return
            self._processing.add(path_str)

        logger.info("Arquivo estavel. Iniciando processamento: %s", path.name)

        def _process():
            success = False
            try:
                self.pipeline.process(path)
                self._mark_processed(path)
                success = True
            except Exception:
                # Falha NÃO marca .done: o arquivo continua elegível para
                # reprocessamento (ex.: rate limit, Ollama offline, JSON
                # truncado do LLM). Ver SummaryParseError no summarizer.
                logger.exception("Erro ao processar %s", path.name)
            finally:
                with self._lock:
                    self._processing.discard(path_str)
                    if success:
                        self._retries.pop(path_str, None)
            if not success:
                self._schedule_retry(path)

        self._executor.submit(_process)

    def _schedule_retry(self, path: Path) -> None:
        """Reagenda o processamento de uma reunião que falhou, com backoff fixo.

        Sem isso, uma falha transitória deixaria a reunião órfã até o watcher
        reiniciar. Desiste após ``config.max_retries`` tentativas (DLQ implícita
        via log de erro).
        """
        path_str = str(path)
        max_r = self.config.max_retries
        if max_r <= 0:
            return
        with self._lock:
            count = self._retries.get(path_str, 0)
            if count >= max_r:
                logger.error(
                    "Reuniao %s falhou apos %d tentativa(s); desistindo.",
                    path.name, count,
                )
                self._retries.pop(path_str, None)
                return
            self._retries[path_str] = count + 1
        delay = self.config.retry_delay_seconds
        logger.info(
            "Reagendando %s para nova tentativa em %.0fs (%d/%d).",
            path.name, delay, count + 1, max_r,
        )
        timer = threading.Timer(delay, self._submit_processing, args=(path,))
        timer.daemon = True
        timer.start()

    @staticmethod
    def _signature(path: Path) -> str:
        """Assinatura de conteúdo (tamanho + mtime) para detectar regravações."""
        try:
            st = path.stat()
            return f"{st.st_size}:{int(st.st_mtime)}"
        except OSError:
            return ""

    def _is_already_processed(self, path: Path) -> bool:
        """True só se já processamos ESTE conteúdo.

        Compara a assinatura (tamanho+mtime) gravada no marcador. Se o OBS
        regravou um arquivo com o mesmo nome mas conteúdo diferente, a
        assinatura muda e o arquivo é reprocessado em vez de ignorado.
        """
        marker = self._processed_dir / f"{path.name}.done"
        if not marker.exists():
            return False
        try:
            recorded = marker.read_text(encoding="utf-8")
        except OSError:
            return False
        # Marcadores antigos (sem assinatura) contam como processados por nome,
        # preservando o comportamento anterior para arquivos já concluídos.
        if "sig=" not in recorded:
            return True
        current_sig = self._signature(path)
        return current_sig != "" and f"sig={current_sig}" in recorded

    def _mark_processed(self, path: Path) -> None:
        marker = self._processed_dir / f"{path.name}.done"
        marker.write_text(
            f"processed_at={time.strftime('%Y-%m-%d %H:%M:%S')}\n"
            f"sig={self._signature(path)}\n",
            encoding="utf-8",
        )


def start_watching(config: Settings) -> None:
    """Inicia o monitoramento da pasta de gravações do OBS."""
    pipeline = MeetingPipeline(config)
    handler = RecordingHandler(pipeline, config)
    observer = Observer()

    watch_path = str(config.watch_path)
    observer.schedule(handler, watch_path, recursive=False)
    observer.start()

    logger.info("Monitorando pasta: %s", watch_path)
    logger.info("Extensoes: %s", ", ".join(config.watch_extensions))
    logger.info("Pressione Ctrl+C para parar.")

    try:
        while observer.is_alive():
            observer.join(timeout=1)
    except KeyboardInterrupt:
        logger.info("Parando monitoramento...")
    finally:
        observer.stop()
        observer.join()
        logger.info("Monitoramento encerrado.")

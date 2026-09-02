"""Transcrição via whisper.cpp (CPU ou GPU)."""

import json
import logging
import os
import re
import shutil
import subprocess
import threading
from pathlib import Path

from .cleanup import clean_segments
from .config import Settings
from .models import Transcript, TranscriptSegment
from .utils import parse_timestamp

logger = logging.getLogger(__name__)

# Nomes do executável do whisper.cpp procurados no PATH do sistema.
# Apenas nomes específicos — "main" (binário legado) é genérico demais e
# casaria com programas não relacionados (ex.: main.CPL no Windows).
_CLI_NAMES_PATH = ("whisper-cli", "whisper-cpp")
# Nomes aceitos dentro de .whisper-cpp/ no projeto, onde o contexto é claro.
# "main" ficou de fora de propósito: nas versões atuais do whisper.cpp ele é
# apenas um stub que imprime aviso de depreciação e sai com sucesso — se fosse
# aceito, a transcrição "passaria" sem produzir nada.
_CLI_NAMES_LOCAL = ("whisper-cli", "whisper-cpp")

# Linha de progresso do whisper.cpp com --print-progress:
#   whisper_print_progress_callback: progress =  45%
_PROGRESS_RE = re.compile(r"progress\s*=\s*(\d+)\s*%")

# Device Vulkan escolhido pelo whisper.cpp:
#   ggml_vulkan: 0 = AMD Radeon RX 9060 XT (AMD proprietary driver) | uma: 0 |
_VULKAN_DEVICE_RE = re.compile(r"ggml_vulkan:\s*\d+\s*=\s*([^|]+?)\s*\|")


def summarize_cli_error(stderr: str, limit: int = 300) -> str:
    """Extrai do stderr do whisper.cpp a parte que explica a falha.

    O whisper.cpp abre o stderr com um preâmbulo longo sobre os devices
    Vulkan encontrados, e a causa real ("error: input file not found", por
    exemplo) sai bem depois. Cortar os primeiros caracteres, como fazíamos,
    mostrava só o preâmbulo — um relatório de hardware no lugar do erro.
    """
    lines = [line.strip() for line in stderr.splitlines() if line.strip()]
    errors = [line for line in lines if line.lower().startswith(("error", "failed", "whisper_"))]
    relevant = errors or lines[-3:]
    message = " | ".join(relevant)
    if not message:
        return "sem saída de erro"
    return message if len(message) <= limit else message[:limit] + "..."


def resolve_whisper_cli(config: Settings) -> Path | None:
    """Localiza o executável do whisper.cpp de forma portável.

    Ordem: caminho explícito na config -> PATH do sistema -> .whisper-cpp/
    dentro do projeto (com ou sem extensão .exe).
    """
    if config.whisper_cli_path:
        p = Path(config.whisper_cli_path).expanduser()
        if p.exists():
            return p

    for name in _CLI_NAMES_PATH:
        found = shutil.which(name)
        if found:
            return Path(found)

    local_dir = Path(config.project_root) / ".whisper-cpp"
    for name in _CLI_NAMES_LOCAL:
        for candidate in (local_dir / name, local_dir / f"{name}.exe"):
            if candidate.exists():
                return candidate
    return None


def resolve_whisper_model(config: Settings) -> Path | None:
    """Localiza o modelo GGML de forma portável.

    Ordem: caminho explícito na config -> primeiro ``*.bin`` em .models/.
    """
    if config.whisper_model_path:
        p = Path(config.whisper_model_path).expanduser()
        if p.exists():
            return p

    models_dir = Path(config.project_root) / ".models"
    if models_dir.is_dir():
        # O modelo de VAD também é .bin, mas não transcreve nada.
        models = sorted(p for p in models_dir.glob("*.bin") if not is_vad_model(p))
        if models:
            return models[0]
    return None


def is_vad_model(path: Path) -> bool:
    """O Silero VAD vem como ``ggml-silero-*.bin`` — mesmo formato, outro papel."""
    return "silero" in path.name.lower() or "vad" in path.name.lower()


def resolve_vad_model(config: Settings) -> Path | None:
    """Localiza o modelo de detecção de voz, se houver.

    Ordem: caminho explícito na config -> primeiro ``ggml-silero*.bin`` em
    .models/. Sem ele, a transcrição segue sem VAD.
    """
    if config.whisper_vad_model_path:
        p = Path(config.whisper_vad_model_path).expanduser()
        if p.exists():
            return p

    models_dir = Path(config.project_root) / ".models"
    if models_dir.is_dir():
        candidates = sorted(p for p in models_dir.glob("*.bin") if is_vad_model(p))
        if candidates:
            return candidates[0]
    return None


class WhisperTranscriber:
    """Transcreve áudio com Whisper.

    Dois backends, escolhidos por ``config.whisper_backend``:
      - ``cpp``: whisper.cpp (binário; mais rápido com GPU)
      - ``openai``: openai-whisper (Python puro; baixa o modelo sozinho)
      - ``auto`` (padrão): usa whisper.cpp se encontrado, senão openai-whisper.
    """

    def __init__(self, config: Settings):
        self.config = config
        # Cache do modelo openai-whisper em memória — evita recarregar o
        # modelo do disco (segundos a dezenas de segundos) a cada reunião.
        self._openai_model = None
        self._openai_model_key: tuple[str, str | None] | None = None

    def _resolve_device(self) -> str | None:
        """Device do Whisper. 'auto'/'' => None (deixa a lib decidir)."""
        dev = (self.config.whisper_device or "auto").lower().strip()
        return None if dev in ("auto", "") else dev

    def _resolve_threads(self) -> int:
        """Threads do whisper.cpp: config explícita ou todos os núcleos."""
        configured = self.config.whisper_threads
        if configured and configured > 0:
            return configured
        return os.cpu_count() or 4

    def transcribe(self, audio_path: Path, progress_callback=None) -> Transcript:
        """Transcreve um arquivo de áudio escolhendo o backend disponível."""
        backend = (self.config.whisper_backend or "auto").lower()
        cli = resolve_whisper_cli(self.config)

        if backend == "openai":
            return self._transcribe_openai(audio_path, progress_callback)
        if backend == "cpp":
            return self._transcribe_cpp(audio_path, progress_callback)

        # auto: whisper.cpp se disponível, senão openai-whisper
        if cli is not None and resolve_whisper_model(self.config) is not None:
            return self._transcribe_cpp(audio_path, progress_callback)
        logger.info("whisper.cpp nao encontrado; usando openai-whisper (pip).")
        return self._transcribe_openai(audio_path, progress_callback)

    # -- Backend: openai-whisper (Python puro) -------------------------------

    def _transcribe_openai(self, audio_path: Path, progress_callback=None) -> Transcript:
        try:
            import whisper  # openai-whisper
        except ImportError as e:
            raise RuntimeError(
                "openai-whisper não instalado. Rode: pip install -r requirements.txt"
            ) from e

        if progress_callback:
            progress_callback(5, f"Carregando modelo {self.config.whisper_model}...")

        device = self._resolve_device()
        key = (self.config.whisper_model, device)
        if self._openai_model is not None and self._openai_model_key == key:
            model = self._openai_model  # reaproveita o modelo já em memória
            logger.info(
                "Transcrevendo %s com openai-whisper (modelo=%s, cache)...",
                audio_path.name, self.config.whisper_model,
            )
        else:
            logger.info(
                "Carregando openai-whisper (modelo=%s, device=%s)...",
                self.config.whisper_model, device or "auto",
            )
            model = whisper.load_model(self.config.whisper_model, device=device)
            self._openai_model = model
            self._openai_model_key = key
        if progress_callback:
            progress_callback(15, "Transcrevendo áudio...")

        result = model.transcribe(
            str(audio_path),
            language=self.config.whisper_language,
            initial_prompt=self.config.whisper_initial_prompt or None,
        )

        segments = []
        for seg in result.get("segments", []):
            text = (seg.get("text") or "").strip()
            if text:
                segments.append(
                    TranscriptSegment(
                        start=float(seg.get("start", 0.0)),
                        end=float(seg.get("end", 0.0)),
                        text=text,
                    )
                )

        return self._finish(segments, progress_callback)

    def _finish(self, segments: list[TranscriptSegment], progress_callback=None) -> Transcript:
        """Fecha a transcrição: limpa alucinações e monta o Transcript."""
        segments, report = clean_segments(segments)
        if report.total:
            logger.info("Limpeza da transcrição: %s", report.describe())

        duration = segments[-1].end if segments else 0.0
        full_text = " ".join(seg.text for seg in segments)
        if progress_callback:
            detalhe = f"{len(segments)} segmentos, {duration/60:.1f} min"
            if report.total:
                detalhe += f" · {report.describe()}"
            progress_callback(100, detalhe)
        logger.info(
            "Transcrição concluída: %d segmentos, %.1f minutos.",
            len(segments),
            duration / 60,
        )
        return Transcript(
            segments=segments,
            full_text=full_text,
            language=self.config.whisper_language,
            duration=duration,
        )

    # -- Backend: whisper.cpp (binário) --------------------------------------

    def _run_whisper_cli(
        self, cmd: list[str], audio_path: Path, progress_callback=None
    ) -> tuple[str, str]:
        """Executa o whisper-cli lendo o progresso do stderr em tempo real.

        O JSON com os segmentos sai inteiro no stdout no fim; o stderr traz
        ``progress = NN%`` durante a execução. Por isso os dois fluxos são
        lidos separadamente, em vez de um ``subprocess.run`` que só entrega
        tudo no final.

        Returns:
            (stdout, stderr) do processo.
        """
        timeout = self.config.whisper_timeout
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

        stderr_parts: list[str] = []

        def pump_stderr() -> None:
            for line in proc.stderr:
                stderr_parts.append(line)

                device = _VULKAN_DEVICE_RE.search(line)
                if device:
                    # Deixa explícito onde a transcrição está rodando: sem isso,
                    # cair para CPU passa despercebido e só aparece como lentidão.
                    logger.info("whisper.cpp usando GPU: %s", device.group(1))
                    if progress_callback:
                        progress_callback(10, f"GPU: {device.group(1)}")

                match = _PROGRESS_RE.search(line)
                if match and progress_callback:
                    # 10-99: a faixa abaixo de 10 é o carregamento do modelo e
                    # 100 só é reportado quando os segmentos estão prontos.
                    pct = int(match.group(1))
                    progress_callback(
                        min(99, 10 + int(pct * 0.89)), "Transcrevendo áudio..."
                    )

        reader = threading.Thread(target=pump_stderr, daemon=True)
        reader.start()

        # Watchdog: um whisper travado congelaria a leitura do stdout para
        # sempre, e com ela o worker inteiro.
        timed_out = threading.Event()

        def on_timeout() -> None:
            timed_out.set()
            proc.kill()

        killer = threading.Timer(timeout, on_timeout)
        killer.daemon = True
        killer.start()
        try:
            stdout = proc.stdout.read()
            returncode = proc.wait()
        finally:
            killer.cancel()
            reader.join(timeout=5)
            proc.stdout.close()
            proc.stderr.close()

        stderr = "".join(stderr_parts)

        if returncode != 0:
            if timed_out.is_set():
                logger.error(
                    "whisper-cli excedeu o tempo limite (%.0fs) em %s",
                    timeout,
                    audio_path.name,
                )
                raise RuntimeError(
                    f"Transcrição excedeu o tempo limite ({timeout:.0f}s) "
                    f"em {audio_path.name}."
                )
            logger.error("Erro no whisper-cli: %s", stderr[-2000:])
            raise RuntimeError(f"whisper-cli falhou: {summarize_cli_error(stderr)}")

        return stdout, stderr

    def _transcribe_cpp(self, audio_path: Path, progress_callback=None) -> Transcript:
        cli = resolve_whisper_cli(self.config)
        if cli is None:
            raise RuntimeError(
                "Executável do whisper.cpp não encontrado. Instale o whisper.cpp "
                "e deixe-o no PATH, coloque o binário em .whisper-cpp/, ou defina "
                "whisper_cli_path no config.yaml (ou a env MEETING_WHISPER_CLI_PATH). "
                "Alternativa sem build: use whisper_backend=openai."
            )
        model = resolve_whisper_model(self.config)
        if model is None:
            raise RuntimeError(
                "Modelo do Whisper (.bin) não encontrado. Baixe um modelo GGML para "
                ".models/, ou defina whisper_model_path no config.yaml "
                "(ou a env MEETING_WHISPER_MODEL_PATH)."
            )

        if progress_callback:
            progress_callback(5, "Iniciando whisper.cpp...")

        logger.info("Transcrevendo %s com whisper.cpp...", audio_path.name)

        # whisper-cli com saída JSON para pegar timestamps
        cmd = [
            str(cli),
            "-m", str(model),
            "-f", str(audio_path),
            "-l", self.config.whisper_language,
            "-oj",          # output JSON
            "--no-prints",  # sem logs extras no stdout
        ]
        # Sem -t explícito o whisper.cpp fica em 4 threads, independentemente
        # do tamanho da CPU.
        cmd += ["-t", str(self._resolve_threads())]
        # whisper.cpp usa a GPU automaticamente quando o binário tem suporte.
        # device=cpu força o uso de CPU explicitamente.
        if self._resolve_device() == "cpu":
            cmd.append("--no-gpu")
        # VAD: o modelo só vê os trechos com fala. Sem isso, no silêncio de uma
        # sala esperando gente entrar ele inventa "Tchau." quinze vezes.
        vad_model = resolve_vad_model(self.config) if self.config.whisper_vad else None
        if vad_model is not None:
            cmd += ["--vad", "--vad-model", str(vad_model)]
            logger.info("VAD ligado: %s", vad_model.name)
        elif self.config.whisper_vad:
            logger.info("VAD pedido mas sem modelo Silero em .models/; seguindo sem VAD.")
        if self.config.whisper_suppress_nst:
            cmd.append("--suppress-nst")
        if progress_callback:
            # Progresso real da etapa mais longa do pipeline, em vez de uma
            # barra parada do começo ao fim.
            cmd.append("--print-progress")

        if progress_callback:
            progress_callback(10, "Transcrevendo áudio...")

        stdout, stderr = self._run_whisper_cli(cmd, audio_path, progress_callback)

        # Parse JSON output
        try:
            data = json.loads(stdout)
        except json.JSONDecodeError:
            # Fallback: tentar encontrar o arquivo JSON gerado
            json_path = audio_path.with_suffix(".wav.json")
            if json_path.exists():
                data = json.loads(json_path.read_text(encoding="utf-8"))
                json_path.unlink()
            else:
                raise RuntimeError(
                    "whisper-cli nao gerou saida JSON valida: "
                    f"{summarize_cli_error(stderr)}"
                ) from None

        # Extrair segmentos
        segments = []
        for seg in data.get("transcription", []):
            t0 = parse_timestamp(seg.get("timestamps", {}).get("from", "00:00:00"))
            t1 = parse_timestamp(seg.get("timestamps", {}).get("to", "00:00:00"))
            text = seg.get("text", "").strip()
            if text:
                segments.append(TranscriptSegment(start=t0, end=t1, text=text))

        return self._finish(segments, progress_callback)

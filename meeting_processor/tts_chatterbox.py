"""Voz do assistente com o Chatterbox Multilingual V3 (pack pt-BR), offline.

O Chatterbox é um TTS aberto da Resemble AI, 0,5B parâmetros, com prosódia de
fala de verdade — e o pack ``ResembleAI/Chatterbox-Multilingual-pt-br`` é o
ajuste fino só para português do Brasil. Roda na máquina, sem internet e sem
chave; em troca, pesa ~3 GB e, em CPU, leva alguns segundos por frase.

Este módulo roda **no venv próprio do TTS** (``.venv-tts``), porque o
Chatterbox fixa versões de torch e transformers diferentes das do motor de
transcrição. Ele não importa nada do resto do ``meeting_processor``.

Dois modos:

- ``--serve``: carrega o modelo uma vez e atende pedidos por stdin, um JSON
  por linha (``{"id", "text", "out", "ref", "exaggeration", "cfg"}``),
  respondendo um JSON por linha no stdout. É como o app usa — carregar 3 GB a
  cada frase seria inviável.
- sem ``--serve``: sintetiza um texto e sai (útil para testar na mão).

A pasta do modelo (``--model-dir``) é a que o download deixou: o pack pt-BR
tem nomes de arquivo diferentes dos que a biblioteca espera, então uma
subpasta ``ready/`` é montada com links (ou cópias) nos nomes certos.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

# Arquivos como a biblioteca espera → arquivo como o download entregou.
READY_LAYOUT = {
    "t3_mtl23ls_v3.safetensors": "t3_pt_br.safetensors",
    "s3gen.pt": "s3gen_v3.pt",
    "ve.pt": "ve.pt",
    "conds.pt": "conds.pt",
    "grapheme_mtl_merged_expanded_v1.json": "grapheme_mtl_merged_expanded_v1.json",
    "Cangjie5_TC.json": "Cangjie5_TC.json",
}
OPTIONAL = {"Cangjie5_TC.json", "conds.pt"}

# Frases longas demais estouram o modelo; cortamos em sentenças e emendamos.
MAX_CHUNK_CHARS = 280
_SENTENCE_RE = re.compile(r"(?<=[.!?…])\s+")


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def prepare_ready_dir(model_dir: Path) -> Path:
    """Monta ``model_dir/ready`` com os nomes que ``from_local`` procura."""
    ready = model_dir / "ready"
    ready.mkdir(exist_ok=True)
    for wanted, source in READY_LAYOUT.items():
        dest = ready / wanted
        src = model_dir / source
        if dest.exists():
            continue
        if not src.exists():
            if wanted in OPTIONAL:
                continue
            raise FileNotFoundError(f"Falta {source} em {model_dir}")
        try:
            os.link(src, dest)          # mesmo disco: sem duplicar 3 GB
        except OSError:
            shutil.copyfile(src, dest)  # outro volume ou sem permissão de link
    return ready


def split_text(text: str, limit: int = MAX_CHUNK_CHARS) -> list[str]:
    """Sentenças agrupadas até ``limit`` caracteres; uma sentença enorme vai inteira."""
    sentences = [s.strip() for s in _SENTENCE_RE.split(text.strip()) if s.strip()]
    chunks: list[str] = []
    atual = ""
    for s in sentences:
        if atual and len(atual) + 1 + len(s) > limit:
            chunks.append(atual)
            atual = s
        else:
            atual = f"{atual} {s}".strip()
    if atual:
        chunks.append(atual)
    return chunks


# Buffers determinísticos do tokenizador de áudio (filtros mel e janela) que o
# s3gen do pack pt-BR não traz. O S3Gen os recria no __init__; só eles podem faltar.
S3GEN_OPTIONAL_KEYS = frozenset({"tokenizer._mel_filters", "tokenizer.window"})


def load_model(ready: Path, device: str = "cpu"):
    """Monta o ChatterboxMultilingualTTS a partir de ``ready/``.

    Espelha o ``from_local`` da biblioteca, com uma diferença: o ``s3gen_v3.pt``
    do pack pt-BR vem sem dois buffers determinísticos do tokenizador, e o
    carregamento estrito da biblioteca recusa o arquivo. Aqui esses dois podem
    faltar — qualquer outra chave ausente ou sobrando continua sendo erro.
    """
    import torch
    from chatterbox.mtl_tts import (
        ChatterboxMultilingualTTS,
        Conditionals,
        MTLTokenizer,
        S3Gen,
        T3,
        T3Config,
        VoiceEncoder,
        load_safetensors,
    )

    map_location = torch.device("cpu") if device in ("cpu", "mps") else None

    ve = VoiceEncoder()
    ve.load_state_dict(torch.load(ready / "ve.pt", map_location=map_location, weights_only=True))
    ve.to(device).eval()

    t3 = T3(T3Config.multilingual())
    t3_state = load_safetensors(ready / "t3_mtl23ls_v3.safetensors")
    if "model" in t3_state:
        t3_state = t3_state["model"][0]
    t3.load_state_dict(t3_state)
    t3.to(device).eval()

    s3gen = S3Gen()
    s3gen_state = torch.load(ready / "s3gen.pt", map_location=map_location, weights_only=True)
    result = s3gen.load_state_dict(s3gen_state, strict=False)
    inesperadas = set(result.missing_keys) - S3GEN_OPTIONAL_KEYS
    if inesperadas or result.unexpected_keys:
        raise RuntimeError(
            f"s3gen incompatível: faltam {sorted(inesperadas)}, sobram {sorted(result.unexpected_keys)}"
        )
    s3gen.to(device).eval()

    tokenizer = MTLTokenizer(str(ready / "grapheme_mtl_merged_expanded_v1.json"))

    conds = None
    builtin_voice = ready / "conds.pt"
    if builtin_voice.exists():
        conds = Conditionals.load(builtin_voice, map_location=map_location).to(device)

    return ChatterboxMultilingualTTS(t3, s3gen, ve, tokenizer, device, conds=conds)


class Speaker:
    """O modelo carregado, pronto para falar quantas vezes precisar."""

    def __init__(self, model_dir: Path, device: str = "cpu", threads: int | None = None):
        import torch

        # Metade dos processadores lógicos ≈ núcleos físicos: com SMT, 8 threads
        # geraram 30% mais rápido que 16 nesta classe de CPU.
        torch.set_num_threads(threads or max(1, (os.cpu_count() or 8) // 2))
        ready = prepare_ready_dir(model_dir)
        t0 = time.time()
        self.model = load_model(ready, device)
        self.load_seconds = time.time() - t0
        self.torch = torch

    def speak(
        self,
        text: str,
        out: Path,
        ref: str | None = None,
        exaggeration: float = 0.5,
        cfg: float = 0.5,
    ) -> float:
        import torchaudio

        t0 = time.time()
        partes = []
        for chunk in split_text(text) or [text]:
            kwargs = {"language_id": "pt", "exaggeration": exaggeration, "cfg_weight": cfg}
            if ref:
                kwargs["audio_prompt_path"] = ref
            partes.append(self.model.generate(chunk, **kwargs))
        wav = self.torch.cat(partes, dim=-1) if len(partes) > 1 else partes[0]
        torchaudio.save(str(out), wav, self.model.sr)
        return time.time() - t0


def serve(speaker: Speaker) -> None:
    emit({"event": "ready", "load_seconds": round(speaker.load_seconds, 1), "sr": speaker.model.sr})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            emit({"ok": False, "message": "pedido não é JSON"})
            continue
        try:
            seconds = speaker.speak(
                req["text"], Path(req["out"]), req.get("ref") or None,
                float(req.get("exaggeration", 0.5)), float(req.get("cfg", 0.5)),
            )
            emit({"id": req.get("id"), "ok": True, "out": req["out"], "seconds": round(seconds, 1)})
        except Exception as err:  # noqa: BLE001 — o worker não pode morrer por um pedido
            emit({"id": req.get("id"), "ok": False, "message": f"{type(err).__name__}: {err}"})


def download(model_dir: Path) -> None:
    """Baixa o pack pt-BR e os arquivos auxiliares do repositório principal (~3,2 GB)."""
    from huggingface_hub import hf_hub_download, snapshot_download

    model_dir.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        "ResembleAI/Chatterbox-Multilingual-pt-br",
        local_dir=str(model_dir),
        allow_patterns=["t3_pt_br.safetensors", "s3gen_v3.pt", "grapheme_mtl_merged_expanded_v1.json", "README.md"],
    )
    # Codificador de voz, voz padrão e tabela de caracteres: só existem no repositório principal.
    for name in ("ve.pt", "conds.pt", "Cangjie5_TC.json"):
        hf_hub_download("ResembleAI/chatterbox", name, local_dir=str(model_dir))
    emit({"event": "downloaded", "model_dir": str(model_dir)})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Chatterbox pt-BR: texto → fala, offline.")
    parser.add_argument("--model-dir", required=True, help="pasta com os pesos baixados")
    parser.add_argument("--download", action="store_true", help="baixa os pesos para --model-dir e sai")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--threads", type=int, default=0)
    parser.add_argument("--serve", action="store_true", help="atende pedidos por stdin (JSON por linha)")
    parser.add_argument("--text-file", help="texto a falar (modo único)")
    parser.add_argument("--out", help="WAV de saída (modo único)")
    parser.add_argument("--ref", default="", help="WAV de referência para clonar a voz")
    parser.add_argument("--exaggeration", type=float, default=0.5)
    parser.add_argument("--cfg", type=float, default=0.5)
    args = parser.parse_args(argv)

    if args.download:
        download(Path(args.model_dir))
        return 0

    try:
        speaker = Speaker(Path(args.model_dir), args.device, args.threads or None)
    except Exception as err:  # noqa: BLE001
        emit({"event": "error", "message": f"não deu para carregar o Chatterbox: {type(err).__name__}: {err}"})
        return 2

    if args.serve:
        serve(speaker)
        return 0

    if not args.text_file or not args.out:
        parser.error("sem --serve, informe --text-file e --out")
    text = Path(args.text_file).read_text(encoding="utf-8")
    seconds = speaker.speak(text, Path(args.out), args.ref or None, args.exaggeration, args.cfg)
    emit({"ok": True, "out": args.out, "seconds": round(seconds, 1), "load_seconds": round(speaker.load_seconds, 1)})
    return 0


if __name__ == "__main__":
    sys.exit(main())

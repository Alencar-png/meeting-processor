#!/usr/bin/env bash
# ============================================================
# Meeting Processor - inicia o watcher (monitora a pasta do OBS)
# Equivalente Linux/macOS de start_watcher.bat
# ============================================================
set -e
cd "$(dirname "$0")"

if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "[ERRO] ffmpeg nao encontrado no PATH."
    echo "Instale:  macOS 'brew install ffmpeg'  |  Linux 'sudo apt install ffmpeg'"
    exit 1
fi

exec python3 -m meeting_processor watch

#!/usr/bin/env sh
# Garante o modelo GGML em $MODELS_DIR e chama o motor de transcrição.
#
# O modelo (dezenas a centenas de MB) não vai na imagem: é baixado uma vez
# para o volume /models e reaproveitado em todas as execuções seguintes.
set -eu

MODEL="${WHISPER_MODEL:-small}"
MODELS_DIR="${MODELS_DIR:-/models}"
MODEL_PATH="${MODELS_DIR}/ggml-${MODEL}.bin"
BASE_URL="${WHISPER_MODEL_BASE_URL:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main}"

# Só a transcrição precisa do modelo — `--help` e afins não devem gastar
# minutos baixando centenas de MB.
case "${1:-}" in
    transcribe) ;;
    *) exec python -m meeting_processor "$@" ;;
esac

mkdir -p "${MODELS_DIR}"

if [ ! -f "${MODEL_PATH}" ]; then
    # stderr: no modo --json o stdout carrega só os eventos JSONL.
    echo "Baixando modelo Whisper '${MODEL}' (primeira execucao)..." >&2
    # Baixa para .part e só renomeia no fim — um download interrompido não
    # deixa um .bin truncado que quebraria todas as execuções seguintes.
    if ! curl -fsSL --retry 3 -o "${MODEL_PATH}.part" "${BASE_URL}/ggml-${MODEL}.bin"; then
        rm -f "${MODEL_PATH}.part"
        echo "Falha ao baixar o modelo '${MODEL}'. Verifique a conexao." >&2
        exit 1
    fi
    mv "${MODEL_PATH}.part" "${MODEL_PATH}"
    echo "Modelo salvo em ${MODEL_PATH}" >&2
fi

export MEETING_WHISPER_MODEL_PATH="${MODEL_PATH}"
export MEETING_WHISPER_MODEL="${MODEL}"

exec python -m meeting_processor "$@"

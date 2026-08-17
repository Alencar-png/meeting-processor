# Meeting Processor — imagem de transcrição (CPU).
#
# Estágio 1 compila o whisper.cpp estaticamente; estágio 2 leva só o binário,
# o ffmpeg e o pacote Python. Resultado: imagem pequena (~500 MB) e sem torch.
# O modelo GGML é baixado no primeiro uso para o volume montado em /models.

# ---------------------------------------------------------------------------
# 1. Build do whisper.cpp
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS whisper-build

ARG WHISPER_CPP_VERSION=v1.7.4

RUN apt-get update && apt-get install -y --no-install-recommends \
        git build-essential cmake ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 --branch "${WHISPER_CPP_VERSION}" \
        https://github.com/ggml-org/whisper.cpp.git .

# BUILD_SHARED_LIBS=OFF: o binário fica autocontido e a cópia para o estágio
# final não precisa perseguir .so espalhados pela árvore de build.
RUN cmake -B build \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF \
        -DWHISPER_BUILD_TESTS=OFF \
        -DWHISPER_BUILD_SERVER=OFF \
    && cmake --build build --config Release -j "$(nproc)" --target whisper-cli

# ---------------------------------------------------------------------------
# 2. Runtime
# ---------------------------------------------------------------------------
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg curl ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=whisper-build /src/build/bin/whisper-cli /usr/local/bin/whisper-cli

WORKDIR /app

# Instalação editável com o pacote ainda vazio: a camada pesada (dependências)
# fica em cache e mudar o código depois não dispara um novo pip install.
COPY pyproject.toml README.md ./
RUN mkdir -p meeting_processor && touch meeting_processor/__init__.py \
    && pip install --no-cache-dir -e .

COPY meeting_processor/ ./meeting_processor/
COPY config.yaml ./
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Backend fixo: dentro do container é sempre whisper.cpp.
ENV MEETING_WHISPER_BACKEND=cpp \
    MEETING_WHISPER_CLI_PATH=/usr/local/bin/whisper-cli \
    MEETING_WHISPER_LANGUAGE=pt \
    WHISPER_MODEL=small \
    MODELS_DIR=/models \
    PYTHONUNBUFFERED=1

VOLUME ["/models"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["--help"]

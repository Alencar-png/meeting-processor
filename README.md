# Meeting Processor

> Transforma gravações de reuniões em **transcrição**, **resumo**, **tarefas**
> e **Kanban** — rodando **100% na sua máquina** (Windows, macOS ou Linux).

[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue.svg)](https://www.python.org/)
[![License MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## O que ele faz

1. Você grava a reunião (OBS ou qualquer vídeo).
2. Ele **extrai o áudio** (ffmpeg) e **transcreve** (Whisper).
3. Opcionalmente **resume** com uma LLM (Claude API ou Ollama local) e gera
   nota, lista de tarefas e quadro Kanban.
4. O resultado são arquivos Markdown em `vault/` — leia com o Obsidian ou
   qualquer editor de texto.

Você escolhe **quais etapas rodar** — pode usar só a transcrição, por exemplo.

---

## Instalação — passo a passo

Funciona igual nos três sistemas. Onde o comando muda, há uma linha para cada SO.

### Passo 1 — Instale o Python 3.11+

Confira se já tem:

```bash
python --version      # Windows
python3 --version     # macOS / Linux
```

Se não tiver, baixe em <https://www.python.org/downloads/> (no Windows, marque
**"Add Python to PATH"** durante a instalação).

### Passo 2 — Instale o ffmpeg

| Sistema | Comando |
|---------|---------|
| Windows | `winget install Gyan.FFmpeg` |
| macOS   | `brew install ffmpeg` |
| Linux   | `sudo apt install ffmpeg` |

Confira: `ffmpeg -version`

### Passo 3 — Baixe o projeto e instale as dependências

```bash
git clone https://github.com/Alencar-png/meeting-processor.git
cd meeting-processor
```

Crie o ambiente virtual e instale:

**Windows (PowerShell):**
```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

**macOS / Linux:**
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

> Pronto para transcrever. O Whisper roda direto via `pip` (baixa o modelo
> sozinho na primeira vez). Para resumos com IA, faça o passo 4.

### Passo 4 *(opcional)* — Ative o resumo com IA

Primeiro copie o `.env.example` para `.env`
(`copy .env.example .env` no Windows, `cp .env.example .env` no macOS/Linux).
Depois escolha **um** provedor e preencha a chave no `.env`:

| Provedor | `MEETING_LLM_PROVIDER` | Chave no `.env` | Onde obter |
|----------|------------------------|-----------------|------------|
| **Claude** | `anthropic` | `ANTHROPIC_API_KEY` | <https://console.anthropic.com/> |
| **OpenAI** | `openai` | `OPENAI_API_KEY` | <https://platform.openai.com/> |
| **Gemini** | `gemini` | `GEMINI_API_KEY` | <https://aistudio.google.com/apikey> |
| **Ollama (local, grátis)** | `local` | — | <https://ollama.com/download> |
| **Sem IA (só transcrição)** | `none` | — | não precisa de nada |

Exemplo (OpenAI):
```dotenv
MEETING_LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
# MEETING_OPENAI_MODEL=gpt-4o
```

Para **Ollama**, instale e baixe um modelo (`ollama pull qwen2.5:14b`), depois
use `MEETING_LLM_PROVIDER=local`.

> Sem o passo 4, o sistema funciona em **modo só transcrição**.

**Qualquer outro modelo do mercado** — o provedor `openai` aceita qualquer
serviço compatível com a API da OpenAI: basta trocar `MEETING_OPENAI_BASE_URL`.

| Serviço | Base URL | Exemplo de modelo |
|---------|----------|-------------------|
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-4o`, `anthropic/claude-3.5-sonnet` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| xAI (Grok) | `https://api.x.ai/v1` | `grok-2-latest` |

---

## Como usar

### App desktop — solte o vídeo e pronto

Clique duas vezes em **`Meeting Processor (sem console).vbs`** na raiz do
projeto. Na primeira vez ele instala as dependências do app; depois abre
direto, sem janela de console. O **`Meeting Processor.bat`** faz o mesmo
mostrando as mensagens, útil quando algo dá errado.

Pela linha de comando:

```bash
cd desktop && npm install && npm start
```

Arraste um vídeo para a janela: ele transcreve e grava `.md` e `.txt` na pasta
que você escolher. Dois motores, alternáveis na própria janela:

- **GPU** (padrão) — whisper.cpp com Vulkan; ~11x mais rápido que tempo real
  numa Radeon RX 9060 XT. Uma reunião de 1 h sai em ~5 min.
- **Docker** — container CPU-only, para quando não há GPU disponível.

Detalhes e como compilar o whisper.cpp com Vulkan em
[`desktop/README.md`](desktop/README.md).

### Linha de comando

```bash
# Processa um arquivo já gravado
python -m meeting_processor process reuniao.mkv

# Apenas transcrever (sem resumo/nota/kanban/wiki)
python -m meeting_processor process reuniao.mkv --only-transcribe

# Desligar etapas específicas
python -m meeting_processor process reuniao.mkv --no-kanban --no-wiki

# Só transcrever, gravando numa pasta qualquer (fora do vault).
# Cria ./saida/<nome>/ com a transcrição e o meeting.json (metadados).
python -m meeting_processor transcribe reuniao.mkv --output-dir ./saida --formats md,txt
python -m meeting_processor transcribe reuniao.mkv --output-dir ./saida --name "Reuniao com o cliente"

# Monitorar a pasta do OBS continuamente
python -m meeting_processor watch

# Reindexar no SQLite as reuniões já existentes no vault
python -m meeting_processor reindex
```

### Atalhos prontos

| Sistema | Monitorar |
|---------|-----------|
| Windows | `start_watcher.bat` (ou `start_watcher_silent.vbs`, sem janela) |
| macOS/Linux | `./start_watcher.sh` |

*(no macOS/Linux, rode uma vez `chmod +x start_watcher.sh`)*

### Acompanhar o processamento

O progresso vai para o console e para `meeting_processor.log`. O estado de
cada job também fica na tabela `jobs` do SQLite (`meeting_processor.db`):

```bash
sqlite3 meeting_processor.db \
  "SELECT file, status, stage, progress, detail FROM jobs ORDER BY id DESC LIMIT 10;"
```

---

## Onde fica o resultado

Cada reunião vira uma pasta em `vault/wiki/reunioes/<data hora - nome>/` com:

- `Transcricao - *.md` — transcrição com timestamps (sempre);
- `Resumo - *.md` — resumo executivo + por blocos (se o resumo estiver ligado);
- `Tarefas - *.md` — quadro Kanban (se ligado);
- nota central que liga tudo no grafo do Obsidian.

Abra a pasta `vault/` como **vault do Obsidian** ou leia os arquivos com
qualquer editor de Markdown.

---

## Escolher o que rodar

Áudio e transcrição **sempre** rodam. As demais são opcionais e podem ser
ligadas/desligadas pelo `config.yaml` ou por variável de ambiente:

| Etapa | config.yaml | Variável de ambiente | Depende de |
|-------|-------------|----------------------|------------|
| Resumo (LLM) | `enable_summary` | `MEETING_ENABLE_SUMMARY` | — |
| Nota Obsidian | `enable_note` | `MEETING_ENABLE_NOTE` | Resumo |
| Kanban | `enable_kanban` | `MEETING_ENABLE_KANBAN` | Resumo |
| Wiki | `enable_wiki` | `MEETING_ENABLE_WIKI` | Resumo |

Desligar o **Resumo** equivale ao modo "só transcrição".

---

## Acelerar com GPU (opcional)

O backend padrão (`openai-whisper`) é simples e funciona em qualquer máquina,
mas é lento sem GPU. Para máxima velocidade, use o **whisper.cpp**:

1. Coloque o `whisper-cli` em `.whisper-cpp/` (ou deixe no PATH). Os binários
   oficiais em <https://github.com/ggml-org/whisper.cpp/releases> cobrem CPU e
   NVIDIA; para **GPU AMD ou Intel**, compile com Vulkan — passo a passo em
   [`desktop/README.md`](desktop/README.md).
2. Baixe um modelo GGML em
   <https://huggingface.co/ggerganov/whisper.cpp/tree/main> para `.models/`.
   `ggml-large-v3-turbo.bin` é o melhor equilíbrio.
3. No `config.yaml`: `whisper_backend: "cpp"` (ou deixe `"auto"`, que usa o
   whisper.cpp automaticamente quando ele está presente).

O log diz qual dispositivo está em uso (`whisper.cpp usando GPU: …`). Sem essa
linha, a transcrição está na CPU.

Referência medida numa Radeon RX 9060 XT, `large-v3-turbo`, áudio de 5 min:

| Execução | Tempo |
|----------|-------|
| GPU (Vulkan) | 27 s |
| CPU, 16 threads | 153 s |
| CPU, 4 threads (padrão do whisper.cpp) | ~10 min |

Por padrão o whisper.cpp usa só 4 threads; o projeto agora passa todos os
núcleos (ajustável em `whisper_threads` no `config.yaml`).

---

## Solução de problemas

| Sintoma | O que fazer |
|---------|-------------|
| `ffmpeg não encontrado no PATH` | Refaça o **Passo 2** e reabra o terminal |
| Transcrição muito lenta | Use um modelo menor (`whisper_model: "base"`) ou whisper.cpp com GPU |
| `Chave da API Anthropic inválida` | Confira `ANTHROPIC_API_KEY` no `.env` |
| `Não foi possível conectar ao Ollama` | Inicie o Ollama (`ollama serve`) |
| `Ollama respondeu 404` | Baixe o modelo: `ollama pull qwen2.5:14b` |
| Nenhuma reunião é detectada | Confira `watch_dir` no `config.yaml` e se há vídeos na pasta |

Logs detalhados ficam em `meeting_processor.log`.

---

## Para desenvolvedores

```bash
python -m pytest -q          # roda os testes (sem rede)
```

Estrutura principal:

```
meeting_processor/
├── __main__.py        # CLI (watch / process / transcribe / reindex)
├── config.py          # configuração (YAML + .env)
├── audio.py           # extração de áudio (ffmpeg)
├── transcriber.py     # Whisper (openai-whisper / whisper.cpp)
├── summarizer.py      # resumo (Claude / OpenAI / Gemini / Ollama)
├── note_generator.py  # notas Markdown para Obsidian
├── kanban.py          # quadros Kanban
├── pipeline.py        # orquestra as etapas escolhidas
├── watcher.py         # monitora a pasta do OBS
├── progress.py        # progresso dos jobs (log + fila no SQLite)
├── events.py          # eventos JSONL consumidos pelo app desktop
├── media_info.py      # data da gravação e duração (ffprobe)
├── transcript_export.py  # grava .md/.txt + meeting.json na pasta da reunião
├── db.py              # estado estruturado (SQLite)
├── vault_index.py     # leitura das reuniões já gravadas no vault
└── utils.py           # helpers compartilhados

desktop/               # app Electron (drag-and-drop → container → arquivos)
Dockerfile             # imagem de transcrição (whisper.cpp + ffmpeg, CPU)
```

Documentos extras: [`docs/obsidian.md`](docs/obsidian.md),
[`docs/llm-local.md`](docs/llm-local.md).

---

## Licença

MIT — veja [`LICENSE`](LICENSE).

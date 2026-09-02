# Synapse

> Grave a reunião — ou solte o vídeo na janela — e receba **transcrição**,
> **tarefas no Kanban** e **documentos**, organizados por projeto.
> Roda **na sua máquina**: nada de áudio sai dela.

[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue.svg)](https://www.python.org/)
[![Node 20+](https://img.shields.io/badge/node-20%2B-green.svg)](https://nodejs.org/)
[![License MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## O que ele faz

1. Você grava pela janela do app, ou solta um vídeo/áudio nela.
2. O **ffmpeg** extrai o áudio e o **Whisper** transcreve — local, na GPU.
3. O Claude lê a transcrição **uma vez** e devolve a análise da reunião:
   visão geral, decisões, riscos e as **ações combinadas**.
4. Dessa análise saem, juntos, os cards no Kanban do projeto e um **documento
   em PDF** na pasta da reunião — a tabela de tarefas do PDF é a mesma lista
   dos cards.

Cards e documento são opcionais: em **Configurações → Depois da transcrição**
cada um liga e desliga sozinho, e o prompt da análise pode ser visto e editado
ali mesmo. Enquanto a reunião processa, a tela de
trabalho pode ser **minimizada** — o progresso segue num chip na barra lateral
e o app fica livre para uso.

O centro é o **projeto**: cada um tem seu Kanban, suas reuniões, seus
documentos, um texto de contexto que orienta o tom do que é gerado — e um
**chat**, que é o Claude Code rodando com tudo isso à mão. Dê ao projeto uma
**pasta de trabalho** (um repositório, uma pasta de documentos): o app cria
`synapse/` lá dentro e passa a guardar as reuniões do projeto nela, e o chat
passa a trabalhar nessa pasta. Ligue o **modo autônomo** e ele age na máquina
sem pedir a cada passo; desligado, só lê e pesquisa. Dá para **falar** com ele:
o microfone do chat transcreve na GPU e, com o modo Voz ligado, a resposta é
lida em voz alta com uma voz neural (ou a do sistema, offline).

---

## Abrir e rodar

### Passo 1 — Requisitos

| O quê | Para quê | Como instalar |
|-------|----------|---------------|
| **Node.js 20+** | abrir o app | `winget install OpenJS.NodeJS.LTS` |
| **Python 3.11+** | motor de transcrição | <https://www.python.org/downloads/> (marque *Add to PATH*) |
| **ffmpeg** | extrair o áudio | `winget install Gyan.FFmpeg` · `brew install ffmpeg` · `apt install ffmpeg` |
| **Claude Code** | tarefas e documentos | <https://claude.com/claude-code> |

### Passo 2 — Instale as dependências do Python

```bash
git clone https://github.com/Alencar-png/meeting-processor.git
cd meeting-processor
python -m venv .venv
```

```powershell
.venv\Scripts\Activate.ps1      # Windows
```
```bash
source .venv/bin/activate       # macOS / Linux
```

```bash
pip install -e .
```

Isso basta para o caminho rápido (whisper.cpp). Se preferir a transcrição em
Python puro, que baixa o modelo sozinho mas é bem mais lenta:
`pip install -e ".[transcription]"`.

### Passo 3 — Coloque o whisper.cpp e um modelo

O motor rápido precisa de dois arquivos, que não vão no repositório por serem
binários grandes:

- `whisper-cli` (ou `whisper-cli.exe`) em **`.whisper-cpp/`**
- um modelo GGML `.bin` em **`.models/`** — `ggml-large-v3-turbo.bin` é um bom
  padrão ([modelos disponíveis](https://huggingface.co/ggerganov/whisper.cpp))
- opcional, mas recomendado: o modelo de **detecção de voz**
  [`ggml-silero-v5.1.2.bin`](https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin)
  (0,9 MB), também em **`.models/`**. Com ele o Whisper só vê os trechos com
  fala e deixa de inventar "Tchau." em série nos silêncios. Sem ele, uma
  limpeza posterior remove repetições e frases-fantasma isoladas.

Como compilar o whisper.cpp com Vulkan está em
[`desktop/README.md`](desktop/README.md). Sem esses arquivos o app ainda roda
pelo motor Docker, que dispensa GPU.

### Passo 4 — Abra

Clique duas vezes em **`Meeting Processor (sem console).vbs`**. Na primeira vez
ele instala as dependências do app; depois abre direto. O
**`Meeting Processor.bat`** faz o mesmo mostrando as mensagens — use quando algo
der errado.

Pela linha de comando:

```bash
cd desktop && npm install && npm start
```

Para atualizar depois, não precisa voltar ao terminal: **Configurações →
Sobre → Verificar atualização** mostra o que mudou e o botão **Atualizar agora**
faz o `git pull`, reinstala dependências se elas mudaram e reabre o app.

---

## Voz offline com o Chatterbox (opcional)

O chat lê as respostas com vozes neurais do Edge (online) ou com a voz do
sistema (offline, sem entonação). Há um terceiro motor, **Chatterbox
Multilingual V3 pt-BR** (Resemble AI, MIT): prosódia natural e clonagem de
voz, **offline**, 0,5B parâmetros. É um modelo PyTorch, então não usa o
Vulkan do whisper.cpp; a GPU entra por CUDA (NVIDIA) ou **ROCm (AMD)**. Como
fixa versões próprias de torch e transformers, vive num ambiente à parte. O
app prefere `.venv-tts-gpu` quando existe e cai para `.venv-tts` (CPU).

**Com Radeon (ROCm no Windows)** — a AMD dá suporte oficial a PyTorch no
Windows para RX 9060 XT, 9070/9070 XT, 7900 XTX, 7700 e as PRO
correspondentes. Exige **Python 3.12** e driver Adrenalin 26.2.2 ou mais novo:

```powershell
winget install --id Python.Python.3.12 --exact
py -3.12 -m venv .venv-tts-gpu
.venv-tts-gpu\Scripts\python -m pip install --no-cache-dir `
  https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_core-7.2.1-py3-none-win_amd64.whl `
  https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_devel-7.2.1-py3-none-win_amd64.whl `
  https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_libraries_custom-7.2.1-py3-none-win_amd64.whl `
  https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm-7.2.1.tar.gz
.venv-tts-gpu\Scripts\python -m pip install --no-cache-dir `
  https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torch-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl `
  https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchaudio-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl `
  https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchvision-0.24.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl
.venv-tts-gpu\Scripts\python -c "import torch; print(torch.cuda.get_device_name(0))"   # deve imprimir a placa
.venv-tts-gpu\Scripts\python -m pip install --no-deps "git+https://github.com/resemble-ai/chatterbox.git"
.venv-tts-gpu\Scripts\python -m pip install "numpy<2" "librosa==0.11.0" s3tokenizer "transformers==5.2.0" "diffusers==0.29.0" "git+https://github.com/resemble-ai/Perth.git" "conformer==0.3.2" "safetensors==0.5.3" spacy-pkuseg "pykakasi==2.3.0" pyloudnorm omegaconf huggingface_hub
.venv-tts-gpu\Scripts\python -m meeting_processor.tts_chatterbox --model-dir .models\chatterbox-pt-br --download
```

O Chatterbox entra com `--no-deps` porque seus metadados fixam o torch 2.6 de
CPU; as dependências vão em seguida, e o torch ROCm fica. Medido numa **RX
9060 XT**: ~29 s para carregar, **~5 s de espera por segundo de fala** (voz
padrão ou clonada, depois da primeira frase) — o ROCm no Windows ainda usa
kernels genéricos para a RDNA4, então não chega ao tempo real, mas é 3 a 5×
a CPU.

**Só CPU** (qualquer máquina, Python 3.11 ou 3.12):

```powershell
python -m venv .venv-tts
.venv-tts\Scripts\python -m pip install "git+https://github.com/resemble-ai/chatterbox.git"
.venv-tts\Scripts\python -m meeting_processor.tts_chatterbox --model-dir .models\chatterbox-pt-br --download
```

Num Ryzen 7 5700X: ~26 s para carregar (~4 GB de RAM) e **~7 s de espera por
segundo de fala** com a voz padrão, ~20 s com voz clonada. (O pacote do PyPI,
`chatterbox-tts` 0.1.7, ainda é o V2 e não carrega o pack pt-BR; por isso a
instalação vem do GitHub.)

O download é de ~3,2 GB, em `.models/chatterbox-pt-br/` (fora do repositório).
Depois, **Configurações → Voz do assistente → Chatterbox**. Um áudio seu de
5 a 15 s como **voz de referência** faz o modelo falar com a sua voz.

## Os dois motores

Alterne em **Configurações → Motor ativo**.

| Motor | Onde roda | Velocidade |
|-------|-----------|------------|
| **GPU** (padrão) | Python do host + whisper.cpp com Vulkan | ~11x tempo real |
| **Docker** | container CPU-only | ~2x tempo real |

Medido no mesmo áudio de 5 min com `large-v3-turbo` numa Radeon RX 9060 XT:
**27 s na GPU** contra **153 s na CPU** com 16 threads. No Windows o Docker
Desktop **não** expõe GPU AMD, então container e GPU são exclusivos.

Para o motor Docker, construa a imagem uma vez:

```bash
docker build -t meeting-processor:latest .
```

---

## Transcrever pelo terminal

O app chama exatamente este comando. Ele também serve avulso:

```bash
# Cria ./saida/<nome>/ com a transcrição (.md e .txt) e o meeting.json
python -m meeting_processor transcribe reuniao.mkv --output-dir ./saida
python -m meeting_processor transcribe reuniao.mkv --output-dir ./saida --name "Call com o cliente"
```

Padrões em [`config.yaml`](config.yaml); qualquer um deles aceita override por
variável de ambiente (veja [`.env.example`](.env.example)).

---

## Solução de problemas

| Sintoma | O que fazer |
|---------|-------------|
| `ffmpeg não encontrado no PATH` | Instale o ffmpeg e reabra o terminal |
| `Motor nativo indisponível` | Falta o `whisper-cli` em `.whisper-cpp/` ou o `.bin` em `.models/` |
| Transcrição lenta | Confira se a linha "GPU: ..." aparece no progresso; sem ela está na CPU |
| "Tchau." (ou outra frase) repetida em série na transcrição | Alucinação do Whisper no silêncio. Coloque o `ggml-silero-v5.1.2.bin` em `.models/` (VAD); a limpeza já colapsa a repetição, mas o VAD evita que ela nasça |
| Kanban vazio depois da reunião | O aviso na tela diz o motivo; o log completo está em `meeting_processor.log` |
| `não foi possível executar o Claude Code` | Instale o Claude Code, ou aponte `CLAUDE_BIN` para o binário |

---

## Para desenvolvedores

```bash
python -m pytest -q                    # motor de transcrição
cd desktop && npm test                 # app
```

```
meeting_processor/         # motor de transcrição (Python)
├── __main__.py            # CLI: transcribe
├── config.py              # configuração (YAML + .env)
├── audio.py               # extração de áudio (ffmpeg)
├── transcriber.py         # Whisper (whisper.cpp / openai-whisper), com VAD
├── cleanup.py             # remove alucinações: repetições em série e frases-fantasma
├── tts_chatterbox.py      # voz offline (Chatterbox pt-BR): worker por stdin, roda no .venv-tts
├── media_info.py          # data da gravação e duração (ffprobe)
├── transcript_export.py   # grava .md/.txt + meeting.json na pasta da reunião
├── events.py              # eventos JSONL consumidos pelo app
├── models.py              # Transcript e seus segmentos
└── utils.py               # helpers compartilhados

desktop/                   # app Electron (Synapse) — veja desktop/README.md
├── main.js                # processo principal: jobs, extração, documentos
├── library.js             # reuniões na pasta de saída
├── projects.js tasks.js   # projetos e Kanban (SQLite)
├── claude-jobs.js         # a chamada ao Claude Code (análise da reunião)
├── analysis.js            # a análise: JSON normalizado em analise.json, por reunião
├── document-html.js       # o PDF da reunião montado a partir da análise
├── pipeline-steps.js      # quais etapas rodam depois da transcrição
├── prompts-store.js       # prompts editados em Configurações, por cima do padrão
├── updater.js             # atualização pelo app: git pull + reinstalar o que mudou
├── project-chat.js        # o chat: argumentos do claude -p, system prompt do projeto, eventos
├── chat-messages.js       # histórico do chat por projeto (synapse.db)
├── voice.js               # recado de voz do chat → texto (whisper.cpp local)
├── tts.js                 # resposta → fala: Edge neural (online), Chatterbox (offline) ou sistema
├── chatterbox-worker.js   # mantém o worker do Chatterbox vivo; fila; desliga por ociosidade
├── unicode-path.js        # caminhos com acento nas duas formas do Unicode
├── prompts/               # prompts de extração e documentos, fora do código
└── renderer/              # interface

Dockerfile                 # imagem do motor CPU (whisper.cpp + ffmpeg)
```

---

## Licença

MIT — veja [`LICENSE`](LICENSE).

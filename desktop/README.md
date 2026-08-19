# Synapse — app desktop

Um workspace por projeto para reuniões. Você grava ou solta um vídeo na janela;
o app extrai o áudio, transcreve, extrai as tarefas combinadas e liga tudo ao
projeto. Nada sai da máquina: transcrição e extração rodam localmente.

O nome antigo era *Meeting Processor*; o pipeline Python continua o mesmo.

## O modelo mental

O centro é o **projeto**, não a transcrição:

```
                    PROJETO
                       │
        ┌──────────────┼──────────────┐
        ↓              ↓              ↓
     REUNIÃO         TAREFA        DOCUMENTO
        │              │
        └──── grafo ───┘
```

Cada projeto tem visão geral, kanban, reuniões, grafo e chat. Um projeto
carrega também um texto de contexto, usado para orientar o registro dos
documentos gerados.

## Como funciona

```
janela (Electron)  →  motor de transcrição  →  arquivos na pasta de saída
       ↑                      │                        │
       └──── eventos JSONL ───┘                  extração (claude -p)
                                                        │
                                                  cards no kanban
```

O app não fala Python: faz spawn do motor, que emite um evento JSON por linha
no stdout (`stage`, `done`, `error`). Terminada a transcrição, o app roda a
extração estruturada e só então anuncia a reunião como pronta.

## Os dois motores

Alterne em **Configurações → Motor ativo**.

| Motor | Onde roda | Velocidade |
|-------|-----------|------------|
| **GPU** (padrão) | Python do host + whisper.cpp com Vulkan | ~11x tempo real numa Radeon RX 9060 XT |
| **Docker** | container CPU-only | ~2x tempo real com 16 threads |

Medido no mesmo áudio de 5 min com `large-v3-turbo`: **27 s na GPU** contra
**153 s na CPU**. No Windows o Docker Desktop **não** expõe GPU AMD, então
container e GPU são exclusivos.

## Pré-requisitos

- **Node.js 20+** para abrir o app.
- Motor **GPU**: Python com as dependências do projeto, ffmpeg no PATH,
  `whisper-cli.exe` em `.whisper-cpp/` e ao menos um modelo `.bin` em
  `.models/`.
- Motor **Docker**: só o Docker Desktop.
- Extração de tarefas e PDFs: **Claude Code** instalado e autenticado. O app
  procura o binário em `~/.local/bin` e no PATH; `CLAUDE_BIN` força um caminho.

## Rodar

```bash
cd desktop && npm install && npm start
```

Ou clique em `Meeting Processor (sem console).vbs` na raiz do projeto.

## Os fluxos

### Gravar

Dentro de um projeto, **Iniciar reunião** grava microfone **e** áudio do
sistema (loopback), mixados num arquivo só — numa chamada online o microfone
traz apenas o seu lado. Sem permissão de loopback, o app segue só com o
microfone e diz isso na tela. Ao finalizar, o áudio entra no mesmo pipeline da
importação e o arquivo temporário é apagado no fim.

### Importar

Solte um vídeo em qualquer lugar da janela, ou use **Importar vídeo**. Você
confirma o nome e o projeto antes de começar.

**Importar transcrição** aceita texto já pronto (`.txt`, `.md`) e legendas
(`.srt`, `.vtt`) — útil para reuniões que já foram transcritas pelo Teams ou
pelo Zoom. A legenda vira fala com horário, e a reunião entra na biblioteca
como qualquer outra: com projeto escolhido, ainda passa pela extração de
tarefas.

### Depois da transcrição

O Claude lê a transcrição e devolve as ações combinadas em JSON — título,
descrição, responsável e prioridade. Elas viram cards no backlog do projeto,
cada um ligado à reunião de origem. Sem projeto, essa etapa é pulada: tarefa
sem projeto não teria onde viver.

Resumo e tarefas em PDF continuam sob demanda, no painel da reunião.

## Onde ficam os dados

A pasta de saída é a fonte da verdade — não há banco paralelo:

```
<pasta de saída>/
├── groups.json                    # projetos e a que projeto cada reunião pertence
├── tasks.json                     # tarefas do kanban
└── <nome da reunião>/
    ├── <nome>.md                  # transcrição com timestamps
    ├── <nome>.txt
    ├── meeting.json               # data, duração, modelo, idioma, nº de falas
    └── <nome> - Tarefas.pdf       # quando gerado
```

## Estrutura

```
desktop/
├── assets/              # marca do app
│   ├── icon.svg         # fonte do ícone (neurônio disparando)
│   ├── icon.ico         # janela e barra de tarefas no Windows
│   └── icon.png         # 512px, para empacotamento e outras plataformas
├── main.js              # janela, IPC, pipeline, gravação e extração
├── engines.js           # os dois motores: nativo (GPU) e container (CPU)
├── docker-args.js       # montagem do comando do container
├── claude-jobs.js       # prompts e execução do `claude -p`
├── transcript-import.js # texto e legenda viram reunião (.txt .md .srt .vtt)
├── library.js           # a pasta de saída lida como biblioteca (CRUD)
├── groups.js            # projetos e seus contextos (groups.json)
├── tasks.js             # tarefas do kanban (tasks.json)
├── workspace.js         # traduz disco → projeto/reunião/tarefa
├── preload.js           # ponte segura entre janela e sistema
├── prompts/             # instruções editáveis
│   ├── extrair.md       # extração estruturada (JSON de tarefas)
│   ├── tarefas.md       # PDF de tarefas
│   └── resumo.md        # PDF de resumo
└── renderer/
    ├── index.html       # shell: sidebar, vistas, drawer, overlays
    ├── styles.css       # tema neural (azul-tinta, ciano, violeta)
    ├── app.js           # navegação, kanban, gravação, chat, pipeline
    ├── neural.js        # rede do hero, no Início
    ├── network.js       # rede viva das telas de trabalho (interativa)
    ├── graph.js         # grafo força-dirigida (hero e projeto)
    └── mock-api.js      # backend simulado fora do Electron (inerte no app)
```

## Solução de problemas

> Excluir uma reunião manda a pasta para a **Lixeira** do sistema, não apaga
> do disco: transcrição não se refaz sem o vídeo original.

| Sintoma | O que fazer |
|---------|-------------|
| "motor indisponível" | No modo GPU, confira `.whisper-cpp/whisper-cli.exe` e `.models/*.bin`. No Docker, abra o Docker Desktop e clique em **Verificar de novo**. |
| Transcrição muito lenta | Confira o motor em Configurações: se está em **Docker**, é CPU. O detalhe da tela mostra `GPU: <placa>` quando a GPU entra em ação. |
| Nenhuma tarefa foi criada | A reunião precisa estar num projeto e o `claude` precisa estar autenticado — rode `claude` uma vez no terminal. O log da janela traz o motivo. |
| "O PDF não foi gerado" | Além do `claude`, é preciso ter Edge ou Chrome instalado. |
| Gravação sem o áudio da outra pessoa | A tela de gravação diz a fonte em uso. Só microfone significa que o loopback do sistema foi negado. |
| Arquivo não aceito | Só vídeo e áudio: mkv, mp4, mov, webm, avi, mp3, wav, m4a e afins. |

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

O Claude lê a transcrição **uma vez** (`prompts/analise.md`) e devolve a
análise da reunião em JSON: título, visão geral, pontos discutidos, decisões,
riscos, tarefas e pendências. O app normaliza esse JSON (`analysis.js`) e o
guarda em `analise.json`, na pasta da reunião.

Dessa análise saem as duas coisas, por construção iguais:

- **Tarefas no Kanban** — cada tarefa vira um card no backlog do projeto,
  ligado à reunião. O painel da reunião lista essas tarefas e abre o card. Sem
  projeto, a etapa é pulada: tarefa sem projeto não teria onde viver.
- **Documento em PDF** — o app monta o HTML a partir da análise
  (`document-html.js`) e o imprime pelo Edge ou Chrome. A tabela de tarefas do
  PDF é a mesma lista dos cards.

Cada uma liga e desliga em **Configurações → Depois da transcrição**
(`pipeline-steps.js` decide o que roda; com as duas desligadas e sem nome
automático, o Claude nem é chamado). O botão **Gerar documentos**, no painel da
reunião, monta o PDF a partir da análise guardada — e, numa reunião de antes da
análise existir, pede a análise primeiro.

No mesmo cartão, **Prompts** lista as etapas num seletor (a lista vem de
`prompts-store.js`: um prompt novo registrado ali aparece sozinho) e abre as
instruções escolhidas num modal para ler e editar. O padrão fica em `prompts/*.md`; a edição vai para a pasta de
dados do usuário e vale por cima (`prompts-store.js`) — restaurar o padrão é
apagar essa cópia, e atualizar o app nunca sobrescreve o que a pessoa escreveu.
O editor recusa texto sem os placeholders obrigatórios (`{{TRANSCRICAO}}`,
`{{PDF}}`…), porque é por eles que o app passa os caminhos.

Enquanto tudo isso roda, a tela de processamento pode ser **minimizada** (botão
ou `Esc`): o progresso segue num chip no pé da barra lateral, o app fica livre
e um clique no chip traz a tela de volta. Ao terminar, o aviso único aparece
do mesmo jeito — só não puxa a pessoa para o projeto se ela estava em outra
coisa.

### O chat do projeto

O chat é o Claude Code (`claude -p`) rodando na **pasta de trabalho** do
projeto — um campo do projeto; vazio, usa a pasta das reuniões. Cada mensagem
vai com um system prompt montado na hora (`project-chat.js`): nome e contexto
do projeto, os caminhos de transcrição, `analise.json` e PDF de cada reunião,
as tarefas abertas do Kanban e o modo em vigor. A conversa continua entre
mensagens e entre aberturas do app pela sessão do próprio Claude Code
(`--session-id` na primeira, `--resume` depois); se a sessão sumiu, o app abre
outra e segue. O que a tela mostra fica em `chat_messages`, no `synapse.db`.

Dois modos, por projeto, no alto do chat:

- **Leitura** (padrão): `--permission-mode dontAsk` com `Read, Glob, Grep,
  WebSearch, WebFetch`. O Claude consulta e responde; não escreve nem executa.
- **Autônomo**: `--dangerously-skip-permissions`. O Claude age na máquina sem
  pedir a cada passo. Liga com confirmação, fica vermelho enquanto ativo, e o
  system prompt pede aviso antes de algo destrutivo. **Parar** derruba a rodada.

## Onde ficam os dados

Um projeto com **pasta de trabalho** é a casa das suas reuniões: o app cria
`synapse/` dentro dela e cada reunião do projeto é uma subpasta ali —
transcrição, `analise.json` e PDF. Definir, trocar ou limpar a pasta move as
reuniões do projeto para a raiz certa (entre discos, copia e apaga). Excluir o
projeto exclui tudo dele: cada reunião vai para a Lixeira, a `synapse/` vazia
sai, e tarefas, vínculos e histórico do chat caem do banco. Excluir uma
reunião leva a pasta dela e as tarefas que nasceram dela. A biblioteca lê
todas as raízes; o id da reunião leva o projeto na
frente (`alpha::Kickoff`) porque dois projetos podem ter reuniões de mesmo nome.

A **pasta de saída** (Configurações) fica com as reuniões sem projeto e com o
`synapse.db` — projetos, tarefas, vínculos, histórico do chat.

As transcrições e os documentos são arquivos na pasta de saída, legíveis sem
o app. O que não cabe num nome de pasta — projetos, tarefas e o vínculo de
cada reunião — fica num SQLite na mesma pasta:

```
<pasta de saída>/
├── synapse.db                     # projetos, tarefas e vínculos (SQLite)
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
├── claude-jobs.js       # a chamada ao `claude -p` (análise da reunião)
├── analysis.js          # normaliza e guarda a análise (analise.json)
├── document-html.js     # o PDF da reunião, montado a partir da análise
├── pipeline-steps.js    # quais etapas rodam depois da transcrição (Configurações)
├── prompts-store.js     # prompts editados por cima do padrão (Configurações → Prompts)
├── updater.js           # Configurações → Sobre: git pull --ff-only, npm/pip se mudaram, relaunch
├── project-chat.js      # chat do projeto: system prompt, args do claude -p, tradução do stream
├── chat-messages.js     # histórico do chat (tabela chat_messages)
├── transcript-import.js # texto e legenda viram reunião (.txt .md .srt .vtt)
├── library.js           # a pasta de saída lida como biblioteca (CRUD)
├── db.js                # banco do workspace (SQLite) e migração dos JSONs
├── projects.js          # projetos, contextos e vínculo com as reuniões
├── tasks.js             # tarefas do kanban
├── workspace.js         # traduz disco → projeto/reunião/tarefa
├── preload.js           # ponte segura entre janela e sistema
├── prompts/             # instruções padrão, editáveis também pelo app
│   └── analise.md       # a leitura única: análise da reunião em JSON
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
>
> Vindo de uma versão anterior, o `groups.json` e o `tasks.json` são
> importados para o banco na primeira abertura e guardados como `.migrado`.

| Sintoma | O que fazer |
|---------|-------------|
| "motor indisponível" | No modo GPU, confira `.whisper-cpp/whisper-cli.exe` e `.models/*.bin`. No Docker, abra o Docker Desktop e clique em **Verificar de novo**. |
| Transcrição muito lenta | Confira o motor em Configurações: se está em **Docker**, é CPU. O detalhe da tela mostra `GPU: <placa>` quando a GPU entra em ação. |
| Nenhuma tarefa foi criada | A reunião precisa estar num projeto e o `claude` precisa estar autenticado — rode `claude` uma vez no terminal. O log da janela traz o motivo. |
| "O PDF não foi gerado" | Além do `claude`, é preciso ter Edge ou Chrome instalado. |
| Gravação sem o áudio da outra pessoa | A tela de gravação diz a fonte em uso. Só microfone significa que o loopback do sistema foi negado. |
| Arquivo não aceito | Só vídeo e áudio: mkv, mp4, mov, webm, avi, mp3, wav, m4a e afins. |

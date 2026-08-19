# Meeting Processor — o que é e como funciona

Cópia literal do frontend do app desktop (`desktop/renderer/`). Este documento
explica o sistema ao redor desses arquivos: o que ele faz, quem chama quem e o
que cada arquivo daqui é responsável.

---

## O que o sistema é

Um aplicativo que transforma **gravação de reunião em texto e documentos**,
rodando 100% na máquina do usuário. Você arrasta um vídeo para a janela; ele
extrai o áudio, transcreve com Whisper e grava os arquivos numa pasta. A partir
da transcrição, ainda dá para gerar **resumo executivo** e **lista de tarefas**
em PDF.

Há duas portas de entrada para o mesmo motor:

| Porta | Como se usa | Para quê |
|-------|-------------|----------|
| App desktop (Electron) | arrasta o vídeo na janela | uso manual, um arquivo por vez |
| CLI Python (`python -m meeting_processor`) | `process`, `transcribe`, `watch` | lote, automação, monitorar a pasta do OBS |

---

## As três camadas

```
┌─ frontend (estes arquivos) ──────────────────────────────┐
│  index.html + styles.css + app.js + wave.js              │
│  + library-ui.js + table-ui.js                           │
│  Roda isolado: sem Node, sem acesso a disco.             │
└──────────────────┬───────────────────────────────────────┘
                   │  window.api  (ponte do preload.js, IPC)
┌──────────────────▼───────────────────────────────────────┐
│  processo principal do Electron — desktop/main.js         │
│  engines.js · library.js · groups.js · claude-jobs.js     │
│  Abre diálogos, lê o disco, sobe subprocessos.            │
└──────────────────┬───────────────────────────────────────┘
                   │  subprocesso, eventos JSONL no stdout
┌──────────────────▼───────────────────────────────────────┐
│  motor de transcrição                                     │
│   • nativo: Python + whisper.cpp (Vulkan, usa a GPU)      │
│   • docker: container CPU-only, portátil                  │
│  Pipeline Python: meeting_processor/                      │
└──────────────────────────────────────────────────────────┘
```

O frontend **nunca** toca em arquivo. Tudo passa pela API explícita exposta em
`window.api` — é isso que mantém a janela incapaz de mexer no sistema por conta
própria.

---

## O caminho de um vídeo

1. **Solta o arquivo** na janela. `app.js` pega o caminho real via
   `window.api.pathForFile(file)` (o `File.path` deixou de existir no
   Electron 32+).
2. **Confirma o nome** da reunião — esse nome vira a pasta de saída.
3. **`window.api.startJob(...)`** sobe o motor escolhido. Os dois motores falam
   o mesmo protocolo — eventos JSONL no stdout — então o resto do app não
   precisa saber qual está rodando.
4. **Etapas do pipeline**, com progresso chegando pelo canal `job:event`:
   extrair áudio (ffmpeg) → transcrever (Whisper) → gravar `.md` e `.txt`.
5. **Pronto**: a lista de arquivos gerados aparece na tela e a reunião entra na
   biblioteca da coluna esquerda.
6. **Opcional**: gerar resumo ou tarefas em PDF (`startDoc`). Isso dispara o
   Claude CLI com os prompts de `desktop/prompts/`, que escreve um HTML
   autocontido e o converte em PDF com Edge/Chrome em modo headless.

Os dois motores:

- **GPU (padrão)** — whisper.cpp com Vulkan. Numa Radeon RX 9060 XT, cerca de
  11× mais rápido que tempo real: uma reunião de 1 h sai em ~5 min.
- **Docker** — container CPU-only, para máquina sem GPU disponível.

---

## Os arquivos desta pasta

| Arquivo | O que faz |
|---------|-----------|
| `index.html` | Estrutura da janela. Todos os painéis existem no HTML o tempo todo; só um fica visível, escolhido pelo atributo `data-state` no elemento `.app`. |
| `styles.css` | Toda a aparência. Os painéis aparecem/somem por seletores como `.app[data-state="working"] .panel-working`. |
| `app.js` | O cérebro da janela: máquina de estados (`idle`, `dragging`, `confirm`, `working`, `done`, `detail`, `viewer`, `table`, `context`, `groups`, `doc`, `error`, `blocked`), drag-and-drop, chamadas à `window.api` e assinatura dos eventos de progresso. |
| `wave.js` | A forma de onda do palco — elemento de assinatura. Não é enfeite: em repouso é uma linha quase plana, ao arrastar ganha amplitude, e durante a transcrição o progresso avança por ela como um cabeçote de leitura. |
| `library-ui.js` | Renderiza a lista de transcrições da coluna esquerda. |
| `table-ui.js` | A visão em tabela da biblioteca: ordenação por coluna, seleção múltipla, edição do nome na própria célula e ações em lote. |

**Não incluído aqui** (é processo principal, não frontend): `preload.js`,
`main.js`, `engines.js`, `library.js`, `groups.js`, `docker-args.js`,
`claude-jobs.js` e a pasta `prompts/`.

---

## A API que o frontend consome

Exposta pelo `desktop/preload.js` como `window.api`:

- **Configuração** — `getSettings`, `setSettings`
- **Motores** — `enginesStatus`, `dockerStatus`, `buildImage`
- **Transcrição** — `startJob`, `cancelJob`
- **Documentos (PDF)** — `startDoc`, `cancelDoc`
- **Biblioteca** — `listMeetings`, `getMeeting`, `renameMeeting`,
  `deleteMeeting`, `readFile`, `downloadFile`
- **Projetos** — `listGroups`, `saveGroup`, `deleteGroup`, `assignGroup`
- **Sistema** — `pickVideo`, `pickOutputDir`, `showInFolder`, `openPath`,
  `pathForFile`
- **Eventos** — `on(canal, fn)` nos canais `job:event`, `job:log`,
  `job:closed`, `build:log`, `doc:progress`, `doc:done`

Um "projeto" é um agrupamento de reuniões com um texto de contexto; esse
contexto é injetado nos prompts para orientar a linguagem do resumo e das
tarefas — sem fornecer fatos que não estejam na transcrição.

---

## Rodando estes arquivos isolados

Abrir o `index.html` direto no navegador mostra o layout, mas nada funciona:
`window.api` não existe fora do Electron. Para ver o app de verdade:

```bash
cd desktop && npm install && npm start
```

Ou clique duas vezes em `Meeting Processor (sem console).vbs` na raiz do
projeto.

# Synapse — workspace neural por projeto

Redesign completo do frontend: o **projeto** vira o centro da experiência
(não mais "a transcrição"). Cada projeto concentra reuniões, tarefas,
documentos, memória e chat. Tema: **conexões neurais** — o app transforma
fala em conhecimento e a interface desenha isso: redes de neurônios que
acendem conforme o sinal se propaga, e um grafo que conecta tudo.

## Módulos (nova sidebar)

```
SYNAPSE
⌂ Início
PROJETOS  (+)
  ◈ Projeto Alpha → Visão geral · Kanban · Reuniões · Grafo · Chat
BIBLIOTECA
  ☷ Todas as reuniões
SISTEMA
  ⚙ Configurações
```

- **Início** — hero com a rede neural, estatísticas gerais, projetos e reuniões recentes.
- **Projeto / Visão geral** — última reunião, tarefas abertas, concluídas na semana, contexto da IA.
- **Projeto / Kanban** — backlog · em andamento · concluído; drag-and-drop; cards com prioridade, responsável e a reunião de origem (📅); criação manual ou automática.
- **Projeto / Reuniões** — lista do projeto; clique abre o drawer com metadados, arquivos, transcrição pesquisável, gerar resumo/tarefas, renomear, excluir.
- **Projeto / Grafo** — grafo força-dirigida estilo Obsidian: projeto ↔ reuniões ↔ tarefas ↔ conceitos; clicar no nó abre o item; arrastar reposiciona.
- **Projeto / Chat** — RAG por projeto; respostas citam fontes clicáveis (📄 reunião, 📋 tarefa) e entendem que decisão nova substitui a antiga.
- **Biblioteca** — todas as reuniões, busca e filtros.
- **Configurações** — TUDO que antes ficava espalhado pela tela: motor (GPU/Docker), modelo, idioma, pasta de saída, sobre.

## Fluxos principais

**Gravar**: `● Iniciar reunião` (dentro do projeto) → overlay de gravação →
`⏹ Finalizar` → pipeline automático (áudio → transcrição → arquivos →
**extração de resumo + tarefas**) → cards caem no kanban → toast + drawer.

**Importar**: botão "Importar vídeo" ou soltar o arquivo em qualquer lugar
da janela → confirma nome + projeto → mesmo pipeline.

## Arquivos

| Arquivo | Papel |
|---------|-------|
| `index.html` | Shell: sidebar, vistas, drawer, modais, overlays. |
| `styles.css` | Tema neural completo (azul-tinta, ciano elétrico, violeta). |
| `app.js` | Navegação, renderização das vistas, kanban DnD, chat, gravação, pipeline. |
| `neural.js` | Rede neural canvas (hero, gravação e processamento). `createNeural(canvas)` → `{setMode, setProgress}`. |
| `graph.js` | Grafo força-dirigida. `createGraph(canvas, {onOpen})` → `{setData, start, stop}`. |
| `mock-api.js` | Simula o backend fora do Electron **e documenta o contrato** da `window.api` que o processo principal precisa expor. Inerte dentro do Electron. |
| `BACKLOG.md` | Backlog com status atualizado por esta entrega. |
| `preview.html` | Cópia do `index.html` **sem a CSP**, só para pré-visualizar no navegador/ferramentas. O app real usa `index.html`. |

## Contrato `window.api` (a implementar no main process)

- Configurações: `getSettings`, `setSettings`, `enginesStatus`, `pickOutputDir`
- Projetos: `listProjects`, `saveProject`, `deleteProject`
- Reuniões: `listMeetings(projectId?)`, `getMeeting`, `renameMeeting`, `deleteMeeting`, `assignProject`
- Tarefas: `listTasks(projectId)`, `saveTask`, `moveTask(id, status)`, `deleteTask`
- Pipeline: `startJob({videoPath, name, projectId})`, `processRecording({projectId, name, duration})`, `cancelJob` — eventos `job:event` (`stage` com `key: audio|transcription|export|extract`, `done` com `meetingId` e `tasksCreated`)
- Documentos: `generateDoc({kind, meetingId})` — eventos `doc:progress`, `doc:done`
- Chat: `chatAsk({projectId, question})` → `{answer, sources: [{type, id, label}]}`
- Sistema: `pickVideo`, `pathForFile`, `openPath`, `on(canal, fn)`

Ponto-chave: a IA passa a devolver **dados estruturados** (`tasks` com título,
responsável, prioridade, reunião de origem); o PDF vira só uma visualização.

## Rodando

- **No navegador**: abra `index.html` — o `mock-api.js` simula tudo.
- **No Electron**: aponte o renderer para esta pasta e implemente o contrato acima no `main.js`/`preload.js`.

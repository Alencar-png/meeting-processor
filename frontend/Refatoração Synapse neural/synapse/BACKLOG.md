# Backlog — Synapse

Status após esta entrega de frontend. 🟢 = pronto na UI (mock de backend),
🟡 = parcial, ⬜ = pendente (backend real ou fase futura).

| ID | Épico | Feature | Prior. | Status |
|----|-------|---------|--------|--------|
| PRJ-01 | Projetos | Criar projeto | Alta | 🟢 UI pronta |
| PRJ-02 | Projetos | Editar projeto | Alta | 🟢 UI pronta |
| PRJ-03 | Projetos | Excluir projeto | Alta | 🟢 UI pronta |
| PRJ-04 | Projetos | Listar projetos | Alta | 🟢 UI pronta |
| PRJ-05 | Projetos | Dashboard individual do projeto | Alta | 🟢 UI pronta |
| PRJ-06 | Projetos | Associar reuniões ao projeto | Alta | 🟢 UI pronta (import + gravação) |
| KAN-01 | Kanban | Kanban individual por projeto | Alta | 🟢 UI pronta |
| KAN-02 | Kanban | Colunas configuráveis | Média | ⬜ Backlog |
| KAN-03 | Kanban | Cards de tarefas | Alta | 🟢 UI pronta |
| KAN-04 | Kanban | Drag-and-drop entre colunas | Alta | 🟢 UI pronta |
| KAN-05 | Kanban | Abrir detalhes do card | Alta | 🟢 UI pronta |
| KAN-06 | Kanban | Criar/editar/excluir tarefa manual | Alta | 🟢 UI pronta |
| KAN-07 | Kanban | Vincular card à reunião de origem | Alta | 🟢 UI pronta |
| AI-01 | IA | Extrair ações/tarefas da reunião | Alta | 🟡 Existe em PDF; falta saída estruturada |
| AI-02 | IA | Criar automaticamente cards das ações | Alta | 🟡 UI + contrato prontos; falta backend |
| AI-03 | IA | Gerar resumo da reunião | Alta | 🟢 Existe |
| AI-04 | IA | Resumo PDF dentro do projeto | Alta | 🟢 UI pronta (drawer da reunião) |
| AI-05 | IA | Identificar contexto entre reuniões | Média | 🟡 Conceitos no grafo; falta extração real |
| REC-01 | Gravação | Iniciar gravação dentro do projeto | Alta | 🟡 UI pronta; falta captura de áudio |
| REC-02 | Gravação | Pausar/continuar gravação | Média | ⬜ Backlog |
| REC-03 | Gravação | Encerrar gravação | Alta | 🟡 UI pronta |
| REC-04 | Gravação | Processar automaticamente após encerrar | Alta | 🟡 UI + pipeline prontos (reaproveita o existente) |
| REC-05 | Gravação | Associar gravação ao projeto | Alta | 🟢 UI pronta |
| MEM-01 | Memória | Indexar reuniões em Vector DB | Alta | ⬜ Backend |
| MEM-02 | Memória | Indexar tarefas/cards | Alta | ⬜ Backend |
| MEM-03 | Memória | Embeddings dos contextos | Alta | ⬜ Backend |
| MEM-04 | Memória | Relacionar reuniões semanticamente | Média | ⬜ Backend |
| MEM-05 | Memória | Relacionar tarefas semanticamente | Média | ⬜ Backend |
| MEM-06 | Memória | Grafo visual estilo Obsidian | Média | 🟢 UI pronta |
| MEM-07 | Memória | Abrir reunião/card clicando no nó | Média | 🟢 UI pronta |
| CHAT-01 | Chat | Chat individual por projeto | Alta | 🟢 UI pronta |
| CHAT-02 | Chat | RAG sobre reuniões do projeto | Alta | 🟡 UI + contrato; falta backend |
| CHAT-03 | Chat | RAG sobre tarefas do projeto | Alta | 🟡 UI + contrato; falta backend |
| CHAT-04 | Chat | Histórico de conversas | Média | 🟡 Em memória; falta persistir |
| CHAT-05 | Chat | Citar reunião utilizada na resposta | Alta | 🟢 UI pronta (chips clicáveis) |
| CHAT-06 | Chat | Citar tarefas/cards utilizados | Alta | 🟢 UI pronta |
| UI-01 | Interface | Sidebar organizada por módulos | Alta | 🟢 Pronta |
| UI-02 | Interface | Navegação Projeto → Dashboard | Alta | 🟢 Pronta |
| UI-03 | Interface | Alternar Kanban/Reuniões/Grafo/Chat | Alta | 🟢 Pronta |
| SET-01 | Interface | Módulo de Configurações centralizado | Alta | 🟢 Pronta (motor, modelo, idioma, pasta) |

## Milestones sugeridos (backend)

- **M1 — Projects**: persistir projetos/tarefas no disco (`groups.js` evolui para `projects.js`).
- **M2 — Meetings → Work**: captura de áudio no Electron; prompt do Claude passa a devolver JSON estruturado (`summary` + `tasks[]`).
- **M3 — Memory**: embeddings + Vector DB local; `chatAsk` real com RAG.
- **M4 — Neural Graph**: extração de entidades/conceitos; relações automáticas no grafo.

# Backlog — Synapse

Status real do produto. 🟢 = pronto e verificado no app com dados reais,
🟡 = parcial, ⬜ = pendente.

| ID | Épico | Feature | Prior. | Status |
|----|-------|---------|--------|--------|
| PRJ-01 | Projetos | Criar projeto | Alta | 🟢 |
| PRJ-02 | Projetos | Editar projeto | Alta | 🟢 |
| PRJ-03 | Projetos | Excluir projeto | Alta | 🟢 (leva as tarefas junto; reuniões ficam sem projeto) |
| PRJ-04 | Projetos | Listar projetos | Alta | 🟢 (módulo próprio: blocos ou tabela ordenável, com CRUD na própria lista) |
| PRJ-05 | Projetos | Dashboard individual do projeto | Alta | 🟢 |
| PRJ-06 | Projetos | Associar reuniões ao projeto | Alta | 🟢 (na importação, na gravação e no painel da reunião) |
| KAN-01 | Kanban | Kanban individual por projeto | Alta | 🟢 |
| KAN-02 | Kanban | Colunas configuráveis | Média | ⬜ (fixas: backlog, em andamento, concluído) |
| KAN-03 | Kanban | Cards de tarefas | Alta | 🟢 |
| KAN-04 | Kanban | Drag-and-drop entre colunas | Alta | 🟢 |
| KAN-05 | Kanban | Abrir detalhes do card | Alta | 🟢 |
| KAN-06 | Kanban | Criar/editar/excluir tarefa manual | Alta | 🟢 |
| KAN-07 | Kanban | Vincular card à reunião de origem | Alta | 🟢 |
| AI-01 | IA | Extrair ações da reunião | Alta | 🟢 (`prompts/extrair.md`, saída JSON) |
| AI-02 | IA | Criar automaticamente cards das ações | Alta | 🟢 (roda ao fim do pipeline, antes do aviso de pronto) |
| AI-03 | IA | Gerar resumo da reunião | Alta | 🟢 (PDF sob demanda) |
| AI-04 | IA | Resumo PDF dentro do projeto | Alta | 🟢 (painel da reunião) |
| AI-05 | IA | Identificar contexto entre reuniões | Média | ⬜ M3 |
| REC-01 | Gravação | Iniciar gravação dentro do projeto | Alta | 🟢 (microfone + áudio do sistema) |
| REC-02 | Gravação | Pausar/continuar | Média | ⬜ |
| REC-03 | Gravação | Encerrar gravação | Alta | 🟢 |
| REC-04 | Gravação | Processar automaticamente após encerrar | Alta | 🟢 (mesmo pipeline da importação) |
| REC-05 | Gravação | Associar gravação ao projeto | Alta | 🟢 |
| MEM-01 | Memória | Indexar reuniões em Vector DB | Alta | ⬜ M3 |
| MEM-02 | Memória | Indexar tarefas/cards | Alta | ⬜ M3 |
| MEM-03 | Memória | Embeddings dos contextos | Alta | ⬜ M3 |
| MEM-04 | Memória | Relacionar reuniões semanticamente | Média | ⬜ M3 |
| MEM-05 | Memória | Relacionar tarefas semanticamente | Média | ⬜ M3 |
| MEM-06 | Memória | Grafo visual estilo Obsidian | Média | 🟢 (projeto ↔ reuniões ↔ tarefas; conceitos entram no M4) |
| MEM-07 | Memória | Abrir reunião/card clicando no nó | Média | 🟢 |
| CHAT-01 | Chat | Chat individual por projeto | Alta | 🟡 UI pronta; resposta ainda informa que a memória não está ligada |
| CHAT-02 | Chat | RAG sobre reuniões do projeto | Alta | ⬜ M3 |
| CHAT-03 | Chat | RAG sobre tarefas do projeto | Alta | ⬜ M3 |
| CHAT-04 | Chat | Histórico de conversas | Média | 🟡 em memória; falta persistir |
| CHAT-05 | Chat | Citar reunião utilizada | Alta | 🟡 UI pronta; depende do RAG |
| CHAT-06 | Chat | Citar tarefas/cards utilizados | Alta | 🟡 UI pronta; depende do RAG |
| UI-01 | Interface | Sidebar organizada por módulos | Alta | 🟢 |
| UI-02 | Interface | Navegação Projeto → Dashboard | Alta | 🟢 |
| UI-03 | Interface | Alternar Kanban/Reuniões/Grafo/Chat | Alta | 🟢 |
| SET-01 | Interface | Configurações centralizadas | Alta | 🟢 (motor, modelo, idioma, pasta de saída) |

## Milestones

- **M1 — Projects** ✅ projetos, kanban, reuniões vinculadas, grafo, gravação e
  extração automática de tarefas, tudo sobre a pasta de saída.
- **M2 — Meetings → Work** 🟡 falta pausar/continuar a gravação, colunas
  configuráveis e o resumo estruturado (hoje o resumo só existe em PDF).
- **M3 — Memory** ⬜ embeddings + Vector DB local, `chatAsk` real com RAG,
  citações clicáveis e relações semânticas entre reuniões e tarefas.
- **M4 — Neural Graph** ⬜ extração de entidades e conceitos; nós de conceito
  no grafo ligando reuniões que falam do mesmo assunto.

## Verificado nesta entrega

Áudio de teste (42 s, pt-BR) processado pelo app do começo ao fim:

```
audio 100% → transcription 100% (whisper.cpp, GPU AMD, 6 s) →
export 2 arquivo(s) → extract → 4 tarefas criadas com responsáveis
```

As tarefas saíram com título, descrição, responsável e prioridade, ligadas à
reunião de origem, e apareceram no kanban do projeto sem intervenção manual.

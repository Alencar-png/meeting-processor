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
| KAN-07 | Kanban | Vincular card à reunião de origem | Alta | 🟢 (e o painel da reunião lista as tarefas dela, abrindo o card) |
| AI-01 | IA | Analisar a reunião (uma leitura só) | Alta | 🟡 `prompts/analise.md` → `analise.json`; cards e PDF saem dela; falta verificar no app com reunião real |
| AI-02 | IA | Criar automaticamente cards das ações | Alta | 🟢 (roda ao fim do pipeline, antes do aviso de pronto) |
| AI-03 | IA | Gerar o documento da reunião | Alta | 🟡 PDF montado pelo app a partir da análise (`document-html.js`); a tabela de tarefas é a mesma do Kanban; falta verificar no app |
| AI-04 | IA | Documento PDF dentro do projeto | Alta | 🟢 (painel da reunião) |
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
| CHAT-01 | Chat | Chat individual por projeto | Alta | 🟡 é o Claude Code (`claude -p`) com sessão por projeto e system prompt do projeto (`project-chat.js`); falta verificar no app |
| CHAT-02 | Chat | Reuniões do projeto no chat | Alta | 🟡 o system prompt leva os caminhos de transcrição, análise e PDF; o Claude lê com Read (sem embeddings — M3 continua para busca semântica) |
| CHAT-03 | Chat | Tarefas do projeto no chat | Alta | 🟡 tarefas abertas entram no system prompt |
| CHAT-04 | Chat | Histórico de conversas | Média | 🟡 persistido em `chat_messages` (synapse.db); "Nova conversa" apaga e solta a sessão |
| CHAT-05 | Chat | Citar reunião utilizada | Alta | 🟡 o Claude cita no texto; as ferramentas usadas (arquivos lidos) aparecem acima da resposta |
| CHAT-06 | Chat | Citar tarefas/cards utilizados | Alta | 🟡 idem, no texto |
| CHAT-07 | Chat | Modo autônomo por projeto (bypass) | Alta | 🟡 interruptor no chat, desligado por padrão, com confirmação; `--dangerously-skip-permissions`; modo leitura só Read/Glob/Grep/web |
| PRJ-07 | Projetos | Pasta de trabalho do projeto | Alta | 🟡 diretório onde o Claude trabalha no chat (repositório, documentos); vazio usa a pasta de reuniões |
| UI-01 | Interface | Sidebar organizada por módulos | Alta | 🟢 |
| UI-02 | Interface | Navegação Projeto → Dashboard | Alta | 🟢 |
| UI-03 | Interface | Alternar Kanban/Reuniões/Grafo/Chat | Alta | 🟢 |
| SET-01 | Interface | Configurações centralizadas | Alta | 🟢 (motor, modelo, idioma, pasta de saída) |
| SET-02 | Interface | Ligar/desligar cada etapa depois da transcrição | Alta | 🟡 implementado (tarefas no Kanban, documento em PDF); falta verificar no app com reunião real |
| SET-03 | Interface | Ver e editar o prompt de cada etapa | Alta | 🟡 implementado (modal em Configurações; edição vale por cima do padrão, com restaurar); falta verificar no app |
| SET-04 | Interface | Atualizar o app pelo próprio app | Alta | 🟡 implementado (Sobre → verificar, lista dos commits, atualizar, reiniciar; recusa árvore suja e histórico divergente); falta verificar contra o remoto |
| UI-04 | Interface | Minimizar a tela de processamento e seguir usando o app | Alta | 🟡 implementado (chip na barra lateral com progresso; Esc minimiza); falta verificar no app |

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

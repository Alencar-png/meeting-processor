# Usar com Obsidian

O Meeting Processor escreve as reuniões em `vault/wiki/reunioes/` no
formato Markdown padrão, compatível com Obsidian e com o ecossistema
[claude-obsidian](https://github.com/) (wiki / index / hot / log).

## 1. Instalar o Obsidian

Baixe em <https://obsidian.md/download> (Windows / macOS / Linux).

## 2. Abrir o vault

1. Abra o Obsidian.
2. Clique em "Open folder as vault".
3. Selecione a pasta `vault/` deste repositório.

## 3. Plugins recomendados

Vá em **Settings → Community plugins → Browse** e instale:

| Plugin                | Para quê                                                    |
|-----------------------|-------------------------------------------------------------|
| **Kanban**            | Renderiza `Tarefas - *.md` como quadro Kanban arrastável.   |
| **Calendar**          | Mostra reuniões por data (criadas com frontmatter `created`). |
| **Banners** (opcional)| Capa visual das notas.                                      |

Os plugins já estão pré-configurados em `vault/.obsidian/plugins/`, então
provavelmente o Obsidian vai apenas pedir para habilitá-los.

## 4. Estrutura criada

Cada reunião gera uma pasta com 4 arquivos:

```
vault/wiki/reunioes/2026-05-07 14h30 - Reuniao com X/
├── 2026-05-07 14h30 - Reuniao com X.md         # nó central no grafo
├── Resumo - 2026-05-07 14h30 - Reuniao com X.md
├── Tarefas - 2026-05-07 14h30 - Reuniao com X.md   # vira Kanban
└── Transcricao - 2026-05-07 14h30 - Reuniao com X.md
```

Você pode renomear a pasta (e o `.md` central de mesmo nome) sem quebrar
nada — o grafo do Obsidian acompanha.

## 5. Acompanhar o processamento

O sistema é headless: o progresso aparece no console do watcher e em
`meeting_processor.log`. O estado de cada job também fica na tabela `jobs`
do SQLite (`meeting_processor.db`), consultável por script:

```bash
sqlite3 meeting_processor.db \
  "SELECT file, status, stage, progress, detail FROM jobs ORDER BY id DESC LIMIT 10;"
```

## 6. Não usar Obsidian

O Obsidian é opcional: as notas são Markdown puro e podem ser lidas por
qualquer editor. Sem ele, o Kanban (`Tarefas - *.md`) fica como uma lista
de checkboxes comum.

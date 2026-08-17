# Meeting Processor — app desktop

Solte um vídeo na janela; ele transcreve e grava os arquivos na pasta que você
escolher. Nada roda na nuvem: o Whisper trabalha dentro de um container Docker
na sua máquina.

## Como funciona

```
janela (Electron)  →  motor de transcrição  →  arquivos na pasta de saída
       ↑                      │
       └──── eventos JSONL ───┘
```

O app não fala Python: ele faz spawn do motor, que emite um evento JSON por
linha no stdout (`stage`, `done`, `error`). Isso mantém o Python headless e a
interface descartável.

## Os dois motores

Clique no indicador no canto superior direito para alternar.

| Motor | Onde roda | Velocidade |
|-------|-----------|------------|
| **GPU** (padrão) | Python do host + whisper.cpp com Vulkan | ~11x tempo real numa Radeon RX 9060 XT |
| **Docker** | container CPU-only | ~2x tempo real com 16 threads |

Medido no mesmo áudio de 5 min com `large-v3-turbo`: **27 s na GPU** contra
**153 s na CPU**. Uma reunião de 1 h sai em ~5 min na GPU.

O motor Docker existe para quando não há GPU ou whisper.cpp compilado — ele
não depende de nada instalado além do próprio Docker. No Windows, o Docker
Desktop **não** expõe GPU AMD, então container e GPU são exclusivos.

## Pré-requisitos

- **Node.js 20+** para abrir o app.
- Para o motor **GPU**: Python com as dependências do projeto, ffmpeg no PATH,
  `whisper-cli.exe` em `.whisper-cpp/` e ao menos um modelo `.bin` em
  `.models/`. Para compilar o whisper.cpp com Vulkan:

```bash
git clone --depth 1 --branch v1.9.2 https://github.com/ggml-org/whisper.cpp.git .whisper-cpp/src
cmake -S .whisper-cpp/src -B .whisper-cpp/src/build -DGGML_VULKAN=ON -DCMAKE_BUILD_TYPE=Release
cmake --build .whisper-cpp/src/build --config Release --target whisper-cli -j
cp .whisper-cpp/src/build/bin/Release/*.exe .whisper-cpp/src/build/bin/Release/*.dll .whisper-cpp/
```

- Para o motor **Docker**: Docker Desktop rodando e a imagem construída
  (`docker build -t meeting-processor:latest .`). Se faltar, o app oferece o
  botão **Construir imagem**.

## Rodar

```bash
cd desktop
npm install
npm start
```

## O que dá para ajustar

| Controle | O que muda |
|----------|------------|
| **Motor** (canto superior) | Alterna entre GPU e Docker. |
| **Salvar em** | Pasta onde o `.md` e o `.txt` são gravados. Fica salvo entre sessões. |
| **Modelo** | No motor GPU, lista os `.bin` de `.models/`. No Docker, `tiny` → `large-v3`. |
| **Idioma** | Idioma do áudio, ou `detectar`. |

No motor Docker o modelo é baixado uma vez para o volume
`meeting-processor-models`. No motor GPU, os modelos vêm de `.models/` —
baixe de <https://huggingface.co/ggerganov/whisper.cpp>. `large-v3-turbo` é o
melhor equilíbrio: qualidade de `large` com velocidade muito maior.

## Saída

Ao soltar um vídeo, o app **pergunta o nome da reunião** (sugerindo o nome do
arquivo). Esse nome vira uma pasta, e tudo daquela reunião mora nela:

```
Transcricoes/
└── Reunião com o cliente/
    ├── Reunião com o cliente.md            transcrição com timestamps
    ├── Reunião com o cliente.txt           só o texto
    ├── Reunião com o cliente - Tarefas.pdf
    ├── Reunião com o cliente - Resumo executivo.pdf
    └── meeting.json                        metadados da reunião
```

Se já existir uma pasta com esse nome, a nova vira `Reunião com o cliente (2)` —
nada é sobrescrito.

O `meeting.json` guarda **data e hora da gravação** (lidas do próprio vídeo, não
do momento da transcrição), duração, número de falas, modelo e idioma. Quando o
vídeo não traz a data nas suas tags, o app usa a data do arquivo e diz isso na
tela, em vez de apresentar um palpite como fato.

## Biblioteca (barra lateral)

A barra lateral lista as reuniões da pasta de saída, da mais recente para a mais
antiga, com a data e quais documentos já foram gerados. Clique numa reunião para
ver os metadados e a barra de ações:

| Ação | O que faz |
|------|-----------|
| **Visualizar** | Lê a transcrição dentro do app, com busca e destaque no texto. |
| **Baixar** | Salva uma cópia da transcrição onde você escolher. |
| **Gerar tarefas** | PDF com a lista de tarefas extraídas da reunião. |
| **Resumo executivo** | PDF com o resumo da reunião. |
| **Renomear** | Renomeia a pasta e todos os arquivos de uma vez. |
| **Excluir** | Apaga a reunião do disco, após confirmação. |
| Clique num arquivo | Abre no aplicativo padrão do sistema. |

A pasta de saída **é** a biblioteca: não há banco de dados nem índice paralelo.
Apagar uma pasta por fora do app some da lista, e nada quebra. Transcrições
antigas, gravadas soltas antes dessa organização, continuam aparecendo.

## Visão em tabela

O botão **tabela** no topo da barra lateral troca para uma tabela com todas as
reuniões: nome, data da gravação, duração, número de falas, modelo e quais
documentos existem.

- **Busca** por nome, arquivo de origem ou modelo.
- **Filtro** por documento: com/sem tarefas, com/sem resumo.
- **Ordenação** clicando no cabeçalho da coluna (clique de novo inverte).
- Clicar numa linha abre o detalhe daquela reunião.

## Tarefas e resumo executivo (PDF)

Os dois botões chamam o **Claude Code em modo headless** (`claude -p`), que lê a
transcrição, monta um HTML e o converte em PDF pelo Edge ou Chrome. Leva cerca de
um minuto; a janela mostra o que está acontecendo ("lendo a transcrição",
"convertendo para PDF") e abre o PDF ao terminar.

Os prompts ficam em `prompts/tarefas.md` e `prompts/resumo.md` — edite-os para
mudar o formato ou o conteúdo dos documentos, sem tocar no código. Eles instruem
o Claude a **não inventar** responsáveis, prazos ou decisões: o que a reunião não
definiu sai marcado como "não definido".

Requisitos: `claude` no PATH (autenticado) e Edge ou Chrome instalado. O app
considera o documento pronto só quando o arquivo PDF existe no disco — não basta
o modelo dizer que terminou.

## Estrutura

```
desktop/
├── main.js              # janela, IPC e execução dos processos
├── engines.js           # os dois motores: nativo (GPU) e container (CPU)
├── docker-args.js       # montagem do comando do container
├── claude-jobs.js       # geração de tarefas e resumo via `claude -p`
├── library.js           # a pasta de saída lida como biblioteca (CRUD)
│                        # e os metadados de cada reunião
├── preload.js           # ponte segura entre janela e sistema
├── prompts/             # instruções dos documentos (editáveis)
│   ├── tarefas.md
│   └── resumo.md
└── renderer/
    ├── index.html       # os estados da tela
    ├── styles.css       # direção visual (grafite, âmbar de VU meter)
    ├── wave.js          # a forma de onda: ela é o progresso
    ├── library-ui.js    # renderização da barra lateral e dos arquivos
    ├── table-ui.js      # tabela: busca, filtro e ordenação
    └── app.js           # estados, drop do arquivo e eventos
```

## Solução de problemas

| Sintoma | O que fazer |
|---------|-------------|
| "motor indisponível" | No modo GPU, confira `.whisper-cpp/whisper-cli.exe` e `.models/*.bin`. No Docker, abra o Docker Desktop e clique em **Verificar de novo**. |
| "Falta o motor de transcrição" | Clique em **Construir imagem** (leva alguns minutos na primeira vez). |
| Transcrição muito lenta | Confira o motor no topo da janela: se está em **Docker**, é CPU. A tela mostra `GPU: <placa>` no detalhe quando a GPU entra em ação. |
| Arquivo não aceito | Só vídeo e áudio: mkv, mp4, mov, webm, avi, mp3, wav, m4a e afins. |
| "O PDF não foi gerado" | Rode `claude` uma vez no terminal para confirmar que está autenticado, e verifique se há Edge ou Chrome instalado. |
| A barra lateral está vazia | Ela mostra a pasta em **Salvar em** — confira se é a pasta certa. |

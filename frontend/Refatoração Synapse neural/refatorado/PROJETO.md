# Synapse — frontend refatorado

Refatoração completa do frontend do **Meeting Processor**, agora **Synapse**:
mesmo comportamento, nova identidade. O tema é **conexões neurais** — o app
transforma fala em conhecimento, e a interface desenha exatamente isso: uma
rede de neurônios que acende conforme o sinal (a transcrição) se propaga.

---

## O que o sistema é

Um app desktop (Electron) que transforma **gravação de reunião em texto e
documentos**, 100% na máquina do usuário. Você arrasta um vídeo para a janela;
ele extrai o áudio (ffmpeg), transcreve com Whisper e grava os arquivos numa
pasta. Da transcrição, ainda gera **resumo executivo** e **lista de tarefas**
em PDF via Claude CLI.

O frontend roda isolado — sem Node, sem acesso a disco. Tudo passa pela ponte
`window.api` exposta pelo `preload.js` do Electron (IPC). Nada disso mudou na
refatoração: **a API consumida é exatamente a mesma**.

---

## A identidade: conexões neurais

| Decisão | Como aparece |
|---------|--------------|
| **Rede neural como elemento de assinatura** | O canvas do palco (`neural.js`) substitui a forma de onda. Não é decoração: é o estado do trabalho. Em repouso a rede respira baixinho; ao arrastar um vídeo ela inteira se excita; durante a transcrição o sinal se propaga da esquerda para a direita — neurônios acendem conforme o progresso e pulsos correm pelos axônios na frente de onda. Pronto = rede acesa em verde-menta; erro = vermelho apagado. |
| **Paleta** | Espaço profundo azul-tinta (`#070a14`), texto quase-branco frio. Dois acentos com o mesmo peso: **ciano elétrico** (`#53d5fd`, o sinal) e **violeta** (`#9d8bfa`, os pulsos). Menta para sucesso, coral para erro. |
| **Superfícies** | Painéis de vidro escuro: cantos arredondados, bordas finas, brilho ciano suave (`glow`) em foco/seleção — a luz é sempre informação (progresso, seleção, estado do motor). |
| **Tipografia** | Display geométrico do sistema (`Segoe UI Variable Display`/`Bahnschrift`), corpo `Segoe UI`, mono `Cascadia Code` para dados técnicos. Sem fontes externas: a CSP (`style-src 'self'`) continua intacta. |
| **Movimento** | Painéis sobem 8px ao entrar; a rede anima por `requestAnimationFrame`. Tudo respeita `prefers-reduced-motion`. |

---

## Os arquivos

| Arquivo | O que faz |
|---------|-----------|
| `index.html` | Estrutura da janela. Todos os painéis existem no HTML o tempo todo; só um fica visível, escolhido pelo atributo `data-state` no elemento `.app`. |
| `styles.css` | Toda a aparência — o tema neural inteiro vive aqui. Painéis aparecem/somem por seletores como `.app[data-state="working"] .panel-working`. |
| `app.js` | O cérebro da janela: máquina de estados (`idle`, `dragging`, `confirm`, `working`, `done`, `detail`, `viewer`, `table`, `context`, `groups`, `doc`, `error`, `blocked`), drag-and-drop, chamadas à `window.api` e eventos de progresso. Lógica preservada da base original. |
| `neural.js` | A rede neural do palco. Topologia determinística (mesma rede em toda execução): ~10 colunas de neurônios ligadas por axônios curvos; pulsos viajam pelas conexões; a frente de onda vertical marca onde a transcrição está. Expõe `window.createNeural(canvas)` → `{ setMode, setProgress, destroy }` — o mesmo contrato da onda antiga. |
| `library-ui.js` | Renderiza a lista de transcrições da coluna esquerda. |
| `table-ui.js` | Visão em tabela: ordenação por coluna, seleção múltipla, edição do nome na célula e ações em lote. |
| `mock-api.js` | **Só para desenvolvimento.** Se `window.api` não existe (fora do Electron), simula motor, biblioteca, jobs e geração de documentos com dados de demonstração — dá para abrir o `index.html` direto no navegador e usar tudo. Dentro do Electron é inerte (o preload define `window.api` antes). Pode remover no build final. |

---

## O que mudou vs. o que ficou

**Mudou**
- Identidade completa: paleta, tipografia, raios, brilhos, microinterações.
- `wave.js` → `neural.js`: a forma de onda virou rede neural, mantendo o
  contrato (`setMode`/`setProgress`) — em `app.js` só mudou a linha que cria
  o elemento.
- Wordmark **Synapse** com neurônio-marca no cabeçalho.
- `mock-api.js` novo, para rodar o frontend isolado.

**Ficou igual (de propósito)**
- Todos os ids, estados e fluxos do `app.js` — nenhuma regressão de
  comportamento.
- A superfície da `window.api` consumida (canais e métodos idênticos).
- A CSP restritiva do `index.html`.
- Acessibilidade: `aria-label`s, `focus-visible`, `prefers-reduced-motion`.

---

## Como usar no app

Substitua o conteúdo de `desktop/renderer/` por estes arquivos e rode:

```bash
cd desktop && npm install && npm start
```

Para ver fora do Electron, abra o `index.html` no navegador — o
`mock-api.js` assume com dados de demonstração.

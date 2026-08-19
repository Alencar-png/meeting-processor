'use strict';

/**
 * Geração dos documentos derivados da reunião (tarefas e resumo executivo)
 * pelo Claude Code em modo headless (`claude -p`).
 *
 * Os prompts ficam em `prompts/*.md`, fora do código, para poderem ser
 * ajustados sem mexer no app. O Claude lê a transcrição, monta um HTML e o
 * converte em PDF pelo navegador.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KINDS = {
  tarefas: { prompt: 'tarefas.md', suffix: 'Tarefas' },
  // "Resumo" e não "Resumo executivo": o registro do documento vem do contexto
  // do projeto, não de um formato fixo.
  resumo: { prompt: 'resumo.md', suffix: 'Resumo' },
};

// Navegadores capazes de imprimir HTML em PDF, na ordem de preferência.
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findBrowser() {
  return BROWSERS.find((b) => fs.existsSync(b)) || null;
}

/**
 * Onde o Claude Code costuma estar instalado, na ordem de preferência.
 *
 * Depender só do PATH quebra quando o app é aberto pelo Explorer ou por um
 * atalho: o processo herda um ambiente diferente do terminal, e o binário
 * some. A variável CLAUDE_BIN cobre instalações fora do lugar padrão.
 */
function findClaude() {
  const home = os.homedir();
  const candidatos = [
    process.env.CLAUDE_BIN,
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
  ].filter(Boolean);

  const achado = candidatos.find((c) => {
    try { return fs.existsSync(c); } catch { return false; }
  });
  // Sem caminho conhecido, ainda vale tentar pelo PATH do sistema.
  return achado || 'claude';
}

/**
 * Bloco de contexto inserido no prompt.
 *
 * Sem contexto, o texto diz isso explicitamente: um placeholder vazio deixaria
 * o modelo preenchendo a lacuna por conta própria.
 */
function contextBlock(context) {
  const texto = (context || '').trim();
  if (!texto) {
    return 'Nenhum contexto foi fornecido. Baseie-se apenas na transcrição e '
      + 'mantenha um registro profissional e neutro.';
  }
  return [
    'O contexto abaixo descreve o projeto e o tipo de documento esperado.',
    'Use-o para ajustar o foco, o vocabulário e o registro do texto — mas ele',
    'não é fonte de fatos: nada que esteja apenas no contexto pode virar',
    'decisão, tarefa ou conclusão atribuída à reunião.',
    '',
    '```',
    texto,
    '```',
  ].join('\n');
}

/** Monta o prompt final a partir do template, com caminhos absolutos. */
function buildPrompt(kind, { transcriptPath, pdfPath, browser, context = '' }) {
  const config = KINDS[kind];
  if (!config) throw new Error(`Tipo de documento desconhecido: ${kind}`);

  const template = fs.readFileSync(
    path.join(__dirname, 'prompts', config.prompt),
    'utf-8',
  );
  const htmlTmp = path.join(
    os.tmpdir(),
    `mp-${kind}-${path.basename(pdfPath, '.pdf')}.html`,
  );

  return template
    .replaceAll('{{TRANSCRICAO}}', transcriptPath)
    .replaceAll('{{PDF}}', pdfPath)
    .replaceAll('{{HTML_TMP}}', htmlTmp)
    .replaceAll('{{EDGE}}', browser)
    .replaceAll('{{CONTEXTO}}', contextBlock(context));
}

/**
 * Prompt da extração estruturada (AI-02): o Claude lê a transcrição e grava um
 * JSON com as ações combinadas. Sai dados, não documento — o PDF continua
 * sendo uma visualização gerada à parte.
 */
function buildExtractionPrompt({ transcriptPath, jsonPath, context = '' }) {
  const template = fs.readFileSync(path.join(__dirname, 'prompts', 'extrair.md'), 'utf-8');
  return template
    .replaceAll('{{TRANSCRICAO}}', transcriptPath)
    .replaceAll('{{JSON}}', jsonPath)
    .replaceAll('{{CONTEXTO}}', contextBlock(context));
}

/** Onde o JSON temporário da extração é gravado. */
function extractionPathFor(transcriptPath) {
  return path.join(
    os.tmpdir(),
    `synapse-extracao-${path.basename(transcriptPath, path.extname(transcriptPath))}.json`,
  );
}

/** Caminho do PDF gerado para uma transcrição. */
function pdfPathFor(kind, transcriptPath) {
  const dir = path.dirname(transcriptPath);
  const stem = path.basename(transcriptPath, path.extname(transcriptPath));
  return path.join(dir, `${stem} - ${KINDS[kind].suffix}.pdf`);
}

/**
 * Argumentos do `claude -p`. O prompt NÃO vai aqui: ele é escrito no stdin.
 *
 * Como argumento, um prompt de várias linhas com aspas e barras é destruído
 * pelo shell do Windows — o processo chega a rodar, mas sem instrução nenhuma.
 *
 * `stream-json` (que exige `--verbose`) permite acompanhar o trabalho em vez
 * de olhar para uma tela parada por dois minutos.
 */
function buildClaudeArgs({ model = 'sonnet' } = {}) {
  return [
    '-p',
    '--allowedTools', 'Read,Write,Bash',
    '--permission-mode', 'acceptEdits',
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
  ];
}

/**
 * Traduz um evento do stream do Claude numa frase curta para a interface.
 * Devolve null quando o evento não interessa ao usuário.
 */
function describeEvent(event) {
  if (event.type === 'assistant') {
    const blocks = event.message?.content || [];
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        if (block.name === 'Read') return 'lendo a transcrição';
        if (block.name === 'Write') return 'escrevendo o documento';
        if (block.name === 'Bash') return 'convertendo para PDF';
        return `usando ${block.name}`;
      }
      if (block.type === 'text' && block.text.trim()) return 'analisando a reunião';
    }
  }
  if (event.type === 'result') {
    return event.is_error ? 'erro ao gerar o documento' : 'documento pronto';
  }
  return null;
}

module.exports = {
  KINDS,
  findClaude,
  buildClaudeArgs,
  buildExtractionPrompt,
  buildPrompt,
  describeEvent,
  extractionPathFor,
  findBrowser,
  pdfPathFor,
};

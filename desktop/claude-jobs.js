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
  resumo: { prompt: 'resumo.md', suffix: 'Resumo executivo' },
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

/** Monta o prompt final a partir do template, com caminhos absolutos. */
function buildPrompt(kind, { transcriptPath, pdfPath, browser }) {
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
    .replaceAll('{{EDGE}}', browser);
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

module.exports = { KINDS, buildClaudeArgs, buildPrompt, describeEvent, findBrowser, pdfPathFor };

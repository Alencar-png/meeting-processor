'use strict';

/**
 * Importação de transcrições já prontas.
 *
 * Nem toda reunião passa pelo microfone: legendas do Teams e do Zoom, textos
 * colados de outra ferramenta e transcrições antigas também são material de
 * trabalho. Aqui esses arquivos viram uma reunião igual às demais — mesma
 * pasta, mesmo `meeting.json` — e daí em diante seguem o caminho normal:
 * projeto, extração de tarefas, documentos.
 */

const fs = require('node:fs');
const path = require('node:path');

const EXTENSIONS = ['txt', 'md', 'srt', 'vtt'];

// Caracteres proibidos em nome de arquivo no Windows.
const INVALID_CHARS = /[<>:"/\\|?*]/;

/** "00:01:23,450" e "01:23.450" viram segundos. */
function toSeconds(stamp) {
  const partes = stamp.replace(',', '.').split(':').map(Number);
  if (partes.some(Number.isNaN)) return 0;
  return partes.reduce((total, n) => total * 60 + n, 0);
}

/** Segundos viram "MM:SS" ou "HH:MM:SS" — o formato que o app já lê. */
function toStamp(segundos) {
  const s = Math.max(0, Math.round(segundos));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const seg = s % 60;
  const dois = (n) => String(n).padStart(2, '0');
  return h ? `${dois(h)}:${dois(m)}:${dois(seg)}` : `${dois(m)}:${dois(seg)}`;
}

/**
 * Legendas (.srt/.vtt) viram falas com horário.
 *
 * Os dois formatos são blocos separados por linha em branco, com uma linha de
 * tempo "início --> fim". O índice numérico do SRT e o cabeçalho WEBVTT são
 * descartados: não dizem nada sobre a reunião.
 */
function parseSubtitles(texto) {
  const falas = [];
  const blocos = texto.replace(/\r/g, '').split(/\n{2,}/);

  for (const bloco of blocos) {
    const linhas = bloco.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!linhas.length) continue;
    if (linhas[0].toUpperCase().startsWith('WEBVTT')) continue;

    const tempoIdx = linhas.findIndex((l) => l.includes('-->'));
    if (tempoIdx === -1) continue;

    const inicio = linhas[tempoIdx].split('-->')[0].trim().split(' ')[0];
    const fala = linhas.slice(tempoIdx + 1).join(' ').trim();
    if (!fala) continue;

    falas.push({ at: toSeconds(inicio), text: fala });
  }

  return falas;
}

/** Texto corrido: cada parágrafo é uma fala, sem horário para inventar. */
function parsePlain(texto) {
  return texto
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((text) => ({ at: null, text }));
}

/** Monta o Markdown no mesmo formato que o pipeline grava. */
function toMarkdown(nome, falas, origem, quando) {
  const cabecalho = [
    `# ${nome}`,
    '',
    `**Gravado em:** ${quando}`,
    '**Origem:** transcrição importada',
    `**Arquivo:** ${origem}`,
    '',
    '---',
    '',
  ];
  const corpo = falas.map((f) => (f.at === null
    ? f.text
    : `**[${toStamp(f.at)}]** ${f.text}`));
  return `${cabecalho.concat(corpo).join('\n')}\n`;
}

function formatDate(data) {
  const dois = (n) => String(n).padStart(2, '0');
  return `${data.getFullYear()}-${dois(data.getMonth() + 1)}-${dois(data.getDate())} `
    + `${dois(data.getHours())}:${dois(data.getMinutes())}:${dois(data.getSeconds())}`;
}

/**
 * Importa o arquivo como uma reunião nova.
 *
 * A pasta leva o nome escolhido, como na transcrição gerada pelo app; se já
 * existir, a importação para em vez de misturar dois conteúdos na mesma pasta.
 */
function importTranscript({ filePath, outputDir, name, language = 'pt' }) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, message: 'Arquivo não encontrado.' };
  }

  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!EXTENSIONS.includes(ext)) {
    return { ok: false, message: `Formato .${ext} não é uma transcrição (use ${EXTENSIONS.join(', ')}).` };
  }

  const nome = (name || path.basename(filePath, path.extname(filePath))).trim();
  if (!nome) return { ok: false, message: 'Dê um nome à reunião.' };
  if (INVALID_CHARS.test(nome)) {
    return { ok: false, message: 'O nome não pode conter < > : " / \\ | ? *' };
  }

  let bruto;
  try {
    bruto = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return { ok: false, message: `Não foi possível ler o arquivo: ${err.message}` };
  }

  const falas = ext === 'srt' || ext === 'vtt' ? parseSubtitles(bruto) : parsePlain(bruto);
  if (!falas.length) {
    return { ok: false, message: 'O arquivo está vazio ou não tem texto reconhecível.' };
  }

  const destino = path.join(outputDir, nome);
  if (fs.existsSync(destino)) {
    return { ok: false, message: `Já existe uma reunião chamada "${nome}".` };
  }

  // A data do arquivo é a melhor pista de quando a reunião aconteceu.
  let quando = new Date();
  try {
    quando = fs.statSync(filePath).mtime;
  } catch { /* mantém agora */ }

  const comTempo = falas.filter((f) => f.at !== null);
  const duracao = comTempo.length ? comTempo[comTempo.length - 1].at : 0;

  try {
    fs.mkdirSync(destino, { recursive: true });
    fs.writeFileSync(
      path.join(destino, `${nome}.md`),
      toMarkdown(nome, falas, path.basename(filePath), formatDate(quando)),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(destino, `${nome}.txt`),
      `${falas.map((f) => f.text).join('\n\n')}\n`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(destino, 'meeting.json'),
      `${JSON.stringify({
        name: nome,
        source_file: path.basename(filePath),
        recorded_at_local: formatDate(quando),
        duration_seconds: duracao,
        segments: falas.length,
        language,
        model: 'importada',
        imported_at: formatDate(new Date()),
        files: [`${nome}.md`, `${nome}.txt`],
      }, null, 2)}\n`,
      'utf-8',
    );
  } catch (err) {
    return { ok: false, message: `Não foi possível gravar a reunião: ${err.message}` };
  }

  return {
    ok: true,
    id: nome,
    transcriptPath: path.join(destino, `${nome}.md`),
    segments: falas.length,
    duration: duracao,
  };
}

module.exports = { EXTENSIONS, importTranscript, parsePlain, parseSubtitles, toStamp };

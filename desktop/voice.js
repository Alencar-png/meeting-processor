'use strict';

/**
 * Voz no chat do projeto: o recado gravado vira texto.
 *
 * O Claude Code em modo headless (`claude -p`) não tem canal de áudio, e nem
 * precisa: o Synapse já tem um transcritor rápido na GPU. Um recado de dez
 * segundos vira texto em cerca de um — com o mesmo whisper.cpp, o mesmo
 * modelo e o mesmo VAD das reuniões, tudo na máquina.
 *
 * `run(command, args)` é injetado: no app é o spawn de verdade; nos testes,
 * um ffmpeg e um whisper de mentira.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** O modelo de detecção de voz (Silero), se estiver em .models/. */
function findVadModel(projectRoot) {
  const dir = path.join(projectRoot, '.models');
  try {
    const nome = fs.readdirSync(dir).find((n) => n.endsWith('.bin') && /silero|vad/i.test(n));
    return nome ? path.join(dir, nome) : null;
  } catch {
    return null;
  }
}

/** O recado (webm/ogg do navegador) vira WAV 16 kHz mono, o formato do Whisper. */
function buildFfmpegArgs({ clipPath, wavPath }) {
  return ['-y', '-loglevel', 'error', '-i', clipPath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath];
}

/** whisper-cli com saída JSON, VAD quando há modelo, e sem tokens não-fala. */
function buildClipArgs({ modelPath, wavPath, outBase, language = 'pt', threads = 4, vadModel = null }) {
  const args = [
    '-m', modelPath,
    '-f', wavPath,
    '-l', language || 'pt',
    '-t', String(threads || 4),
    '-oj', '-of', outBase,
    '--no-prints',
    '--suppress-nst',
  ];
  if (vadModel) args.push('--vad', '--vad-model', vadModel);
  return args;
}

/** O texto do recado: segmentos unidos, repetição imediata colapsada. */
function textFromWhisperJson(json) {
  const partes = [];
  for (const seg of json?.transcription || []) {
    const texto = String(seg.text || '').trim();
    if (!texto) continue;
    if (partes.length && partes[partes.length - 1].toLowerCase() === texto.toLowerCase()) continue;
    partes.push(texto);
  }
  return partes.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Do arquivo gravado ao texto. Os temporários (WAV e JSON) somem no fim,
 * dê certo ou errado.
 */
async function transcribeClip({
  clipPath, cli, modelPath, vadModel = null, language = 'pt', threads = 4, run, tmpDir = os.tmpdir(),
}) {
  const base = path.join(tmpDir, `synapse-recado-${Date.now()}-${process.pid}`);
  const wavPath = `${base}.wav`;
  const jsonPath = `${base}.json`;
  const ultimaLinha = (texto) => String(texto || '').split('\n').filter(Boolean).pop() || 'sem detalhe';

  try {
    const ff = await run('ffmpeg', buildFfmpegArgs({ clipPath, wavPath }));
    if (ff.code !== 0) {
      return { ok: false, message: `O ffmpeg não converteu o recado: ${ultimaLinha(ff.stderr)}` };
    }
    const w = await run(cli, buildClipArgs({ modelPath, wavPath, outBase: base, language, threads, vadModel }));
    if (w.code !== 0) {
      return { ok: false, message: `O whisper não transcreveu o recado: ${ultimaLinha(w.stderr)}` };
    }
    let json;
    try {
      json = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    } catch (err) {
      return { ok: false, message: `Não deu para ler a transcrição do recado: ${err.message}` };
    }
    return { ok: true, text: textFromWhisperJson(json) };
  } finally {
    for (const f of [wavPath, jsonPath]) {
      try { fs.unlinkSync(f); } catch { /* já removido ou nunca criado */ }
    }
  }
}

module.exports = {
  buildClipArgs,
  buildFfmpegArgs,
  findVadModel,
  textFromWhisperJson,
  transcribeClip,
};

'use strict';

/**
 * O recado de voz vira texto com o mesmo whisper das reuniões. ffmpeg e
 * whisper aqui são de mentira: o teste fixa os argumentos, a leitura do JSON
 * e a limpeza dos temporários.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const {
  buildClipArgs,
  buildFfmpegArgs,
  findVadModel,
  textFromWhisperJson,
  transcribeClip,
} = require('../voice');

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-voz-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('ffmpeg converte para WAV 16 kHz mono, sobrescrevendo', () => {
  const args = buildFfmpegArgs({ clipPath: 'C:\\t\\recado.webm', wavPath: 'C:\\t\\recado.wav' });
  assert.ok(args.includes('-y'));
  assert.strictEqual(args[args.indexOf('-ar') + 1], '16000');
  assert.strictEqual(args[args.indexOf('-ac') + 1], '1');
  assert.strictEqual(args[args.length - 1], 'C:\\t\\recado.wav');
});

test('whisper-cli: JSON, sem prints, sem tokens não-fala, VAD só com modelo', () => {
  const sem = buildClipArgs({ modelPath: 'm.bin', wavPath: 'a.wav', outBase: 'C:\\t\\x', language: 'pt', threads: 16 });
  assert.ok(sem.includes('-oj') && sem.includes('--no-prints') && sem.includes('--suppress-nst'));
  assert.strictEqual(sem[sem.indexOf('-of') + 1], 'C:\\t\\x');
  assert.strictEqual(sem[sem.indexOf('-t') + 1], '16');
  assert.ok(!sem.includes('--vad'));

  const com = buildClipArgs({ modelPath: 'm.bin', wavPath: 'a.wav', outBase: 'x', vadModel: 'C:\\m\\silero.bin' });
  assert.strictEqual(com[com.indexOf('--vad-model') + 1], 'C:\\m\\silero.bin');
  assert.strictEqual(com[com.indexOf('-l') + 1], 'pt');
});

test('textFromWhisperJson une segmentos e colapsa repetição imediata', () => {
  const json = { transcription: [
    { text: ' Cria uma tarefa ' }, { text: 'para revisar o contrato.' }, { text: 'Tchau.' }, { text: 'tchau.' }, { text: '' },
  ] };
  assert.strictEqual(textFromWhisperJson(json), 'Cria uma tarefa para revisar o contrato. Tchau.');
  assert.strictEqual(textFromWhisperJson({}), '');
  assert.strictEqual(textFromWhisperJson(null), '');
});

test('findVadModel acha o Silero em .models e devolve null sem ele', () => {
  const root = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(root, '.models'), { recursive: true });
  assert.strictEqual(findVadModel(root), null);
  fs.writeFileSync(path.join(root, '.models', 'ggml-large-v3-turbo.bin'), '');
  assert.strictEqual(findVadModel(root), null, 'o modelo de transcrição não é VAD');
  fs.writeFileSync(path.join(root, '.models', 'ggml-silero-v5.1.2.bin'), '');
  assert.strictEqual(findVadModel(root), path.join(root, '.models', 'ggml-silero-v5.1.2.bin'));
  assert.strictEqual(findVadModel(path.join(tmp, 'nao-existe')), null);
});

test('transcribeClip: ffmpeg → whisper → texto, e limpa os temporários', async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    if (command === 'ffmpeg') { fs.writeFileSync(args[args.length - 1], ''); return { code: 0, stdout: '', stderr: '' }; }
    const base = args[args.indexOf('-of') + 1];
    fs.writeFileSync(`${base}.json`, JSON.stringify({ transcription: [{ text: ' Olá, ' }, { text: 'tudo bem?' }] }));
    return { code: 0, stdout: '', stderr: '' };
  };
  const r = await transcribeClip({
    clipPath: 'C:\\t\\recado.webm', cli: 'whisper-cli.exe', modelPath: 'm.bin', vadModel: 'v.bin',
    language: 'pt', threads: 8, run, tmpDir: tmp,
  });
  assert.deepStrictEqual(r, { ok: true, text: 'Olá, tudo bem?' });
  assert.strictEqual(calls[0].command, 'ffmpeg');
  assert.strictEqual(calls[1].command, 'whisper-cli.exe');
  assert.ok(calls[1].args.includes('--vad'));
  const sobras = fs.readdirSync(tmp).filter((n) => n.startsWith('synapse-recado-'));
  assert.deepStrictEqual(sobras, [], 'wav e json temporários somem');
});

test('transcribeClip: ffmpeg falhando vira mensagem com a última linha do stderr', async () => {
  const run = async () => ({ code: 1, stdout: '', stderr: 'x\nInvalid data found when processing input' });
  const r = await transcribeClip({ clipPath: 'c.webm', cli: 'w', modelPath: 'm', run, tmpDir: tmp });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /Invalid data found/);
});

test('transcribeClip: whisper sem JSON legível vira mensagem, não exceção', async () => {
  const run = async (command, args) => {
    if (command === 'ffmpeg') { fs.writeFileSync(args[args.length - 1], ''); return { code: 0, stdout: '', stderr: '' }; }
    return { code: 0, stdout: '', stderr: '' };   // não escreveu o .json
  };
  const r = await transcribeClip({ clipPath: 'c.webm', cli: 'w', modelPath: 'm', run, tmpDir: tmp });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /ler a transcrição/);
});

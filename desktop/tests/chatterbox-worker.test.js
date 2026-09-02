'use strict';

/**
 * O worker do Chatterbox é um processo Python que fala por stdin/stdout. Aqui
 * o processo é de mentira: o teste fixa o protocolo (ready, pedidos com id,
 * respostas), a fila, o desligamento por ociosidade e as falhas.
 */

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const { REQUIRED_WEIGHTS, chatterboxStatus, createChatterboxWorker } = require('../chatterbox-worker');

let root;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-cb-'));
  fs.mkdirSync(path.join(root, '.venv-tts', 'Scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, '.venv-tts', 'Scripts', 'python.exe'), '');
  fs.mkdirSync(path.join(root, '.models', 'chatterbox-pt-br'), { recursive: true });
  for (const f of REQUIRED_WEIGHTS) fs.writeFileSync(path.join(root, '.models', 'chatterbox-pt-br', f), '');
});
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** Um filho falso: guarda o que recebeu no stdin e deixa o teste responder. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.written = [];
  child.stdin = { write: (s) => child.written.push(s), end: () => {} };
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.say = (obj) => child.stdout.emit('data', `${JSON.stringify(obj)}\n`);
  return child;
}

test('chatterboxStatus diz o que falta', () => {
  const ok = chatterboxStatus(root);
  assert.strictEqual(ok.ok, true);
  assert.ok(ok.python.endsWith('python.exe'));

  const vazio = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-cb-vazio-'));
  const sem = chatterboxStatus(vazio);
  assert.strictEqual(sem.ok, false);
  assert.match(sem.message, /\.venv-tts/);
  fs.rmSync(vazio, { recursive: true, force: true });
});

test('sobe o worker uma vez, espera o ready e responde por id', async () => {
  const children = [];
  const spawn = () => { const c = fakeChild(); children.push(c); return c; };
  const timers = [];
  const w = createChatterboxWorker({
    projectRoot: root, spawn, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
  });

  const p1 = w.speak({ text: 'Olá', out: 'C:\\t\\a.wav' });
  const p2 = w.speak({ text: 'Tudo bem?', out: 'C:\\t\\b.wav' });
  assert.strictEqual(children.length, 1, 'um processo só');
  const child = children[0];
  assert.strictEqual(child.written.length, 0, 'nada vai antes do ready');

  child.say({ event: 'ready', load_seconds: 42.5, sr: 24000 });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(child.written.length, 2);
  const req1 = JSON.parse(child.written[0]);
  const req2 = JSON.parse(child.written[1]);
  assert.deepStrictEqual([req1.text, req2.text], ['Olá', 'Tudo bem?']);
  assert.ok(req1.id !== req2.id);

  // Respostas fora de ordem casam pelo id.
  child.say({ id: req2.id, ok: true, out: 'C:\\t\\b.wav', seconds: 3.2 });
  child.say({ id: req1.id, ok: true, out: 'C:\\t\\a.wav', seconds: 2.1 });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepStrictEqual(r1, { id: req1.id, ok: true, out: 'C:\\t\\a.wav', seconds: 2.1 });
  assert.strictEqual(r2.out, 'C:\\t\\b.wav');
  assert.strictEqual(w.status().running, true);
  assert.strictEqual(w.status().loadSeconds, 42.5);

  // O timer de ociosidade foi armado depois da fala; disparar derruba o worker.
  const idle = timers.filter((t) => t.ms === 10 * 60 * 1000).pop();
  assert.ok(idle, 'timer de ociosidade armado');
  idle.fn();
  assert.strictEqual(child.killed, true);
  assert.strictEqual(w.status().running, false);
});

test('erro ao carregar vira mensagem e o worker não fica pendurado', async () => {
  const child = fakeChild();
  const w = createChatterboxWorker({ projectRoot: root, spawn: () => child, setTimer: () => 1, clearTimer: () => {} });
  const p = w.speak({ text: 'x', out: 'y' });
  child.say({ event: 'error', message: 'não deu para carregar o Chatterbox: FileNotFoundError' });
  const r = await p;
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /FileNotFoundError/);
  assert.strictEqual(child.killed, true);
  assert.strictEqual(w.status().running, false);
});

test('worker que morre no meio responde aos pedidos pendentes', async () => {
  const child = fakeChild();
  const w = createChatterboxWorker({ projectRoot: root, spawn: () => child, setTimer: () => 1, clearTimer: () => {} });
  const p = w.speak({ text: 'x', out: 'y' });
  child.say({ event: 'ready', load_seconds: 1 });
  await new Promise((r) => setImmediate(r));
  child.stderr.emit('data', 'MemoryError: sem RAM\n');
  child.emit('close', 1);
  const r = await p;
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /MemoryError/);
  assert.strictEqual(w.status().running, false);
});

test('sem venv ou pesos, speak devolve o motivo sem tentar spawn', async () => {
  const vazio = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-cb-vazio2-'));
  let spawned = false;
  const w = createChatterboxWorker({ projectRoot: vazio, spawn: () => { spawned = true; return fakeChild(); } });
  const r = await w.speak({ text: 'x', out: 'y' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(spawned, false);
  fs.rmSync(vazio, { recursive: true, force: true });
});

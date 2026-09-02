'use strict';

/**
 * O worker do Chatterbox: um processo Python que carrega o modelo uma vez e
 * fala quantas vezes pedirem.
 *
 * Carregar 3 GB de pesos leva dezenas de segundos em CPU; fazer isso a cada
 * resposta seria inviável. Então o app sobe o worker na primeira fala, manda
 * os pedidos por stdin (um JSON por linha) e lê as respostas do stdout. Sem
 * uso por um tempo, o worker é derrubado para devolver a memória (~4 GB).
 *
 * `spawn` é injetado para o protocolo poder ser testado com um filho de
 * mentira. Nada aqui sabe de Electron.
 */

const path = require('node:path');
const fs = require('node:fs');

const IDLE_MS = 10 * 60 * 1000;      // dez minutos sem falar: libera a memória
const READY_TIMEOUT_MS = 5 * 60 * 1000;   // carga em CPU fria pode passar de um minuto

// O ambiente com GPU (ROCm/CUDA) tem preferência sobre o de CPU, quando existe.
const PYTHON_CANDIDATES = [
  path.join('.venv-tts-gpu', 'Scripts', 'python.exe'),
  path.join('.venv-tts-gpu', 'bin', 'python'),
  path.join('.venv-tts', 'Scripts', 'python.exe'),
  path.join('.venv-tts', 'bin', 'python'),
];
const MODEL_REL = path.join('.models', 'chatterbox-pt-br');
const REQUIRED_WEIGHTS = ['t3_pt_br.safetensors', 's3gen_v3.pt', 've.pt', 'grapheme_mtl_merged_expanded_v1.json'];

/** O que falta para o Chatterbox funcionar nesta máquina, se faltar algo. */
function chatterboxStatus(projectRoot) {
  const python = PYTHON_CANDIDATES.map((rel) => path.join(projectRoot, rel))
    .find((p) => fs.existsSync(p)) || null;
  const modelDir = path.join(projectRoot, MODEL_REL);
  const missing = REQUIRED_WEIGHTS.filter((f) => !fs.existsSync(path.join(modelDir, f)));
  const ok = Boolean(python) && missing.length === 0;
  let message = '';
  if (!python) message = 'Falta o ambiente do Chatterbox (.venv-tts). Veja o README: "Voz offline com o Chatterbox".';
  else if (missing.length) message = `Faltam pesos do Chatterbox em .models/chatterbox-pt-br: ${missing.join(', ')}.`;
  return { ok, python, modelDir, missing, message };
}

function createChatterboxWorker({
  projectRoot,
  spawn,
  idleMs = IDLE_MS,
  readyTimeoutMs = READY_TIMEOUT_MS,
  log = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  // No Windows o python.exe de um venv é um lançador que cria o interpretador
  // de verdade como filho: matar só o pai deixaria 4 GB órfãos. Quem chama
  // pode passar um killTree (taskkill /t); o padrão serve para os testes.
  killTree = (c) => c.kill(),
}) {
  let child = null;
  let ready = null;          // Promise que resolve quando o modelo carregou
  let nextId = 1;
  const pending = new Map(); // id → { resolve }
  let idleTimer = null;
  let loadSeconds = 0;
  let device = '';

  function armIdle() {
    if (idleTimer) clearTimer(idleTimer);
    idleTimer = setTimer(() => stop('ocioso'), idleMs);
  }

  function failAll(message) {
    for (const { resolve } of pending.values()) resolve({ ok: false, message });
    pending.clear();
  }

  function stop(reason = '') {
    if (idleTimer) { clearTimer(idleTimer); idleTimer = null; }
    if (!child) return;
    log(`Chatterbox: encerrando o worker${reason ? ` (${reason})` : ''}.`);
    const c = child;
    child = null;
    ready = null;
    failAll('O worker de voz foi encerrado.');
    try { c.stdin.end(); } catch { /* já fechado */ }
    try { killTree(c); } catch { /* já morto */ }
  }

  function handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
      return;
    }
    if (msg.event === 'ready') {
      loadSeconds = Number(msg.load_seconds) || 0;
      device = String(msg.device || '');
    }
  }

  function start() {
    if (ready) return ready;
    const status = chatterboxStatus(projectRoot);
    if (!status.ok) return Promise.resolve({ ok: false, message: status.message });

    log('Chatterbox: carregando o modelo…');
    // Metade dos processadores lógicos ≈ os núcleos físicos: medido nesta
    // classe de CPU, 8 threads foram 30% mais rápidos que 16 (o SMT atrapalha).
    const threads = Math.max(1, Math.floor(require('node:os').cpus().length / 2));
    const args = [
      '-m', 'meeting_processor.tts_chatterbox', '--model-dir', status.modelDir,
      '--threads', String(threads), '--device', 'auto', '--serve',
    ];
    child = spawn(status.python, args, { cwd: projectRoot, windowsHide: true });
    const started = child;

    ready = new Promise((resolve) => {
      let buffer = '';
      let stderr = '';
      let settled = false;
      const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
      const timer = setTimer(() => {
        settle({ ok: false, message: 'O Chatterbox demorou demais para carregar.' });
        stop('tempo esgotado');
      }, readyTimeoutMs);

      started.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) continue;
          let msg;
          try { msg = JSON.parse(trimmed); } catch { continue; }
          if (msg.event === 'ready') { clearTimer(timer); handleLine(trimmed); settle({ ok: true }); continue; }
          if (msg.event === 'error') { clearTimer(timer); settle({ ok: false, message: msg.message }); stop('erro ao carregar'); continue; }
          handleLine(trimmed);
        }
      });
      started.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      started.on('error', (err) => {
        clearTimer(timer);
        settle({ ok: false, message: `não foi possível iniciar o worker do Chatterbox (${err.code || err.message}).` });
        if (child === started) { child = null; ready = null; }
      });
      started.on('close', (code) => {
        clearTimer(timer);
        const motivo = stderr.split('\n').filter(Boolean).pop() || `código ${code}`;
        settle({ ok: false, message: `O worker do Chatterbox saiu antes de ficar pronto: ${motivo}` });
        if (child === started) {
          child = null;
          ready = null;
          failAll(`O worker de voz caiu: ${motivo}`);
        }
      });
    });
    return ready;
  }

  /**
   * Sintetiza `text` no arquivo `out` (WAV). Sobe o worker se preciso.
   * Resolve `{ ok, out, seconds }` ou `{ ok: false, message }`.
   */
  async function speak({ text, out, ref = '', exaggeration = 0.5, cfg = 0.5 }) {
    const up = await start();
    if (!up.ok) return up;
    if (!child) return { ok: false, message: 'O worker de voz não está de pé.' };
    const id = nextId++;
    const resposta = new Promise((resolve) => pending.set(id, { resolve }));
    child.stdin.write(`${JSON.stringify({ id, text, out, ref, exaggeration, cfg })}\n`);
    const r = await resposta;
    armIdle();
    return r;
  }

  return {
    speak,
    stop,
    status: () => ({ ...chatterboxStatus(projectRoot), running: Boolean(child), loadSeconds, device }),
  };
}

module.exports = { IDLE_MS, MODEL_REL, REQUIRED_WEIGHTS, chatterboxStatus, createChatterboxWorker };

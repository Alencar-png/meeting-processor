'use strict';

/**
 * A atualização pelo app é `git pull --ff-only` mais reinstalar o que mudou.
 * Aqui o git é de mentira: cada teste diz o que cada comando responde, e a
 * gente confere o que o updater decide — sem rede, sem tocar no repositório.
 */

const assert = require('node:assert');
const { test } = require('node:test');

const {
  createUpdater,
  describeCheck,
  needsNpmInstall,
  needsPipInstall,
  parseAheadBehind,
} = require('../updater');

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'erro') => ({ code: 1, stdout: '', stderr });

/** Um `run` que responde por comando ("git rev-parse HEAD" → resposta) e anota o que foi chamado. */
function fakeRun(answers) {
  const calls = [];
  const run = async (command, args, options) => {
    const key = `${command} ${args.join(' ')}`;
    calls.push({ key, cwd: options?.cwd });
    const found = Object.entries(answers).find(([prefix]) => key.startsWith(prefix));
    return found ? (typeof found[1] === 'function' ? found[1]() : found[1]) : fail(`comando inesperado: ${key}`);
  };
  return { run, calls };
}

const BASE = {
  'git rev-parse --abbrev-ref HEAD': ok('master\n'),
  'git log -1 --format=': ok('12c850d\n2026-08-19T17:00:00-03:00\nrefactor: só o Synapse\n'),
  'git fetch': ok(),
  'git status --porcelain': ok(''),
};

test('parseAheadBehind lê a saída do rev-list e tolera lixo', () => {
  assert.deepStrictEqual(parseAheadBehind('2\t5\n'), { ahead: 2, behind: 5 });
  assert.deepStrictEqual(parseAheadBehind('0 0'), { ahead: 0, behind: 0 });
  assert.deepStrictEqual(parseAheadBehind(''), { ahead: 0, behind: 0 });
  assert.deepStrictEqual(parseAheadBehind(undefined), { ahead: 0, behind: 0 });
});

test('só os manifestos pedem reinstalação, com barra de qualquer lado', () => {
  assert.strictEqual(needsNpmInstall(['desktop/main.js']), false);
  assert.strictEqual(needsNpmInstall(['desktop\\package-lock.json']), true);
  assert.strictEqual(needsPipInstall(['README.md', 'pyproject.toml']), true);
  assert.strictEqual(needsPipInstall(['desktop/package.json']), false);
});

test('describeCheck fala a língua da tela', () => {
  assert.match(describeCheck({ ok: false, message: 'sem rede' }), /sem rede/);
  assert.match(describeCheck({ ok: true, behind: 0, ahead: 0, dirty: false }), /última versão/);
  assert.match(describeCheck({ ok: true, behind: 1, ahead: 0, dirty: false }), /1 atualização disponível\./);
  assert.match(describeCheck({ ok: true, behind: 3, ahead: 0, dirty: false }), /3 atualizações disponíveis\./);
  assert.match(describeCheck({ ok: true, behind: 3, ahead: 1, dirty: false }), /1 commit\(s\) locais/);
  assert.match(describeCheck({ ok: true, behind: 3, ahead: 0, dirty: true }), /alterações locais/);
});

test('currentVersion devolve commit, data e branch', async () => {
  const { run } = fakeRun(BASE);
  const v = await createUpdater({ root: 'C:\\app', run }).currentVersion();
  assert.deepStrictEqual(v, {
    ok: true, commit: '12c850d', date: '2026-08-19T17:00:00-03:00', subject: 'refactor: só o Synapse', branch: 'master',
  });
});

test('fora de um clone git, diz isso em vez de quebrar', async () => {
  const { run } = fakeRun({ 'git log -1': fail('not a git repository') });
  const v = await createUpdater({ root: 'C:\\app', run }).currentVersion();
  assert.strictEqual(v.ok, false);
  assert.match(v.message, /clone git/);
});

test('check: atualizado quando o rev-list dá 0 0', async () => {
  const { run } = fakeRun({ ...BASE, 'git rev-list': ok('0\t0\n') });
  const r = await createUpdater({ root: 'C:\\app', run }).check();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.behind, 0);
  assert.deepStrictEqual(r.changes, []);
  assert.match(r.message, /última versão/);
});

test('check: atrás do remoto lista os títulos dos commits que vêm', async () => {
  const { run, calls } = fakeRun({
    ...BASE,
    'git rev-list': ok('0\t2\n'),
    'git log --format=%s HEAD..origin/master': ok('feat: minimizar a tela\nfix: acento no nome\n'),
  });
  const r = await createUpdater({ root: 'C:\\app', run }).check();
  assert.strictEqual(r.behind, 2);
  assert.deepStrictEqual(r.changes, ['feat: minimizar a tela', 'fix: acento no nome']);
  assert.strictEqual(r.remote, 'origin/master');
  assert.ok(calls.some((c) => c.key === 'git fetch --quiet origin'), 'faz fetch antes de comparar');
});

test('check: sem rede vira mensagem, não exceção', async () => {
  const { run } = fakeRun({ ...BASE, 'git fetch': fail('fatal: unable to access') });
  const r = await createUpdater({ root: 'C:\\app', run }).check();
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /unable to access/);
});

test('update: árvore suja recusa sem fazer pull', async () => {
  const { run, calls } = fakeRun({ ...BASE, 'git rev-list': ok('0\t1\n'), 'git status --porcelain': ok(' M desktop/main.js\n'), 'git log --format=%s': ok('x\n') });
  const r = await createUpdater({ root: 'C:\\app', run }).update();
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /alterações locais/);
  assert.ok(!calls.some((c) => c.key.startsWith('git pull')));
});

test('update: já atualizado não faz pull nem instala', async () => {
  const { run, calls } = fakeRun({ ...BASE, 'git rev-list': ok('0\t0\n') });
  const r = await createUpdater({ root: 'C:\\app', run }).update();
  assert.deepStrictEqual(r, { ok: true, updated: false, message: 'Já está na última versão.' });
  assert.ok(!calls.some((c) => c.key.startsWith('git pull')));
});

test('update: pull ff-only e npm install só quando o manifesto mudou', async () => {
  let head = 'aaaaaaa1111';
  const logs = [];
  const { run, calls } = fakeRun({
    ...BASE,
    'git rev-list': ok('0\t1\n'),
    'git log --format=%s': ok('chore: bump electron\n'),
    'git rev-parse HEAD': () => ok(`${head}\n`),
    'git pull --ff-only origin master': () => { head = 'bbbbbbb2222'; return ok('Fast-forward'); },
    'git diff --name-only aaaaaaa1111 bbbbbbb2222': ok('desktop/package.json\ndesktop/main.js\n'),
    'cmd /c npm install': ok('added 1 package'),
  });
  const r = await createUpdater({ root: 'C:\\app', run, platform: 'win32', log: (m) => logs.push(m) }).update();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.updated, true);
  assert.deepStrictEqual([r.from, r.to], ['aaaaaaa', 'bbbbbbb']);
  const npm = calls.find((c) => c.key.startsWith('cmd /c npm install'));
  assert.ok(npm, 'rodou npm install');
  assert.match(npm.cwd, /desktop$/);
  assert.ok(!calls.some((c) => c.key.includes('pip install')), 'não mexeu no pip');
  assert.ok(logs.some((m) => /npm install/.test(m)));
});

test('update: só código mudou → nenhuma reinstalação', async () => {
  const { run, calls } = fakeRun({
    ...BASE,
    'git rev-list': ok('0\t1\n'),
    'git log --format=%s': ok('fix: x\n'),
    'git rev-parse HEAD': ok('ccccccc\n'),
    'git pull --ff-only origin master': ok(''),
    'git diff --name-only': ok('desktop/renderer/app.js\n'),
  });
  const r = await createUpdater({ root: 'C:\\app', run, platform: 'win32' }).update();
  assert.strictEqual(r.ok, true);
  assert.ok(!calls.some((c) => /npm install|pip install/.test(c.key)));
});

test('update: pull recusado (histórico divergente) vira mensagem com o motivo', async () => {
  const { run } = fakeRun({
    ...BASE,
    'git rev-list': ok('1\t1\n'),
    'git log --format=%s': ok('x\n'),
    'git rev-parse HEAD': ok('ddddddd\n'),
    'git pull --ff-only origin master': fail('fatal: Not possible to fast-forward, aborting.'),
  });
  const r = await createUpdater({ root: 'C:\\app', run }).update();
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /fast-forward/);
});

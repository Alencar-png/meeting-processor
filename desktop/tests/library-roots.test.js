'use strict';

/**
 * A biblioteca lê mais de uma raiz: a pasta de saída e, para cada projeto com
 * pasta de trabalho, a `synapse/` dentro dela. Aqui as pastas são de verdade
 * (temporárias) e o banco também — o que se testa é o id, a raiz e o
 * movimento das reuniões entre raízes.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const db = require('../db');
const library = require('../library');
const projects = require('../projects');

let out;       // pasta de saída (workspace)
let work;      // pasta de trabalho do projeto
let projectId;

function meetingFolder(root, name) {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, `${name}.md`), `# ${name}\n\n[00:01] olá`, 'utf-8');
}

before(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-out-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-work-'));
  projectId = projects.saveProject(out, { name: 'Alpha', workdir: work }).id;
  meetingFolder(out, 'Reunião Global');
  meetingFolder(path.join(work, 'synapse'), 'Reunião do Projeto');
  // Formato antigo: arquivo solto na raiz da pasta de saída.
  fs.writeFileSync(path.join(out, 'Antiga.md'), '# antiga', 'utf-8');
});

after(() => {
  db.closeAll();
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

test('meetingsRootFor: projeto com pasta de trabalho aponta para <pasta>/synapse', () => {
  assert.strictEqual(library.meetingsRootFor(out, { workdir: work }), path.join(work, 'synapse'));
  assert.strictEqual(library.meetingsRootFor(out, { workdir: '' }), out);
  assert.strictEqual(library.meetingsRootFor(out, null), out);
});

test('meetingId e splitMeetingId: prefixo do projeto só quando há projeto', () => {
  assert.strictEqual(library.meetingId('', 'X'), 'X');
  assert.strictEqual(library.meetingId('alpha', 'X'), 'alpha::X');
  assert.deepStrictEqual(library.splitMeetingId('alpha::Reunião::estranha'), { projectId: 'alpha', name: 'Reunião::estranha' });
  assert.deepStrictEqual(library.splitMeetingId('X'), { projectId: '', name: 'X' });
});

test('listMeetings junta a pasta de saída com a raiz do projeto, cada uma com sua identidade', () => {
  const lista = library.listMeetings(out);
  const global = lista.find((m) => m.id === 'Reunião Global');
  const doProjeto = lista.find((m) => m.id === `${projectId}::Reunião do Projeto`);
  const antiga = lista.find((m) => m.id === 'Antiga');

  assert.ok(global && doProjeto && antiga, 'as três aparecem');
  assert.strictEqual(global.project, null);
  assert.strictEqual(global.root, out);
  assert.strictEqual(doProjeto.project.id, projectId);
  assert.strictEqual(doProjeto.name, 'Reunião do Projeto');
  assert.strictEqual(doProjeto.root, path.join(work, 'synapse'));
  assert.strictEqual(antiga.legacy, true);
});

test('renameMeeting numa raiz de projeto mantém a raiz e o prefixo', () => {
  const r = library.renameMeeting(out, `${projectId}::Reunião do Projeto`, 'Kickoff');
  assert.ok(r.ok, r.message);
  assert.strictEqual(r.id, `${projectId}::Kickoff`);
  assert.ok(fs.existsSync(path.join(work, 'synapse', 'Kickoff', 'Kickoff.md')));
  assert.ok(!fs.existsSync(path.join(work, 'synapse', 'Reunião do Projeto')));
});

test('nomes iguais em raízes diferentes não conflitam', () => {
  meetingFolder(out, 'Kickoff');   // mesmo nome da reunião do projeto, na pasta global
  const lista = library.listMeetings(out);
  assert.strictEqual(lista.filter((m) => m.name === 'Kickoff').length, 2);
  assert.ok(lista.some((m) => m.id === 'Kickoff'));
  assert.ok(lista.some((m) => m.id === `${projectId}::Kickoff`));
});

test('relocateMeeting leva a pasta para a raiz do projeto e devolve o id novo', () => {
  const r = library.relocateMeeting(out, 'Reunião Global', path.join(work, 'synapse'), projectId);
  assert.ok(r.ok, r.message);
  assert.strictEqual(r.moved, true);
  assert.strictEqual(r.id, `${projectId}::Reunião Global`);
  assert.ok(fs.existsSync(path.join(work, 'synapse', 'Reunião Global', 'Reunião Global.md')));
  assert.ok(!fs.existsSync(path.join(out, 'Reunião Global')));
});

test('relocateMeeting recusa quando já existe pasta com o nome no destino', () => {
  const r = library.relocateMeeting(out, 'Kickoff', path.join(work, 'synapse'), projectId);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /Já existe/);
  assert.ok(fs.existsSync(path.join(out, 'Kickoff')), 'a origem fica intacta');
});

test('relocateMeeting de reunião antiga (arquivo solto) vira pasta no destino', () => {
  const r = library.relocateMeeting(out, 'Antiga', path.join(work, 'synapse'), projectId);
  assert.ok(r.ok, r.message);
  assert.ok(fs.existsSync(path.join(work, 'synapse', 'Antiga', 'Antiga.md')));
  assert.ok(!fs.existsSync(path.join(out, 'Antiga.md')));
});

test('relocateMeeting para a mesma raiz não move nada', () => {
  const r = library.relocateMeeting(out, `${projectId}::Antiga`, path.join(work, 'synapse'), projectId);
  assert.deepStrictEqual(r, { ok: true, id: `${projectId}::Antiga`, moved: false });
});

test('de volta à pasta de saída: perde o prefixo', () => {
  const r = library.relocateMeeting(out, `${projectId}::Antiga`, out, '');
  assert.ok(r.ok, r.message);
  assert.strictEqual(r.id, 'Antiga');
  assert.ok(fs.existsSync(path.join(out, 'Antiga', 'Antiga.md')));
});

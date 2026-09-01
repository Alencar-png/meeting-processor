'use strict';

/**
 * O histórico do chat e os campos novos do projeto (pasta de trabalho, modo
 * autônomo, sessão) moram no synapse.db. Banco de verdade numa pasta
 * temporária: o que se testa é a migração das colunas e o ciclo das
 * mensagens, não um mock do SQLite.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const db = require('../db');
const projects = require('../projects');
const chat = require('../chat-messages');

let dir;
let projectId;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-chat-'));
  const r = projects.saveProject(dir, { name: 'Alpha', context: 'ctx' });
  assert.ok(r.ok, r.message);
  projectId = r.id;
});

after(() => {
  db.closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('projeto nasce em modo leitura, sem pasta de trabalho nem sessão', () => {
  const p = projects.getProject(dir, projectId);
  assert.strictEqual(p.workdir, '');
  assert.strictEqual(p.chatBypass, false);
  assert.strictEqual(p.chatSessionId, '');
});

test('saveProject grava a pasta de trabalho; o modo e a sessão têm setters próprios', () => {
  const r = projects.saveProject(dir, { id: projectId, name: 'Alpha', context: 'ctx', workdir: 'C:\\code\\alpha' });
  assert.ok(r.ok);
  assert.strictEqual(projects.getProject(dir, projectId).workdir, 'C:\\code\\alpha');

  projects.setChatBypass(dir, projectId, true);
  projects.setChatSession(dir, projectId, 'sess-1');
  const p = projects.getProject(dir, projectId);
  assert.strictEqual(p.chatBypass, true);
  assert.strictEqual(p.chatSessionId, 'sess-1');

  // Editar nome/contexto não mexe no modo nem na sessão.
  projects.saveProject(dir, { id: projectId, name: 'Alpha 2', context: 'novo' });
  const depois = projects.getProject(dir, projectId);
  assert.strictEqual(depois.chatBypass, true);
  assert.strictEqual(depois.chatSessionId, 'sess-1');
  assert.strictEqual(depois.workdir, 'C:\\code\\alpha');
});

test('listProjects também traz os campos novos', () => {
  const p = projects.listProjects(dir).find((x) => x.id === projectId);
  assert.strictEqual(p.workdir, 'C:\\code\\alpha');
  assert.strictEqual(p.chatBypass, true);
});

test('mensagens entram em ordem e voltam com as ferramentas usadas', () => {
  assert.ok(chat.addMessage(dir, { projectId, role: 'user', text: 'Oi' }).ok);
  assert.ok(chat.addMessage(dir, { projectId, role: 'ai', text: 'Olá', tools: ['lendo Weekly.md'], bypass: true }).ok);
  const lista = chat.listMessages(dir, projectId);
  assert.strictEqual(lista.length, 2);
  assert.deepStrictEqual(lista.map((m) => m.role), ['user', 'ai']);
  assert.deepStrictEqual(lista[1].tools, ['lendo Weekly.md']);
  assert.strictEqual(lista[1].bypass, true);
  assert.strictEqual(lista[0].tools.length, 0);
});

test('papel desconhecido e projeto inexistente são recusados', () => {
  assert.strictEqual(chat.addMessage(dir, { projectId, role: 'system', text: 'x' }).ok, false);
  assert.strictEqual(chat.addMessage(dir, { projectId: 'nao-existe', role: 'user', text: 'x' }).ok, false);
});

test('clearMessages apaga só o projeto pedido', () => {
  const outro = projects.saveProject(dir, { name: 'Beta' }).id;
  chat.addMessage(dir, { projectId: outro, role: 'user', text: 'beta' });
  chat.clearMessages(dir, projectId);
  assert.strictEqual(chat.listMessages(dir, projectId).length, 0);
  assert.strictEqual(chat.listMessages(dir, outro).length, 1);
});

test('excluir o projeto leva o histórico junto', () => {
  const temp = projects.saveProject(dir, { name: 'Temp' }).id;
  chat.addMessage(dir, { projectId: temp, role: 'user', text: 'x' });
  projects.deleteProject(dir, temp);
  assert.strictEqual(chat.listMessages(dir, temp).length, 0);
});

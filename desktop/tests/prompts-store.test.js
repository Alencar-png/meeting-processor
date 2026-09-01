'use strict';

/**
 * O prompt que a pessoa edita em Configurações vale sobre o padrão do app, e
 * restaurar é voltar ao padrão sem perder nada. Tudo em pastas temporárias:
 * o padrão aqui é um arquivo de mentira, para o teste não depender do texto
 * real dos prompts.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const { listPrompts, readPrompt, savePrompt, resetPrompt, validatePrompt } = require('../prompts-store');

const PADRAO = 'Leia {{TRANSCRICAO}} e grave {{JSON}}. {{CONTEXTO}}';
let defaultDir;
let userDir;

before(() => {
  defaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-prompts-padrao-'));
  userDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-prompts-user-')), 'prompts');
  fs.writeFileSync(path.join(defaultDir, 'analise.md'), PADRAO, 'utf-8');
});

after(() => {
  fs.rmSync(defaultDir, { recursive: true, force: true });
  fs.rmSync(path.dirname(userDir), { recursive: true, force: true });
});

test('listPrompts devolve todos os prompts com rótulo para a interface', () => {
  const lista = listPrompts();
  assert.ok(lista.length >= 1);
  for (const item of lista) {
    assert.ok(item.kind, 'kind');
    assert.ok(item.label && item.label.length > 3, `label de ${item.kind}`);
  }
  assert.ok(lista.some((i) => i.kind === 'analise'));
});

test('sem edição, lê o padrão e diz que não é custom', () => {
  const p = readPrompt('analise', { userDir, defaultDir });
  assert.strictEqual(p.text, PADRAO);
  assert.strictEqual(p.isCustom, false);
  assert.ok(p.required.includes('{{JSON}}'));
});

test('prompt desconhecido é erro de programação, não silêncio', () => {
  assert.throws(() => readPrompt('inexistente', { userDir, defaultDir }), /desconhecido/);
});

test('validatePrompt recusa vazio e placeholders obrigatórios faltando', () => {
  assert.match(validatePrompt('analise', ''), /vazio/);
  assert.match(validatePrompt('analise', '   '), /vazio/);
  const semJson = PADRAO.replace('{{JSON}}', 'saida.json');
  assert.match(validatePrompt('analise', semJson), /\{\{JSON\}\}/);
  assert.strictEqual(validatePrompt('analise', PADRAO), '');
});

test('{{CONTEXTO}} é opcional: tirar não invalida', () => {
  assert.strictEqual(validatePrompt('analise', PADRAO.replace('{{CONTEXTO}}', '')), '');
});

test('savePrompt grava a edição na pasta do usuário e ela passa a valer', () => {
  const editado = `${PADRAO}\n\nSeja breve.`;
  const r = savePrompt('analise', editado, { userDir, defaultDir });
  assert.deepStrictEqual(r, { ok: true, isCustom: true });

  const p = readPrompt('analise', { userDir, defaultDir });
  assert.strictEqual(p.text, editado);
  assert.strictEqual(p.isCustom, true);
  // O padrão continua intacto.
  assert.strictEqual(fs.readFileSync(path.join(defaultDir, 'analise.md'), 'utf-8'), PADRAO);
});

test('savePrompt inválido não toca no que estava gravado', () => {
  const antes = readPrompt('analise', { userDir, defaultDir }).text;
  const r = savePrompt('analise', 'sem placeholders', { userDir, defaultDir });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(readPrompt('analise', { userDir, defaultDir }).text, antes);
});

test('salvar o texto igual ao padrão volta a ser padrão, não cópia', () => {
  const r = savePrompt('analise', PADRAO, { userDir, defaultDir });
  assert.deepStrictEqual(r, { ok: true, isCustom: false });
  assert.strictEqual(readPrompt('analise', { userDir, defaultDir }).isCustom, false);
});

test('resetPrompt apaga a edição e é inofensivo quando já é padrão', () => {
  savePrompt('analise', `${PADRAO} x`, { userDir, defaultDir });
  assert.deepStrictEqual(resetPrompt('analise', { userDir }), { ok: true, isCustom: false });
  assert.strictEqual(readPrompt('analise', { userDir, defaultDir }).isCustom, false);
  assert.deepStrictEqual(resetPrompt('analise', { userDir }), { ok: true, isCustom: false });
});

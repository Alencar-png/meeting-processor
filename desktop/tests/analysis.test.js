'use strict';

/**
 * A análise vem de um modelo e é heurística: campo faltando, tipo errado ou
 * lista em vez de texto não podem derrubar a reunião. Estes testes fixam a
 * forma que o resto do app pode assumir depois de `normalizeAnalysis`.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const {
  ANALYSIS_FILE,
  analysisPath,
  normalizeAnalysis,
  readAnalysis,
  writeAnalysis,
} = require('../analysis');

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-analise-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('JSON vazio ou lixo vira a forma completa com listas vazias', () => {
  for (const raw of [undefined, null, 'texto', 42, [], {}]) {
    const a = normalizeAnalysis(raw);
    assert.deepStrictEqual(a, {
      title: '', note: '', overview: [], topics: [], decisions: [], risks: [], tasks: [], pending: [], generatedAt: 0,
    });
  }
});

test('tarefas sem título caem fora; prioridade estranha vira medium', () => {
  const a = normalizeAnalysis({
    tasks: [
      { title: '  Revisar contrato ', assignee: 'Ana', priority: 'urgente', deadline: 'sexta', origin: '[12:04]' },
      { title: '', description: 'sem título' },
      'string solta',
      null,
    ],
  });
  assert.deepStrictEqual(a.tasks, [{
    title: 'Revisar contrato', description: '', assignee: 'Ana', deadline: 'sexta', priority: 'medium', origin: '[12:04]',
  }]);
});

test('overview aceita string única ou lista; decisões aceitam string ou objeto', () => {
  const a = normalizeAnalysis({
    overview: 'Um parágrafo só.',
    decisions: ['Fechado', { text: 'Pendente', open: true }, { text: '' }, 7],
    topics: ['Só o resumo', { title: 'Tema', summary: 'Detalhe' }, { title: '', summary: '' }],
  });
  assert.deepStrictEqual(a.overview, ['Um parágrafo só.']);
  assert.deepStrictEqual(a.decisions, [{ text: 'Fechado', open: false }, { text: 'Pendente', open: true }]);
  assert.deepStrictEqual(a.topics, [{ title: '', summary: 'Só o resumo' }, { title: 'Tema', summary: 'Detalhe' }]);
});

test('analysisPath: pasta própria tem analise.json; formato antigo não guarda', () => {
  assert.strictEqual(analysisPath('C:\\saida\\Reunião X', false), path.join('C:\\saida\\Reunião X', ANALYSIS_FILE));
  assert.strictEqual(analysisPath('C:\\saida', true), null);
});

test('writeAnalysis normaliza, carimba generatedAt e readAnalysis lê de volta', () => {
  const file = path.join(dir, ANALYSIS_FILE);
  const gravado = writeAnalysis(file, { title: ' Kickoff ', tasks: [{ title: 'Marcar reunião' }], risks: 'um risco' });
  assert.ok(gravado.generatedAt > 0);
  const lido = readAnalysis(file);
  assert.strictEqual(lido.title, 'Kickoff');
  assert.deepStrictEqual(lido.risks, ['um risco']);
  assert.strictEqual(lido.tasks[0].priority, 'medium');
  assert.strictEqual(lido.generatedAt, gravado.generatedAt);
});

test('readAnalysis devolve null para arquivo ausente, nulo ou corrompido', () => {
  assert.strictEqual(readAnalysis(null), null);
  assert.strictEqual(readAnalysis(path.join(dir, 'nao-existe.json')), null);
  const ruim = path.join(dir, 'ruim.json');
  fs.writeFileSync(ruim, '{ isto não é json', 'utf-8');
  assert.strictEqual(readAnalysis(ruim), null);
});

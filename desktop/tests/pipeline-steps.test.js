'use strict';

/**
 * O que roda depois da transcrição é escolha de quem usa.
 *
 * Cada etapa — tarefas no Kanban, resumo em PDF, tarefas em PDF — liga e
 * desliga sozinha em Configurações. Estes testes fixam a decisão sem rodar o
 * pipeline: nada de Claude, disco ou processo.
 */

const assert = require('node:assert');
const { test } = require('node:test');

const {
  DEFAULT_STEPS,
  DOC_KINDS,
  normalizeSteps,
  pendingDocKinds,
  planAfterTranscription,
} = require('../pipeline-steps');

test('por padrão todas as etapas ficam ligadas, e cada PDF é uma etapa', () => {
  assert.deepStrictEqual(DEFAULT_STEPS, { kanban: true, documento: true });
  for (const kind of DOC_KINDS) assert.ok(kind in DEFAULT_STEPS, kind);
});

test('normalizeSteps completa o que falta e ignora lixo', () => {
  assert.deepStrictEqual(normalizeSteps(undefined), DEFAULT_STEPS);
  assert.deepStrictEqual(normalizeSteps(null), DEFAULT_STEPS);
  assert.deepStrictEqual(normalizeSteps('sim'), DEFAULT_STEPS);
  assert.deepStrictEqual(
    normalizeSteps({ documento: false, kanban: 'não', outra: true }),
    { kanban: true, documento: false },
  );
});

test('normalizeSteps migra as configurações antigas de resumo e tarefas', () => {
  // Os dois PDFs desligados: a pessoa não quer documento.
  assert.deepStrictEqual(normalizeSteps({ resumo: false, tarefas: false }), { kanban: true, documento: false });
  // Qualquer um ligado: quer.
  assert.deepStrictEqual(normalizeSteps({ resumo: false, tarefas: true }), { kanban: true, documento: true });
  assert.deepStrictEqual(normalizeSteps({ resumo: true }), { kanban: true, documento: true });
  // Já migrado: o valor novo manda.
  assert.deepStrictEqual(normalizeSteps({ resumo: true, documento: false }), { kanban: true, documento: false });
});

test('normalizeSteps não altera o objeto recebido', () => {
  const raw = { kanban: false };
  normalizeSteps(raw);
  assert.deepStrictEqual(raw, { kanban: false });
});

test('com projeto e tudo ligado: analisa, grava tarefas e gera o documento', () => {
  const plan = planAfterTranscription({ steps: DEFAULT_STEPS, projectId: 'p1' });
  assert.deepStrictEqual(plan, { analyze: true, saveTasks: true, docs: ['documento'] });
});

test('sem projeto não há onde pendurar tarefa, mas o documento ainda pede a análise', () => {
  const plan = planAfterTranscription({ steps: DEFAULT_STEPS, projectId: '' });
  assert.deepStrictEqual(plan, { analyze: true, saveTasks: false, docs: ['documento'] });
});

test('tudo desligado e sem autoName: o Claude nem é chamado', () => {
  const plan = planAfterTranscription({ steps: { kanban: false, documento: false }, projectId: 'p1' });
  assert.deepStrictEqual(plan, { analyze: false, saveTasks: false, docs: [] });
});

test('autoName sozinho ainda pede a análise — o título vem dela', () => {
  const plan = planAfterTranscription({ steps: { kanban: false, documento: false }, projectId: 'p1', autoName: true });
  assert.strictEqual(plan.analyze, true);
  assert.strictEqual(plan.saveTasks, false);
  assert.deepStrictEqual(plan.docs, []);
});

test('o documento liga e desliga sem mexer no kanban', () => {
  assert.deepStrictEqual(planAfterTranscription({ steps: { documento: false } }).docs, []);
  assert.strictEqual(planAfterTranscription({ steps: { documento: false }, projectId: 'p1' }).saveTasks, true);
  assert.deepStrictEqual(planAfterTranscription({ steps: { kanban: false } }).docs, ['documento']);
});

test('sem transcrição em .md não há o que ler, mesmo com tudo ligado', () => {
  const plan = planAfterTranscription({ steps: DEFAULT_STEPS, projectId: 'p1', autoName: true, hasTranscript: false });
  assert.deepStrictEqual(plan, { analyze: false, saveTasks: false, docs: [] });
});

test('pendingDocKinds: fila vazia deixa passar tudo o que foi pedido', () => {
  assert.deepStrictEqual(pendingDocKinds([], 'm1', ['documento']), ['documento']);
});

test('pendingDocKinds: o que a fila já promete para a reunião não entra de novo', () => {
  const queue = [{ meetingId: 'm1', kinds: ['documento'] }];
  assert.deepStrictEqual(pendingDocKinds(queue, 'm1', ['documento']), []);
  assert.deepStrictEqual(pendingDocKinds(queue, 'm1', ['documento', 'outro']), ['outro']);
});

test('pendingDocKinds: outra reunião na fila não conta', () => {
  const queue = [{ meetingId: 'm2', kinds: ['documento'] }];
  assert.deepStrictEqual(pendingDocKinds(queue, 'm1', ['documento']), ['documento']);
});

test('pendingDocKinds: soma o que vários itens da mesma reunião prometem', () => {
  const queue = [{ meetingId: 'm1', kinds: ['a'] }, { meetingId: 'm1', kinds: ['b'] }];
  assert.deepStrictEqual(pendingDocKinds(queue, 'm1', ['a', 'b']), []);
});

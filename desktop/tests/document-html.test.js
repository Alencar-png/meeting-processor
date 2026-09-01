'use strict';

/**
 * O PDF é montado pelo app a partir da análise. O que estes testes garantem:
 * a tabela de tarefas é a lista da análise (a mesma do Kanban), seções vazias
 * somem, e texto vindo da reunião não vira HTML.
 */

const assert = require('node:assert');
const { test } = require('node:test');

const { escapeHtml, renderDocumentHtml } = require('../document-html');
const { normalizeAnalysis } = require('../analysis');

const meeting = {
  name: 'Weekly produto',
  recordedAt: new Date(2026, 7, 18, 14, 30).getTime(),
  duration: 1934,
  project: { name: 'Projeto Alpha' },
};

test('escapeHtml neutraliza os cinco caracteres perigosos', () => {
  assert.strictEqual(escapeHtml(`<a href="x" onclick='y'>&`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
});

test('o título da análise manda; sem ele vale o nome da reunião', () => {
  const com = renderDocumentHtml({ meeting, analysis: normalizeAnalysis({ title: 'Alinhamento do onboarding' }) });
  assert.match(com, /<h1>Alinhamento do onboarding<\/h1>/);
  assert.match(com, /“Weekly produto”/);   // o nome original fica no rodapé
  const sem = renderDocumentHtml({ meeting, analysis: normalizeAnalysis({}) });
  assert.match(sem, /<h1>Weekly produto<\/h1>/);
});

test('cabeçalho traz data, duração e projeto', () => {
  const html = renderDocumentHtml({ meeting, analysis: normalizeAnalysis({}) });
  assert.match(html, /18\/08\/2026 14:30/);
  assert.match(html, /32 min/);
  assert.match(html, /Projeto Alpha/);
});

test('as tarefas do PDF são exatamente as da análise, com uma linha por tarefa', () => {
  const analysis = normalizeAnalysis({
    tasks: [
      { title: 'Ajustar e-mail', assignee: 'Bruno', priority: 'high', deadline: 'quinta', origin: '[03:12]' },
      { title: 'Repetir teste', priority: 'low' },
    ],
  });
  const html = renderDocumentHtml({ meeting, analysis });
  assert.strictEqual((html.match(/<tr class="prio-/g) || []).length, 2);
  assert.match(html, /2 tarefas saíram desta reunião; a mais urgente: Ajustar e-mail\./);
  assert.match(html, /<td>Bruno<\/td>/);
  assert.match(html, /<td>quinta<\/td>/);
  assert.match(html, /\[03:12\]/);
  // Sem responsável e sem prazo: diz "não definido" em vez de deixar vazio.
  assert.strictEqual((html.match(/não definido/g) || []).length, 2);
});

test('sem tarefas o documento diz isso, em vez de omitir a seção', () => {
  const html = renderDocumentHtml({ meeting, analysis: normalizeAnalysis({}) });
  assert.match(html, /A reunião não gerou tarefas\./);
});

test('seções sem conteúdo somem; decisões separam decidido e em aberto', () => {
  const html = renderDocumentHtml({
    meeting,
    analysis: normalizeAnalysis({
      decisions: [{ text: 'Usar Postgres', open: false }, { text: 'Data do lançamento', open: true }],
    }),
  });
  assert.match(html, /<h2>Decisões<\/h2>/);
  assert.match(html, /<h3>Decidido<\/h3>/);
  assert.match(html, /<h3>Em aberto<\/h3>/);
  assert.doesNotMatch(html, /<h2>Visão geral<\/h2>/);
  assert.doesNotMatch(html, /<h2>Riscos e bloqueios<\/h2>/);
  assert.doesNotMatch(html, /<h2>Pendências de decisão<\/h2>/);
});

test('texto da reunião não vira HTML', () => {
  const html = renderDocumentHtml({
    meeting,
    analysis: normalizeAnalysis({ overview: ['<script>alert(1)</script>'], tasks: [{ title: 'a < b' }] }),
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /a &lt; b/);
});

test('a página é autocontida: sem recursos externos e com estilo de impressão A4', () => {
  const html = renderDocumentHtml({ meeting, analysis: normalizeAnalysis({}) });
  assert.doesNotMatch(html, /https?:\/\//);
  assert.match(html, /@page \{ size: A4/);
  assert.match(html, /<meta charset="utf-8">/);
});

'use strict';

/**
 * Prompts do Claude: o padrão do app e a versão editada pela pessoa.
 *
 * O padrão vive em `prompts/*.md`, no repositório. A edição feita em
 * Configurações vai para a pasta de dados do usuário, e é ela que vale quando
 * existe — assim "restaurar o padrão" é apagar um arquivo, e atualizar o app
 * nunca sobrescreve o que a pessoa escreveu.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DIR = path.join(__dirname, 'prompts');

// Os placeholders são preenchidos pelo app antes de o prompt ir ao Claude.
// `required` são os que não podem faltar: sem eles o Claude não sabe onde está
// a transcrição nem onde gravar o resultado.
//
// A interface de Configurações lista o que estiver aqui: um prompt novo entra
// com `label` e aparece no seletor sem mexer no HTML.
const PROMPTS = {
  analise: {
    label: 'Análise da reunião (documento e tarefas)',
    file: 'analise.md',
    placeholders: ['{{TRANSCRICAO}}', '{{CONTEXTO}}', '{{JSON}}'],
    required: ['{{TRANSCRICAO}}', '{{JSON}}'],
  },
};

function spec(kind) {
  const found = PROMPTS[kind];
  if (!found) throw new Error(`Prompt desconhecido: ${kind}`);
  return found;
}

/** Os prompts que existem, na ordem de exibição — para o seletor da interface. */
function listPrompts() {
  return Object.entries(PROMPTS).map(([kind, { label }]) => ({ kind, label }));
}

/** O texto que vale hoje: a edição da pessoa, se houver; senão, o padrão. */
function readPrompt(kind, { userDir, defaultDir = DEFAULT_DIR } = {}) {
  const { file, label, placeholders, required } = spec(kind);
  const base = { kind, label, placeholders, required };
  if (userDir) {
    try {
      return { ...base, text: fs.readFileSync(path.join(userDir, file), 'utf-8'), isCustom: true };
    } catch {
      // Sem edição gravada: vale o padrão.
    }
  }
  return { ...base, text: fs.readFileSync(path.join(defaultDir, file), 'utf-8'), isCustom: false };
}

/** Motivo para recusar o texto, ou string vazia quando ele serve. */
function validatePrompt(kind, text) {
  if (typeof text !== 'string' || !text.trim()) return 'O prompt não pode ficar vazio.';
  const faltando = spec(kind).required.filter((ph) => !text.includes(ph));
  if (faltando.length) {
    return `O prompt precisa manter ${faltando.join(', ')} — é por aí que o app passa os caminhos.`;
  }
  return '';
}

/**
 * Grava a edição. Texto igual ao padrão não vira cópia: volta a ser o padrão,
 * para a tela não dizer "editado" sobre algo que não mudou.
 */
function savePrompt(kind, text, { userDir, defaultDir = DEFAULT_DIR }) {
  const message = validatePrompt(kind, text);
  if (message) return { ok: false, message };

  const { file } = spec(kind);
  const padrao = fs.readFileSync(path.join(defaultDir, file), 'utf-8');
  if (text === padrao) return resetPrompt(kind, { userDir });

  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, file), text, 'utf-8');
  return { ok: true, isCustom: true };
}

function resetPrompt(kind, { userDir }) {
  try {
    fs.unlinkSync(path.join(userDir, spec(kind).file));
  } catch {
    // Já era o padrão.
  }
  return { ok: true, isCustom: false };
}

module.exports = {
  DEFAULT_DIR,
  PROMPTS,
  listPrompts,
  readPrompt,
  resetPrompt,
  savePrompt,
  validatePrompt,
};

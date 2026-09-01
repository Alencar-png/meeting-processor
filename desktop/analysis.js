'use strict';

/**
 * A análise da reunião.
 *
 * O Claude lê a transcrição uma vez e devolve um JSON: título, visão geral,
 * pontos discutidos, decisões, riscos, tarefas e pendências. Esse JSON é
 * gravado em `analise.json`, na pasta da reunião, e dele saem tanto os cards
 * do Kanban quanto o documento em PDF — o mesmo dado nos dois lugares, por
 * construção, em vez de duas leituras que podiam discordar.
 *
 * Este módulo normaliza o que o modelo devolveu (o JSON é heurístico: campo
 * faltando ou com tipo errado não pode derrubar a reunião) e lê/grava o
 * arquivo. Não fala com o Claude.
 */

const fs = require('node:fs');
const path = require('node:path');

const ANALYSIS_FILE = 'analise.json';
const PRIORITIES = ['low', 'medium', 'high'];

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const list = (v) => (Array.isArray(v) ? v : []);
const strings = (v) => (typeof v === 'string' ? [v] : list(v)).map(str).filter(Boolean);

function normalizeTask(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = str(raw.title);
  if (!title) return null;
  return {
    title,
    description: str(raw.description),
    assignee: str(raw.assignee),
    deadline: str(raw.deadline),
    priority: PRIORITIES.includes(raw.priority) ? raw.priority : 'medium',
    origin: str(raw.origin),
  };
}

function normalizeTopic(raw) {
  if (typeof raw === 'string') return str(raw) ? { title: '', summary: str(raw) } : null;
  if (!raw || typeof raw !== 'object') return null;
  const topic = { title: str(raw.title), summary: str(raw.summary) };
  return topic.title || topic.summary ? topic : null;
}

function normalizeDecision(raw) {
  if (typeof raw === 'string') return str(raw) ? { text: str(raw), open: false } : null;
  if (!raw || typeof raw !== 'object') return null;
  const text = str(raw.text);
  return text ? { text, open: Boolean(raw.open) } : null;
}

/** Devolve sempre a mesma forma, com listas vazias no lugar do que faltou. */
function normalizeAnalysis(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    title: str(src.title),
    note: str(src.note),
    overview: strings(src.overview),
    topics: list(src.topics).map(normalizeTopic).filter(Boolean),
    decisions: list(src.decisions).map(normalizeDecision).filter(Boolean),
    risks: strings(src.risks),
    tasks: list(src.tasks).map(normalizeTask).filter(Boolean),
    pending: strings(src.pending),
    generatedAt: Number(src.generatedAt) || 0,
  };
}

/**
 * Onde a análise da reunião mora. Reuniões do formato antigo (arquivos soltos
 * na raiz) não têm pasta própria, e aí a análise não é guardada.
 */
function analysisPath(meetingDir, legacy) {
  return legacy ? null : path.join(meetingDir, ANALYSIS_FILE);
}

function readAnalysis(file) {
  if (!file) return null;
  try {
    return normalizeAnalysis(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch {
    return null; // ainda não analisada, ou arquivo corrompido
  }
}

function writeAnalysis(file, analysis) {
  const payload = { ...normalizeAnalysis(analysis), generatedAt: Date.now() };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
  return payload;
}

module.exports = {
  ANALYSIS_FILE,
  analysisPath,
  normalizeAnalysis,
  readAnalysis,
  writeAnalysis,
};

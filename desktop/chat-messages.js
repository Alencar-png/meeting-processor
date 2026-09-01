'use strict';

/**
 * Histórico do chat de cada projeto.
 *
 * O Claude Code guarda a conversa do lado dele (é a sessão que o `--resume`
 * continua); aqui fica o que a tela mostra — pergunta, resposta e o que ele
 * fez no caminho — para o histórico sobreviver ao fechar do app. Mora no
 * `synapse.db`, junto do projeto, e cai com ele.
 */

const db = require('./db');

const ROLES = ['user', 'ai'];

function toMessage(row) {
  let meta = {};
  try { meta = JSON.parse(row.meta || '{}'); } catch { /* meta antiga ou vazia */ }
  return {
    id: row.id,
    projectId: row.project_id,
    role: row.role,
    text: row.content,
    tools: Array.isArray(meta.tools) ? meta.tools : [],
    bypass: Boolean(meta.bypass),
    error: Boolean(meta.error),
    createdAt: row.created_at,
  };
}

/** As últimas mensagens do projeto, em ordem cronológica. */
function listMessages(dir, projectId, limit = 200) {
  const conn = db.open(dir);
  if (!conn || !projectId) return [];
  const linhas = conn.prepare(`
    SELECT * FROM chat_messages WHERE project_id = ?
     ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(projectId, limit);
  return linhas.reverse().map(toMessage);
}

function addMessage(dir, { projectId, role, text, tools = [], bypass = false, error = false }) {
  const conn = db.open(dir);
  if (!conn) return { ok: false, message: 'Pasta de saída indisponível.' };
  if (!ROLES.includes(role)) return { ok: false, message: `Papel desconhecido: ${role}` };
  const existe = conn.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
  if (!existe) return { ok: false, message: 'Projeto não encontrado.' };

  const meta = JSON.stringify({ tools, bypass, error });
  const r = conn.prepare(`
    INSERT INTO chat_messages (project_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)
  `).run(projectId, role, String(text ?? ''), meta, Date.now());
  return { ok: true, id: Number(r.lastInsertRowid) };
}

/** Apaga o histórico do projeto — a conversa recomeça do zero. */
function clearMessages(dir, projectId) {
  const conn = db.open(dir);
  if (!conn) return { ok: false, message: 'Pasta de saída indisponível.' };
  conn.prepare('DELETE FROM chat_messages WHERE project_id = ?').run(projectId);
  return { ok: true };
}

module.exports = { addMessage, clearMessages, listMessages };

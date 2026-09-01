'use strict';

/**
 * Projetos e o vínculo das reuniões com eles.
 *
 * Um projeto reúne reuniões do mesmo assunto e carrega um texto de contexto —
 * o que é o projeto, quem são as pessoas, que tipo de documento se espera.
 * Esse contexto vai para o prompt na hora de gerar tarefas ou resumo, para o
 * documento sair no registro certo.
 *
 * Antes chamado `groups.js`, com os dados num `groups.json`. O nome mudou
 * junto com o modelo do produto, e o armazenamento passou para o SQLite.
 */

const db = require('./db');

// Caracteres proibidos em nome de arquivo — o nome do projeto aparece na UI e
// pode virar nome de pasta no futuro; manter a mesma regra evita surpresa.
const INVALID_CHARS = /[<>:"/\\|?*]/;

const COLS = 'p.id, p.name, p.context, p.workdir, p.chat_bypass, p.chat_session_id';

/** Converte a linha do banco para o vocabulário do resto do app. */
function toProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    context: row.context,
    workdir: row.workdir || '',
    chatBypass: Boolean(row.chat_bypass),
    chatSessionId: row.chat_session_id || '',
    ...(row.count !== undefined ? { count: row.count } : {}),
  };
}

/** Projetos com a contagem de reuniões de cada um. */
function listProjects(dir) {
  const conn = db.open(dir);
  if (!conn) return [];
  return conn.prepare(`
    SELECT ${COLS},
           (SELECT COUNT(*) FROM meetings m WHERE m.project_id = p.id) AS count
      FROM projects p
     ORDER BY p.name COLLATE NOCASE
  `).all().map(toProject);
}

function getProject(dir, projectId) {
  const conn = db.open(dir);
  if (!conn || !projectId) return null;
  return toProject(conn.prepare(`SELECT ${COLS} FROM projects p WHERE p.id = ?`).get(projectId));
}

/** Projeto de uma reunião, ou null. */
function projectOf(dir, meetingId) {
  const conn = db.open(dir);
  if (!conn) return null;
  return conn.prepare(`
    SELECT p.id, p.name, p.context
      FROM meetings m JOIN projects p ON p.id = m.project_id
     WHERE m.id = ?
  `).get(meetingId) || null;
}

/** Mapa meetingId → projeto, para montar a listagem numa leitura só. */
function projectsByMeeting(dir) {
  const conn = db.open(dir);
  if (!conn) return {};
  const linhas = conn.prepare(`
    SELECT m.id AS meetingId, p.id, p.name, p.context
      FROM meetings m JOIN projects p ON p.id = m.project_id
  `).all();
  const saida = {};
  for (const l of linhas) {
    saida[l.meetingId] = { id: l.id, name: l.name, context: l.context };
  }
  return saida;
}

/**
 * Cria ou edita o projeto. `workdir` é a pasta onde o Claude trabalha no chat
 * deste projeto; omitido, não muda. O modo do chat e a sessão têm setters
 * próprios — não passam pelo formulário.
 */
function saveProject(dir, { id, name, context, workdir }) {
  const conn = db.open(dir);
  if (!conn) return { ok: false, message: 'Pasta de saída indisponível.' };

  const nome = (name || '').trim();
  if (!nome) return { ok: false, message: 'O projeto precisa de um nome.' };
  if (INVALID_CHARS.test(nome)) {
    return { ok: false, message: 'O nome não pode conter < > : " / \\ | ? *' };
  }

  const repetido = conn
    .prepare('SELECT id FROM projects WHERE name = ? COLLATE NOCASE AND id <> ?')
    .get(nome, id || '');
  if (repetido) return { ok: false, message: `Já existe um projeto chamado ${nome}.` };

  const texto = (context || '').trim();
  const pasta = workdir === undefined ? undefined : String(workdir || '').trim();

  if (id) {
    const atual = conn.prepare('SELECT id, workdir FROM projects WHERE id = ?').get(id);
    if (!atual) return { ok: false, message: 'Projeto não encontrado.' };
    conn.prepare('UPDATE projects SET name = ?, context = ?, workdir = ? WHERE id = ?')
      .run(nome, texto, pasta === undefined ? atual.workdir : pasta, id);
    return { ok: true, id };
  }

  // Id derivado do nome, com sufixo numérico se preciso: legível no banco.
  const base = nome.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'projeto';
  let novoId = base;
  let n = 2;
  while (conn.prepare('SELECT 1 FROM projects WHERE id = ?').get(novoId)) novoId = `${base}-${n++}`;

  conn.prepare('INSERT INTO projects (id, name, context, workdir, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(novoId, nome, texto, pasta || '', Date.now());
  return { ok: true, id: novoId };
}

/** Liga ou desliga o modo autônomo do chat deste projeto. */
function setChatBypass(dir, projectId, enabled) {
  const conn = db.open(dir);
  if (!conn) return { ok: false, message: 'Pasta de saída indisponível.' };
  const r = conn.prepare('UPDATE projects SET chat_bypass = ? WHERE id = ?').run(enabled ? 1 : 0, projectId);
  return r.changes ? { ok: true } : { ok: false, message: 'Projeto não encontrado.' };
}

/** A sessão do Claude Code que o chat deste projeto continua ('' recomeça). */
function setChatSession(dir, projectId, sessionId) {
  const conn = db.open(dir);
  if (!conn) return { ok: false, message: 'Pasta de saída indisponível.' };
  const r = conn.prepare('UPDATE projects SET chat_session_id = ? WHERE id = ?').run(sessionId || '', projectId);
  return r.changes ? { ok: true } : { ok: false, message: 'Projeto não encontrado.' };
}

/**
 * Remove o projeto do banco: vínculos, tarefas e histórico do chat vão junto.
 * Os arquivos das reuniões são de quem chama (main.js), que os manda para a
 * Lixeira antes de chegar aqui — excluir um projeto é excluir tudo dele.
 */
function deleteProject(dir, projectId) {
  const conn = db.open(dir);
  if (!conn) return { ok: false, message: 'Pasta de saída indisponível.' };
  const existe = conn.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
  if (!existe) return { ok: false, message: 'Projeto não encontrado.' };

  db.transaction(conn, () => {
    // Os vínculos saem explicitamente: a chave estrangeira os deixaria como
    // linhas sem projeto, e isso é lixo, não histórico.
    conn.prepare('DELETE FROM meetings WHERE project_id = ?').run(projectId);
    // Tarefas e chat caem pela cascata do banco.
    conn.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  });
  return { ok: true };
}

/** Anexa a reunião a um projeto; `projectId` vazio desanexa. */
function assignMeeting(dir, meetingId, projectId) {
  const conn = db.open(dir);
  if (!conn) return { ok: false, message: 'Pasta de saída indisponível.' };

  if (projectId) {
    const existe = conn.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
    if (!existe) return { ok: false, message: 'Projeto não encontrado.' };
    conn.prepare('INSERT OR REPLACE INTO meetings (id, project_id) VALUES (?, ?)')
      .run(meetingId, projectId);
  } else {
    conn.prepare('DELETE FROM meetings WHERE id = ?').run(meetingId);
  }
  return { ok: true };
}

/** Acompanha o novo id quando a reunião é renomeada. */
function renameMeeting(dir, oldId, newId) {
  const conn = db.open(dir);
  if (!conn) return;
  conn.prepare('UPDATE meetings SET id = ? WHERE id = ?').run(newId, oldId);
}

/** Esquece uma reunião excluída, para não acumular órfãos. */
function forgetMeeting(dir, meetingId) {
  const conn = db.open(dir);
  if (!conn) return;
  conn.prepare('DELETE FROM meetings WHERE id = ?').run(meetingId);
}

module.exports = {
  assignMeeting,
  deleteProject,
  forgetMeeting,
  getProject,
  listProjects,
  projectOf,
  projectsByMeeting,
  renameMeeting,
  saveProject,
  setChatBypass,
  setChatSession,
};

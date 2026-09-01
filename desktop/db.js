'use strict';

/**
 * Banco do workspace.
 *
 * Projetos, tarefas e o vínculo de cada reunião com seu projeto moram num
 * SQLite dentro da pasta de saída (`synapse.db`). Antes isso vivia em dois
 * arquivos JSON reescritos por inteiro a cada mudança — qualquer falha no meio
 * da escrita levava o arquivo todo, e duas janelas mexendo ao mesmo tempo
 * sobrescreviam uma à outra. Aqui cada mudança é uma transação.
 *
 * O que **não** entra no banco: as transcrições e os PDFs. Eles continuam
 * sendo arquivos na pasta, legíveis sem o app — o banco guarda o que não cabe
 * num nome de pasta.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const FILE = 'synapse.db';

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  -- workdir: onde o Claude trabalha no chat deste projeto (vazio = pasta de saída).
  -- chat_bypass: o chat pode agir na máquina sem pedir permissão.
  -- chat_session_id: a sessão do Claude Code que o chat continua.
  CREATE TABLE IF NOT EXISTS projects (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    context         TEXT NOT NULL DEFAULT '',
    workdir         TEXT NOT NULL DEFAULT '',
    chat_bypass     INTEGER NOT NULL DEFAULT 0,
    chat_session_id TEXT NOT NULL DEFAULT '',
    created_at      INTEGER NOT NULL
  );

  -- A reunião em si é a pasta no disco; aqui fica o que a pasta não guarda.
  CREATE TABLE IF NOT EXISTS meetings (
    id         TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    meeting_id  TEXT NOT NULL DEFAULT '',
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    assignee    TEXT NOT NULL DEFAULT '',
    priority    TEXT NOT NULL DEFAULT 'medium',
    status      TEXT NOT NULL DEFAULT 'backlog',
    source      TEXT NOT NULL DEFAULT 'manual',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER
  );

  -- O que a tela do chat mostra. A conversa em si o Claude Code guarda na
  -- sessão dele; aqui fica pergunta, resposta e o que ele fez no caminho.
  CREATE TABLE IF NOT EXISTS chat_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    meta       TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_meeting ON tasks(meeting_id);
  CREATE INDEX IF NOT EXISTS idx_meetings_project ON meetings(project_id);
  CREATE INDEX IF NOT EXISTS idx_chat_project ON chat_messages(project_id);
`;

// Colunas que entraram depois de o banco existir. CREATE TABLE IF NOT EXISTS
// não altera tabela antiga: cada uma é conferida e adicionada se faltar.
const LATER_COLUMNS = [
  ['projects', 'workdir', "TEXT NOT NULL DEFAULT ''"],
  ['projects', 'chat_bypass', 'INTEGER NOT NULL DEFAULT 0'],
  ['projects', 'chat_session_id', "TEXT NOT NULL DEFAULT ''"],
];

function migrateColumns(db) {
  for (const [table, column, ddl] of LATER_COLUMNS) {
    const existentes = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!existentes.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

// Uma conexão por pasta: abrir o arquivo a cada leitura custaria caro numa
// listagem que roda a cada navegação.
const conexoes = new Map();

/**
 * Traz para o banco o que estava nos arquivos JSON.
 *
 * Roda uma vez por pasta: os arquivos ficam guardados com sufixo `.migrado`
 * em vez de apagados, para o caminho de volta existir se algo der errado.
 */
function migrateJson(db, dir) {
  const groups = path.join(dir, 'groups.json');
  const tasks = path.join(dir, 'tasks.json');
  const agora = Date.now();

  if (fs.existsSync(groups)) {
    try {
      const dados = JSON.parse(fs.readFileSync(groups, 'utf-8'));
      const insProjeto = db.prepare(
        'INSERT OR IGNORE INTO projects (id, name, context, created_at) VALUES (?, ?, ?, ?)',
      );
      for (const g of dados.groups || []) {
        insProjeto.run(g.id, g.name, g.context || '', agora);
      }
      const insVinculo = db.prepare(
        'INSERT OR REPLACE INTO meetings (id, project_id) VALUES (?, ?)',
      );
      for (const [meetingId, projectId] of Object.entries(dados.members || {})) {
        insVinculo.run(meetingId, projectId);
      }
      fs.renameSync(groups, `${groups}.migrado`);
    } catch {
      // JSON ilegível: seguimos com o banco vazio em vez de travar o app.
    }
  }

  if (fs.existsSync(tasks)) {
    try {
      const dados = JSON.parse(fs.readFileSync(tasks, 'utf-8'));
      const ins = db.prepare(`
        INSERT OR IGNORE INTO tasks
          (id, project_id, meeting_id, title, description, assignee, priority, status, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const t of dados.tasks || []) {
        // Tarefa sem projeto existente violaria a chave estrangeira.
        const existe = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(t.projectId);
        if (!existe) continue;
        ins.run(
          t.id, t.projectId, t.meetingId || '', t.title, t.description || '',
          t.assignee || '', t.priority || 'medium', t.status || 'backlog',
          t.source || 'manual', t.createdAt || agora, t.updatedAt || null,
        );
      }
      fs.renameSync(tasks, `${tasks}.migrado`);
    } catch {
      // idem
    }
  }
}

/** Abre (ou cria) o banco daquela pasta de saída. */
function open(dir) {
  if (!dir) return null;
  const chave = path.resolve(dir);
  const aberta = conexoes.get(chave);
  if (aberta) return aberta;

  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, FILE));
  db.exec(SCHEMA);
  migrateColumns(db);
  migrateJson(db, dir);
  conexoes.set(chave, db);
  return db;
}

/** Fecha tudo — usado no encerramento do app e nos testes. */
function closeAll() {
  for (const db of conexoes.values()) {
    try { db.close(); } catch { /* já fechado */ }
  }
  conexoes.clear();
}

/** Agrupa escritas relacionadas numa transação só. */
function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const saida = fn();
    db.exec('COMMIT');
    return saida;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { FILE, closeAll, open, transaction };

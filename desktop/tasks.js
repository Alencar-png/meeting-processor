'use strict';

/**
 * Tarefas do Kanban.
 *
 * Uma tarefa pertence a um projeto e, quando veio de uma reunião, guarda o id
 * dela — é o que permite abrir a reunião de origem a partir do card e desenhar
 * a aresta tarefa→reunião no grafo.
 *
 * Mora num `tasks.json` na raiz da pasta de saída, ao lado do `groups.json`:
 * a pasta continua sendo a fonte da verdade, sem banco paralelo.
 */

const fs = require('node:fs');
const path = require('node:path');

const TASKS_FILE = 'tasks.json';

const STATUSES = ['backlog', 'doing', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];

function tasksPath(dir) {
  return path.join(dir, TASKS_FILE);
}

/** Lê o arquivo de tarefas; devolve lista vazia se não existir. */
function read(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(tasksPath(dir), 'utf-8'));
    return Array.isArray(data.tasks) ? data.tasks : [];
  } catch {
    return [];
  }
}

function write(dir, tasks) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tasksPath(dir), `${JSON.stringify({ tasks }, null, 2)}\n`, 'utf-8');
  return tasks;
}

/** Normaliza campos vindos da UI ou da extração da IA. */
function sanitize(data, existente = {}) {
  const status = STATUSES.includes(data.status) ? data.status : existente.status || 'backlog';
  const priority = PRIORITIES.includes(data.priority)
    ? data.priority
    : existente.priority || 'medium';
  return {
    title: String(data.title ?? existente.title ?? '').trim(),
    description: String(data.description ?? existente.description ?? '').trim(),
    assignee: String(data.assignee ?? existente.assignee ?? '').trim(),
    projectId: String(data.projectId ?? existente.projectId ?? ''),
    meetingId: String(data.meetingId ?? existente.meetingId ?? ''),
    status,
    priority,
  };
}

/** Tarefas de um projeto, mais recentes primeiro dentro de cada coluna. */
function listTasks(dir, projectId) {
  if (!dir) return [];
  return read(dir)
    .filter((t) => !projectId || t.projectId === projectId)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** Quantas tarefas abertas cada projeto tem — para a sidebar e o painel. */
function openCountByProject(dir) {
  const contagem = {};
  for (const t of read(dir)) {
    if (t.status === 'done') continue;
    contagem[t.projectId] = (contagem[t.projectId] || 0) + 1;
  }
  return contagem;
}

function saveTask(dir, data) {
  const tasks = read(dir);

  if (data.id) {
    const tarefa = tasks.find((t) => t.id === data.id);
    if (!tarefa) return { ok: false, message: 'Tarefa não encontrada.' };
    const campos = sanitize(data, tarefa);
    if (!campos.title) return { ok: false, message: 'Dê um título à tarefa.' };
    Object.assign(tarefa, campos, { updatedAt: Date.now() });
    write(dir, tasks);
    return { ok: true, id: tarefa.id };
  }

  const campos = sanitize(data);
  if (!campos.title) return { ok: false, message: 'Dê um título à tarefa.' };
  if (!campos.projectId) return { ok: false, message: 'A tarefa precisa de um projeto.' };

  const nova = { id: `t-${Date.now().toString(36)}-${tasks.length}`, ...campos, createdAt: Date.now() };
  tasks.push(nova);
  write(dir, tasks);
  return { ok: true, id: nova.id };
}

/** Move o card entre colunas do Kanban. */
function moveTask(dir, id, status) {
  if (!STATUSES.includes(status)) return { ok: false, message: 'Coluna desconhecida.' };
  const tasks = read(dir);
  const tarefa = tasks.find((t) => t.id === id);
  if (!tarefa) return { ok: false, message: 'Tarefa não encontrada.' };
  tarefa.status = status;
  tarefa.updatedAt = Date.now();
  write(dir, tasks);
  return { ok: true };
}

function deleteTask(dir, id) {
  const tasks = read(dir);
  const restantes = tasks.filter((t) => t.id !== id);
  if (restantes.length === tasks.length) return { ok: false, message: 'Tarefa não encontrada.' };
  write(dir, restantes);
  return { ok: true };
}

/**
 * Cria em lote as tarefas extraídas de uma reunião (AI-02). Ignora as sem
 * título em vez de falhar o lote inteiro: a extração é heurística e uma
 * entrada ruim não deve custar as outras.
 */
function createFromExtraction(dir, { projectId, meetingId, items }) {
  if (!projectId || !Array.isArray(items) || !items.length) return { created: 0 };
  const tasks = read(dir);
  const agora = Date.now();
  let criadas = 0;

  for (const item of items) {
    const campos = sanitize({ ...item, projectId, meetingId, status: 'backlog' });
    if (!campos.title) continue;
    tasks.push({
      id: `t-${agora.toString(36)}-${tasks.length}`,
      ...campos,
      source: 'ia',
      createdAt: agora,
    });
    criadas += 1;
  }

  if (criadas) write(dir, tasks);
  return { created: criadas };
}

/** O projeto sumiu: suas tarefas somem com ele. */
function forgetProject(dir, projectId) {
  const tasks = read(dir);
  const restantes = tasks.filter((t) => t.projectId !== projectId);
  if (restantes.length !== tasks.length) write(dir, restantes);
}

/**
 * A reunião sumiu, mas a tarefa continua valendo: perde só o vínculo de
 * origem. Apagar trabalho por causa de um arquivo excluído seria destrutivo.
 */
function forgetMeeting(dir, meetingId) {
  const tasks = read(dir);
  let mudou = false;
  for (const t of tasks) {
    if (t.meetingId === meetingId) {
      t.meetingId = '';
      mudou = true;
    }
  }
  if (mudou) write(dir, tasks);
}

/** Acompanha o novo id quando a reunião é renomeada. */
function renameMeeting(dir, oldId, newId) {
  const tasks = read(dir);
  let mudou = false;
  for (const t of tasks) {
    if (t.meetingId === oldId) {
      t.meetingId = newId;
      mudou = true;
    }
  }
  if (mudou) write(dir, tasks);
}

module.exports = {
  PRIORITIES,
  STATUSES,
  TASKS_FILE,
  createFromExtraction,
  deleteTask,
  forgetMeeting,
  forgetProject,
  listTasks,
  moveTask,
  openCountByProject,
  renameMeeting,
  saveTask,
};

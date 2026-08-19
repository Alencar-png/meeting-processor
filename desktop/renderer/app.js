'use strict';

/**
 * Synapse — lógica da janela.
 *
 * Navegação por módulos (Início, Projetos, Biblioteca, Configurações),
 * dashboard e kanban por projeto, gravação/importação com pipeline,
 * grafo de conexões e chat RAG. Todo acesso a dados passa por window.api.
 */

const $ = (id) => document.getElementById(id);
const app = $('app');

// --- Estado ------------------------------------------------------------------

let settings = null;
let engines = null;
let engineReady = false;
let projects = [];
let view = 'home';
let currentProjectId = '';
let currentTab = 'overview';
let drawerMeetingId = '';
let drawerTranscript = '';
let editingTaskId = '';
let editingProjectId = '';
let pendingVideo = '';
let pendingKind = 'video';   // 'video' ou 'transcript'
let recTimer = null;
let recStartedAt = 0;
let jobProjectId = '';
const chatHistories = new Map();
let libView = { search: '', filter: 'todas', group: '' };

// --- Formatação ---------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
const clock = (s) => `${pad(Math.floor(Math.max(0, s) / 60))}:${pad(Math.round(Math.max(0, s)) % 60)}`;
const fmtDate = (ts) => { const d = new Date(ts); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`; };
const fmtDateTime = (ts) => { const d = new Date(ts); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDuration = (s) => {
  if (!s) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${pad(m)}` : `${m} min`;
};
const PRIO_LABEL = { high: 'alta', medium: 'média', low: 'baixa' };

function toast(html) {
  const t = $('toast');
  t.innerHTML = html;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 4200);
}

// --- Redes neurais (canvas) -----------------------------------------------------

const heroNet = window.createNeural($('hero-net'));
heroNet.setMode('idle');
let recordNet = null;
let processNet = null;

// --- Navegação -----------------------------------------------------------------

function setView(next) {
  view = next;
  app.dataset.view = next;
  $('top-record').hidden = next !== 'project';
  renderSidebar();
  if (next === 'home') renderHome();
  if (next === 'projects') renderProjects();
  if (next === 'library') renderLibrary();
  if (next === 'settings') renderSettings();
  $('crumb').textContent = {
    home: 'Início',
    projects: 'Projetos / Todos os projetos',
    library: 'Biblioteca / Todas as reuniões',
    settings: 'Sistema / Configurações',
    project: `Projetos / ${projects.find((p) => p.id === currentProjectId)?.name || ''}`,
  }[next];
  if (graph && next !== 'project') graph.stop();
}

async function openProject(id, tab = currentTab || 'overview') {
  currentProjectId = id;
  currentTab = tab;
  await refreshProjects();
  setView('project');
  await renderProject();
}

function setTab(tab) {
  currentTab = tab;
  $('project-view').dataset.tab = tab;
  for (const b of $('project-tabs').children) b.classList.toggle('is-active', b.dataset.tab === tab);
  renderSidebar();
  if (tab === 'graph') renderGraph(); else if (graph) graph.stop();
  if (tab === 'kanban') renderKanban();
  if (tab === 'meetings') renderProjectMeetings();
  if (tab === 'chat') renderChat();
  if (tab === 'overview') renderOverview();
}

// --- Sidebar --------------------------------------------------------------------

const TAB_LABELS = { overview: 'Visão geral', kanban: 'Kanban', meetings: 'Reuniões', graph: 'Grafo', chat: 'Chat' };

function renderSidebar() {
  $('nav-home').classList.toggle('is-active', view === 'home');
  // O módulo cobre projeto individual também: sair dele não apaga a pista.
  $('nav-projects-all').classList.toggle('is-active', view === 'projects' || view === 'project');
  $('nav-library').classList.toggle('is-active', view === 'library');
  $('nav-settings').classList.toggle('is-active', view === 'settings');
}

async function refreshProjects() {
  projects = await window.api.listProjects();
}

// --- Tiles reutilizáveis -----------------------------------------------------------

function meetingTile(m, { showProject = false } = {}) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'tile';
  const main = document.createElement('div');
  main.className = 'tile-main';
  const name = document.createElement('span');
  name.className = 'tile-name';
  name.textContent = m.name;
  const meta = document.createElement('span');
  meta.className = 'tile-meta';
  meta.textContent = `${fmtDateTime(m.recordedAt)} · ${fmtDuration(m.duration)} · ${m.segments} falas`;
  main.append(name, meta);

  const badges = document.createElement('div');
  badges.className = 'tile-badges';
  if (showProject && m.project) badges.append(pill(m.project.name, 'mint'));
  badges.append(pill('resumo', m.hasResumo ? 'on' : ''), pill('tarefas', m.hasTarefas ? 'violet' : ''));
  tile.append(main, badges);
  tile.addEventListener('click', () => openDrawer(m.id));
  return tile;
}

function pill(text, kind) {
  const s = document.createElement('span');
  s.className = `pill ${kind}`.trim();
  s.textContent = text;
  return s;
}

function statCard(n, label, color = '') {
  const div = document.createElement('div');
  div.className = 'stat';
  const num = document.createElement('span');
  num.className = `n ${color}`.trim();
  num.textContent = n;
  const l = document.createElement('span');
  l.className = 'l';
  l.textContent = label;
  div.append(num, l);
  return div;
}

function emptyNote(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}

// --- Início --------------------------------------------------------------------

async function renderHome() {
  const meetings = await window.api.listMeetings();
  const allTasks = (await Promise.all(projects.map((p) => window.api.listTasks(p.id)))).flat();
  const horas = meetings.reduce((s, m) => s + (m.duration || 0), 0) / 3600;

  const stats = $('home-stats');
  stats.replaceChildren(
    statCard(projects.length, 'projetos', 'mint'),
    statCard(meetings.length, 'reuniões'),
    statCard(allTasks.filter((t) => t.status !== 'done').length, 'tarefas abertas', 'violet'),
    statCard(`${horas.toFixed(1)}h`, 'de áudio transcrito'),
  );

  const pj = $('home-projects');
  pj.replaceChildren();
  if (!projects.length) pj.append(emptyNote('Nenhum projeto ainda. Crie o primeiro.'));
  for (const p of projects) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    const main = document.createElement('div');
    main.className = 'tile-main';
    const name = document.createElement('span');
    name.className = 'tile-name';
    name.textContent = p.name;
    const meta = document.createElement('span');
    meta.className = 'tile-meta';
    meta.textContent = `${p.meetings} reunião(ões) · ${p.openTasks} tarefa(s) aberta(s)`;
    main.append(name, meta);
    tile.append(main);
    tile.addEventListener('click', () => openProject(p.id, 'overview'));
    pj.append(tile);
  }

  const rec = $('home-recent');
  rec.replaceChildren();
  if (!meetings.length) rec.append(emptyNote('Nenhuma reunião ainda. Importe um vídeo para começar.'));
  for (const m of meetings.slice(0, 5)) rec.append(meetingTile(m, { showProject: true }));
}

// --- Projetos: o módulo -----------------------------------------------------------------

/** Blocos ou tabela — a escolha fica salva entre sessões. */
let projectsMode = localStorage.getItem('projectsMode') === 'table' ? 'table' : 'grid';
let projectsSort = { key: 'name', dir: 1 };

function setProjectsMode(mode) {
  projectsMode = mode;
  localStorage.setItem('projectsMode', mode);
  renderProjects();
}

async function renderProjects() {
  await refreshProjects();

  const grid = $('projects-grid');
  const wrap = $('projects-table-wrap');
  const vazio = $('projects-empty');

  $('vs-grid').setAttribute('aria-pressed', String(projectsMode === 'grid'));
  $('vs-table').setAttribute('aria-pressed', String(projectsMode === 'table'));

  const reunioes = projects.reduce((s, p) => s + p.meetings, 0);
  const abertas = projects.reduce((s, p) => s + p.openTasks, 0);
  $('projects-sub').textContent = projects.length
    ? `${projects.length} projeto(s) · ${reunioes} reunião(ões) · ${abertas} tarefa(s) aberta(s)`
    : 'nenhum projeto';

  const temProjetos = projects.length > 0;
  vazio.hidden = temProjetos;
  grid.hidden = !temProjetos || projectsMode !== 'grid';
  wrap.hidden = !temProjetos || projectsMode !== 'table';

  if (!temProjetos) {
    grid.replaceChildren();
    $('projects-tbody').replaceChildren();
    return;
  }

  if (projectsMode === 'grid') renderProjectsGrid();
  else renderProjectsTable();
}

/** Botão pequeno de ação, usado no cartão e na linha da tabela. */
function projectAction(label, title, onClick, extraClass = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `mini ${extraClass}`.trim();
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

async function confirmDeleteProject(p) {
  const ok = await confirmDanger({
    title: `Excluir "${p.name}"?`,
    message: `As reuniões continuam na biblioteca, apenas ficam sem projeto. ${p.openTasks} tarefa(s) do kanban serão apagadas.`,
    confirmLabel: 'Excluir projeto',
  });
  if (!ok) return;
  await window.api.deleteProject(p.id);
  await renderProjects();
  renderSidebar();
  toast(`Projeto <strong>${p.name}</strong> excluído.`);
}

function bold(texto) {
  const b = document.createElement('b');
  b.textContent = texto;
  return b;
}

function renderProjectsGrid() {
  const grid = $('projects-grid');
  grid.replaceChildren();

  for (const p of projects) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'proj-card';
    card.addEventListener('click', () => openProject(p.id, 'overview'));

    const head = document.createElement('div');
    head.className = 'proj-card-head';
    const glyph = document.createElement('span');
    glyph.className = 'proj-card-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = '◈';
    const name = document.createElement('span');
    name.className = 'proj-card-name';
    name.textContent = p.name;
    head.append(glyph, name);

    const ctx = document.createElement('p');
    ctx.className = 'proj-card-context';
    ctx.textContent = p.context
      || 'Sem contexto. O contexto orienta o tom dos documentos gerados pela IA.';

    const foot = document.createElement('div');
    foot.className = 'proj-card-foot';
    const reun = document.createElement('span');
    reun.append(bold(p.meetings), document.createTextNode(' reuniões'));
    const tar = document.createElement('span');
    tar.className = 'open';
    tar.append(bold(p.openTasks), document.createTextNode(' abertas'));
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = p.lastMeetingAt ? fmtDate(p.lastMeetingAt) : '—';
    when.title = p.lastMeetingAt ? 'Última reunião' : 'Nenhuma reunião ainda';
    foot.append(reun, tar, when);

    const acts = document.createElement('div');
    acts.className = 'proj-card-acts';
    acts.append(
      projectAction('editar', `Editar ${p.name}`, () => openProjectModal(p)),
      projectAction('excluir', `Excluir ${p.name}`, () => confirmDeleteProject(p), 'danger'),
    );

    card.append(acts, head, ctx, foot);
    grid.append(card);
  }
}

function renderProjectsTable() {
  const tbody = $('projects-tbody');
  tbody.replaceChildren();

  const { key, dir } = projectsSort;
  const ordenados = [...projects].sort((a, b) => {
    const va = a[key];
    const vb = b[key];
    if (typeof va === 'string') return va.localeCompare(vb) * dir;
    return (va - vb) * dir;
  });

  for (const th of $('projects-table').querySelectorAll('th[data-sort]')) {
    const ativo = th.dataset.sort === key;
    th.toggleAttribute('data-active', ativo);
    const antigo = th.querySelector('.caret');
    if (antigo) antigo.remove();
    if (!ativo) continue;
    const seta = document.createElement('span');
    seta.className = 'caret';
    seta.textContent = dir === 1 ? '↑' : '↓';
    th.append(seta);
  }

  for (const p of ordenados) {
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    tr.addEventListener('click', () => openProject(p.id, 'overview'));
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') openProject(p.id, 'overview');
    });

    const nome = document.createElement('td');
    nome.textContent = p.name;

    const reun = document.createElement('td');
    reun.className = 'num';
    reun.textContent = p.meetings;

    const abertas = document.createElement('td');
    abertas.className = 'num';
    abertas.textContent = p.openTasks;

    const quando = document.createElement('td');
    quando.className = 'dim';
    quando.textContent = p.lastMeetingAt ? fmtDate(p.lastMeetingAt) : '—';

    const ctx = document.createElement('td');
    ctx.className = 'ctx';
    ctx.textContent = p.context || '—';
    if (p.context) ctx.title = p.context;

    const acts = document.createElement('td');
    acts.className = 'acts-col';
    const box = document.createElement('div');
    box.className = 'row-acts';
    box.append(
      projectAction('abrir', `Abrir ${p.name}`, () => openProject(p.id, 'overview')),
      projectAction('editar', `Editar ${p.name}`, () => openProjectModal(p)),
      projectAction('excluir', `Excluir ${p.name}`, () => confirmDeleteProject(p), 'danger'),
    );
    acts.append(box);

    tr.append(nome, reun, abertas, quando, ctx, acts);
    tbody.append(tr);
  }
}

$('vs-grid').addEventListener('click', () => setProjectsMode('grid'));
$('vs-table').addEventListener('click', () => setProjectsMode('table'));
$('projects-new').addEventListener('click', () => openProjectModal());
$('projects-table').querySelectorAll('th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    projectsSort = key === projectsSort.key
      ? { key, dir: projectsSort.dir * -1 }
      : { key, dir: key === 'name' ? 1 : -1 };
    renderProjectsTable();
  });
});

// --- Projeto: visão geral -----------------------------------------------------------

async function renderProject() {
  const p = projects.find((x) => x.id === currentProjectId);
  if (!p) { setView('home'); return; }
  $('project-name').textContent = p.name;
  $('project-sub').textContent = `${p.meetings} reunião(ões) · ${p.openTasks} tarefa(s) aberta(s)`;
  setTab(currentTab);
}

async function renderOverview() {
  const p = projects.find((x) => x.id === currentProjectId);
  const meetings = await window.api.listMeetings(currentProjectId);
  const tasks = await window.api.listTasks(currentProjectId);
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;

  $('project-stats').replaceChildren(
    statCard(meetings.length ? fmtDate(meetings[0].recordedAt) : '—', 'última reunião', 'mint'),
    statCard(meetings.length, 'reuniões'),
    statCard(tasks.filter((t) => t.status !== 'done').length, 'tarefas abertas', 'violet'),
    statCard(tasks.filter((t) => t.status === 'done' && t.createdAt > weekAgo).length, 'concluídas na semana'),
  );

  const ms = $('overview-meetings');
  ms.replaceChildren();
  if (!meetings.length) ms.append(emptyNote('Nenhuma reunião neste projeto. Grave a primeira.'));
  for (const m of meetings.slice(0, 3)) ms.append(meetingTile(m));

  const ts = $('overview-tasks');
  ts.replaceChildren();
  const doing = tasks.filter((t) => t.status === 'doing');
  if (!doing.length) ts.append(emptyNote('Nada em andamento agora.'));
  for (const t of doing.slice(0, 4)) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    const main = document.createElement('div');
    main.className = 'tile-main';
    const name = document.createElement('span');
    name.className = 'tile-name';
    name.textContent = t.title;
    const meta = document.createElement('span');
    meta.className = 'tile-meta';
    meta.textContent = `${t.assignee || 'sem responsável'} · prioridade ${PRIO_LABEL[t.priority]}`;
    main.append(name, meta);
    tile.append(main);
    tile.addEventListener('click', () => openTaskModal(t));
    ts.append(tile);
  }

  $('overview-context').textContent = p.context || 'Sem contexto ainda — edite para orientar resumos, tarefas e o chat.';
}

// --- Projeto: kanban -----------------------------------------------------------------

const KANBAN_COLS = [
  { status: 'backlog', label: 'Backlog' },
  { status: 'doing', label: 'Em andamento' },
  { status: 'done', label: 'Concluído' },
];

async function renderKanban() {
  const tasks = await window.api.listTasks(currentProjectId);
  const board = $('kanban');
  board.replaceChildren();

  for (const col of KANBAN_COLS) {
    const box = document.createElement('div');
    box.className = 'kcol';
    box.dataset.status = col.status;
    const list = tasks.filter((t) => t.status === col.status);

    const head = document.createElement('div');
    head.className = 'kcol-head';
    head.innerHTML = `<span class="kcol-title">${col.label}</span><span class="kcount">${list.length}</span>`;
    box.append(head);

    for (const t of list) box.append(kanbanCard(t));

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'kadd';
    add.textContent = '+ tarefa';
    add.addEventListener('click', () => openTaskModal(null, col.status));
    box.append(add);

    box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('is-over'); });
    box.addEventListener('dragleave', () => box.classList.remove('is-over'));
    box.addEventListener('drop', async (e) => {
      e.preventDefault();
      box.classList.remove('is-over');
      const id = e.dataTransfer.getData('text/task');
      if (!id) return;
      await window.api.moveTask(id, col.status);
      await refreshProjects();
      renderKanban();
      renderSidebar();
    });
    board.append(box);
  }
}

function kanbanCard(t) {
  const card = document.createElement('div');
  card.className = 'kcard';
  if (t.status === 'done') card.classList.add('is-done');
  card.draggable = true;
  card.tabIndex = 0;

  const title = document.createElement('div');
  title.className = 'kcard-title';
  title.textContent = t.title;
  card.append(title);

  if (t.description) {
    const d = document.createElement('div');
    d.className = 'kcard-desc';
    d.textContent = t.description;
    card.append(d);
  }

  const foot = document.createElement('div');
  foot.className = 'kcard-foot';
  const prio = document.createElement('span');
  prio.className = `prio prio-${t.priority}`;
  prio.title = `prioridade ${PRIO_LABEL[t.priority]}`;
  foot.append(prio);
  if (t.assignee) {
    const who = document.createElement('span');
    who.className = 'kcard-who';
    who.textContent = t.assignee;
    foot.append(who);
  }
  if (t.meeting) {
    const src = document.createElement('span');
    src.className = 'kcard-src';
    src.textContent = `📅 ${fmtDate(t.meeting.recordedAt)}`;
    src.title = `Origem: ${t.meeting.name}`;
    foot.append(src);
  }
  card.append(foot);

  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/task', t.id);
    card.classList.add('is-dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('is-dragging'));
  card.addEventListener('click', () => openTaskModal(t));
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') openTaskModal(t); });
  return card;
}

// --- Projeto: reuniões -----------------------------------------------------------------

async function renderProjectMeetings() {
  const meetings = await window.api.listMeetings(currentProjectId);
  const box = $('project-meetings');
  box.replaceChildren();
  if (!meetings.length) box.append(emptyNote('Nenhuma reunião neste projeto ainda.'));
  for (const m of meetings) box.append(meetingTile(m));
}

// --- Projeto: grafo -----------------------------------------------------------------

let graph = null;

async function renderGraph() {
  const p = projects.find((x) => x.id === currentProjectId);
  const meetings = await window.api.listMeetings(currentProjectId);
  const tasks = await window.api.listTasks(currentProjectId);

  const nodes = [{ id: `p:${p.id}`, type: 'project', label: p.name }];
  const edges = [];
  const concepts = new Map();

  for (const m of meetings) {
    nodes.push({ id: `m:${m.id}`, type: 'meeting', label: `${m.name.slice(0, 24)}${m.name.length > 24 ? '…' : ''}`, ref: m.id });
    edges.push({ from: `p:${p.id}`, to: `m:${m.id}` });
    for (const c of m.concepts || []) {
      if (!concepts.has(c)) {
        concepts.set(c, true);
        nodes.push({ id: `c:${c}`, type: 'concept', label: c });
      }
      edges.push({ from: `m:${m.id}`, to: `c:${c}` });
    }
  }
  for (const t of tasks) {
    nodes.push({ id: `t:${t.id}`, type: 'task', label: `${t.title.slice(0, 20)}${t.title.length > 20 ? '…' : ''}`, ref: t.id });
    edges.push({ from: t.meetingId ? `m:${t.meetingId}` : `p:${p.id}`, to: `t:${t.id}` });
  }

  if (!graph) {
    graph = window.createGraph($('graph-canvas'), {
      onOpen: async (node) => {
        if (node.type === 'meeting') openDrawer(node.ref);
        if (node.type === 'task') {
          const all = await window.api.listTasks(currentProjectId);
          const t = all.find((x) => x.id === node.ref);
          if (t) openTaskModal(t);
        }
      },
    });
  }
  graph.start();
  graph.setData({ nodes, edges });
}

// --- Projeto: chat -----------------------------------------------------------------

function chatHistory() {
  if (!chatHistories.has(currentProjectId)) chatHistories.set(currentProjectId, []);
  return chatHistories.get(currentProjectId);
}

function renderChat() {
  const thread = $('chat-thread');
  thread.replaceChildren();
  const history = chatHistory();

  if (!history.length) {
    const empty = document.createElement('p');
    empty.className = 'chat-empty';
    empty.textContent = 'Pergunte qualquer coisa sobre este projeto — as respostas citam as reuniões e tarefas usadas como fonte.';
    thread.append(empty);
    return;
  }

  for (const msg of history) {
    const box = document.createElement('div');
    box.className = `msg msg-${msg.role}${msg.thinking ? ' msg-thinking' : ''}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    // Só **negrito** é interpretado; o resto é texto puro.
    bubble.replaceChildren(...msg.text.split(/\*\*(.+?)\*\*/g).map((part, i) => {
      if (i % 2) { const b = document.createElement('strong'); b.textContent = part; return b; }
      return document.createTextNode(part);
    }));
    box.append(bubble);

    if (msg.sources?.length) {
      const srcs = document.createElement('div');
      srcs.className = 'msg-sources';
      for (const s of msg.sources) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `src-chip ${s.type}`;
        chip.textContent = s.label;
        chip.addEventListener('click', async () => {
          if (s.type === 'meeting') openDrawer(s.id);
          else {
            const all = await window.api.listTasks(currentProjectId);
            const t = all.find((x) => x.id === s.id);
            if (t) openTaskModal(t);
          }
        });
        srcs.append(chip);
      }
      box.append(srcs);
    }
    thread.append(box);
  }
  thread.scrollTop = thread.scrollHeight;
}

$('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('chat-input').value.trim();
  if (!q) return;
  $('chat-input').value = '';
  const history = chatHistory();
  history.push({ role: 'user', text: q });
  const thinking = { role: 'ai', text: 'consultando a memória do projeto…', thinking: true };
  history.push(thinking);
  renderChat();

  const result = await window.api.chatAsk({ projectId: currentProjectId, question: q });
  history.splice(history.indexOf(thinking), 1);
  history.push({ role: 'ai', text: result.answer, sources: result.sources });
  renderChat();
});

// --- Biblioteca -----------------------------------------------------------------

async function renderLibrary() {
  const meetings = await window.api.listMeetings();
  const sel = $('lib-group');
  const keep = libView.group;
  sel.replaceChildren(new Option('todos os projetos', ''));
  for (const p of projects) sel.append(new Option(p.name, p.id));
  sel.value = keep;

  const termo = libView.search.trim().toLowerCase();
  const rows = meetings
    .filter((m) => ({
      todas: true,
      'com-tarefas': m.hasTarefas, 'sem-tarefas': !m.hasTarefas,
      'com-resumo': m.hasResumo, 'sem-resumo': !m.hasResumo,
    }[libView.filter]))
    .filter((m) => !libView.group || m.projectId === libView.group)
    .filter((m) => !termo || m.name.toLowerCase().includes(termo)
      || (m.source || '').toLowerCase().includes(termo)
      || (m.project?.name || '').toLowerCase().includes(termo));

  const box = $('lib-list');
  box.replaceChildren();
  for (const m of rows) box.append(meetingTile(m, { showProject: true }));
  $('lib-empty').hidden = rows.length > 0;
}

$('lib-search').addEventListener('input', () => { libView.search = $('lib-search').value; renderLibrary(); });
$('lib-filter').addEventListener('change', () => { libView.filter = $('lib-filter').value; renderLibrary(); });
$('lib-group').addEventListener('change', () => { libView.group = $('lib-group').value; renderLibrary(); });

// --- Configurações -----------------------------------------------------------------

async function checkEngine() {
  engines = await window.api.enginesStatus();
  const active = engines.active === 'native' ? engines.native : engines.docker;
  engineReady = Boolean(active.ok);
}

function renderSettings() {
  $('set-outdir').textContent = settings.outputDir;
  $('set-language').value = settings.language;
  const isNative = engines.active === 'native';
  for (const b of $('set-engine').children) {
    b.classList.toggle('is-active', b.dataset.engine === engines.active);
  }
  $('set-engine-desc').textContent = isNative
    ? 'whisper.cpp com Vulkan — usa a GPU, ~11× tempo real'
    : 'container Docker CPU-only, portátil';

  const model = $('set-model');
  model.replaceChildren();
  const options = isNative
    ? engines.native.models.map((m) => ({ id: m.path, label: `${m.id} — ${(m.sizeMB / 1024).toFixed(1)} GB` }))
    : [{ id: 'small', label: 'small — equilibrado' }, { id: 'large-v3', label: 'large-v3 — mais preciso' }];
  for (const o of options) model.append(new Option(o.label, o.id));
  const saved = isNative ? settings.nativeModel : settings.model;
  if (saved && options.some((o) => o.id === saved)) model.value = saved;
}

$('set-engine').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-engine]');
  if (!b) return;
  settings = await window.api.setSettings({ engine: b.dataset.engine });
  await checkEngine();
  renderSettings();
});

$('set-model').addEventListener('change', async () => {
  const patch = engines.active === 'native'
    ? { nativeModel: $('set-model').value } : { model: $('set-model').value };
  settings = await window.api.setSettings(patch);
});

$('set-language').addEventListener('change', async () => {
  settings = await window.api.setSettings({ language: $('set-language').value });
});

$('set-pick-outdir').addEventListener('click', async () => {
  const dir = await window.api.pickOutputDir();
  if (dir) {
    settings = await window.api.setSettings({ outputDir: dir });
    renderSettings();
  }
});

// --- Drawer da reunião -----------------------------------------------------------------

async function openDrawer(meetingId) {
  const m = await window.api.getMeeting(meetingId);
  if (!m) return;
  drawerMeetingId = m.id;
  drawerTranscript = m.transcript || '';
  $('drawer-kicker').textContent = m.project ? `reunião · ${m.project.name}` : 'reunião · sem projeto';
  $('drawer-name').textContent = m.name;
  $('drawer-error').textContent = '';
  $('drawer-search').value = '';

  const meta = $('drawer-meta');
  meta.replaceChildren();
  for (const [k, v] of [
    ['Gravado em', fmtDateTime(m.recordedAt)],
    ['Duração', fmtDuration(m.duration)],
    ['Falas', String(m.segments)],
    ['Modelo', m.model],
    ['Idioma', m.language],
    ['Arquivo', m.source],
  ]) {
    const div = document.createElement('div');
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    div.append(dt, dd);
    meta.append(div);
  }

  const files = $('drawer-files');
  files.replaceChildren();
  const rows = [[`${m.name}.md`, 'transcrição'], [`${m.name}.txt`, 'texto']];
  if (m.hasResumo) rows.push(['resumo.pdf', 'documento']);
  if (m.hasTarefas) rows.push(['tarefas.pdf', 'documento']);
  for (const [name, kind] of rows) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'file-row';
    b.innerHTML = `<span></span><span class="ext">${kind}</span>`;
    b.firstChild.textContent = name;
    b.addEventListener('click', () => window.api.openPath(name));
    files.append(b);
  }

  renderReader(drawerTranscript, '');
  $('drawer').hidden = false;
  $('drawer-scrim').hidden = false;
}

function closeDrawer() {
  $('drawer').hidden = true;
  $('drawer-scrim').hidden = true;
  drawerMeetingId = '';
}

/** Destaca ocorrências sem interpretar HTML. */
/**
 * Leitor da transcrição.
 *
 * O arquivo é Markdown: mostrar a marcação crua ("**[00:12]**") faz o texto
 * parecer código. Aqui o horário vira uma etiqueta discreta e a fala fica como
 * texto — sem interpretar Markdown completo, que seria mais superfície do que
 * esta tela precisa.
 */
function renderReader(text, termo) {
  const out = $('drawer-text');
  out.replaceChildren();
  const busca = termo.trim().toLowerCase();

  const escrever = (destino, trecho) => {
    if (!busca) { destino.append(document.createTextNode(trecho)); return; }
    const fonte = trecho.toLowerCase();
    let cursor = 0;
    let hit = fonte.indexOf(busca);
    while (hit !== -1) {
      destino.append(document.createTextNode(trecho.slice(cursor, hit)));
      const mark = document.createElement('mark');
      mark.textContent = trecho.slice(hit, hit + busca.length);
      destino.append(mark);
      cursor = hit + busca.length;
      hit = fonte.indexOf(busca, cursor);
    }
    destino.append(document.createTextNode(trecho.slice(cursor)));
  };

  for (const linha of text.split('\n')) {
    const limpa = linha.trim();
    // O cabeçalho e os metadados do arquivo já aparecem no topo do painel.
    if (!limpa || limpa === '---' || limpa.startsWith('# ')) continue;
    if (/^\*\*[^*]+:\*\*/.test(limpa)) continue;

    const fala = limpa.match(/^\*\*\[(\d{2}:\d{2}(?::\d{2})?)\]\*\*\s*(.*)$/);
    const p = document.createElement('p');
    p.className = 'reader-line';
    if (fala) {
      const hora = document.createElement('span');
      hora.className = 'reader-time';
      hora.textContent = fala[1];
      p.append(hora);
      escrever(p, fala[2]);
    } else {
      escrever(p, limpa.replace(/\*\*/g, ''));
    }
    out.append(p);
  }

  // Formato inesperado: melhor o texto cru do que uma tela vazia.
  if (!out.childElementCount) escrever(out, text);
}

$('drawer-search').addEventListener('input', () => renderReader(drawerTranscript, $('drawer-search').value));
$('drawer-close').addEventListener('click', closeDrawer);
$('drawer-scrim').addEventListener('click', closeDrawer);

$('drawer-rename').addEventListener('click', () => {
  const h2 = $('drawer-name');
  const input = document.createElement('input');
  input.className = 'input';
  input.value = h2.textContent;
  h2.replaceChildren(input);
  input.focus();
  input.select();
  const done = () => openDrawer(drawerMeetingId);
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const r = await window.api.renameMeeting(drawerMeetingId, input.value);
      if (!r.ok) { $('drawer-error').textContent = r.message; return; }
      await refreshAll();
      done();
    }
    if (e.key === 'Escape') done();
  });
  input.addEventListener('blur', done);
});

$('drawer-delete').addEventListener('click', async () => {
  const ok = await confirmDanger({
    title: 'Excluir esta reunião?',
    message: 'A transcrição e os documentos gerados serão apagados do disco. Não dá para desfazer.',
    confirmLabel: 'Excluir reunião',
  });
  if (!ok) return;
  await window.api.deleteMeeting(drawerMeetingId);
  closeDrawer();
  await refreshAll();
});

for (const kind of ['resumo', 'tarefas']) {
  $(`drawer-${kind}`).addEventListener('click', async () => {
    toast(`Gerando <strong>${kind}</strong> — o Claude está lendo a reunião…`);
    await window.api.generateDoc({ kind, meetingId: drawerMeetingId });
  });
}

// --- Modais -----------------------------------------------------------------

function openModal(id) {
  $('modal-scrim').hidden = false;
  $(id).hidden = false;
}
/**
 * Confirmação de ação destrutiva.
 *
 * A caixa do sistema trava a janela, ignora o tema e não cabe o detalhe do que
 * será apagado. Aqui a pergunta é do app: diz o que some e o que fica, e
 * responde a Esc e Enter.
 */
let dangerResolve = null;

function confirmDanger({ title, message, confirmLabel = 'Excluir' }) {
  $('md-title').textContent = title;
  $('md-message').textContent = message;
  $('md-confirm').textContent = confirmLabel;
  openModal('modal-danger');
  $('md-confirm').focus();

  return new Promise((resolve) => {
    dangerResolve = resolve;
  });
}

function closeDanger(resposta) {
  if (!dangerResolve) return;
  const resolve = dangerResolve;
  dangerResolve = null;
  $('modal-danger').hidden = true;
  $('modal-scrim').hidden = true;
  resolve(resposta);
}

$('md-confirm').addEventListener('click', () => closeDanger(true));
$('md-cancel').addEventListener('click', () => closeDanger(false));

function closeModals() {
  $('modal-scrim').hidden = true;
  for (const id of ['modal-project', 'modal-task', 'modal-confirm']) $(id).hidden = true;
}
$('modal-scrim').addEventListener('click', closeModals);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeModals(); closeDrawer(); }
  if (e.key === 'Enter' && dangerResolve) closeDanger(true);
});

// Projeto: criar/editar.
function openProjectModal(p = null) {
  editingProjectId = p?.id || '';
  $('mp-title').textContent = p ? 'Editar projeto' : 'Novo projeto';
  $('mp-name').value = p?.name || '';
  $('mp-context').value = p?.context || '';
  $('mp-error').textContent = '';
  $('mp-delete').hidden = !p;
  openModal('modal-project');
  $('mp-name').focus();
}

$('mp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await window.api.saveProject({
    id: editingProjectId, name: $('mp-name').value, context: $('mp-context').value,
  });
  if (!r.ok) { $('mp-error').textContent = r.message; return; }
  closeModals();
  await refreshProjects();
  openProject(r.id, editingProjectId ? currentTab : 'overview');
});

$('mp-delete').addEventListener('click', async () => {
  const p = projects.find((x) => x.id === editingProjectId);
  if (!p) return;
  const ok = await confirmDanger({
    title: `Excluir "${p.name}"?`,
    message: 'As reuniões continuam na biblioteca, apenas ficam sem projeto. As tarefas do kanban serão apagadas.',
    confirmLabel: 'Excluir projeto',
  });
  if (!ok) return;
  await window.api.deleteProject(editingProjectId);
  closeModals();
  await refreshProjects();
  setView('home');
});

$('mp-cancel').addEventListener('click', closeModals);
$('nav-new-project').addEventListener('click', () => openProjectModal());
$('overview-edit').addEventListener('click', () => openProjectModal(projects.find((x) => x.id === currentProjectId)));

// Tarefa: criar/editar.
function openTaskModal(t = null, status = 'backlog') {
  editingTaskId = t?.id || '';
  $('mt-title').textContent = t ? 'Tarefa' : 'Nova tarefa';
  $('mt-name').value = t?.title || '';
  $('mt-desc').value = t?.description || '';
  $('mt-assignee').value = t?.assignee || '';
  $('mt-priority').value = t?.priority || 'medium';
  $('mt-status').value = t?.status || status;
  $('mt-error').textContent = '';
  $('mt-delete').hidden = !t;
  const origin = $('mt-origin');
  origin.hidden = !t?.meeting;
  if (t?.meeting) origin.textContent = `📅 Origem: ${t.meeting.name} (${fmtDate(t.meeting.recordedAt)})`;
  openModal('modal-task');
  $('mt-name').focus();
}

$('mt-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await window.api.saveTask({
    id: editingTaskId,
    projectId: currentProjectId,
    title: $('mt-name').value,
    description: $('mt-desc').value,
    assignee: $('mt-assignee').value,
    priority: $('mt-priority').value,
    status: $('mt-status').value,
  });
  if (!r.ok) { $('mt-error').textContent = r.message; return; }
  closeModals();
  await refreshProjects();
  renderSidebar();
  if (currentTab === 'kanban') renderKanban();
  if (currentTab === 'overview') renderOverview();
  if (currentTab === 'graph') renderGraph();
});

$('mt-delete').addEventListener('click', async () => {
  await window.api.deleteTask(editingTaskId);
  closeModals();
  await refreshProjects();
  if (currentTab === 'kanban') renderKanban(); else renderOverview();
});

$('mt-cancel').addEventListener('click', closeModals);

// Importação: confirmar nome + projeto.
function askImport(filePath, kind = "video") {
  // Transcrição pronta não passa pelo Whisper: motor parado não impede.
  if (kind === 'video' && !engineReady) {
    toast('O motor de transcrição não está disponível — veja as <strong>Configurações</strong>.');
    return;
  }
  pendingVideo = filePath;
  pendingKind = kind;
  $('mc-file').textContent = filePath.split(/[\\/]/).pop();
  $('mc-name').value = filePath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  $('mc-error').textContent = '';
  $('mc-submit').textContent = kind === 'video' ? 'Transcrever' : 'Importar';
  const sel = $('mc-project');
  sel.replaceChildren(new Option('sem projeto', ''));
  for (const p of projects) sel.append(new Option(p.name, p.id));
  sel.value = view === 'project' ? currentProjectId : '';
  openModal('modal-confirm');
  $('mc-name').focus();
  $('mc-name').select();
}

$('mc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nome = $('mc-name').value.trim();
  if (!nome) { $('mc-error').textContent = 'Dê um nome à reunião.'; return; }
  if (/[<>:"/\\|?*]/.test(nome)) { $('mc-error').textContent = 'O nome não pode conter < > : " / \\ | ? *'; return; }
  const projectId = $('mc-project').value;
  closeModals();

  if (pendingKind === 'transcript') {
    startProcessing($('mc-file').textContent, projectId, ['export', 'extract']);
    const r = await window.api.importTranscript({ filePath: pendingVideo, name: nome, projectId });
    if (!r.ok) {
      $('overlay-process').hidden = true;
      toast(`Não deu para importar: ${r.message}`);
    }
    return;
  }

  startProcessing($('mc-file').textContent, projectId);
  await window.api.startJob({ videoPath: pendingVideo, name: nome, projectId });
});

$('mc-cancel').addEventListener('click', closeModals);

async function pickAndImport() {
  const path = await window.api.pickVideo();
  if (path) askImport(path, 'video');
}

async function pickAndImportTranscript() {
  const path = await window.api.pickTranscript();
  if (path) askImport(path, 'transcript');
}
$('home-import-text').addEventListener('click', pickAndImportTranscript);
$('home-import').addEventListener('click', pickAndImport);

// Soltar um vídeo em qualquer lugar da janela também importa.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  const path = window.api.pathForFile(file);
  if (path) askImport(path);
});

// --- Gravação -----------------------------------------------------------------

/**
 * Grava a reunião pelo app: junta o microfone e o áudio que sai pelos
 * alto-falantes num arquivo só. Numa chamada online o microfone traz o nosso
 * lado e o loopback do sistema traz o resto da sala — gravar só o microfone
 * daria uma transcrição pela metade.
 */
let recorder = null;
let recStreams = [];
let recChunks = [];

async function captureAudio() {
  const trilhas = [];
  const contexto = new AudioContext();
  const destino = contexto.createMediaStreamDestination();
  let mic = false;
  let sistema = false;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recStreams.push(stream);
    contexto.createMediaStreamSource(stream).connect(destino);
    mic = true;
  } catch { /* sem microfone: seguimos com o que houver */ }

  try {
    // O vídeo vem junto porque o Chromium exige uma fonte de tela; a trilha é
    // descartada logo em seguida — o que interessa é o áudio do sistema.
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    recStreams.push(stream);
    stream.getVideoTracks().forEach((t) => t.stop());
    if (stream.getAudioTracks().length) {
      contexto.createMediaStreamSource(stream).connect(destino);
      sistema = true;
    }
  } catch { /* sem loopback: microfone basta */ }

  if (!mic && !sistema) {
    contexto.close();
    return null;
  }

  trilhas.push(...destino.stream.getAudioTracks());
  return { stream: new MediaStream(trilhas), contexto, mic, sistema };
}

function releaseAudio(contexto) {
  recStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  recStreams = [];
  if (contexto) contexto.close();
}

/**
 * Começa a gravar.
 *
 * O projeto é escolhido na própria tela de gravação: daqui do Início não há
 * um projeto em foco, e sem projeto as tarefas extraídas não teriam kanban
 * onde cair. `preferido` apenas deixa o seletor já na opção certa quando a
 * gravação parte de dentro de um projeto.
 */
async function startRecording(preferido = '') {
  if (!engineReady) { toast('O motor de transcrição não está disponível.'); return; }
  if (recorder) { toast('Já existe uma gravação em andamento.'); return; }

  const captura = await captureAudio();
  if (!captura) {
    toast('Nenhuma fonte de áudio disponível. Libere o microfone e tente de novo.');
    return;
  }

  recChunks = [];
  recorder = new MediaRecorder(captura.stream, { mimeType: 'audio/webm' });
  recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => releaseAudio(captura.contexto);
  recorder.start(1000);   // um bloco por segundo: perda máxima de 1s se travar

  const select = $('record-project');
  select.replaceChildren();
  const semProjeto = document.createElement('option');
  semProjeto.value = '';
  semProjeto.textContent = projects.length ? 'Sem projeto' : 'Sem projeto — crie um para gerar tarefas';
  select.append(semProjeto);
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    select.append(opt);
  }
  select.value = preferido || '';

  $('record-clock').textContent = '00:00';
  $('record-fonte').textContent = captura.sistema
    ? 'microfone + áudio do sistema'
    : 'somente microfone';
  $('overlay-record').hidden = false;
  if (!recordNet) recordNet = window.createNeural($('record-net'));
  window.dispatchEvent(new Event('resize'));
  recordNet.setMode('dragging');
  recStartedAt = Date.now();
  recTimer = setInterval(() => {
    $('record-clock').textContent = clock((Date.now() - recStartedAt) / 1000);
  }, 500);
}

$('top-record').addEventListener('click', () => startRecording(currentProjectId));
$('home-record').addEventListener('click', () => startRecording(currentProjectId));

function stopRecordingUI() {
  clearInterval(recTimer);
  $('overlay-record').hidden = true;
}

/** Encerra o gravador e devolve o áudio completo. */
function finishRecording() {
  return new Promise((resolve) => {
    if (!recorder || recorder.state === 'inactive') { resolve(null); return; }
    recorder.addEventListener('stop', () => {
      const blob = new Blob(recChunks, { type: 'audio/webm' });
      recorder = null;
      recChunks = [];
      resolve(blob.size ? blob : null);
    }, { once: true });
    recorder.stop();
  });
}

$('record-cancel').addEventListener('click', async () => {
  stopRecordingUI();
  await finishRecording();   // descarta o áudio: cancelar é cancelar
  toast('Gravação descartada.');
});

$('record-stop').addEventListener('click', async () => {
  const duration = (Date.now() - recStartedAt) / 1000;
  stopRecordingUI();

  const blob = await finishRecording();
  if (!blob) { toast('A gravação saiu vazia.'); return; }

  const name = `Reunião ${fmtDate(Date.now())} ${new Date().getHours()}h${pad(new Date().getMinutes())}`;
  const projectId = $('record-project').value;
  startProcessing(name, projectId);

  const result = await window.api.processRecording({
    projectId: currentProjectId,
    name,
    duration,
    audio: await blob.arrayBuffer(),
    mimeType: blob.type,
  });
  if (result && result.started === false) {
    $('overlay-process').hidden = true;
    toast(`Não deu para processar: ${result.message}`);
  }
});

// --- Processamento (pipeline) -----------------------------------------------------------------

const STAGE_RANGE = { audio: [0, 0.1], transcription: [0.1, 0.72], export: [0.72, 0.78], extract: [0.78, 1] };
const STAGE_LABELS = { audio: 'Extraindo áudio', transcription: 'Transcrevendo', export: 'Gravando arquivos', extract: 'Extraindo tarefas' };

/**
 * Abre a tela de processamento.
 *
 * `etapas` limita o que a lista mostra: uma transcrição importada não passa
 * por áudio nem por Whisper, e exibir esses passos apagados sugeriria que
 * algo ficou pelo caminho.
 */
function startProcessing(label, projectId, etapas = null) {
  jobProjectId = projectId || '';
  $('process-file').textContent = label;
  $('process-stage').textContent = 'Iniciando';
  $('process-pct').textContent = '0%';
  for (const li of $('pipeline').children) {
    li.className = '';
    li.hidden = Boolean(etapas) && !etapas.includes(li.dataset.step);
  }
  $('overlay-process').hidden = false;
  if (!processNet) processNet = window.createNeural($('process-net'));
  window.dispatchEvent(new Event('resize'));
  processNet.setMode('working');
  processNet.setProgress(0);
}

$('process-cancel').addEventListener('click', () => window.api.cancelJob());

window.api.on('job:event', async (event) => {
  if (event.event === 'stage') {
    const [from, to] = STAGE_RANGE[event.key] || [0, 1];
    const overall = from + ((to - from) * (event.progress || 0)) / 100;
    processNet?.setProgress(overall);
    $('process-pct').textContent = `${Math.round(overall * 100)}%`;
    $('process-stage').textContent = STAGE_LABELS[event.key] || event.label || '';
    for (const li of $('pipeline').children) {
      const idx = ['audio', 'transcription', 'export', 'extract'];
      const cur = idx.indexOf(event.key);
      const mine = idx.indexOf(li.dataset.step);
      li.className = mine < cur ? 'is-done' : mine === cur ? 'is-active' : '';
    }
  } else if (event.event === 'done') {
    processNet?.setProgress(1);
    for (const li of $('pipeline').children) li.className = 'is-done';
    setTimeout(async () => {
      $('overlay-process').hidden = true;
      await refreshAll();
      toast(event.tasksCreated
        ? `Reunião pronta — <strong>${event.tasksCreated} tarefas</strong> criadas no kanban`
        : 'Reunião pronta — transcrição na biblioteca');
      if (jobProjectId) openProject(jobProjectId, event.tasksCreated ? 'kanban' : 'meetings');
      if (event.meetingId) openDrawer(event.meetingId);
    }, 600);
  } else if (event.event === 'error') {
    $('overlay-process').hidden = true;
    toast(`Não deu para processar: ${event.message || 'erro desconhecido'}`);
  } else if (event.event === 'canceled') {
    $('overlay-process').hidden = true;
  }
});

window.api.on('doc:done', async (result) => {
  if (result.ok) {
    toast(`<strong>${result.kind === 'tarefas' ? 'Tarefas' : 'Resumo'}</strong> gerado em PDF.`);
    if (drawerMeetingId === result.meetingId) openDrawer(result.meetingId);
    refreshAll();
  }
});

window.api.on('doc:progress', ({ description }) => {
  toast(`Gerando documento — ${description}…`);
});

// --- Navegação: ligações -----------------------------------------------------------------

$('nav-home').addEventListener('click', () => setView('home'));
$('nav-projects-all').addEventListener('click', () => setView('projects'));
$('nav-library').addEventListener('click', () => setView('library'));
$('nav-settings').addEventListener('click', () => setView('settings'));
$('project-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (b) setTab(b.dataset.tab);
});
$('overview-all-meetings').addEventListener('click', () => setTab('meetings'));
$('overview-kanban').addEventListener('click', () => setTab('kanban'));

async function refreshAll() {
  await refreshProjects();
  renderSidebar();
  if (view === 'home') renderHome();
  if (view === 'library') renderLibrary();
  if (view === 'project') renderProject();
}

// --- Início -----------------------------------------------------------------

(async function init() {
  settings = await window.api.getSettings();
  await checkEngine();
  await refreshProjects();
  setView('home');
})();

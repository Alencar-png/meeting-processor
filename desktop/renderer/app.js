'use strict';

/**
 * Synapse — lógica da janela.
 *
 * Navegação por módulos (Início, Projetos, Biblioteca, Configurações),
 * dashboard e kanban por projeto, gravação/importação com pipeline,
 * grafo de conexões e o chat do projeto — o Claude Code rodando com o contexto
 * dele. Todo acesso a dados passa por window.api.
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
  badges.append(pill('documento', m.hasDocumento ? 'on' : ''));
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

/**
 * Menu de ações de um item.
 *
 * No cartão de projeto os botões ficavam soltos no canto e caíam por cima do
 * nome. Aqui as ações moram atrás de um "⋯" na própria linha do título: o
 * cartão fica limpo e nada se sobrepõe.
 */
let popmenuAnchor = null;

function openPopmenu(botao, itens) {
  const menu = $('popmenu');
  menu.replaceChildren();

  for (const item of itens) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = item.danger ? 'popmenu-item danger' : 'popmenu-item';
    b.textContent = item.label;
    b.addEventListener('click', () => {
      closePopmenu();
      item.onClick();
    });
    menu.append(b);
  }

  menu.hidden = false;
  popmenuAnchor = botao;
  botao.setAttribute('aria-expanded', 'true');

  // Posição fixa ancorada no botão, virando para dentro quando falta espaço.
  const r = botao.getBoundingClientRect();
  const largura = menu.offsetWidth;
  const altura = menu.offsetHeight;
  const x = Math.min(r.right - largura, window.innerWidth - largura - 8);
  const y = r.bottom + altura > window.innerHeight ? r.top - altura - 6 : r.bottom + 6;
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${y}px`;
  menu.querySelector('button')?.focus();
}

function closePopmenu() {
  const menu = $('popmenu');
  if (menu.hidden) return;
  menu.hidden = true;
  popmenuAnchor?.setAttribute('aria-expanded', 'false');
  popmenuAnchor = null;
}

window.addEventListener('pointerdown', (e) => {
  if ($('popmenu').hidden) return;
  if (e.target.closest('#popmenu') || e.target === popmenuAnchor) return;
  closePopmenu();
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopmenu(); });
window.addEventListener('resize', closePopmenu);

/** Botão "⋯" que abre as ações do projeto. */
function projectMenuButton(p) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'card-menu';
  b.textContent = '⋯';
  b.title = `Ações de ${p.name}`;
  b.setAttribute('aria-label', `Ações de ${p.name}`);
  b.setAttribute('aria-haspopup', 'menu');
  b.setAttribute('aria-expanded', 'false');
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popmenuAnchor === b) { closePopmenu(); return; }
    openPopmenu(b, [
      { label: 'Abrir', onClick: () => openProject(p.id, 'overview') },
      { label: 'Editar', onClick: () => openProjectModal(p) },
      { label: 'Excluir', danger: true, onClick: () => confirmDeleteProject(p) },
    ]);
  });
  return b;
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
    message: `Tudo dele vai junto: as reuniões (transcrições, análises e PDFs vão para a Lixeira), ${p.openTasks} tarefa(s) abertas no kanban e o histórico do chat.`,
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
    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-menu')) return;
      openProject(p.id, 'overview');
    });

    const head = document.createElement('div');
    head.className = 'proj-card-head';
    const glyph = document.createElement('span');
    glyph.className = 'proj-card-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = '◈';
    const name = document.createElement('span');
    name.className = 'proj-card-name';
    name.textContent = p.name;
    head.append(glyph, name, projectMenuButton(p));

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

    card.append(head, ctx, foot);
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
  $('overview-workdir').textContent = p.workdir ? `Pasta de trabalho: ${p.workdir}` : '';
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

/**
 * O chat é o Claude Code rodando no projeto.
 *
 * O histórico vem do banco. O que está acontecendo agora — texto chegando,
 * ferramentas em uso — vive em `chatLive` até a rodada fechar; aí o processo
 * principal grava a resposta e a tela recarrega do banco.
 */
let chatLive = null;   // { projectId, texts, toolsBox, bubble, box }

const projectById = (id) => projects.find((p) => p.id === id);

/** Texto do assistente: **negrito** e `código`; o resto é texto puro. */
function renderRichText(el, text) {
  el.replaceChildren(...String(text || '').split(/(\*\*.+?\*\*|`[^`]+`)/g).map((part) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      const b = document.createElement('strong'); b.textContent = part.slice(2, -2); return b;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const c = document.createElement('code'); c.textContent = part.slice(1, -1); return c;
    }
    return document.createTextNode(part);
  }));
}

function toolLine(label, live = false) {
  const li = document.createElement('span');
  li.className = `msg-tool${live ? ' is-live' : ''}`;
  li.textContent = label;
  return li;
}

function messageBox(msg) {
  const box = document.createElement('div');
  box.className = `msg msg-${msg.role}${msg.error ? ' msg-error' : ''}`;
  if (msg.role === 'ai' && msg.bypass) {
    const badge = document.createElement('span');
    badge.className = 'msg-badge';
    badge.textContent = 'modo autônomo';
    box.append(badge);
  }
  if (msg.tools?.length) {
    const tools = document.createElement('div');
    tools.className = 'msg-tools';
    for (const t of msg.tools) tools.append(toolLine(t));
    box.append(tools);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  renderRichText(bubble, msg.text);
  box.append(bubble);
  if (msg.role === 'ai' && msg.text && !msg.error) {
    // Ler esta resposta em voz alta — de novo, ou só ela, sem ligar o modo Voz.
    const acoes = document.createElement('div');
    acoes.className = 'msg-actions';
    const falar = document.createElement('button');
    falar.type = 'button';
    falar.className = 'msg-speak';
    falar.title = 'Ler em voz alta';
    falar.textContent = '🔊';
    falar.addEventListener('click', () => {
      if (speakingButton === falar) stopSpeaking();
      else speak(msg.text, falar);
    });
    acoes.append(falar);
    box.append(acoes);
  }
  return box;
}

function renderChatTools(p) {
  $('chat-workdir').textContent = p.workdir || 'pasta das reuniões — defina uma pasta de trabalho ao editar o projeto';
  $('chat-workdir').title = p.workdir || '';
  $('chat-bypass').checked = Boolean(p.chatBypass);
  $('chat-box').classList.toggle('is-bypass', Boolean(p.chatBypass));
}

function setChatBusy(busy) {
  $('chat-input').disabled = busy;
  $('chat-send').hidden = busy;
  $('chat-stop').hidden = !busy;
  $('chat-new').disabled = busy;
}

async function renderChat() {
  const p = projectById(currentProjectId);
  if (!p) return;
  renderChatTools(p);
  $('chat-voice').checked = voiceMode;

  const thread = $('chat-thread');
  thread.replaceChildren();
  const history = await window.api.chatHistory(currentProjectId);
  const live = chatLive && chatLive.projectId === currentProjectId ? chatLive : null;

  if (!history.length && !live) {
    const empty = document.createElement('p');
    empty.className = 'chat-empty';
    empty.textContent = p.workdir
      ? 'Este é o Claude Code dentro do projeto: ele conhece as reuniões, as tarefas e a pasta de trabalho. Pergunte, peça um resumo, ou peça para fazer.'
      : 'Este é o Claude Code dentro do projeto: ele conhece as reuniões e as tarefas. Defina uma pasta de trabalho no projeto para ele também mexer nos seus arquivos.';
    thread.append(empty);
  }
  for (const msg of history) thread.append(messageBox(msg));
  if (live) thread.append(live.box);
  thread.scrollTop = thread.scrollHeight;
  setChatBusy(Boolean(live));
}

/** A resposta em construção: ferramentas vão entrando, o texto vai crescendo. */
function startLive(projectId, bypass) {
  const box = messageBox({ role: 'ai', text: '', tools: [], bypass });
  const toolsBox = document.createElement('div');
  toolsBox.className = 'msg-tools';
  box.insertBefore(toolsBox, box.querySelector('.bubble'));
  return { projectId, texts: [], toolsBox, bubble: box.querySelector('.bubble'), box };
}

$('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (chatLive) return;
  const q = $('chat-input').value.trim();
  if (!q) return;
  const p = projectById(currentProjectId);
  if (!p) return;
  $('chat-input').value = '';

  const thread = $('chat-thread');
  thread.querySelector('.chat-empty')?.remove();
  thread.append(messageBox({ role: 'user', text: q }));
  chatLive = startLive(currentProjectId, p.chatBypass);
  thread.append(chatLive.box);
  thread.scrollTop = thread.scrollHeight;
  setChatBusy(true);

  const r = await window.api.chatSend({ projectId: currentProjectId, text: q });
  if (!r.ok) {
    chatLive = null;
    toast(r.message);
    renderChat();
  }
});

window.api.on('chat:event', (ev) => {
  const live = chatLive && chatLive.projectId === ev.projectId ? chatLive : null;
  if (ev.kind === 'done') {
    chatLive = null;
    if (view === 'project' && currentTab === 'chat' && currentProjectId === ev.projectId) {
      renderChat();
    } else {
      const nome = projectById(ev.projectId)?.name || 'projeto';
      toast(`O assistente respondeu em <strong>${nome}</strong>.`);
    }
    if (voiceMode && ev.ok && ev.text) speak(ev.text);
    return;
  }
  if (!live) return;
  if (ev.kind === 'tool') {
    for (const t of live.toolsBox.querySelectorAll('.is-live')) t.classList.remove('is-live');
    live.toolsBox.append(toolLine(ev.label, true));
  } else if (ev.kind === 'text') {
    live.texts.push(ev.text);
    renderRichText(live.bubble, live.texts.join('\n\n'));
  }
  const thread = $('chat-thread');
  thread.scrollTop = thread.scrollHeight;
});

$('chat-stop').addEventListener('click', () => window.api.chatStop());

// --- Chat por voz -----------------------------------------------------------------

/**
 * Falar com o projeto. O recado é gravado do microfone, transcrito pelo mesmo
 * whisper das reuniões (na GPU, em segundos) e vira mensagem. Com o modo Voz
 * ligado, vai direto e a resposta é lida em voz alta pela síntese do sistema
 * — pt-BR do Windows, offline. Desligado, o microfone só preenche a caixa.
 */
let voiceMode = false;
let clipRecorder = null;
let clipStream = null;
let clipChunks = [];

// As vozes carregam de forma assíncrona; pedir cedo evita lista vazia na hora.
if ('speechSynthesis' in window) {
  speechSynthesis.getVoices();
  speechSynthesis.addEventListener('voiceschanged', () => speechSynthesis.getVoices());
}

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => /pt[-_]BR/i.test(v.lang) && /natural|online/i.test(v.name))
    || voices.find((v) => /pt[-_]BR/i.test(v.lang))
    || voices.find((v) => /^pt/i.test(v.lang))
    || null;
}

/** Texto para ler: sem marcação, sem código, sem URL — só o que faz sentido ouvir. */
function speakable(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' código omitido. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/\s+/g, ' ')
    .trim();
}

let currentAudio = null;      // a fala neural em reprodução
let warnedFallback = false;   // avisa uma vez por sessão que caiu para a voz do sistema
let speakingButton = null;    // o 🔊 da mensagem que está sendo lida, se foi por ele

/** Marca (ou desmarca) o botão da mensagem em leitura. */
function setSpeakingButton(btn) {
  if (speakingButton) { speakingButton.classList.remove('is-speaking'); speakingButton.textContent = '🔊'; speakingButton.title = 'Ler em voz alta'; }
  speakingButton = btn || null;
  if (speakingButton) { speakingButton.classList.add('is-speaking'); speakingButton.textContent = '⏹'; speakingButton.title = 'Parar a leitura'; }
}

function speakingStarted() { $('chat-mute').hidden = false; }
function speakingEnded() { $('chat-mute').hidden = true; setSpeakingButton(null); }

/** "+5%" → 1.05: a voz do sistema fala em multiplicador. */
function systemRate() {
  const pct = Number(String(settings?.tts?.rate || '+0%').replace('%', ''));
  return Number.isFinite(pct) ? Math.min(2, Math.max(0.5, 1 + pct / 100)) : 1;
}

/** A voz do sistema: offline, sem prosódia — o plano B, ou a escolha de quem prefere. */
function speakWithSystem(fala) {
  if (!('speechSynthesis' in window)) { speakingEnded(); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(fala);
  u.lang = 'pt-BR';
  const escolhida = settings?.tts?.systemVoice
    ? speechSynthesis.getVoices().find((v) => v.name === settings.tts.systemVoice)
    : null;
  const voz = escolhida || pickVoice();
  if (voz) u.voice = voz;
  u.rate = systemRate();
  u.onstart = speakingStarted;
  u.onend = speakingEnded;
  u.onerror = speakingEnded;
  speechSynthesis.speak(u);
}

/**
 * Lê a resposta. Primeiro a voz neural (Edge, via Python do app); se ela não
 * vier — sem internet, sem o pacote, motor desligado — a voz do sistema lê.
 */
async function speak(text, button = null) {
  const fala = speakable(text);
  if (!fala) return;
  stopSpeaking();
  setSpeakingButton(button);
  if (button) button.classList.add('is-busy');
  const r = await window.api.ttsSpeak(fala);
  if (button) button.classList.remove('is-busy');
  if (speakingButton !== button) return;   // a pessoa pediu outra coisa nesse meio-tempo
  if (r.ok && r.audio) {
    const blob = new Blob([r.audio], { type: r.mimeType || 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;
    speakingStarted();
    const fim = () => {
      if (currentAudio === audio) { currentAudio = null; speakingEnded(); }
      URL.revokeObjectURL(url);
    };
    audio.addEventListener('ended', fim);
    audio.addEventListener('error', () => { fim(); speakWithSystem(fala); });
    audio.play().catch(() => { fim(); speakWithSystem(fala); });
    return;
  }
  if (r.fallback && r.message && !warnedFallback) {
    warnedFallback = true;
    toast(r.message);
  }
  speakWithSystem(fala);
}

function stopSpeaking() {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  speakingEnded();
}

async function startClip() {
  clipStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  clipChunks = [];
  clipRecorder = new MediaRecorder(clipStream, { mimeType: 'audio/webm;codecs=opus' });
  clipRecorder.addEventListener('dataavailable', (e) => { if (e.data.size) clipChunks.push(e.data); });
  clipRecorder.start(250);
  stopSpeaking();
  $('chat-mic').classList.add('is-recording');
  $('chat-mic').title = 'Parar e enviar';
  $('chat-input').placeholder = 'Gravando… clique no microfone quando terminar';
}

function stopClip() {
  return new Promise((resolve) => {
    const recorder = clipRecorder;
    clipRecorder = null;
    if (!recorder || recorder.state === 'inactive') { resolve(null); return; }
    recorder.addEventListener('stop', () => {
      clipStream?.getTracks().forEach((t) => t.stop());
      clipStream = null;
      resolve(new Blob(clipChunks, { type: 'audio/webm' }));
    });
    recorder.stop();
  });
}

const CHAT_PLACEHOLDER = $('chat-input').placeholder;

function resetMic() {
  $('chat-mic').classList.remove('is-recording', 'is-busy');
  $('chat-mic').title = 'Falar: clique, fale, clique de novo';
  $('chat-input').placeholder = CHAT_PLACEHOLDER;
}

$('chat-mic').addEventListener('click', async () => {
  if (chatLive) return;
  if (!clipRecorder) {
    try {
      await startClip();
    } catch {
      toast('Não deu para acessar o microfone.');
    }
    return;
  }

  const blob = await stopClip();
  $('chat-mic').classList.remove('is-recording');
  if (!blob || blob.size < 2000) { resetMic(); toast('O recado saiu curto demais.'); return; }

  $('chat-mic').classList.add('is-busy');
  $('chat-input').placeholder = 'Transcrevendo o recado…';
  const r = await window.api.chatTranscribe({ audio: await blob.arrayBuffer(), mimeType: blob.type });
  resetMic();
  if (!r.ok) { toast(r.message); return; }
  if (!r.text) { toast('Não entendi nada no recado — tente de novo, mais perto do microfone.'); return; }

  $('chat-input').value = r.text;
  if (voiceMode) $('chat-form').requestSubmit();
  else $('chat-input').focus();
});

$('chat-mute').addEventListener('click', stopSpeaking);

$('chat-voice').addEventListener('change', (e) => {
  voiceMode = e.target.checked;
  if (!voiceMode) stopSpeaking();
  else if (!('speechSynthesis' in window)) toast('Este sistema não tem síntese de voz; o recado ainda vira texto.');
});

$('chat-bypass').addEventListener('change', async (e) => {
  const ligar = e.target.checked;
  if (ligar) {
    const ok = await confirmDanger({
      title: 'Ligar o modo autônomo neste projeto?',
      message: 'O Claude vai poder ler, escrever e executar comandos na sua máquina sem pedir permissão a cada passo — na pasta de trabalho e onde mais precisar. Ele avisa antes de algo destrutivo, mas não espera resposta. Desligue quando não precisar.',
      confirmLabel: 'Ligar modo autônomo',
    });
    if (!ok) { e.target.checked = false; return; }
  }
  await window.api.chatSetBypass({ projectId: currentProjectId, enabled: ligar });
  await refreshProjects();
  renderChatTools(projectById(currentProjectId));
});

$('chat-new').addEventListener('click', async () => {
  const ok = await confirmDanger({
    title: 'Começar uma conversa nova?',
    message: 'O histórico deste chat é apagado e o Claude deixa de lembrar o que foi dito aqui. As reuniões e tarefas continuam no lugar.',
    confirmLabel: 'Nova conversa',
  });
  if (!ok) return;
  const r = await window.api.chatClear(currentProjectId);
  if (!r.ok) { toast(r.message); return; }
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
      'com-documento': m.hasDocumento, 'sem-documento': !m.hasDocumento,
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
  for (const input of $('set-steps').querySelectorAll('input[data-step]')) {
    input.checked = settings.steps?.[input.dataset.step] !== false;
  }
  renderPromptChoices();
  renderUpdateVersion();
  renderTtsSettings();
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

$('set-steps').addEventListener('change', async (e) => {
  const input = e.target.closest('input[data-step]');
  if (!input) return;
  settings = await window.api.setSettings({
    steps: { ...settings.steps, [input.dataset.step]: input.checked },
  });
});

// --- Voz do assistente -----------------------------------------------------------------

let ttsOptions = null;

async function renderTtsSettings() {
  if (!ttsOptions) ttsOptions = await window.api.ttsOptions();
  const cfg = settings.tts || {};
  const neural = cfg.engine !== 'system';
  for (const b of $('set-tts-engine').children) {
    b.classList.toggle('is-active', b.dataset.engine === (neural ? 'neural' : 'system'));
  }
  $('set-tts-engine-desc').textContent = neural
    ? 'vozes neurais do Edge — entonação natural, precisa de internet'
    : 'voz instalada no sistema — funciona sem internet';
  const voz = $('set-tts-voice');
  if (neural) {
    voz.replaceChildren(...ttsOptions.voices.map((v) => new Option(v.label, v.id)));
    voz.value = cfg.voice;
  } else {
    // As vozes instaladas no sistema, português primeiro.
    const instaladas = ('speechSynthesis' in window ? speechSynthesis.getVoices() : [])
      .slice()
      .sort((x, y) => (/^pt/i.test(y.lang) - /^pt/i.test(x.lang)) || x.name.localeCompare(y.name));
    voz.replaceChildren(
      new Option('automática (melhor voz em português)', ''),
      ...instaladas.map((v) => new Option(`${v.name.replace(/^Microsoft /, '')} · ${v.lang}`, v.name)),
    );
    voz.value = instaladas.some((v) => v.name === cfg.systemVoice) ? cfg.systemVoice : '';
  }
  $('set-tts-voice-desc').textContent = neural
    ? 'voz neural em português do Brasil'
    : 'voz instalada no Windows (Configurações → Hora e idioma → Fala para instalar outras)';
  const rate = $('set-tts-rate');
  rate.replaceChildren(...ttsOptions.rates.map((r) => new Option(r.label, r.id)));
  rate.value = cfg.rate;
}

async function saveTts(patch) {
  settings = await window.api.setSettings({ tts: { ...settings.tts, ...patch } });
  renderTtsSettings();
}

$('set-tts-engine').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-engine]');
  if (b) saveTts({ engine: b.dataset.engine });
});
$('set-tts-voice').addEventListener('change', () => {
  const valor = $('set-tts-voice').value;
  saveTts(settings.tts?.engine === 'system' ? { systemVoice: valor } : { voice: valor });
});
if ('speechSynthesis' in window) {
  // A lista de vozes do sistema chega depois do carregamento; se a tela já
  // estiver aberta em Configurações, redesenha.
  speechSynthesis.addEventListener('voiceschanged', () => { if (view === 'settings') renderTtsSettings(); });
}
$('set-tts-rate').addEventListener('change', () => saveTts({ rate: $('set-tts-rate').value }));
$('set-tts-sample').addEventListener('click', () => {
  speak('Olá! Na última reunião ficou combinado repetir o teste de onboarding na quinta. Quer que eu crie a tarefa?');
});

// --- Atualização do app -----------------------------------------------------------------

/**
 * O Synapse roda de um clone git: atualizar é trazer os commits novos e
 * reabrir. A verificação só acontece ao clicar — é a única coisa em
 * Configurações que fala com a rede.
 */
async function renderUpdateVersion() {
  const v = await window.api.updateVersion();
  $('upd-version').textContent = v.ok
    ? `${v.commit} · ${fmtDate(new Date(v.date).getTime())}/${new Date(v.date).getFullYear()} · ${v.branch}`
    : 'não é um clone git';
  if (!v.ok) {
    $('upd-status').textContent = v.message;
    $('upd-check').hidden = true;
  }
}

function setUpdateButtons({ check = true, apply = false, restart = false }) {
  $('upd-check').hidden = !check;
  $('upd-apply').hidden = !apply;
  $('upd-restart').hidden = !restart;
}

$('upd-check').addEventListener('click', async () => {
  const b = $('upd-check');
  b.classList.add('is-busy');
  $('upd-status').textContent = 'Consultando o repositório…';
  $('upd-changes').hidden = true;
  const r = await window.api.updateCheck();
  b.classList.remove('is-busy');
  $('upd-status').textContent = r.message;
  const lista = $('upd-changes');
  lista.replaceChildren(...(r.changes || []).map((texto) => {
    const li = document.createElement('li');
    li.textContent = texto;
    return li;
  }));
  lista.hidden = !(r.changes || []).length;
  setUpdateButtons({ check: true, apply: r.ok && r.behind > 0 && !r.dirty });
});

$('upd-apply').addEventListener('click', async () => {
  if (busyWarning()) return;
  const b = $('upd-apply');
  b.classList.add('is-busy');
  const log = $('upd-log');
  log.textContent = '';
  log.hidden = false;
  $('upd-status').textContent = 'Atualizando…';
  const r = await window.api.updateApply();
  b.classList.remove('is-busy');
  $('upd-status').textContent = r.message;
  if (r.ok && r.updated) {
    setUpdateButtons({ check: false, apply: false, restart: true });
    $('upd-changes').hidden = true;
  } else {
    setUpdateButtons({ check: true, apply: false });
  }
});

$('upd-restart').addEventListener('click', () => window.api.updateRestart());

window.api.on('update:log', (line) => {
  const log = $('upd-log');
  log.hidden = false;
  log.textContent += `${line}\n`;
  log.scrollTop = log.scrollHeight;
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

  // Os arquivos são os que existem na pasta, com o caminho real: clicar abre
  // no programa padrão do sistema.
  const files = $('drawer-files');
  files.replaceChildren();
  const ROTULOS = { md: 'transcrição', txt: 'texto', pdf: 'documento' };
  for (const f of m.files || []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'file-row';
    b.title = `Abrir ${f.name}`;
    const nome = document.createElement('span');
    nome.textContent = f.name;
    const tipo = document.createElement('span');
    tipo.className = 'ext';
    tipo.textContent = `${ROTULOS[f.ext] || f.ext} · ${f.sizeKB} KB`;
    b.append(nome, tipo);
    b.addEventListener('click', () => window.api.openPath(f.path));
    files.append(b);
  }
  if (!(m.files || []).length) files.append(emptyNote('Nenhum arquivo nesta reunião.'));

  await renderDrawerTasks(m.id);

  // O botão só aparece quando a reunião ainda não tem o documento — e quando
  // nada mais está rodando: a tela de trabalho mostra um job só.
  $('drawer-docs').hidden = m.hasDocumento || proc.active;

  renderReader(drawerTranscript, '');
  $('drawer').hidden = false;
  $('drawer-scrim').hidden = false;
}

const TASK_STATUS_LABEL = { backlog: 'backlog', doing: 'em andamento', done: 'concluído' };
const TASK_STATUS_PILL = { backlog: '', doing: 'on', done: 'mint' };

/**
 * As tarefas que nasceram desta reunião — a mesma lista que está no documento.
 * Clicar abre o card, como no Kanban; o vínculo passa a ser visível dos dois lados.
 */
async function renderDrawerTasks(meetingId) {
  const box = $('drawer-tasks');
  const tarefas = await window.api.tasksForMeeting(meetingId);
  box.replaceChildren();
  if (!tarefas.length) {
    box.append(emptyNote('Nenhuma tarefa veio desta reunião.'));
    return;
  }
  for (const t of tarefas) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `task-row${t.status === 'done' ? ' is-done' : ''}`;
    b.title = 'Abrir a tarefa';
    const prio = document.createElement('span');
    prio.className = `prio prio-${t.priority}`;
    prio.title = `prioridade ${PRIO_LABEL[t.priority]}`;
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = t.title;
    b.append(prio, title);
    if (t.assignee) {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = t.assignee;
      b.append(who);
    }
    b.append(pill(TASK_STATUS_LABEL[t.status] || t.status, TASK_STATUS_PILL[t.status] || ''));
    b.addEventListener('click', () => openTaskModal(t));
    box.append(b);
  }
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
    message: 'A transcrição, a análise e o PDF vão para a Lixeira, e as tarefas que nasceram desta reunião são apagadas do kanban.',
    confirmLabel: 'Excluir reunião',
  });
  if (!ok) return;
  await window.api.deleteMeeting(drawerMeetingId);
  closeDrawer();
  await refreshAll();
});

$('drawer-docs').addEventListener('click', async () => {
  if (busyWarning()) return;
  const alvo = drawerMeetingId;
  const nome = $('drawer-name').textContent;
  closeDrawer();
  // Pedido à mão gera o documento, ligado ou não em Configurações.
  enterDocPhase(alvo, DOC_KINDS_ALL, { name: nome });
  const r = await window.api.generateDoc({ meetingId: alvo });
  if (r && r.started === false) {
    stopProcessing();
    toast(r.message);
  }
});

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
  for (const id of ['modal-project', 'modal-task', 'modal-confirm', 'modal-prompt']) $(id).hidden = true;
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
  $('mp-workdir').value = p?.workdir || '';
  $('mp-error').textContent = '';
  $('mp-delete').hidden = !p;
  openModal('modal-project');
  $('mp-name').focus();
}

$('mp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await window.api.saveProject({
    id: editingProjectId, name: $('mp-name').value, context: $('mp-context').value,
    workdir: $('mp-workdir').value,
  });
  if (!r.ok) { $('mp-error').textContent = r.message; return; }
  closeModals();
  await refreshAll();
  openProject(r.id, editingProjectId ? currentTab : 'overview');
  // A pasta mudou: as reuniões do projeto foram junto, e vale dizer quantas.
  if (r.moved) toast(`<strong>${r.moved}</strong> reunião(ões) movida(s) para a pasta do projeto.`);
  if (r.warning) toast(r.warning);
});

$('mp-workdir-pick').addEventListener('click', async () => {
  const dir = await window.api.pickWorkdir();
  if (dir) $('mp-workdir').value = dir;
});
$('mp-workdir-clear').addEventListener('click', () => { $('mp-workdir').value = ''; });

$('mp-delete').addEventListener('click', async () => {
  const p = projects.find((x) => x.id === editingProjectId);
  if (!p) return;
  const ok = await confirmDanger({
    title: `Excluir "${p.name}"?`,
    message: 'Tudo dele vai junto: as reuniões (transcrições, análises e PDFs vão para a Lixeira), as tarefas do kanban e o histórico do chat.',
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
    // Editando, a tarefa fica no projeto dela: o card pode ter sido aberto
    // pelo painel de uma reunião, fora da tela do projeto.
    projectId: editingTaskId ? undefined : currentProjectId,
    title: $('mt-name').value,
    description: $('mt-desc').value,
    assignee: $('mt-assignee').value,
    priority: $('mt-priority').value,
    status: $('mt-status').value,
  });
  if (!r.ok) { $('mt-error').textContent = r.message; return; }
  closeModals();
  await refreshAfterTaskChange();
});

/** O card mudou: o projeto, a barra lateral e o painel da reunião acompanham. */
async function refreshAfterTaskChange() {
  await refreshProjects();
  renderSidebar();
  if (view === 'project') {
    if (currentTab === 'kanban') renderKanban();
    if (currentTab === 'overview') renderOverview();
    if (currentTab === 'graph') renderGraph();
  }
  if (drawerMeetingId) await renderDrawerTasks(drawerMeetingId);
}

$('mt-delete').addEventListener('click', async () => {
  await window.api.deleteTask(editingTaskId);
  closeModals();
  await refreshProjects();
  if (currentTab === 'kanban') renderKanban(); else renderOverview();
});

$('mt-cancel').addEventListener('click', closeModals);

// Importação: confirmar nome + projeto.
function askImport(filePath, kind = "video") {
  if (busyWarning()) return;
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
  $('mc-auto').checked = false;
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
  const autoName = $('mc-auto').checked;
  closeModals();

  if (pendingKind === 'transcript') {
    startProcessing(nome, projectId);
    const r = await window.api.importTranscript({ filePath: pendingVideo, name: nome, projectId, autoName });
    if (!r.ok) {
      stopProcessing();
      toast(`Não deu para importar: ${r.message}`);
    }
    return;
  }

  startProcessing(nome, projectId);
  const r = await window.api.startJob({ videoPath: pendingVideo, name: nome, projectId, autoName });
  if (r && r.started === false) {
    // Outra transcrição ainda roda (talvez minimizada): sem isto a tela
    // ficaria em "Iniciando" para sempre.
    stopProcessing();
    toast(`Não deu para começar: ${r.message}`);
  }
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
  if (busyWarning()) return;
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
  if (!recordNet) recordNet = window.createNetwork($('record-net'));
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
    stopProcessing();
    toast(`Não deu para processar: ${result.message}`);
  }
});

// --- Processamento (pipeline) -----------------------------------------------------------------

const STAGE_RANGE = { audio: [0, 0.1], transcription: [0.1, 0.72], export: [0.72, 0.78], analyze: [0.78, 1] };
const STAGE_LABELS = { audio: 'Extraindo áudio', transcription: 'Transcrevendo', export: 'Gravando arquivos', analyze: 'Analisando a reunião' };
const DOC_KINDS_ALL = ['documento'];
const DOC_NAMES = { documento: 'documento' };

/**
 * Estado único da tela de trabalho.
 *
 * A mesma informação — etapa, percentual, nome — aparece em dois lugares: na
 * tela cheia e, quando ela é minimizada, no chip no pé da barra lateral. Tudo
 * escreve aqui e `renderProcessing` desenha dos dois lados, para nenhum deles
 * ficar para trás.
 */
const proc = { active: false, minimized: false, stage: '', pct: 0, name: '' };

function renderProcessing() {
  const pct = `${Math.round(proc.pct * 100)}%`;
  $('process-name').textContent = proc.name;
  $('process-stage').textContent = proc.stage;
  $('process-pct').textContent = pct;
  $('overlay-process').hidden = !proc.active || proc.minimized;

  $('jobchip').hidden = !proc.active || !proc.minimized;
  $('jobchip-stage').textContent = proc.stage;
  $('jobchip-name').textContent = proc.name;
  $('jobchip-pct').textContent = pct;
  $('jobchip-fill').style.transform = `scaleX(${proc.pct})`;

  processNet?.setProgress(proc.pct);
}

function setProcessing(stage, pct) {
  proc.stage = stage;
  if (typeof pct === 'number') proc.pct = Math.min(1, Math.max(0, pct));
  renderProcessing();
}

function ensureProcessNet() {
  if (!processNet) processNet = window.createNetwork($('process-net'));
  // O canvas pode ter nascido escondido, sem tamanho: mede de novo.
  window.dispatchEvent(new Event('resize'));
  processNet.setMode('working');
}

/**
 * Abre a tela de processamento: a rede e uma frase que acompanha a etapa.
 *
 * A lista de passos saiu — o texto já diz onde o trabalho está, e a coluna
 * curta cabe centralizada em qualquer janela.
 */
function startProcessing(label, projectId) {
  jobProjectId = projectId || '';
  Object.assign(proc, { active: true, minimized: false, stage: 'Iniciando', pct: 0, name: label || '' });
  renderProcessing();
  ensureProcessNet();
  processNet.setProgress(0);
}

/**
 * Minimizar não interrompe nada: o trabalho segue no processo principal e a
 * tela cheia vira o chip da barra lateral, de onde se volta com um clique.
 */
function minimizeProcessing() {
  if (!proc.active) return;
  proc.minimized = true;
  renderProcessing();
}

function restoreProcessing() {
  if (!proc.active) return;
  proc.minimized = false;
  renderProcessing();
  ensureProcessNet();
}

function stopProcessing() {
  docPhase = false;
  Object.assign(proc, { active: false, minimized: false });
  renderProcessing();
}

function cancelCurrent() {
  if (docPhase) window.api.cancelDoc();
  else window.api.cancelJob();
}

/**
 * A tela de trabalho acompanha um job por vez.
 *
 * Com ela minimizada o app fica livre, e daria para começar outra reunião ou
 * pedir PDFs por cima — os dois jobs escreveriam no mesmo progresso e o
 * cancelar não saberia qual deles parar. Avisa e mostra onde está o que roda.
 */
function busyWarning() {
  if (!proc.active) return false;
  toast(`Espere <strong>${proc.name || 'o processamento'}</strong> terminar — o progresso está na barra lateral.`);
  if (proc.minimized) $('jobchip-main').classList.add('is-nudged');
  setTimeout(() => $('jobchip-main').classList.remove('is-nudged'), 900);
  return true;
}

$('process-cancel').addEventListener('click', cancelCurrent);
$('jobchip-cancel').addEventListener('click', cancelCurrent);
$('process-minimize').addEventListener('click', minimizeProcessing);
$('jobchip-open').addEventListener('click', restoreProcessing);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && proc.active && !proc.minimized) minimizeProcessing();
});

/**
 * A reunião só está pronta quando os documentos estão prontos.
 *
 * A tela de trabalho continua aberta na etapa dos PDFs em vez de fechar e
 * deixar o resto acontecer atrás de avisos no rodapé. O Claude não informa
 * percentual, então cada passo do stream empurra a barra um pouco, dentro da
 * fatia do documento em curso.
 */
let docPhase = false;
let docProgress = 0;
let docKinds = DOC_KINDS_ALL;
let pendingMeetingId = '';
let jobSummary = null;   // o que contar quando tudo terminar

function docStageLabel(kinds) {
  const nomes = kinds.map((k) => DOC_NAMES[k] || k);
  return `Gerando ${nomes.join(' e ')} em PDF`;
}

// --- Prompts editáveis (Configurações) -----------------------------------------------------------------

let editingPromptKind = '';

/**
 * O seletor lista o que o processo principal registra: um prompt novo entra
 * no código e aparece aqui, sem botão novo na tela.
 */
async function renderPromptChoices() {
  const sel = $('set-prompt-kind');
  const atual = sel.value;
  const lista = await window.api.listPrompts();
  sel.replaceChildren(...lista.map((p) => new Option(p.label, p.kind)));
  if (lista.some((p) => p.kind === atual)) sel.value = atual;
}

/**
 * Abre o prompt de uma etapa para leitura e edição.
 *
 * O texto vem do processo principal: o padrão do app ou a versão que a pessoa
 * gravou. A lista de placeholders fica visível o tempo todo, porque é o que
 * não pode sair — o app preenche esses trechos na hora de rodar.
 */
async function openPromptModal(kind) {
  const p = await window.api.getPrompt(kind);
  editingPromptKind = kind;
  $('mp-title').textContent = p.label || 'Prompt';
  $('mp-status').textContent = p.isCustom
    ? 'editado por você — o padrão do app segue guardado'
    : 'padrão do app';
  $('mp-text').value = p.text;
  $('mp-reset').hidden = !p.isCustom;
  $('mp-error').textContent = '';

  const help = $('mp-help');
  help.replaceChildren('O app preenche na hora os trechos entre chaves: ');
  p.placeholders.forEach((ph, i) => {
    const code = document.createElement('code');
    code.textContent = ph;
    if (i) help.append(', ');
    help.append(code);
  });
  help.append(`. Obrigatórios: ${p.required.join(', ')}.`);

  openModal('modal-prompt');
  $('mp-text').focus();
}

$('set-prompt-open').addEventListener('click', () => {
  const kind = $('set-prompt-kind').value;
  if (kind) openPromptModal(kind);
});

$('mp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await window.api.savePrompt(editingPromptKind, $('mp-text').value);
  if (!r.ok) { $('mp-error').textContent = r.message; return; }
  closeModals();
  toast(r.isCustom ? 'Prompt salvo — vale a partir da próxima reunião.' : 'Prompt igual ao padrão: nada a guardar.');
});

$('mp-reset').addEventListener('click', async () => {
  await window.api.resetPrompt(editingPromptKind);
  await openPromptModal(editingPromptKind);
  toast('Prompt restaurado ao padrão do app.');
});

$('mp-cancel').addEventListener('click', closeModals);

function enterDocPhase(meetingId, kinds = DOC_KINDS_ALL, { name } = {}) {
  docPhase = true;
  docProgress = 0;
  docKinds = kinds.length ? kinds : DOC_KINDS_ALL;
  pendingMeetingId = meetingId || '';
  if (!proc.active) {
    // Veio do botão da reunião, não do fim do pipeline: abre a tela do zero.
    Object.assign(proc, { active: true, minimized: false, name: name || '' });
  }
  ensureProcessNet();
  setProcessing(docStageLabel(docKinds), 0);
}

function advanceDocs(kind) {
  const fatia = 1 / docKinds.length;
  const indice = Math.max(0, docKinds.indexOf(kind));
  const base = indice * fatia;
  const teto = (indice + 1) * fatia - 0.03;
  docProgress = Math.min(teto, Math.max(base, docProgress + 0.14 * fatia));
  setProcessing(proc.stage, docProgress);
}

window.api.on('job:event', async (event) => {
  if (event.event === 'stage') {
    const [from, to] = STAGE_RANGE[event.key] || [0, 1];
    const overall = from + ((to - from) * (event.progress || 0)) / 100;
    setProcessing(STAGE_LABELS[event.key] || event.label || '', overall);
  } else if (event.event === 'done') {
    setProcessing('Transcrição pronta', 1);
    await refreshAll();
    // Minimizado, a pessoa está em outra coisa: o projeto não a puxa para lá.
    if (jobProjectId && !proc.minimized) {
      openProject(jobProjectId, event.tasksCreated ? 'kanban' : 'meetings');
    }
    // Nada de aviso agora: o que aconteceu aqui entra no aviso único do fim.
    jobSummary = { renamedTo: event.renamedTo || '', tasksCreated: event.tasksCreated || 0 };
    const docs = Array.isArray(event.docs) ? event.docs : [];
    if (docs.length) {
      setTimeout(() => enterDocPhase(event.meetingId, docs), 700);
    } else {
      // Nenhum PDF ligado em Configurações: a reunião está pronta aqui mesmo.
      setProcessing('Pronto', 1);
      await pausaCurta();
      const wasMinimized = proc.minimized;
      stopProcessing();
      announceReady({ meetingId: event.meetingId, kinds: [], wasMinimized });
    }
  } else if (event.event === 'error') {
    stopProcessing();
    toast(`Não deu para processar: ${event.message || 'erro desconhecido'}`);
  } else if (event.event === 'canceled') {
    stopProcessing();
  }
});

window.api.on('doc:progress', ({ kind }) => {
  if (!docPhase) return;
  advanceDocs(kind);
});

window.api.on('doc:done', async (result) => {
  const meetingId = result.meetingId || pendingMeetingId;
  let wasMinimized = false;
  if (docPhase) {
    setProcessing('Pronto', 1);
    await pausaCurta();
    wasMinimized = proc.minimized;
    stopProcessing();
    pendingMeetingId = '';
  }

  await refreshAll();

  if (result.canceled) { toast('Geração cancelada.'); return; }
  if (!result.ok) {
    toast(`Os documentos não foram gerados. ${result.message || ''}`.trim());
    if (meetingId && !wasMinimized) openDrawer(meetingId);
    return;
  }

  announceReady({ meetingId, kinds: result.kinds || [], wasMinimized });
});

/**
 * Um aviso só, no fim: nome, tarefas e documentos numa frase.
 *
 * Se a tela estava minimizada, a pessoa seguiu trabalhando em outra coisa —
 * o aviso conta, mas o painel da reunião não abre por cima do que ela faz.
 */
function announceReady({ meetingId, kinds, wasMinimized }) {
  const partes = [];
  if (jobSummary?.renamedTo) partes.push(`Reunião pronta como <strong>${jobSummary.renamedTo}</strong>`);
  else partes.push('Reunião pronta');
  if (jobSummary?.tasksCreated) partes.push(`<strong>${jobSummary.tasksCreated} tarefas</strong> no kanban`);
  const nomes = kinds.map((k) => DOC_NAMES[k] || k);
  if (nomes.length) partes.push(`${nomes.join(' e ')} em PDF`);
  jobSummary = null;
  toast(partes.join(' · '));
  if (meetingId && !wasMinimized) openDrawer(meetingId);
}

function pausaCurta() {
  return new Promise((resolve) => setTimeout(resolve, 700));
}

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

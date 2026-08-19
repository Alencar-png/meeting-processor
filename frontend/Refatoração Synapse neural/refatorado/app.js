'use strict';

/**
 * Lógica da janela: estados, drop do arquivo e leitura dos eventos do job.
 */

const app = document.getElementById('app');
const stage = document.getElementById('stage');
const wave = window.createNeural(document.getElementById('neural'));

const el = {
  engine: document.getElementById('engine'),
  engineText: document.getElementById('engine-text'),
  pickVideo: document.getElementById('pick-video'),
  workingFile: document.getElementById('working-file'),
  workingStage: document.getElementById('working-stage'),
  workingPct: document.getElementById('working-pct'),
  workingClock: document.getElementById('working-clock'),
  workingDetail: document.getElementById('working-detail'),
  cancel: document.getElementById('cancel'),
  doneSummary: document.getElementById('done-summary'),
  files: document.getElementById('files'),
  openFolder: document.getElementById('open-folder'),
  again: document.getElementById('again'),
  errorMessage: document.getElementById('error-message'),
  retry: document.getElementById('retry'),
  blockedMessage: document.getElementById('blocked-message'),
  build: document.getElementById('build'),
  recheck: document.getElementById('recheck'),
  buildLog: document.getElementById('build-log'),
  outputDir: document.getElementById('output-dir'),
  outputDirValue: document.getElementById('output-dir-value'),
  model: document.getElementById('model'),
  language: document.getElementById('language'),

  library: document.getElementById('library'),
  libraryCount: document.getElementById('library-count'),
  libraryEmpty: document.getElementById('library-empty'),

  detailName: document.getElementById('detail-name'),
  detailDate: document.getElementById('detail-date'),
  detailFiles: document.getElementById('detail-files'),
  detailError: document.getElementById('detail-error'),
  detailTarefas: document.getElementById('detail-tarefas'),
  detailResumo: document.getElementById('detail-resumo'),
  detailRename: document.getElementById('detail-rename'),
  detailDelete: document.getElementById('detail-delete'),
  detailBack: document.getElementById('detail-back'),
  renameForm: document.getElementById('rename-form'),
  renameInput: document.getElementById('rename-input'),
  renameCancel: document.getElementById('rename-cancel'),

  detailMeta: document.getElementById('detail-meta'),
  detailGroup: document.getElementById('detail-group'),
  manageGroups: document.getElementById('manage-groups'),

  contextTarget: document.getElementById('context-target'),
  contextTitle: document.getElementById('context-title'),
  contextUseGroup: document.getElementById('context-use-group'),
  contextGroupName: document.getElementById('context-group-name'),
  contextGroupText: document.getElementById('context-group-text'),
  contextCustom: document.getElementById('context-custom'),
  contextGenerate: document.getElementById('context-generate'),
  contextCancel: document.getElementById('context-cancel'),

  groupList: document.getElementById('group-list'),
  groupForm: document.getElementById('group-form'),
  groupName: document.getElementById('group-name'),
  groupContext: document.getElementById('group-context'),
  groupClear: document.getElementById('group-clear'),
  groupDelete: document.getElementById('group-delete'),
  groupsClose: document.getElementById('groups-close'),
  groupError: document.getElementById('group-error'),
  tableGroup: document.getElementById('table-group'),
  detailView: document.getElementById('detail-view'),
  detailDownload: document.getElementById('detail-download'),

  confirmFile: document.getElementById('confirm-file'),
  confirmForm: document.getElementById('confirm-form'),
  confirmInput: document.getElementById('confirm-input'),
  confirmCancel: document.getElementById('confirm-cancel'),
  confirmError: document.getElementById('confirm-error'),

  viewerFile: document.getElementById('viewer-file'),
  viewerName: document.getElementById('viewer-name'),
  viewerText: document.getElementById('viewer-text'),
  viewerSearch: document.getElementById('viewer-search'),
  viewerDownload: document.getElementById('viewer-download'),
  viewerClose: document.getElementById('viewer-close'),

  viewTable: document.getElementById('view-table'),
  table: document.getElementById('table'),
  tableBody: document.getElementById('table-body'),
  tableSearch: document.getElementById('table-search'),
  tableFilter: document.getElementById('table-filter'),
  tableClose: document.getElementById('table-close'),
  tableEmpty: document.getElementById('table-empty'),
  tableError: document.getElementById('table-error'),
  tableNew: document.getElementById('table-new'),
  tableBulk: document.getElementById('table-bulk'),
  tableSelection: document.getElementById('table-selection'),
  tableDeleteSelected: document.getElementById('table-delete-selected'),
  tableClearSelection: document.getElementById('table-clear-selection'),
  tableCheckAll: document.getElementById('table-check-all'),

  doneTarefas: document.getElementById('done-tarefas'),
  doneResumo: document.getElementById('done-resumo'),
  docTarget: document.getElementById('doc-target'),
  docTitle: document.getElementById('doc-title'),
  docActivity: document.getElementById('doc-activity'),
  docClock: document.getElementById('doc-clock'),
  docCancel: document.getElementById('doc-cancel'),
};

const DOC_TITLES = { tarefas: 'Gerando tarefas', resumo: 'Gerando resumo' };
const DOC_ASK_TITLES = { tarefas: 'Gerar tarefas', resumo: 'Gerar resumo' };

// Nomes das etapas na voz da interface (o CLI emite rótulos sem acento).
const STAGE_LABELS = {
  audio: 'Extraindo áudio',
  transcription: 'Transcrevendo',
  export: 'Gravando arquivos',
};

// Peso de cada etapa no progresso geral: a transcrição é quase todo o tempo.
const STAGE_RANGE = {
  audio: [0, 0.12],
  transcription: [0.12, 0.94],
  export: [0.94, 1],
};

// Modelos do motor Docker (baixados sob demanda dentro do container).
const DOCKER_MODELS = [
  { id: 'tiny', label: 'tiny — mais rápido' },
  { id: 'base', label: 'base' },
  { id: 'small', label: 'small — equilibrado' },
  { id: 'medium', label: 'medium' },
  { id: 'large-v3', label: 'large-v3 — mais preciso' },
];

let settings = null;
let engines = null;
let engineReady = false;
let clockTimer = null;
let startedAt = 0;
let lastOutputDir = '';
let meetings = [];
let selected = null;      // reunião aberta no painel de detalhe
let docStartedAt = 0;
let docTimer = null;
let pendingVideo = '';    // vídeo aguardando confirmação do nome
let viewerFilePath = '';  // arquivo aberto no leitor
let viewerContent = '';
let tableView = { search: '', filter: 'todas', group: '', sort: 'recorded', dir: 'desc' };
const tableSelection = new Set();  // ids marcados para ações em lote
let groups = [];
let editingGroupId = '';  // grupo aberto no formulário de projetos
let pendingDoc = null;    // { kind, meeting } aguardando a escolha de contexto

// --- Estados ---------------------------------------------------------------

// A rede neural só conhece cinco modos; os estados novos reaproveitam os existentes.
const WAVE_MODE = {
  blocked: 'error',
  detail: 'done',
  doc: 'working',
  confirm: 'dragging',
  viewer: 'done',
  table: 'done',
  context: 'dragging',
  groups: 'done',
};

function setState(state) {
  app.dataset.state = state;
  wave.setMode(WAVE_MODE[state] || state);
}

function state() {
  return app.dataset.state;
}

// --- Formatação ------------------------------------------------------------

function clock(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function baseName(filePath) {
  return filePath.split(/[\\/]/).pop();
}

// --- Motor (Docker) --------------------------------------------------------

/** Preenche o seletor de modelos conforme o motor ativo. */
function fillModels() {
  const isNative = engines.active === 'native';
  const options = isNative
    ? engines.native.models.map((m) => ({
        id: m.path,
        label: `${m.id} — ${(m.sizeMB / 1024).toFixed(1)} GB`,
      }))
    : DOCKER_MODELS;

  el.model.replaceChildren();
  for (const option of options) {
    const node = document.createElement('option');
    node.value = option.id;
    node.textContent = option.label;
    el.model.append(node);
  }

  const saved = isNative ? settings.nativeModel : settings.model;
  if (saved && options.some((o) => o.id === saved)) {
    el.model.value = saved;
  } else if (options.length) {
    el.model.value = options[0].id;
  }
}

async function checkEngine() {
  engines = await window.api.enginesStatus();
  const isNative = engines.active === 'native';
  const active = isNative ? engines.native : engines.docker;
  engineReady = Boolean(active.ok);

  el.engine.dataset.ok = String(engineReady);
  el.engineText.textContent = engineReady
    ? isNative
      ? 'GPU · whisper.cpp'
      : `Docker ${engines.docker.version} · CPU`
    : 'motor indisponível';

  fillModels();

  if (!engineReady) {
    el.blockedMessage.textContent = active.message || 'Nenhum motor disponível.';
    // O botão de construir só faz sentido quando o Docker está no ar.
    el.build.disabled = !engines.docker.docker || isNative;
    setState('blocked');
  } else if (state() === 'blocked') {
    setState('idle');
  }
}

/** Alterna entre GPU e Docker, guardando a escolha. */
async function toggleEngine() {
  if (state() === 'working') return;
  const next = engines.active === 'native' ? 'docker' : 'native';
  settings = await window.api.setSettings({ engine: next });
  await checkEngine();
}

// --- Biblioteca -------------------------------------------------------------

async function refreshLibrary(selectId = selected?.id) {
  meetings = await window.api.listMeetings();
  el.libraryCount.textContent = String(meetings.length);
  el.libraryEmpty.hidden = meetings.length > 0;
  window.libraryUI.renderLibraryList(el.library, meetings, {
    selectedId: selectId,
    onSelect: openMeeting,
  });
  // A tabela lê a mesma lista: se está aberta, acompanha a mudança.
  if (state() === 'table') renderTable();
}

/** Abre uma reunião no painel de detalhe. */
async function openMeeting(id) {
  const meeting = await window.api.getMeeting(id);
  if (!meeting) {
    // Sumiu do disco entre a listagem e o clique.
    await refreshLibrary(null);
    return;
  }

  selected = meeting;
  el.detailName.textContent = meeting.name;
  el.detailDate.textContent = meeting.meta?.source_file || baseName(meeting.transcript || '');
  el.detailError.textContent = '';
  el.renameForm.hidden = true;
  fillMeta(meeting);
  fillGroupSelect(el.detailGroup, {
    selectedId: meeting.group?.id || '',
    emptyLabel: 'sem projeto',
  });
  window.libraryUI.renderFileList(el.detailFiles, meeting.files, {
    onOpen: (filePath) => window.api.openPath(filePath),
  });

  await refreshLibrary(id);
  setState('detail');
}

/** Preenche o bloco de metadados do detalhe. */
function fillMeta(meeting) {
  const meta = meeting.meta;
  const recorded = window.tableUI.recordedAt(meeting);
  const campos = [
    ['Gravado em', window.tableUI.formatDateTime(recorded)],
    ['Duração', window.tableUI.formatDuration(meta?.duration_seconds)],
    ['Falas', meta?.segments != null ? String(meta.segments) : '—'],
    ['Modelo', meta?.model || '—'],
    ['Idioma', meta?.language || '—'],
    ['Arquivo', meta?.source_file || '—'],
  ];
  // Sem meeting.json (transcrição antiga), a data vem do arquivo em disco:
  // dizer isso evita passar por informação da gravação.
  if (!meta || meta.date_source === 'arquivo') {
    campos[0][0] = 'Data do arquivo';
  }

  el.detailMeta.replaceChildren();
  for (const [rotulo, valor] of campos) {
    const bloco = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = rotulo;
    const dd = document.createElement('dd');
    dd.textContent = valor;
    bloco.append(dt, dd);
    el.detailMeta.append(bloco);
  }
}

// --- Leitor da transcrição --------------------------------------------------

/** Destaca as ocorrências do termo no texto, sem interpretar HTML. */
function renderReader(text, termo) {
  el.viewerText.replaceChildren();
  const busca = termo.trim();
  if (!busca) {
    el.viewerText.textContent = text;
    return;
  }

  const alvo = busca.toLowerCase();
  const fonte = text.toLowerCase();
  let cursor = 0;
  let achou = fonte.indexOf(alvo);

  while (achou !== -1) {
    el.viewerText.append(document.createTextNode(text.slice(cursor, achou)));
    const marca = document.createElement('mark');
    marca.textContent = text.slice(achou, achou + busca.length);
    el.viewerText.append(marca);
    cursor = achou + busca.length;
    achou = fonte.indexOf(alvo, cursor);
  }
  el.viewerText.append(document.createTextNode(text.slice(cursor)));
}

async function openViewer(meeting) {
  if (!meeting?.transcript) return;
  const result = await window.api.readFile(meeting.transcript);
  if (!result.ok) {
    onError(result.message);
    return;
  }
  viewerFilePath = meeting.transcript;
  viewerContent = result.text;
  el.viewerName.textContent = meeting.name;
  el.viewerFile.textContent = baseName(meeting.transcript);
  el.viewerSearch.value = '';
  renderReader(viewerContent, '');
  setState('viewer');
}

// --- Tabela -----------------------------------------------------------------

/** Renomeia a partir da tabela, sem sair dela. */
async function renameFromTable(id, novoNome, encerrarEdicao) {
  const result = await window.api.renameMeeting(id, novoNome);
  if (!result.ok) {
    el.tableError.textContent = result.message;
    encerrarEdicao();
    return;
  }
  el.tableError.textContent = '';
  // A seleção acompanha o novo id, senão a linha renomeada "perderia" a marca.
  if (tableSelection.delete(id)) tableSelection.add(result.id);
  await refreshLibrary();
}

/** Exclui uma reunião a partir da tabela, com confirmação. */
async function deleteFromTable(id) {
  const reuniao = meetings.find((m) => m.id === id);
  if (!reuniao) return;
  const confirmado = window.confirm(
    `Excluir "${reuniao.name}"?\n\n${reuniao.files.length} arquivo(s) serão apagados do disco. Não dá para desfazer.`,
  );
  if (!confirmado) return;

  const result = await window.api.deleteMeeting(id);
  el.tableError.textContent = result.ok ? '' : result.message;
  tableSelection.delete(id);
  if (selected?.id === id) selected = null;
  await refreshLibrary();
}

/** Exclui todas as reuniões marcadas, relatando o que falhou. */
async function deleteSelectedFromTable() {
  const ids = [...tableSelection];
  if (!ids.length) return;

  const total = ids.reduce(
    (soma, id) => soma + (meetings.find((m) => m.id === id)?.files.length || 0), 0,
  );
  const confirmado = window.confirm(
    `Excluir ${ids.length} transcrição(ões)?\n\n${total} arquivo(s) serão apagados do disco. Não dá para desfazer.`,
  );
  if (!confirmado) return;

  const falhas = [];
  for (const id of ids) {
    const result = await window.api.deleteMeeting(id);
    if (!result.ok) falhas.push(`${id}: ${result.message}`);
    else tableSelection.delete(id);
  }

  el.tableError.textContent = falhas.length ? falhas.join(' · ') : '';
  if (selected && !meetings.some((m) => m.id === selected.id)) selected = null;
  await refreshLibrary();
}

function toggleSelection(id, marcado) {
  if (marcado) tableSelection.add(id);
  else tableSelection.delete(id);
  renderTable();
}

function renderTable() {
  const rows = window.tableUI.applyView(meetings, tableView);
  // Reuniões excluídas ou renomeadas não podem seguir "selecionadas".
  const visiveis = new Set(rows.map((r) => r.id));
  for (const id of [...tableSelection]) {
    if (!visiveis.has(id)) tableSelection.delete(id);
  }

  const nameCells = window.tableUI.renderTable(el.tableBody, rows, {
    selection: tableSelection,
    onOpen: openMeeting,
    onToggle: toggleSelection,
    onRename: renameFromTable,
    onRenameStart: (id) => nameCells.get(id)?.startEditing(),
    onDelete: deleteFromTable,
  });

  // A mensagem distingue "não há nada" de "o filtro escondeu tudo".
  if (rows.length) {
    el.tableEmpty.textContent = `${rows.length} de ${meetings.length} transcrição(ões)`;
  } else if (meetings.length) {
    el.tableEmpty.textContent = 'Nenhuma transcrição corresponde à busca.';
  } else {
    el.tableEmpty.textContent = 'Nenhuma transcrição ainda. Solte um vídeo para começar.';
  }

  const marcadas = tableSelection.size;
  el.tableBulk.hidden = marcadas === 0;
  el.tableSelection.textContent = `${marcadas} selecionada(s)`;
  el.tableCheckAll.checked = marcadas > 0 && marcadas === rows.length;
  el.tableCheckAll.indeterminate = marcadas > 0 && marcadas < rows.length;

  for (const th of el.table.querySelectorAll('th')) {
    if (th.dataset.sort === tableView.sort) th.dataset.active = tableView.dir;
    else delete th.dataset.active;
  }
}

async function renameSelected(newName) {
  const result = await window.api.renameMeeting(selected.id, newName);
  if (!result.ok) {
    el.detailError.textContent = result.message;
    return;
  }
  el.renameForm.hidden = true;
  await openMeeting(result.id);
}

async function deleteSelected() {
  const count = selected.files.length;
  const confirmed = window.confirm(
    `Excluir "${selected.name}"?\n\n${count} arquivo(s) serão apagados do disco. Não dá para desfazer.`,
  );
  if (!confirmed) return;

  const result = await window.api.deleteMeeting(selected.id);
  if (!result.ok) {
    el.detailError.textContent = result.message;
    return;
  }
  selected = null;
  await refreshLibrary(null);
  setState('idle');
}

// --- Grupos (projetos) ------------------------------------------------------

/** Preenche um <select> com os projetos existentes. */
function fillGroupSelect(select, { selectedId = '', emptyLabel }) {
  select.replaceChildren();

  const vazio = document.createElement('option');
  vazio.value = '';
  vazio.textContent = emptyLabel;
  select.append(vazio);

  for (const group of groups) {
    const option = document.createElement('option');
    option.value = group.id;
    option.textContent = group.count
      ? `${group.name} (${group.count})`
      : group.name;
    select.append(option);
  }
  select.value = selectedId;
}

async function refreshGroups() {
  try {
    groups = await window.api.listGroups();
  } catch {
    // Projetos são um extra: sem eles a biblioteca ainda funciona, e derrubar
    // a tela inteira por causa deles seria desproporcional.
    groups = [];
  }
  fillGroupSelect(el.tableGroup, {
    selectedId: tableView.group,
    emptyLabel: 'todos os projetos',
  });
}

/** Lista de projetos no painel de gerenciamento. */
function renderGroupList() {
  el.groupList.replaceChildren();

  if (!groups.length) {
    const vazio = document.createElement('li');
    vazio.className = 'group-empty';
    vazio.textContent = 'Nenhum projeto ainda. Crie o primeiro abaixo.';
    el.groupList.append(vazio);
    return;
  }

  for (const group of groups) {
    const item = document.createElement('li');
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'group-item';
    if (group.id === editingGroupId) botao.classList.add('is-selected');

    const nome = document.createElement('span');
    nome.className = 'group-name';
    nome.textContent = group.name;

    const meta = document.createElement('span');
    meta.className = 'group-meta';
    meta.textContent = `${group.count} reunião(ões)`
      + (group.context ? ` · ${group.context.length} caracteres de contexto` : ' · sem contexto');

    botao.append(nome, meta);
    botao.addEventListener('click', () => editGroup(group.id));
    item.append(botao);
    el.groupList.append(item);
  }
}

function editGroup(groupId) {
  const group = groups.find((g) => g.id === groupId);
  editingGroupId = group ? group.id : '';
  el.groupName.value = group ? group.name : '';
  el.groupContext.value = group ? group.context : '';
  el.groupError.textContent = '';
  el.groupDelete.hidden = !group;
  renderGroupList();
}

async function openGroups() {
  await refreshGroups();
  editGroup('');
  setState('groups');
}

async function saveGroup() {
  const result = await window.api.saveGroup({
    id: editingGroupId,
    name: el.groupName.value,
    context: el.groupContext.value,
  });
  if (!result.ok) {
    el.groupError.textContent = result.message;
    return;
  }
  await refreshGroups();
  await refreshLibrary();
  editGroup(result.id);
}

async function deleteGroup() {
  const group = groups.find((g) => g.id === editingGroupId);
  if (!group) return;
  const confirmado = window.confirm(
    `Excluir o projeto "${group.name}"?\n\nAs ${group.count} reunião(ões) dele continuam no disco, apenas ficam sem projeto.`,
  );
  if (!confirmado) return;

  const result = await window.api.deleteGroup(group.id);
  if (!result.ok) {
    el.groupError.textContent = result.message;
    return;
  }
  await refreshGroups();
  await refreshLibrary();
  editGroup('');
}

/** Anexa a reunião aberta ao projeto escolhido (vazio desanexa). */
async function assignGroup(groupId) {
  if (!selected) return;
  const result = await window.api.assignGroup(selected.id, groupId);
  if (!result.ok) {
    el.detailError.textContent = result.message;
    return;
  }
  await refreshGroups();
  await refreshLibrary();
  selected = await window.api.getMeeting(selected.id);
}

// --- Documentos (Claude) ----------------------------------------------------

/**
 * Pergunta qual contexto usar antes de gerar o documento.
 *
 * O contexto do projeto é o padrão quando existe; sem projeto, a escolha cai
 * para um contexto específico desta reunião.
 */
function askContext(kind, meeting) {
  if (!meeting?.transcript) return;
  pendingDoc = { kind, meeting };

  const group = meeting.group;
  el.contextTitle.textContent = DOC_ASK_TITLES[kind];
  el.contextTarget.textContent = meeting.name;
  el.contextCustom.value = '';
  el.contextGroupName.textContent = group ? group.name : '';
  el.contextGroupText.textContent = group?.context || '';
  el.contextGroupText.hidden = !group?.context;

  // Sem projeto (ou projeto sem contexto), a opção não tem o que oferecer.
  const temContextoDeGrupo = Boolean(group?.context);
  el.contextUseGroup.disabled = !temContextoDeGrupo;
  el.contextUseGroup.closest('.choice').classList.toggle('is-disabled', !temContextoDeGrupo);

  const escolha = temContextoDeGrupo ? 'group' : 'custom';
  document.querySelector(`input[name="context-source"][value="${escolha}"]`).checked = true;

  setState('context');
  if (!temContextoDeGrupo) el.contextCustom.focus();
}

/** Contexto efetivo conforme a opção marcada. */
function chosenContext() {
  const escolha = document.querySelector('input[name="context-source"]:checked')?.value;
  if (escolha === 'group') return pendingDoc?.meeting.group?.context || '';
  if (escolha === 'custom') return el.contextCustom.value;
  return '';
}

/** Gera tarefas ou resumo em PDF para a reunião informada. */
async function generateDoc(kind, meeting, context = '') {
  if (!meeting?.transcript) return;

  el.docTitle.textContent = DOC_TITLES[kind];
  el.docTarget.textContent = meeting.name;
  el.docActivity.textContent = 'iniciando';
  el.docClock.textContent = '00:00';
  setState('doc');

  docStartedAt = Date.now();
  docTimer = window.setInterval(() => {
    el.docClock.textContent = clock((Date.now() - docStartedAt) / 1000);
  }, 1000);

  const result = await window.api.startDoc({
    kind,
    transcriptPath: meeting.transcript,
    context,
  });
  if (!result.started) {
    stopDocClock();
    onError(result.message);
  }
}

function stopDocClock() {
  if (docTimer) window.clearInterval(docTimer);
  docTimer = null;
}

// --- Job -------------------------------------------------------------------

function startClock() {
  startedAt = Date.now();
  el.workingClock.textContent = '00:00';
  clockTimer = window.setInterval(() => {
    el.workingClock.textContent = clock((Date.now() - startedAt) / 1000);
  }, 1000);
}

function stopClock() {
  if (clockTimer) window.clearInterval(clockTimer);
  clockTimer = null;
}

/** Pergunta o nome antes de transcrever: ele define a pasta da reunião. */
function askName(videoPath) {
  if (!engineReady || state() === 'working') return;
  pendingVideo = videoPath;
  el.confirmFile.textContent = baseName(videoPath);
  el.confirmError.textContent = '';
  el.confirmInput.value = baseName(videoPath).replace(/\.[^.]+$/, '');
  setState('confirm');
  el.confirmInput.focus();
  el.confirmInput.select();
}

async function startJob(videoPath, name = '') {
  if (!engineReady || state() === 'working') return;

  el.workingFile.textContent = baseName(videoPath);
  el.workingStage.textContent = STAGE_LABELS.audio;
  el.workingPct.textContent = '0%';
  el.workingDetail.textContent = '';
  wave.setProgress(0);
  setState('working');
  startClock();

  const isNative = engines.active === 'native';
  const result = await window.api.startJob({
    videoPath,
    name,
    outputDir: settings.outputDir,
    engine: engines.active,
    model: isNative ? settings.model : el.model.value,
    nativeModel: isNative ? el.model.value : settings.nativeModel,
    language: el.language.value,
    formats: settings.formats,
  });

  if (!result.started) {
    stopClock();
    el.errorMessage.textContent = result.message;
    setState('error');
  } else {
    lastOutputDir = settings.outputDir;
  }
}

function onStageEvent(event) {
  const [from, to] = STAGE_RANGE[event.key] || [0, 1];
  const overall = from + ((to - from) * (event.progress || 0)) / 100;
  wave.setProgress(overall);

  el.workingStage.textContent = STAGE_LABELS[event.key] || event.label;
  el.workingPct.textContent = `${Math.round(overall * 100)}%`;
  el.workingDetail.textContent = event.detail || '';
}

function onDone(event) {
  stopClock();
  wave.setProgress(1);

  el.files.replaceChildren();
  for (const file of event.files) {
    const name = baseName(file);
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.title = `Abrir ${name}`;

    const label = document.createElement('span');
    label.textContent = name;
    const ext = document.createElement('span');
    ext.className = 'ext';
    ext.textContent = name.split('.').pop();

    button.append(label, ext);
    button.addEventListener('click', () => window.api.openPath(file));
    item.append(button);
    el.files.append(item);
  }

  const audio = clock(event.duration);
  el.doneSummary.textContent = `${audio} de áudio em ${clock(event.elapsed)} · ${event.segments} falas`;
  setState('done');

  // A reunião recém-criada vira a seleção corrente: os botões de documento
  // do painel agem sobre ela. O id é o nome da pasta que guarda os arquivos.
  const parts = (event.files[0] || '').split(/[\\/]/);
  const id = parts[parts.length - 2] || '';
  refreshLibrary(id).then(async () => {
    selected = await window.api.getMeeting(id);
  });
}

function onError(message) {
  stopClock();
  el.errorMessage.textContent = message;
  setState('error');
}

// --- Arrastar e soltar ------------------------------------------------------

let dragDepth = 0;

window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth += 1;
  if (engineReady && state() !== 'working') setState('dragging');
});

window.addEventListener('dragover', (e) => e.preventDefault());

window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0 && state() === 'dragging') setState('idle');
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  if (state() === 'dragging') setState('idle');

  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  const filePath = window.api.pathForFile(file);
  if (filePath) askName(filePath);
});

// Clicar no palco vazio também abre o seletor — o alvo grande é o convite.
stage.addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  if (state() === 'idle') pickVideo();
});

stage.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && state() === 'idle') {
    e.preventDefault();
    pickVideo();
  }
});

async function pickVideo() {
  const filePath = await window.api.pickVideo();
  if (filePath) askName(filePath);
}

// --- Controles --------------------------------------------------------------

el.pickVideo.addEventListener('click', (e) => {
  e.stopPropagation();
  pickVideo();
});

el.outputDir.addEventListener('click', async () => {
  const chosen = await window.api.pickOutputDir();
  if (chosen) {
    settings.outputDir = chosen;
    el.outputDirValue.textContent = chosen;
    // A biblioteca é a pasta de saída: trocar de pasta troca a lista.
    selected = null;
    await refreshLibrary(null);
  }
});

el.model.addEventListener('change', () => {
  // No motor nativo o valor é o caminho do .bin; no Docker, o nome do modelo.
  const patch = engines.active === 'native'
    ? { nativeModel: el.model.value }
    : { model: el.model.value };
  settings = { ...settings, ...patch };
  window.api.setSettings(patch);
});

el.engine.addEventListener('click', toggleEngine);

el.language.addEventListener('change', () => {
  settings = { ...settings, language: el.language.value };
  window.api.setSettings({ language: el.language.value });
});

el.cancel.addEventListener('click', () => window.api.cancelJob());
el.again.addEventListener('click', () => setState('idle'));
el.retry.addEventListener('click', () => setState('idle'));
el.recheck.addEventListener('click', checkEngine);

// Documentos gerados pelo Claude: sempre passando pela escolha de contexto.
el.doneTarefas.addEventListener('click', () => askContext('tarefas', selected));
el.doneResumo.addEventListener('click', () => askContext('resumo', selected));
el.detailTarefas.addEventListener('click', () => askContext('tarefas', selected));
el.detailResumo.addEventListener('click', () => askContext('resumo', selected));
el.docCancel.addEventListener('click', () => window.api.cancelDoc());

el.contextGenerate.addEventListener('click', () => {
  if (!pendingDoc) return;
  generateDoc(pendingDoc.kind, pendingDoc.meeting, chosenContext());
});

el.contextCancel.addEventListener('click', () => {
  pendingDoc = null;
  setState('detail');
});

// Mexer no campo de contexto específico já marca a opção correspondente —
// texto digitado que fosse ignorado por causa do rádio seria uma armadilha.
const marcarContextoCustom = () => {
  document.querySelector('input[name="context-source"][value="custom"]').checked = true;
};
el.contextCustom.addEventListener('focus', marcarContextoCustom);
el.contextCustom.addEventListener('input', marcarContextoCustom);

// Projetos.
el.detailGroup.addEventListener('change', () => assignGroup(el.detailGroup.value));
el.manageGroups.addEventListener('click', openGroups);
// Reabrir a reunião recarrega o seletor de projetos: sem isso, um projeto
// recém-criado não apareceria na lista do detalhe.
el.groupsClose.addEventListener('click', async () => {
  if (selected) await openMeeting(selected.id);
  else setState('idle');
});
el.groupClear.addEventListener('click', () => editGroup(''));
el.groupDelete.addEventListener('click', deleteGroup);
el.groupForm.addEventListener('submit', (e) => {
  e.preventDefault();
  saveGroup();
});

el.tableGroup.addEventListener('change', () => {
  tableView = { ...tableView, group: el.tableGroup.value };
  renderTable();
});

// CRUD da biblioteca.
el.detailBack.addEventListener('click', () => setState('idle'));
el.detailDelete.addEventListener('click', deleteSelected);

el.detailRename.addEventListener('click', () => {
  el.renameForm.hidden = false;
  el.renameInput.value = selected.name;
  el.renameInput.focus();
  el.renameInput.select();
});

el.renameCancel.addEventListener('click', () => {
  el.renameForm.hidden = true;
  el.detailError.textContent = '';
});

el.renameForm.addEventListener('submit', (e) => {
  e.preventDefault();
  renameSelected(el.renameInput.value);
});

// Confirmação do nome antes de transcrever.
el.confirmForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const nome = el.confirmInput.value.trim();
  if (!nome) {
    el.confirmError.textContent = 'Dê um nome à reunião.';
    return;
  }
  if (/[<>:"/\\|?*]/.test(nome)) {
    el.confirmError.textContent = 'O nome não pode conter < > : " / \\ | ? *';
    return;
  }
  startJob(pendingVideo, nome);
});

el.confirmCancel.addEventListener('click', () => {
  pendingVideo = '';
  setState('idle');
});

// Visualizar e baixar a transcrição.
el.detailView.addEventListener('click', () => openViewer(selected));
el.detailDownload.addEventListener('click', () => {
  if (selected?.transcript) window.api.downloadFile(selected.transcript);
});
el.viewerDownload.addEventListener('click', () => {
  if (viewerFilePath) window.api.downloadFile(viewerFilePath);
});
el.viewerClose.addEventListener('click', () => setState('detail'));
el.viewerSearch.addEventListener('input', () => {
  renderReader(viewerContent, el.viewerSearch.value);
});

// Tabela.
el.viewTable.addEventListener('click', () => {
  renderTable();
  setState('table');
});
el.tableClose.addEventListener('click', () => setState('idle'));
el.tableNew.addEventListener('click', pickVideo);
el.tableDeleteSelected.addEventListener('click', deleteSelectedFromTable);

el.tableClearSelection.addEventListener('click', () => {
  tableSelection.clear();
  renderTable();
});

el.tableCheckAll.addEventListener('change', () => {
  const rows = window.tableUI.applyView(meetings, tableView);
  tableSelection.clear();
  // Marca só o que está visível: selecionar o que o filtro escondeu seria
  // apagar coisas que o usuário não está vendo.
  if (el.tableCheckAll.checked) rows.forEach((r) => tableSelection.add(r.id));
  renderTable();
});
el.tableSearch.addEventListener('input', () => {
  tableView = { ...tableView, search: el.tableSearch.value };
  renderTable();
});
el.tableFilter.addEventListener('change', () => {
  tableView = { ...tableView, filter: el.tableFilter.value };
  renderTable();
});
el.table.querySelector('thead').addEventListener('click', (e) => {
  const coluna = e.target.closest('th')?.dataset.sort;
  if (!coluna) return;
  // Clicar na coluna já ordenada inverte a direção.
  const dir = tableView.sort === coluna && tableView.dir === 'desc' ? 'asc' : 'desc';
  tableView = { ...tableView, sort: coluna, dir };
  renderTable();
});

el.openFolder.addEventListener('click', () => {
  if (lastOutputDir) window.api.openPath(lastOutputDir);
});

el.build.addEventListener('click', async () => {
  el.build.disabled = true;
  el.buildLog.textContent = 'Construindo a imagem — isso leva alguns minutos.\n';
  const result = await window.api.buildImage();
  el.build.disabled = false;
  if (result.ok) {
    el.buildLog.textContent += '\nImagem pronta.';
    checkEngine();
  } else {
    el.buildLog.textContent += `\nA construção falhou${result.message ? `: ${result.message}` : '.'}`;
  }
});

// --- Eventos vindos do processo principal -----------------------------------

window.api.on('job:event', (event) => {
  if (event.event === 'stage') onStageEvent(event);
  else if (event.event === 'done') onDone(event);
  else if (event.event === 'error') onError(event.message);
  else if (event.event === 'canceled') {
    stopClock();
    setState('idle');
  }
});

window.api.on('build:log', (line) => {
  el.buildLog.textContent += `${line}\n`;
  el.buildLog.scrollTop = el.buildLog.scrollHeight;
});

window.api.on('doc:progress', ({ description }) => {
  el.docActivity.textContent = description;
});

window.api.on('doc:done', async (result) => {
  stopDocClock();
  if (!result.ok && !result.canceled) {
    onError(result.message || 'Não foi possível gerar o documento.');
    return;
  }
  // Volta para o detalhe da reunião, agora com o PDF na lista de arquivos.
  const id = selected?.id;
  await refreshLibrary(id);
  if (id) await openMeeting(id);
  else setState('idle');
  if (result.ok && result.pdfPath) window.api.openPath(result.pdfPath);
});

// --- Início -----------------------------------------------------------------

(async function init() {
  settings = await window.api.getSettings();
  el.outputDirValue.textContent = settings.outputDir;
  el.language.value = settings.language;
  setState('idle');
  await checkEngine();
  await refreshGroups();
  await refreshLibrary(null);
})();

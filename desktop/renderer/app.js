'use strict';

/**
 * Lógica da janela: estados, drop do arquivo e leitura dos eventos do job.
 */

const app = document.getElementById('app');
const stage = document.getElementById('stage');
const wave = window.createWave(document.getElementById('wave'));

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

  doneTarefas: document.getElementById('done-tarefas'),
  doneResumo: document.getElementById('done-resumo'),
  docTarget: document.getElementById('doc-target'),
  docTitle: document.getElementById('doc-title'),
  docActivity: document.getElementById('doc-activity'),
  docClock: document.getElementById('doc-clock'),
  docCancel: document.getElementById('doc-cancel'),
};

const DOC_TITLES = { tarefas: 'Gerando tarefas', resumo: 'Gerando resumo executivo' };

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
let tableView = { search: '', filter: 'todas', sort: 'recorded', dir: 'desc' };

// --- Estados ---------------------------------------------------------------

// A onda só conhece cinco modos; os estados novos reaproveitam os existentes.
const WAVE_MODE = {
  blocked: 'error',
  detail: 'done',
  doc: 'working',
  confirm: 'dragging',
  viewer: 'done',
  table: 'done',
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

function renderTable() {
  const rows = window.tableUI.applyView(meetings, tableView);
  window.tableUI.renderTable(el.tableBody, rows, { onOpen: openMeeting });
  el.tableEmpty.textContent = rows.length
    ? `${rows.length} de ${meetings.length} transcrição(ões)`
    : 'Nenhuma transcrição corresponde à busca.';

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

// --- Documentos (Claude) ----------------------------------------------------

/** Gera tarefas ou resumo executivo em PDF para a reunião informada. */
async function generateDoc(kind, meeting) {
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

  const result = await window.api.startDoc({ kind, transcriptPath: meeting.transcript });
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

// Documentos gerados pelo Claude, a partir do painel de conclusão ou do detalhe.
el.doneTarefas.addEventListener('click', () => generateDoc('tarefas', selected));
el.doneResumo.addEventListener('click', () => generateDoc('resumo', selected));
el.detailTarefas.addEventListener('click', () => generateDoc('tarefas', selected));
el.detailResumo.addEventListener('click', () => generateDoc('resumo', selected));
el.docCancel.addEventListener('click', () => window.api.cancelDoc());

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
  await refreshLibrary(null);
})();

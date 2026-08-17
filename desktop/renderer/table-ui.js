'use strict';

/**
 * Visão em tabela da biblioteca: busca, filtro e ordenação.
 *
 * Trabalha sobre a mesma lista que alimenta a barra lateral — nada é
 * consultado de novo, então a tabela nunca discorda da lista.
 */

const FILTERS = {
  todas: () => true,
  'com-tarefas': (m) => m.hasTarefas,
  'sem-tarefas': (m) => !m.hasTarefas,
  'com-resumo': (m) => m.hasResumo,
  'sem-resumo': (m) => !m.hasResumo,
};

function formatDuration(seconds) {
  if (!seconds) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Data da gravação: vem dos metadados; sem eles, a data do arquivo. */
function recordedAt(meeting) {
  const raw = meeting.meta?.recorded_at_local;
  if (raw) {
    const parsed = new Date(raw.replace(' ', 'T'));
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(meeting.modified);
}

function formatDateTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Linha da tabela a partir de uma reunião. */
function toRow(meeting) {
  const recorded = recordedAt(meeting);
  return {
    id: meeting.id,
    name: meeting.name,
    source: meeting.meta?.source_file || '',
    recorded,
    recordedLabel: formatDateTime(recorded),
    duration: meeting.meta?.duration_seconds || 0,
    durationLabel: formatDuration(meeting.meta?.duration_seconds),
    segments: meeting.meta?.segments ?? null,
    model: meeting.meta?.model || '—',
    hasTarefas: meeting.hasTarefas,
    hasResumo: meeting.hasResumo,
    docs: (meeting.hasTarefas ? 1 : 0) + (meeting.hasResumo ? 1 : 0),
  };
}

/** Aplica busca, filtro e ordenação. Não muda a lista original. */
function applyView(meetings, { search = '', filter = 'todas', sort = 'recorded', dir = 'desc' } = {}) {
  const termo = search.trim().toLowerCase();
  const passaFiltro = FILTERS[filter] || FILTERS.todas;

  const rows = meetings
    .filter(passaFiltro)
    .map(toRow)
    .filter((row) => !termo
      || row.name.toLowerCase().includes(termo)
      || row.source.toLowerCase().includes(termo)
      || row.model.toLowerCase().includes(termo));

  const factor = dir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const va = a[sort];
    const vb = b[sort];
    if (typeof va === 'string') return va.localeCompare(vb) * factor;
    if (va instanceof Date) return (va - vb) * factor;
    return ((va ?? -1) - (vb ?? -1)) * factor;
  });
}

function cell(text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function docsCell(row) {
  const td = document.createElement('td');
  for (const [label, on] of [['tarefas', row.hasTarefas], ['resumo', row.hasResumo]]) {
    const tag = document.createElement('span');
    tag.className = on ? 'tag tag-on' : 'tag';
    tag.textContent = label;
    td.append(tag);
  }
  return td;
}

/** Desenha as linhas; clicar (ou Enter) numa linha abre a reunião. */
function renderTable(tbody, rows, { onOpen }) {
  tbody.replaceChildren();

  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    tr.append(
      cell(row.name),
      cell(row.recordedLabel, 'num dim'),
      cell(row.durationLabel, 'num'),
      cell(row.segments === null ? '—' : String(row.segments), 'num'),
      cell(row.model, 'dim'),
      docsCell(row),
    );
    tr.addEventListener('click', () => onOpen(row.id));
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') onOpen(row.id);
    });
    tbody.append(tr);
  }
}

window.tableUI = { applyView, formatDateTime, formatDuration, recordedAt, renderTable };

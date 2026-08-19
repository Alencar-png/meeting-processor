'use strict';

/**
 * Renderização da biblioteca: a lista da sidebar e a lista de arquivos de uma
 * reunião. Funções puras de construção de DOM — o estado fica no app.js.
 */

const FILE_LABELS = {
  md: 'transcrição',
  txt: 'texto',
  pdf: 'documento',
};

function formatDate(ms) {
  const d = new Date(ms);
  const dia = String(d.getDate()).padStart(2, '0');
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const hora = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dia}/${mes} · ${hora}:${min}`;
}

/**
 * Itens da sidebar. Cada item mostra o nome, quando foi feito e marcadores
 * dos documentos já gerados, para saber o que falta sem abrir.
 */
function renderLibraryList(container, meetings, { selectedId, onSelect }) {
  container.replaceChildren();

  for (const meeting of meetings) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'library-item';
    if (meeting.id === selectedId) button.classList.add('is-selected');

    const name = document.createElement('span');
    name.className = 'library-name';
    name.textContent = meeting.name;

    const meta = document.createElement('span');
    meta.className = 'library-meta';
    const marks = [
      meeting.group?.name || null,
      meeting.hasTarefas ? 'tarefas' : null,
      meeting.hasResumo ? 'resumo' : null,
    ].filter(Boolean);
    meta.textContent = marks.length
      ? `${formatDate(meeting.modified)} · ${marks.join(' · ')}`
      : formatDate(meeting.modified);

    button.append(name, meta);
    button.addEventListener('click', () => onSelect(meeting.id));
    item.append(button);
    container.append(item);
  }
}

/** Lista de arquivos de uma reunião; clicar abre no aplicativo padrão. */
function renderFileList(container, files, { onOpen }) {
  container.replaceChildren();

  for (const file of files) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.title = `Abrir ${file.name}`;

    const label = document.createElement('span');
    label.textContent = file.name;

    const tag = document.createElement('span');
    tag.className = 'ext';
    tag.textContent = `${FILE_LABELS[file.ext] || file.ext} · ${file.sizeKB} KB`;

    button.append(label, tag);
    button.addEventListener('click', () => onOpen(file.path));
    item.append(button);
    container.append(item);
  }
}

window.libraryUI = { formatDate, renderFileList, renderLibraryList };

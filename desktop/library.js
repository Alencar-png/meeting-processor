'use strict';

/**
 * Biblioteca de transcrições: a pasta de saída lida como uma lista de reuniões.
 *
 * Cada reunião é uma subpasta com o nome da gravação, contendo a transcrição
 * (.md/.txt) e os documentos gerados (.pdf). Transcrições antigas, gravadas
 * soltas na raiz antes dessa organização, continuam aparecendo na lista —
 * some da tela é pior do que uma lista com dois formatos.
 */

const fs = require('node:fs');
const path = require('node:path');

const groups = require('./groups');

const TRANSCRIPT_EXTENSIONS = ['.md', '.txt'];
const DOCUMENT_EXTENSIONS = ['.pdf'];
const ALL_EXTENSIONS = [...TRANSCRIPT_EXTENSIONS, ...DOCUMENT_EXTENSIONS];

// Escrito pelo pipeline: data da gravação, duração, modelo, idioma.
const METADATA_FILE = 'meeting.json';

// Sufixos dos documentos derivados — removidos para achar a reunião de origem.
// "Resumo executivo" continua na lista por causa dos arquivos já gerados antes
// de o resumo deixar de ser sempre executivo.
const DERIVED_SUFFIXES = [' - Tarefas', ' - Resumo executivo', ' - Resumo'];

// Caracteres proibidos em nome de arquivo no Windows.
const INVALID_CHARS = /[<>:"/\\|?*]/;

/** Nome-base da reunião a que um arquivo pertence (formato antigo). */
function groupKey(fileName) {
  let stem = path.basename(fileName, path.extname(fileName));
  for (const suffix of DERIVED_SUFFIXES) {
    if (stem.endsWith(suffix)) {
      stem = stem.slice(0, -suffix.length);
      break;
    }
  }
  return stem;
}

function describeFile(fullPath, name) {
  const ext = path.extname(name).toLowerCase();
  const stat = fs.statSync(fullPath);
  return {
    name,
    path: fullPath,
    ext: ext.slice(1),
    sizeKB: Math.max(1, Math.round(stat.size / 1024)),
    kind: TRANSCRIPT_EXTENSIONS.includes(ext) ? 'transcricao' : 'documento',
    modified: stat.mtimeMs,
  };
}

/** Metadados gravados pelo pipeline junto da transcrição. */
function readMetadata(folder) {
  try {
    return JSON.parse(fs.readFileSync(path.join(folder, METADATA_FILE), 'utf-8'));
  } catch {
    return null; // reunião antiga ou meeting.json corrompido
  }
}

/** Completa a reunião com os campos derivados dos arquivos. */
function finish(meeting) {
  const files = meeting.files.sort((a, b) => a.name.localeCompare(b.name));
  const meta = meeting.legacy ? null : readMetadata(meeting.dir);
  return {
    ...meeting,
    meta,
    files,
    modified: files.reduce((max, f) => Math.max(max, f.modified), 0),
    // O .md é a fonte para gerar tarefas e resumo: tem os timestamps.
    transcript: files.find((f) => f.ext === 'md')?.path
      || files.find((f) => f.kind === 'transcricao')?.path,
    hasTarefas: files.some((f) => f.name.includes(' - Tarefas.')),
    hasResumo: files.some((f) => f.name.includes(' - Resumo.')
      || f.name.includes(' - Resumo executivo.')),
  };
}

/** Reuniões gravadas em pasta própria (formato atual). */
function readFolders(dir) {
  const meetings = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(dir, entry.name);

    let files;
    try {
      files = fs.readdirSync(folder, { withFileTypes: true })
        .filter((f) => f.isFile() && ALL_EXTENSIONS.includes(path.extname(f.name).toLowerCase()))
        .map((f) => describeFile(path.join(folder, f.name), f.name));
    } catch {
      continue; // pasta sem permissão ou removida no meio da varredura
    }

    if (!files.some((f) => f.kind === 'transcricao')) continue;
    meetings.push(finish({ id: entry.name, name: entry.name, dir: folder, legacy: false, files }));
  }

  return meetings;
}

/** Reuniões soltas na raiz da pasta de saída (formato antigo). */
function readLooseFiles(dir) {
  const groups = new Map();

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!ALL_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue;

    const key = groupKey(entry.name);
    let file;
    try {
      file = describeFile(path.join(dir, entry.name), entry.name);
    } catch {
      continue;
    }

    if (!groups.has(key)) {
      groups.set(key, { id: key, name: key, dir, legacy: true, files: [] });
    }
    groups.get(key).files.push(file);
  }

  return [...groups.values()]
    .filter((g) => g.files.some((f) => f.kind === 'transcricao'))
    .map(finish);
}

/**
 * Lista as reuniões de uma pasta, da mais recente para a mais antiga.
 *
 * Se uma pasta e arquivos soltos tiverem o mesmo nome, a pasta vence: dois
 * itens com o mesmo id tornariam ambíguo qual deles renomear ou excluir.
 */
function listMeetings(dir) {
  if (!dir || !fs.existsSync(dir)) return [];

  const folders = readFolders(dir);
  const taken = new Set(folders.map((m) => m.id));
  const loose = readLooseFiles(dir).filter((m) => !taken.has(m.id));
  const porReuniao = groups.groupsByMeeting(dir);

  return [...folders, ...loose]
    .map((m) => ({ ...m, group: porReuniao[m.id] || null }))
    .sort((a, b) => b.modified - a.modified);
}

/** Uma reunião específica, ou null. */
function getMeeting(dir, id) {
  return listMeetings(dir).find((m) => m.id === id) || null;
}

/** Primeiras linhas da transcrição, para a prévia. */
function preview(transcriptPath, maxChars = 1200) {
  try {
    const text = fs.readFileSync(transcriptPath, 'utf-8');
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  } catch {
    return '';
  }
}

/** Conteúdo completo de um arquivo de texto da reunião, para leitura no app. */
function readText(filePath) {
  try {
    return { ok: true, text: fs.readFileSync(filePath, 'utf-8') };
  } catch (err) {
    return { ok: false, message: `Não foi possível ler o arquivo: ${err.message}` };
  }
}

/** Renomeia arquivos preservando os sufixos derivados; desfaz tudo se falhar. */
function renameFiles(moves) {
  const done = [];
  try {
    for (const move of moves) {
      if (move.from === move.to) continue;
      fs.renameSync(move.from, move.to);
      done.push(move);
    }
  } catch (err) {
    // Um grupo meio renomeado viraria duas reuniões quebradas na lista.
    for (const move of done.reverse()) {
      try { fs.renameSync(move.to, move.from); } catch { /* nada a fazer */ }
    }
    return { ok: false, message: `Não foi possível renomear: ${err.message}` };
  }
  return { ok: true };
}

/**
 * Renomeia a reunião: a pasta e os arquivos dentro dela.
 *
 * Recusa nome inválido ou já ocupado — melhor falhar visível do que
 * sobrescrever a transcrição de outra reunião.
 */
function renameMeeting(dir, id, newName) {
  const clean = (newName || '').trim();
  if (!clean) return { ok: false, message: 'O nome não pode ficar vazio.' };
  if (INVALID_CHARS.test(clean)) {
    return { ok: false, message: 'O nome não pode conter < > : " / \\ | ? *' };
  }

  const existing = listMeetings(dir);
  const meeting = existing.find((m) => m.id === id);
  if (!meeting) return { ok: false, message: 'Transcrição não encontrada.' };
  if (clean === meeting.name) return { ok: true, id: clean };

  // Conflito é com qualquer reunião de mesmo nome — pasta ou arquivos soltos.
  if (existing.some((m) => m.id === clean)) {
    return { ok: false, message: `Já existe uma transcrição chamada ${clean}.` };
  }

  if (meeting.legacy) {
    const moves = meeting.files.map((file) => ({
      from: file.path,
      to: path.join(dir, file.name.replace(meeting.name, clean)),
    }));
    const conflict = moves.find((m) => m.from !== m.to && fs.existsSync(m.to));
    if (conflict) {
      return { ok: false, message: `Já existe um arquivo chamado ${path.basename(conflict.to)}.` };
    }
    const result = renameFiles(moves);
    if (result.ok) groups.renameMeeting(dir, meeting.id, clean);
    return result.ok ? { ok: true, id: clean } : result;
  }

  const newFolder = path.join(dir, clean);
  if (fs.existsSync(newFolder)) {
    return { ok: false, message: `Já existe uma transcrição chamada ${clean}.` };
  }

  // Primeiro os arquivos (ainda na pasta antiga), depois a pasta: assim uma
  // falha no meio deixa tudo no lugar de origem.
  const moves = meeting.files.map((file) => ({
    from: file.path,
    to: path.join(meeting.dir, file.name.replace(meeting.name, clean)),
  }));
  const result = renameFiles(moves);
  if (!result.ok) return result;

  try {
    fs.renameSync(meeting.dir, newFolder);
  } catch (err) {
    renameFiles(moves.map((m) => ({ from: m.to, to: m.from })));
    return { ok: false, message: `Não foi possível renomear a pasta: ${err.message}` };
  }

  // O vínculo com o grupo acompanha o novo nome; sem isso a reunião sairia
  // silenciosamente do projeto ao ser renomeada.
  groups.renameMeeting(dir, meeting.id, clean);
  return { ok: true, id: clean };
}

/** Exclui a reunião inteira, ou apenas os arquivos indicados. */
/**
 * Exclusão de reunião.
 *
 * `trash` recebe uma função que manda a pasta para a Lixeira do sistema (no
 * app, `shell.trashItem` do Electron). Transcrição é trabalho que não se
 * refaz sem o vídeo original: apagar direto do disco não deixa volta, e um
 * clique errado custaria a reunião inteira.
 */
function deleteMeeting(dir, id, files = null, trash = null) {
  const meeting = getMeeting(dir, id);
  if (!meeting) return { ok: false, message: 'Transcrição não encontrada.' };

  if (!files && !meeting.legacy) {
    try {
      if (trash) return trash(meeting);
      fs.rmSync(meeting.dir, { recursive: true, force: true });
      groups.forgetMeeting(dir, meeting.id);
      return { ok: true, deleted: meeting.files.length };
    } catch (err) {
      return { ok: false, message: `Não foi possível excluir: ${err.message}` };
    }
  }

  const targets = files
    ? meeting.files.filter((f) => files.includes(f.path))
    : meeting.files;

  const failed = [];
  for (const file of targets) {
    try {
      fs.rmSync(file.path, { force: true });
    } catch (err) {
      failed.push(`${file.name} (${err.message})`);
    }
  }

  if (failed.length) {
    return { ok: false, message: `Não foi possível excluir: ${failed.join(', ')}` };
  }
  if (!files) groups.forgetMeeting(dir, meeting.id);
  return { ok: true, deleted: targets.length };
}

module.exports = {
  METADATA_FILE,
  deleteMeeting,
  getMeeting,
  groupKey,
  listMeetings,
  preview,
  readText,
  renameMeeting,
};

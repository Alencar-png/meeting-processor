'use strict';

/**
 * Biblioteca de transcrições: as pastas de reunião lidas como uma lista.
 *
 * Cada reunião é uma subpasta com o nome da gravação, contendo a transcrição
 * (.md/.txt), a análise (analise.json) e os documentos gerados (.pdf). Ela
 * mora em uma de várias raízes: a pasta de saída, para reuniões sem projeto,
 * ou `<pasta de trabalho>/synapse/` para as de um projeto que tem pasta — o
 * projeto é um espaço de trabalho, e o que é dele fica com ele. Transcrições
 * antigas, gravadas soltas na raiz da pasta de saída, continuam aparecendo —
 * sumir da tela é pior do que uma lista com dois formatos.
 *
 * O `dir` que todas as funções recebem é a pasta de saída: é onde está o
 * banco (`synapse.db`) e de onde se descobrem as outras raízes.
 */

const fs = require('node:fs');
const path = require('node:path');

const projects = require('./projects');
const { toNFC } = require('./unicode-path');

const TRANSCRIPT_EXTENSIONS = ['.md', '.txt'];
const DOCUMENT_EXTENSIONS = ['.pdf'];
const ALL_EXTENSIONS = [...TRANSCRIPT_EXTENSIONS, ...DOCUMENT_EXTENSIONS];

// Escrito pelo pipeline: data da gravação, duração, modelo, idioma.
const METADATA_FILE = 'meeting.json';

// Sufixos dos documentos derivados — removidos para achar a reunião de origem.
// "Resumo executivo" continua na lista por causa dos arquivos já gerados antes
// de o resumo deixar de ser sempre executivo.
const DERIVED_SUFFIXES = [' - Documento', ' - Tarefas', ' - Resumo executivo', ' - Resumo'];

// Caracteres proibidos em nome de arquivo no Windows.
const INVALID_CHARS = /[<>:"/\\|?*]/;

// Dentro da pasta de trabalho de um projeto, as reuniões ficam em `synapse/`.
const PROJECT_SUBDIR = 'synapse';

// O id da reunião é o nome da pasta — com o projeto na frente quando ela mora
// na raiz dele, porque dois projetos podem ter reuniões de mesmo nome.
const ID_SEP = '::';

/** Onde as reuniões de um projeto moram (a pasta de saída, se ele não tem pasta). */
function meetingsRootFor(dir, project) {
  return project?.workdir ? path.join(project.workdir, PROJECT_SUBDIR) : dir;
}

function meetingId(projectId, name) {
  return projectId ? `${projectId}${ID_SEP}${name}` : name;
}

function splitMeetingId(id) {
  const texto = String(id || '');
  const i = texto.indexOf(ID_SEP);
  return i < 0
    ? { projectId: '', name: texto }
    : { projectId: texto.slice(0, i), name: texto.slice(i + ID_SEP.length) };
}

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
    // O .md é a fonte para gerar o documento e as tarefas: tem os timestamps.
    transcript: files.find((f) => f.ext === 'md')?.path
      || files.find((f) => f.kind === 'transcricao')?.path,
    // Reuniões de antes do documento único têm os dois PDFs separados; com
    // ambos no lugar, contam como documentadas.
    hasDocumento: files.some((f) => f.name.includes(' - Documento.'))
      || (files.some((f) => f.name.includes(' - Tarefas.'))
        && files.some((f) => f.name.includes(' - Resumo.') || f.name.includes(' - Resumo executivo.'))),
  };
}

/**
 * Reuniões gravadas em pasta própria (formato atual) dentro de uma raiz.
 * `owner` é o projeto dono da raiz, quando ela é a pasta de um projeto.
 */
function readFolders(root, owner = null) {
  const meetings = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(root, entry.name);

    let files;
    try {
      files = fs.readdirSync(folder, { withFileTypes: true })
        .filter((f) => f.isFile() && ALL_EXTENSIONS.includes(path.extname(f.name).toLowerCase()))
        .map((f) => describeFile(path.join(folder, f.name), f.name));
    } catch {
      continue; // pasta sem permissão ou removida no meio da varredura
    }

    if (!files.some((f) => f.kind === 'transcricao')) continue;
    meetings.push(finish({
      id: meetingId(owner?.id, entry.name), name: entry.name, dir: folder, root, owner, legacy: false, files,
    }));
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
      groups.set(key, { id: key, name: key, dir, root: dir, owner: null, legacy: true, files: [] });
    }
    groups.get(key).files.push(file);
  }

  return [...groups.values()]
    .filter((g) => g.files.some((f) => f.kind === 'transcricao'))
    .map(finish);
}

/**
 * Lista as reuniões de todas as raízes, da mais recente para a mais antiga.
 *
 * Na pasta de saída, se uma pasta e arquivos soltos tiverem o mesmo nome, a
 * pasta vence: dois itens com o mesmo id tornariam ambíguo qual deles renomear
 * ou excluir. O projeto de quem está lá vem do banco. Na raiz de um projeto,
 * o projeto é o dono da raiz — estar lá é pertencer.
 */
function listMeetings(dir) {
  if (!dir || !fs.existsSync(dir)) return [];

  const folders = readFolders(dir);
  const taken = new Set(folders.map((m) => m.id));
  const loose = readLooseFiles(dir).filter((m) => !taken.has(m.id));
  const porReuniao = projects.projectsByMeeting(dir);
  const semRaiz = [...folders, ...loose].map((m) => ({ ...m, project: porReuniao[m.id] || null }));

  const deProjetos = [];
  for (const p of projects.listProjects(dir)) {
    const root = meetingsRootFor(dir, p);
    if (path.resolve(root) === path.resolve(dir) || !fs.existsSync(root)) continue;
    const owner = { id: p.id, name: p.name, context: p.context || '' };
    for (const m of readFolders(root, owner)) deProjetos.push({ ...m, project: owner });
  }

  return [...semRaiz, ...deProjetos].sort((a, b) => b.modified - a.modified);
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
 * Troca o nome antigo pelo novo dentro do nome do arquivo, preservando o
 * sufixo (" - Tarefas.pdf") e a extensão.
 *
 * Compara em NFC porque o nome no disco e o nome em memória podem estar em
 * formas Unicode diferentes; um `replace` direto não casaria, e o arquivo
 * ficaria com o nome antigo dentro da pasta já renomeada.
 */
function renamedFile(fileName, oldName, newName) {
  const alvo = toNFC(fileName);
  const antigo = toNFC(oldName);
  return alvo.startsWith(antigo) ? newName + alvo.slice(antigo.length) : alvo;
}


/**
 * Renomeia a reunião: a pasta e os arquivos dentro dela.
 *
 * Recusa nome inválido ou já ocupado — melhor falhar visível do que
 * sobrescrever a transcrição de outra reunião.
 */
function renameMeeting(dir, id, newName) {
  // NFC antes de qualquer comparação: um nome digitado e o mesmo nome vindo de
  // uma gravação do macOS podem ser strings diferentes para o mesmo texto, e
  // aí o `replace` abaixo não casaria com o nome do arquivo no disco.
  const clean = toNFC(newName || '').trim();
  if (!clean) return { ok: false, message: 'O nome não pode ficar vazio.' };
  if (INVALID_CHARS.test(clean)) {
    return { ok: false, message: 'O nome não pode conter < > : " / \\ | ? *' };
  }

  const existing = listMeetings(dir);
  const meeting = existing.find((m) => m.id === id);
  if (!meeting) return { ok: false, message: 'Transcrição não encontrada.' };
  if (clean === toNFC(meeting.name)) return { ok: true, id: meeting.id };

  // Conflito é com qualquer reunião de mesmo nome na mesma raiz — pasta ou
  // arquivos soltos. Em outra raiz o nome pode repetir: o id não repete.
  const mesmaRaiz = (m) => path.resolve(m.root) === path.resolve(meeting.root);
  if (existing.some((m) => mesmaRaiz(m) && toNFC(m.name) === clean)) {
    return { ok: false, message: `Já existe uma transcrição chamada ${clean}.` };
  }
  const novoId = meetingId(meeting.owner?.id, clean);

  if (meeting.legacy) {
    const moves = meeting.files.map((file) => ({
      from: file.path,
      to: path.join(dir, renamedFile(file.name, meeting.name, clean)),
    }));
    const conflict = moves.find((m) => m.from !== m.to && fs.existsSync(m.to));
    if (conflict) {
      return { ok: false, message: `Já existe um arquivo chamado ${path.basename(conflict.to)}.` };
    }
    const result = renameFiles(moves);
    if (result.ok) projects.renameMeeting(dir, meeting.id, novoId);
    return result.ok ? { ok: true, id: novoId } : result;
  }

  const newFolder = path.join(meeting.root, clean);
  if (fs.existsSync(newFolder)) {
    return { ok: false, message: `Já existe uma transcrição chamada ${clean}.` };
  }

  // Primeiro os arquivos (ainda na pasta antiga), depois a pasta: assim uma
  // falha no meio deixa tudo no lugar de origem.
  const moves = meeting.files.map((file) => ({
    from: file.path,
    to: path.join(meeting.dir, renamedFile(file.name, meeting.name, clean)),
  }));
  const result = renameFiles(moves);
  if (!result.ok) return result;

  try {
    fs.renameSync(meeting.dir, newFolder);
  } catch (err) {
    renameFiles(moves.map((m) => ({ from: m.to, to: m.from })));
    return { ok: false, message: `Não foi possível renomear a pasta: ${err.message}` };
  }

  // O vínculo com o projeto acompanha o novo id; sem isso a reunião sairia
  // silenciosamente do projeto ao ser renomeada.
  projects.renameMeeting(dir, meeting.id, novoId);
  return { ok: true, id: novoId };
}

/** Move pasta ou arquivo; entre discos, copia e apaga. */
function moveSync(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Leva a reunião para outra raiz — a pasta de um projeto, ou de volta à pasta
 * de saída. Reunião do formato antigo (arquivos soltos) vira pasta no destino.
 *
 * Não mexe no banco: devolve o id novo para quem chama acompanhá-lo em
 * vínculos e tarefas.
 */
function relocateMeeting(dir, id, toRoot, toProjectId = '') {
  const meeting = getMeeting(dir, id);
  if (!meeting) return { ok: false, message: 'Transcrição não encontrada.' };

  const destino = path.join(toRoot, meeting.name);
  const novoId = meetingId(toProjectId, meeting.name);
  if (!meeting.legacy && path.resolve(meeting.dir) === path.resolve(destino)) {
    return { ok: true, id: novoId, moved: false };
  }
  if (fs.existsSync(destino)) {
    return { ok: false, message: `Já existe ${meeting.name} em ${toRoot}.` };
  }

  try {
    fs.mkdirSync(toRoot, { recursive: true });
    if (meeting.legacy) {
      fs.mkdirSync(destino);
      for (const file of meeting.files) moveSync(file.path, path.join(destino, file.name));
    } else {
      moveSync(meeting.dir, destino);
    }
  } catch (err) {
    return { ok: false, message: `Não foi possível mover ${meeting.name}: ${err.message}` };
  }
  return { ok: true, id: novoId, moved: true };
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
      projects.forgetMeeting(dir, meeting.id);
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
  if (!files) projects.forgetMeeting(dir, meeting.id);
  return { ok: true, deleted: targets.length };
}

module.exports = {
  METADATA_FILE,
  PROJECT_SUBDIR,
  deleteMeeting,
  getMeeting,
  groupKey,
  listMeetings,
  meetingId,
  meetingsRootFor,
  preview,
  readText,
  relocateMeeting,
  renamedFile,
  renameMeeting,
  splitMeetingId,
};

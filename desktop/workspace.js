'use strict';

/**
 * Tradução entre o disco e o vocabulário do Synapse.
 *
 * O front fala de projeto, reunião e tarefa. No disco existem: a pasta de
 * saída (`library.js`), o `groups.json` (`groups.js`) e o `tasks.json`
 * (`tasks.js`). Este módulo é a única camada que sabe converter um no outro,
 * para o main.js só registrar handlers e o renderer não conhecer o formato
 * dos arquivos.
 */

const path = require('node:path');

const library = require('./library');
const groups = require('./groups');
const tasks = require('./tasks');

/**
 * Data da gravação: preferimos o que o pipeline registrou no meeting.json e
 * caímos para a data de modificação dos arquivos nas reuniões antigas, que
 * nasceram antes do meeting.json existir.
 */
function recordedAt(meeting) {
  const bruto = meeting.meta?.recorded_at_local || meeting.meta?.recorded_at;
  if (bruto) {
    // "2026-08-18 18:59:00" não tem fuso: o Date do JS lê como horário local,
    // que é exatamente o que o pipeline gravou.
    const data = new Date(bruto.replace(' ', 'T'));
    if (!Number.isNaN(data.getTime())) return data.getTime();
  }
  return meeting.modified || 0;
}

/** Reunião no vocabulário do front. */
function toMeeting(meeting, projeto) {
  const meta = meeting.meta || {};
  return {
    id: meeting.id,
    name: meeting.name,
    projectId: projeto?.id || '',
    project: projeto ? { id: projeto.id, name: projeto.name, context: projeto.context || '' } : null,
    recordedAt: recordedAt(meeting),
    duration: Number(meta.duration_seconds || meta.video_duration_seconds || 0),
    segments: Number(meta.segments || 0),
    model: meta.model || '',
    language: meta.language || '',
    source: meta.source_file || '',
    hasResumo: meeting.hasResumo,
    hasTarefas: meeting.hasTarefas,
    // Caminhos ficam aqui para abrir/baixar arquivo sem uma segunda chamada.
    files: meeting.files,
    transcriptPath: meeting.transcript || '',
    dir: meeting.dir,
    concepts: [],   // MEM-04: preenchido quando a extração de conceitos existir
  };
}

/** Projetos com o que a sidebar e a visão geral precisam mostrar. */
function listProjects(dir) {
  if (!dir) return [];
  const abertas = tasks.openCountByProject(dir);
  const reunioes = library.listMeetings(dir);
  const contagem = {};
  for (const m of reunioes) {
    if (m.group) contagem[m.group.id] = (contagem[m.group.id] || 0) + 1;
  }
  return groups.listGroups(dir).map((g) => ({
    id: g.id,
    name: g.name,
    context: g.context || '',
    meetings: contagem[g.id] || 0,
    openTasks: abertas[g.id] || 0,
  }));
}

function listMeetings(dir, projectId) {
  if (!dir) return [];
  return library
    .listMeetings(dir)
    .filter((m) => !projectId || m.group?.id === projectId)
    .map((m) => toMeeting(m, m.group));
}

/**
 * Uma reunião com o texto da transcrição junto — é o que o leitor e a busca
 * dentro da reunião consomem.
 */
function getMeeting(dir, id) {
  const bruta = library.getMeeting(dir, id);
  if (!bruta) return null;
  const meeting = toMeeting(bruta, bruta.group);
  meeting.transcript = bruta.transcript ? library.readText(bruta.transcript).text || '' : '';
  return meeting;
}

/** Tarefas do projeto, cada uma com a reunião de origem resolvida. */
function listTasks(dir, projectId) {
  if (!dir) return [];
  const porId = new Map(library.listMeetings(dir).map((m) => [m.id, m]));
  return tasks.listTasks(dir, projectId).map((t) => {
    const origem = porId.get(t.meetingId);
    return {
      ...t,
      meeting: origem ? { id: origem.id, name: origem.name, recordedAt: recordedAt(origem) } : null,
    };
  });
}

/**
 * Descobre qual reunião acabou de ser criada a partir dos arquivos que o
 * pipeline gravou: o id da reunião é o nome da pasta que os contém.
 */
function meetingIdFromFiles(outputDir, files = []) {
  for (const file of files) {
    const pasta = path.dirname(file);
    if (path.resolve(pasta) === path.resolve(outputDir)) {
      // Formato antigo: arquivos soltos na raiz, o id vem do nome do arquivo.
      return path.basename(file, path.extname(file));
    }
    return path.basename(pasta);
  }
  return '';
}

/** Números do topo do Início. */
function overview(dir) {
  const reunioes = listMeetings(dir);
  const abertas = tasks.openCountByProject(dir);
  return {
    projects: groups.listGroups(dir).length,
    meetings: reunioes.length,
    openTasks: Object.values(abertas).reduce((soma, n) => soma + n, 0),
    transcribedSeconds: reunioes.reduce((soma, m) => soma + m.duration, 0),
  };
}

module.exports = {
  getMeeting,
  listMeetings,
  listProjects,
  listTasks,
  meetingIdFromFiles,
  overview,
  recordedAt,
  toMeeting,
};

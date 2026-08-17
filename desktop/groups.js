'use strict';

/**
 * Grupos (projetos) e seus contextos.
 *
 * Um grupo reúne reuniões que pertencem ao mesmo assunto e carrega um texto de
 * contexto — o que é o projeto, quem são as pessoas, que tipo de documento se
 * espera. Esse contexto vai para o prompt na hora de gerar tarefas ou resumo,
 * para o documento sair no registro certo em vez de sempre "executivo".
 *
 * Tudo mora num `groups.json` na raiz da pasta de saída: a pasta continua sendo
 * a fonte da verdade, sem banco paralelo.
 */

const fs = require('node:fs');
const path = require('node:path');

const GROUPS_FILE = 'groups.json';

// Caracteres proibidos em nome de arquivo — o nome do grupo aparece na UI e
// pode virar nome de pasta no futuro; manter a mesma regra evita surpresa.
const INVALID_CHARS = /[<>:"/\\|?*]/;

function groupsPath(dir) {
  return path.join(dir, GROUPS_FILE);
}

/** Lê o arquivo de grupos; devolve estrutura vazia se não existir. */
function read(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(groupsPath(dir), 'utf-8'));
    return {
      groups: Array.isArray(data.groups) ? data.groups : [],
      // meetingId -> groupId
      members: data.members && typeof data.members === 'object' ? data.members : {},
    };
  } catch {
    return { groups: [], members: {} };
  }
}

function write(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(groupsPath(dir), `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  return data;
}

/** Grupos com a contagem de reuniões de cada um. */
function listGroups(dir) {
  if (!dir) return [];
  const { groups, members } = read(dir);
  const contagem = {};
  for (const groupId of Object.values(members)) {
    contagem[groupId] = (contagem[groupId] || 0) + 1;
  }
  return groups
    .map((g) => ({ ...g, count: contagem[g.id] || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getGroup(dir, groupId) {
  return listGroups(dir).find((g) => g.id === groupId) || null;
}

/** Grupo de uma reunião, ou null. */
function groupOf(dir, meetingId) {
  const { members } = read(dir);
  const groupId = members[meetingId];
  return groupId ? getGroup(dir, groupId) : null;
}

/** Mapa meetingId -> grupo, para montar a listagem numa leitura só. */
function groupsByMeeting(dir) {
  if (!dir) return {};
  const { groups, members } = read(dir);
  const porId = Object.fromEntries(groups.map((g) => [g.id, g]));
  const saida = {};
  for (const [meetingId, groupId] of Object.entries(members)) {
    if (porId[groupId]) saida[meetingId] = porId[groupId];
  }
  return saida;
}

function saveGroup(dir, { id, name, context }) {
  const nome = (name || '').trim();
  if (!nome) return { ok: false, message: 'O grupo precisa de um nome.' };
  if (INVALID_CHARS.test(nome)) {
    return { ok: false, message: 'O nome não pode conter < > : " / \\ | ? *' };
  }

  const data = read(dir);
  const existente = data.groups.find((g) => g.name.toLowerCase() === nome.toLowerCase()
    && g.id !== id);
  if (existente) return { ok: false, message: `Já existe um grupo chamado ${nome}.` };

  const texto = (context || '').trim();

  if (id) {
    const grupo = data.groups.find((g) => g.id === id);
    if (!grupo) return { ok: false, message: 'Grupo não encontrado.' };
    grupo.name = nome;
    grupo.context = texto;
    write(dir, data);
    return { ok: true, id };
  }

  // Id derivado do nome, com sufixo numérico se preciso: legível no arquivo.
  const base = nome.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'grupo';
  let novoId = base;
  let n = 2;
  while (data.groups.some((g) => g.id === novoId)) novoId = `${base}-${n++}`;

  data.groups.push({ id: novoId, name: nome, context: texto });
  write(dir, data);
  return { ok: true, id: novoId };
}

/**
 * Remove o grupo. As reuniões não são apagadas — apenas ficam sem grupo, o que
 * é o comportamento menos destrutivo diante de uma ação ambígua.
 */
function deleteGroup(dir, groupId) {
  const data = read(dir);
  if (!data.groups.some((g) => g.id === groupId)) {
    return { ok: false, message: 'Grupo não encontrado.' };
  }
  data.groups = data.groups.filter((g) => g.id !== groupId);
  for (const [meetingId, id] of Object.entries(data.members)) {
    if (id === groupId) delete data.members[meetingId];
  }
  write(dir, data);
  return { ok: true };
}

/** Anexa a reunião a um grupo; `groupId` vazio desanexa. */
function assignMeeting(dir, meetingId, groupId) {
  const data = read(dir);
  if (groupId && !data.groups.some((g) => g.id === groupId)) {
    return { ok: false, message: 'Grupo não encontrado.' };
  }
  if (groupId) data.members[meetingId] = groupId;
  else delete data.members[meetingId];
  write(dir, data);
  return { ok: true };
}

/** Acompanha o novo id quando a reunião é renomeada. */
function renameMeeting(dir, oldId, newId) {
  const data = read(dir);
  if (!(oldId in data.members)) return;
  data.members[newId] = data.members[oldId];
  delete data.members[oldId];
  write(dir, data);
}

/** Esquece uma reunião excluída, para o arquivo não acumular órfãos. */
function forgetMeeting(dir, meetingId) {
  const data = read(dir);
  if (!(meetingId in data.members)) return;
  delete data.members[meetingId];
  write(dir, data);
}

module.exports = {
  GROUPS_FILE,
  assignMeeting,
  deleteGroup,
  forgetMeeting,
  getGroup,
  groupOf,
  groupsByMeeting,
  listGroups,
  renameMeeting,
  saveGroup,
};

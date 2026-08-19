'use strict';

/**
 * Caminhos com acento e as duas formas do Unicode.
 *
 * "às" pode ser gravado de dois jeitos: composto (NFC, `à` num único ponto de
 * código) ou decomposto (NFD, `a` + acento combinante). Gravações do macOS
 * chegam em NFD, e o NTFS guarda o nome exatamente como recebeu — para o
 * Windows os dois são arquivos diferentes.
 *
 * Isso já custou as tarefas de uma reunião: o Claude Code recebeu o caminho em
 * NFD, normalizou para NFC ao gravar o JSON, e o `readFileSync` do app — que
 * procurava a forma NFD — não achou nada. A extração tinha funcionado; o
 * resultado é que se perdeu na porta.
 *
 * A saída é dupla: gravar sempre em NFC (`toNFC`) e, ao ler o que outro
 * processo escreveu, aceitar a outra forma (`resolveExistingPath`).
 */

const fs = require('node:fs');
const path = require('node:path');

/** Forma composta — a que o Windows, o Node e o Claude Code usam ao escrever. */
function toNFC(text) {
  return typeof text === 'string' ? text.normalize('NFC') : text;
}

/**
 * Caminho realmente existente no disco, ignorando a forma do Unicode.
 *
 * Devolve o caminho como está se ele já existir; senão varre o diretório
 * procurando um nome que só difira na normalização. Devolve null quando não há
 * arquivo nenhum — o chamador distingue "não existe" de "existe com outro
 * nome".
 */
function resolveExistingPath(filePath) {
  if (fs.existsSync(filePath)) return filePath;

  const dir = path.dirname(filePath);
  const alvo = toNFC(path.basename(filePath));
  let entradas;
  try {
    entradas = fs.readdirSync(dir);
  } catch {
    return null;   // diretório inacessível: nada a resolver
  }
  const achado = entradas.find((nome) => toNFC(nome) === alvo);
  return achado ? path.join(dir, achado) : null;
}

/** Lê o arquivo aceitando as duas formas do Unicode no nome. */
function readFileTolerant(filePath, encoding = 'utf-8') {
  const real = resolveExistingPath(filePath);
  if (!real) throw new Error(`Arquivo não encontrado: ${filePath}`);
  return fs.readFileSync(real, encoding);
}

/** Apaga o arquivo aceitando as duas formas do Unicode. Silencioso se não há. */
function unlinkTolerant(filePath) {
  const real = resolveExistingPath(filePath);
  if (!real) return false;
  try {
    fs.unlinkSync(real);
    return true;
  } catch {
    return false;
  }
}

module.exports = { readFileTolerant, resolveExistingPath, toNFC, unlinkTolerant };

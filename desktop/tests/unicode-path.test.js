'use strict';

/**
 * O caso real: a extração gravou o JSON, o app não o encontrou.
 *
 * O caminho pedido estava em NFD (gravação do macOS) e o Claude Code gravou o
 * nome em NFC. No NTFS são dois arquivos diferentes, e as tarefas da reunião
 * ficaram no disco sem nunca chegar ao Kanban.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const {
  readFileTolerant,
  resolveExistingPath,
  toNFC,
  unlinkTolerant,
} = require('../unicode-path');

// O mesmo nome nas duas formas do Unicode. Derivadas por `normalize` em vez de
// digitadas: escritas à mão, as duas linhas ficariam visualmente idênticas no
// arquivo e a diferença que o teste investiga sumiria na primeira edição.
const NOME = 'Daily - IRM - 2026-08-19 às 10.18';
const NFC = NOME.normalize('NFC');
const NFD = NOME.normalize('NFD');

let dir;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-teste-'));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('as duas formas são textos diferentes, apesar de parecerem iguais', () => {
  assert.notStrictEqual(NFC, NFD);
  assert.strictEqual(toNFC(NFD), NFC);
});

test('resolveExistingPath acha o arquivo gravado na outra forma', () => {
  const gravado = path.join(dir, `${NFC}.json`);
  fs.writeFileSync(gravado, '{"tasks":[]}', 'utf-8');

  const procurado = path.join(dir, `${NFD}.json`);
  assert.strictEqual(resolveExistingPath(procurado), gravado);
});

test('resolveExistingPath devolve null quando não há arquivo nenhum', () => {
  assert.strictEqual(resolveExistingPath(path.join(dir, 'inexistente.json')), null);
});

test('resolveExistingPath não quebra com diretório inexistente', () => {
  assert.strictEqual(resolveExistingPath(path.join(dir, 'sem-pasta', 'x.json')), null);
});

test('readFileTolerant lê o JSON da extração pedido na forma errada', () => {
  const conteudo = '{"title":"Daily do time IRM","tasks":[{"title":"Testar o fluxo"}]}';
  fs.writeFileSync(path.join(dir, `extracao-${NFC}.json`), conteudo, 'utf-8');

  const lido = readFileTolerant(path.join(dir, `extracao-${NFD}.json`));
  assert.deepStrictEqual(JSON.parse(lido).tasks, [{ title: 'Testar o fluxo' }]);
});

test('readFileTolerant lança erro claro quando o arquivo realmente não existe', () => {
  assert.throws(
    () => readFileTolerant(path.join(dir, 'nada.json')),
    /Arquivo não encontrado/,
  );
});

test('unlinkTolerant apaga a sobra gravada na outra forma', () => {
  const alvo = path.join(dir, `sobra-${NFC}.json`);
  fs.writeFileSync(alvo, '{}', 'utf-8');

  assert.strictEqual(unlinkTolerant(path.join(dir, `sobra-${NFD}.json`)), true);
  assert.strictEqual(fs.existsSync(alvo), false);
});

test('unlinkTolerant devolve false sem nada para apagar', () => {
  assert.strictEqual(unlinkTolerant(path.join(dir, 'ausente.json')), false);
});

test('renamedFile troca o nome preservando sufixo e extensão', () => {
  const { renamedFile } = require('../library');
  assert.strictEqual(
    renamedFile(`${NFD} - Tarefas.pdf`, NFD, 'Daily do time IRM'),
    'Daily do time IRM - Tarefas.pdf',
  );
});

test('renamedFile casa mesmo quando disco e memória divergem na forma', () => {
  const { renamedFile } = require('../library');
  // O arquivo no disco em NFD, o nome da reunião em memória em NFC: antes
  // disso o replace não casava e o arquivo ficava com o nome antigo.
  assert.strictEqual(
    renamedFile(`${NFD}.md`, NFC, 'Daily do time IRM'),
    'Daily do time IRM.md',
  );
});

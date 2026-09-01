'use strict';

/**
 * Atualização do Synapse pelo próprio app.
 *
 * O app roda de um clone do repositório: atualizar é trazer os commits novos
 * (`git pull --ff-only`), reinstalar dependências só quando os manifestos
 * mudaram e reabrir o Electron. Nada de instalador — quem clonou continua
 * podendo mexer no código, e o `--ff-only` recusa qualquer histórico que não
 * seja uma continuação limpa do que está na máquina.
 *
 * `run(command, args, options)` é injetado: no app é o spawn de verdade; nos
 * testes, um git de mentira. Devolve `{ code, stdout, stderr }` e nunca rejeita.
 */

const path = require('node:path');

// Arquivos cuja mudança pede reinstalação, e o comando correspondente.
const NPM_MANIFESTS = ['desktop/package.json', 'desktop/package-lock.json'];
const PIP_MANIFESTS = ['pyproject.toml', 'requirements.txt'];

/** "2\t5" (saída de `rev-list --left-right --count A...B`) → { ahead: 2, behind: 5 }. */
function parseAheadBehind(text) {
  const [ahead, behind] = String(text || '').trim().split(/\s+/).map((n) => Number(n) || 0);
  return { ahead: ahead || 0, behind: behind || 0 };
}

const touches = (files, manifests) => files.some((f) => manifests.includes(f.replaceAll('\\', '/')));
function needsNpmInstall(changedFiles) { return touches(changedFiles, NPM_MANIFESTS); }
function needsPipInstall(changedFiles) { return touches(changedFiles, PIP_MANIFESTS); }

/** Uma frase para a tela, a partir do que `check()` descobriu. */
function describeCheck({ ok, behind, ahead, dirty, message }) {
  if (!ok) return message || 'Não deu para verificar.';
  if (dirty) return 'Há alterações locais não commitadas: atualize pelo git quando terminar de mexer.';
  if (behind === 0 && ahead === 0) return 'Você está na última versão.';
  if (behind === 0) return `Sua cópia está ${ahead} commit(s) à frente do repositório.`;
  const frase = behind === 1 ? '1 atualização disponível' : `${behind} atualizações disponíveis`;
  return ahead ? `${frase} — e ${ahead} commit(s) locais que não estão no repositório.` : `${frase}.`;
}

function createUpdater({ root, run, platform = process.platform, log = () => {} }) {
  const git = (...args) => run('git', args, { cwd: root });

  async function branch() {
    const r = await git('rev-parse', '--abbrev-ref', 'HEAD');
    return r.code === 0 ? r.stdout.trim() : 'master';
  }

  /** O que está rodando agora: commit curto, data e branch. */
  async function currentVersion() {
    const r = await git('log', '-1', '--format=%h%n%cI%n%s');
    if (r.code !== 0) return { ok: false, message: 'Esta cópia não é um clone git; atualize baixando o repositório de novo.' };
    const [commit, date, subject] = r.stdout.split('\n');
    return { ok: true, commit, date, subject, branch: await branch() };
  }

  /**
   * Busca o repositório e compara com a cópia local. Não muda nada no disco
   * além do que `git fetch` traz para dentro de `.git`.
   */
  async function check() {
    const current = await currentVersion();
    if (!current.ok) return { ok: false, message: current.message };

    const fetch = await git('fetch', '--quiet', 'origin');
    if (fetch.code !== 0) {
      return {
        ok: false,
        current,
        message: `Não deu para falar com o repositório: ${(fetch.stderr || fetch.stdout || 'sem resposta').split('\n')[0]}`,
      };
    }

    const remote = `origin/${current.branch}`;
    const count = await git('rev-list', '--left-right', '--count', `HEAD...${remote}`);
    if (count.code !== 0) {
      return { ok: false, current, message: `O repositório não tem a branch ${current.branch}.` };
    }
    const { ahead, behind } = parseAheadBehind(count.stdout);

    const status = await git('status', '--porcelain');
    const dirty = status.code === 0 && status.stdout.trim().length > 0;

    // O que vem: um título por commit, do mais recente ao mais antigo.
    const changes = behind
      ? (await git('log', '--format=%s', `HEAD..${remote}`)).stdout.split('\n').filter(Boolean)
      : [];

    const result = { ok: true, current, remote, ahead, behind, dirty, changes };
    return { ...result, message: describeCheck(result) };
  }

  /**
   * Aplica a atualização. Recusa árvore suja (o pull poderia sobrescrever
   * trabalho) e histórico divergente (`--ff-only`). Reinstala dependências só
   * se os manifestos mudaram — é o que demora, e na maioria das vezes não é
   * preciso.
   */
  async function update() {
    const before = await check();
    if (!before.ok) return { ok: false, message: before.message };
    if (before.dirty) return { ok: false, message: before.message };
    if (!before.behind) return { ok: true, updated: false, message: 'Já está na última versão.' };

    const from = (await git('rev-parse', 'HEAD')).stdout.trim();
    log(`Trazendo ${before.behind} commit(s) de ${before.remote}…`);
    const pull = await git('pull', '--ff-only', 'origin', before.current.branch);
    if (pull.code !== 0) {
      return { ok: false, message: `git pull falhou: ${(pull.stderr || pull.stdout).split('\n').filter(Boolean).pop() || 'sem detalhe'}` };
    }
    const to = (await git('rev-parse', 'HEAD')).stdout.trim();

    const diff = await git('diff', '--name-only', from, to);
    const changed = diff.stdout.split('\n').filter(Boolean);

    if (needsNpmInstall(changed)) {
      log('Dependências do app mudaram: npm install…');
      const npm = platform === 'win32'
        ? await run('cmd', ['/c', 'npm', 'install', '--no-fund', '--no-audit'], { cwd: path.join(root, 'desktop') })
        : await run('npm', ['install', '--no-fund', '--no-audit'], { cwd: path.join(root, 'desktop') });
      if (npm.code !== 0) {
        return { ok: false, updated: true, message: `Código atualizado, mas o npm install falhou: ${npm.stderr.split('\n').filter(Boolean).pop() || ''}`.trim() };
      }
    }

    if (needsPipInstall(changed)) {
      log('Dependências do motor mudaram: pip install…');
      const python = platform === 'win32'
        ? path.join(root, '.venv', 'Scripts', 'python.exe')
        : path.join(root, '.venv', 'bin', 'python');
      const pip = await run(python, ['-m', 'pip', 'install', '-e', '.', '--quiet'], { cwd: root });
      if (pip.code !== 0) {
        return { ok: false, updated: true, message: `Código atualizado, mas o pip install falhou: ${pip.stderr.split('\n').filter(Boolean).pop() || ''}`.trim() };
      }
    }

    log(`Atualizado: ${from.slice(0, 7)} → ${to.slice(0, 7)}.`);
    return { ok: true, updated: true, from: from.slice(0, 7), to: to.slice(0, 7), message: 'Atualizado. Reinicie o Synapse para usar a nova versão.' };
  }

  return { currentVersion, check, update };
}

module.exports = {
  NPM_MANIFESTS,
  PIP_MANIFESTS,
  createUpdater,
  describeCheck,
  needsNpmInstall,
  needsPipInstall,
  parseAheadBehind,
};

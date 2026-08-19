'use strict';

/**
 * Processo principal do app desktop.
 *
 * O trabalho pesado (ffmpeg + Whisper) roda fora daqui: no motor nativo
 * (Python do host + whisper.cpp com GPU) ou no container Docker (CPU). Este
 * processo só faz o spawn, lê os eventos JSONL do stdout e repassa à janela.
 */

const {
  app, BrowserWindow, desktopCapturer, dialog, ipcMain, session, shell,
} = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {
  IMAGE_NAME,
  buildDockerArgs,
  buildNativeArgs,
  buildNativeEnv,
  nativeStatus,
  toHostPath,
} = require('./engines');
const {
  buildClaudeArgs,
  buildExtractionPrompt,
  buildPrompt,
  describeEvent,
  extractionPathFor,
  findBrowser,
  findClaude,
  pdfPathFor,
} = require('./claude-jobs');
const library = require('./library');
const groups = require('./groups');
const tasks = require('./tasks');
const workspace = require('./workspace');

const PROJECT_ROOT = path.resolve(__dirname, '..');

// Extensões aceitas no drop. Áudio também vale: o ffmpeg trata os dois.
const MEDIA_EXTENSIONS = [
  'mkv', 'mp4', 'mov', 'webm', 'avi', 'm4v', 'wmv', 'flv',
  'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac',
];

const DEFAULT_SETTINGS = {
  outputDir: path.join(app.getPath('documents'), 'Transcricoes'),
  engine: 'native',    // 'native' (GPU) ou 'docker' (CPU)
  model: 'small',      // modelo do motor docker
  nativeModel: '',     // caminho do .bin escolhido no motor nativo
  language: 'pt',
  formats: ['md', 'txt'],
};

let mainWindow = null;
let currentJob = null;    // transcrição em andamento
let currentDocJob = null; // geração de PDF em andamento
let currentExtraction = null; // extração de tarefas em andamento

// --- Configurações persistidas ---------------------------------------------

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

// --- Helpers de processo ----------------------------------------------------

/** Roda um comando e resolve com { code, stdout, stderr }. Nunca rejeita. */
function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

async function dockerStatus() {
  const version = await run('docker', ['version', '--format', '{{.Server.Version}}']);
  if (version.code !== 0) {
    return {
      docker: false,
      image: false,
      message: 'Docker não está acessível. Abra o Docker Desktop e tente de novo.',
    };
  }
  const image = await run('docker', ['image', 'inspect', IMAGE_NAME, '--format', '{{.Id}}']);
  return {
    docker: true,
    image: image.code === 0,
    version: version.stdout,
    message: image.code === 0 ? '' : 'A imagem de transcrição ainda não foi construída.',
  };
}

/** Situação dos dois motores e qual deles pode rodar agora. */
async function enginesStatus() {
  const docker = await dockerStatus();
  const native = nativeStatus(PROJECT_ROOT);
  const settings = loadSettings();

  // Um motor indisponível não deve travar o app: se o escolhido não pode
  // rodar e o outro pode, o app usa o que funciona e diz isso na barra.
  const dockerOk = docker.docker && docker.image;
  let active = settings.engine;
  if (active === 'native' && !native.ok) active = dockerOk ? 'docker' : 'native';
  if (active === 'docker' && !dockerOk) active = native.ok ? 'native' : 'docker';

  return {
    active,
    chosen: settings.engine,
    native: { ...native, label: 'GPU (whisper.cpp)' },
    docker: { ...docker, ok: dockerOk, label: 'Docker (CPU)' },
  };
}

// --- Janela -----------------------------------------------------------------

/**
 * Autoriza a janela a capturar o áudio que sai pelos alto-falantes.
 *
 * Numa reunião online o microfone só pega o nosso lado; o que a outra parte
 * fala vem pelo loopback do sistema. Pedimos a tela só porque o Chromium exige
 * uma fonte de vídeo junto — o renderer descarta essa trilha e grava só áudio.
 */
function enableSystemAudioCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      callback({ video: sources[0], audio: 'loopback' });
    } catch {
      callback({});   // sem loopback: o renderer segue só com o microfone
    }
  }, { useSystemPicker: false });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 880,
    minHeight: 660,
    backgroundColor: '#070A14',
    title: 'Synapse',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // Abre links externos no navegador do sistema, nunca dentro do app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// --- Transcrição ------------------------------------------------------------

function startJob(payload) {
  if (currentJob) {
    return { started: false, message: 'Já existe uma transcrição em andamento.' };
  }

  const videoPath = payload.videoPath;
  if (!videoPath || !fs.existsSync(videoPath)) {
    return { started: false, message: 'Arquivo não encontrado.' };
  }
  const ext = path.extname(videoPath).slice(1).toLowerCase();
  if (!MEDIA_EXTENSIONS.includes(ext)) {
    return { started: false, message: `Formato .${ext} não é vídeo nem áudio.` };
  }

  const settings = loadSettings();
  const outputDir = payload.outputDir || settings.outputDir;
  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    return { started: false, message: `Não foi possível usar a pasta de saída: ${err.message}` };
  }

  const language = payload.language || settings.language;
  const formats = payload.formats || settings.formats;
  const engine = payload.engine || settings.engine;
  const name = (payload.name || '').trim();

  let child;
  let containerName = null;

  if (engine === 'native') {
    const native = nativeStatus(PROJECT_ROOT);
    const modelPath = payload.nativeModel || settings.nativeModel || native.models[0]?.path;
    if (!native.cli || !modelPath) {
      return { started: false, message: native.message || 'Motor nativo indisponível.' };
    }
    child = spawn(
      native.python,
      buildNativeArgs({ videoPath, outputDir, formats, name }),
      {
        cwd: PROJECT_ROOT,
        windowsHide: true,
        env: {
          ...process.env,
          ...buildNativeEnv({ cli: native.cli, modelPath, language, threads: 0 }),
        },
      },
    );
  } else {
    containerName = `mp-transcribe-${Date.now()}`;
    child = spawn(
      'docker',
      buildDockerArgs({
        videoPath,
        outputDir,
        model: payload.model || settings.model,
        language,
        formats,
        containerName,
        name,
      }),
      { windowsHide: true },
    );
  }

  currentJob = {
    child, containerName, canceled: false, outputDir, engine,
    projectId: payload.projectId || '',
    cleanup: payload.cleanup || '',   // gravação temporária, apagada no fim
  };

  let stdoutBuffer = '';
  let lastError = '';

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop(); // guarda a linha incompleta para o próximo chunk
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const event = JSON.parse(trimmed);
        if (event.event === 'done' && Array.isArray(event.files)) {
          event.files = event.files.map((f) => toHostPath(f, outputDir));
          // A reunião acabou de nascer: o id é a pasta que recebeu os arquivos.
          event.meetingId = workspace.meetingIdFromFiles(outputDir, event.files);
          const projectId = currentJob?.projectId;
          if (event.meetingId && projectId) {
            groups.assignMeeting(outputDir, event.meetingId, projectId);
          }
          finishJob(event, outputDir, projectId);
          continue;   // o done é anunciado depois da extração
        }
        if (event.event === 'error') lastError = event.message;
        send('job:event', event);
      } catch {
        // Linha não-JSON no stdout: ignora em vez de derrubar o job.
      }
    }
  });

  // O log do Python vai para stderr; guardamos a última linha útil para o caso
  // de o processo morrer sem emitir um evento de erro.
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      lastError = text.split('\n').filter(Boolean).pop() || lastError;
      send('job:log', text);
    }
  });

  child.on('error', (err) => {
    currentJob = null;
    send('job:event', { event: 'error', message: `Falha ao executar o Docker: ${err.message}` });
  });

  child.on('close', (code) => {
    const wasCanceled = currentJob?.canceled;
    const temporario = currentJob?.cleanup;
    currentJob = null;
    // A gravação bruta já virou transcrição: não precisa ocupar disco.
    if (temporario) {
      try { fs.unlinkSync(temporario); } catch { /* já removido */ }
    }
    if (wasCanceled) {
      send('job:event', { event: 'canceled' });
    } else if (code !== 0) {
      send('job:event', {
        event: 'error',
        message: lastError || `A transcrição terminou com erro (código ${code}).`,
      });
    }
    send('job:closed', { code });
  });

  return { started: true, containerName };
}

/**
 * Gravação feita dentro do app (REC-04): o áudio capturado na janela chega
 * como bytes, vira um arquivo e entra no mesmo pipeline da importação. A
 * origem muda; o processamento é o de sempre.
 */
/**
 * Extração estruturada (AI-02): logo depois da transcrição, o Claude lê o
 * texto e devolve as ações combinadas em JSON, que viram cards no kanban do
 * projeto. É o que faz a reunião terminar sem trabalho manual.
 *
 * Falha aqui não derruba o job: a transcrição já está no disco, e uma extração
 * que não veio é um kanban vazio, não uma reunião perdida.
 */
/**
 * Fecha o ciclo da reunião: com projeto, as ações viram cards antes do aviso de
 * pronto; sem projeto, não há onde pendurar tarefa e o aviso sai na hora.
 */
async function finishJob(event, outputDir, projectId) {
  const transcricao = event.files.find((f) => f.toLowerCase().endsWith('.md'));

  if (projectId && transcricao) {
    send('job:event', { event: 'stage', key: 'extract', progress: 20, detail: 'lendo a transcrição' });
    const { created, message } = await extractTasks({
      meetingId: event.meetingId,
      projectId,
      transcriptPath: transcricao,
      context: groups.getGroup(outputDir, projectId)?.context || '',
    });
    event.tasksCreated = created;
    if (message) send('job:log', `Extração de tarefas: ${message}`);
  } else {
    event.tasksCreated = 0;
  }

  send('job:event', event);
}

function extractTasks({ meetingId, projectId, transcriptPath, context }) {
  return new Promise((resolve) => {
    const jsonPath = extractionPathFor(transcriptPath);
    try { fs.unlinkSync(jsonPath); } catch { /* não existia */ }

    let prompt;
    try {
      prompt = buildExtractionPrompt({ transcriptPath, jsonPath, context });
    } catch (err) {
      resolve({ created: 0, message: err.message });
      return;
    }

    const child = spawn(findClaude(), buildClaudeArgs(), {
      cwd: path.dirname(transcriptPath),
      windowsHide: true,
    });
    child.stdin.write(prompt);
    child.stdin.end();

    currentExtraction = child;
    let progresso = 45;

    child.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const descricao = describeEvent(JSON.parse(line));
          if (!descricao) continue;
          progresso = Math.min(90, progresso + 8);
          send('job:event', { event: 'stage', key: 'extract', progress: progresso, detail: descricao });
        } catch { /* linha parcial do stream */ }
      }
    });

    child.on('error', (err) => resolve({
      created: 0,
      message: `não foi possível executar o Claude Code (${err.code || err.message}).`,
    }));

    child.on('close', () => {
      currentExtraction = null;
      let dados = null;
      try {
        dados = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      } catch {
        resolve({ created: 0, message: 'A extração não devolveu um JSON legível.' });
        return;
      }
      try { fs.unlinkSync(jsonPath); } catch { /* já apagado */ }

      const { created } = tasks.createFromExtraction(loadSettings().outputDir, {
        projectId,
        meetingId,
        items: Array.isArray(dados.tasks) ? dados.tasks : [],
      });
      resolve({ created });
    });
  });
}

function startRecordingJob({ projectId, name, audio, mimeType = 'audio/webm' }) {
  if (currentJob) {
    return { started: false, message: 'Já existe uma transcrição em andamento.' };
  }
  if (!audio || !audio.byteLength) {
    return { started: false, message: 'A gravação saiu vazia. Confira o microfone e tente de novo.' };
  }

  const settings = loadSettings();
  const ext = mimeType.includes('ogg') ? 'ogg' : 'webm';
  const temporario = path.join(
    app.getPath('temp'),
    `synapse-gravacao-${Date.now()}.${ext}`,
  );

  try {
    fs.writeFileSync(temporario, Buffer.from(audio));
  } catch (err) {
    return { started: false, message: `Não foi possível salvar a gravação: ${err.message}` };
  }

  return startJob({
    videoPath: temporario,
    name: name || 'Gravação',
    projectId,
    outputDir: settings.outputDir,
    cleanup: temporario,
  });
}

async function cancelJob() {
  // A extração roda depois do pipeline: cancelar durante ela também vale.
  if (currentExtraction) {
    currentExtraction.kill();
    currentExtraction = null;
    send('job:event', { event: 'canceled' });
    return { canceled: true };
  }
  if (!currentJob) return { canceled: false };
  currentJob.canceled = true;

  if (currentJob.containerName) {
    // Matar o cliente `docker run` não para o container: removemos pelo nome.
    await run('docker', ['rm', '-f', currentJob.containerName]);
  } else if (process.platform === 'win32') {
    // No motor nativo o Python tem o whisper-cli como filho, e matar só o pai
    // deixaria a transcrição consumindo a GPU até o fim.
    await run('taskkill', ['/pid', String(currentJob.child.pid), '/t', '/f']);
  }
  currentJob.child.kill();
  return { canceled: true };
}

// --- Documentos gerados pelo Claude ----------------------------------------

/**
 * Gera tarefas ou resumo executivo em PDF a partir de uma transcrição.
 *
 * Roda `claude -p` em modo headless na pasta da transcrição e acompanha o
 * stream de eventos para a janela mostrar o que está acontecendo.
 */
function startDocJob({ kind, transcriptPath, context = '' }) {
  if (currentDocJob) {
    return { started: false, message: 'Já existe um documento sendo gerado.' };
  }
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { started: false, message: 'Transcrição não encontrada.' };
  }

  const browser = findBrowser();
  if (!browser) {
    return {
      started: false,
      message: 'Nenhum navegador encontrado para gerar o PDF (Edge ou Chrome).',
    };
  }

  const pdfPath = pdfPathFor(kind, transcriptPath);
  let prompt;
  try {
    prompt = buildPrompt(kind, { transcriptPath, pdfPath, browser, context });
  } catch (err) {
    return { started: false, message: err.message };
  }

  const child = spawn(findClaude(), buildClaudeArgs(), {
    cwd: path.dirname(transcriptPath),
    windowsHide: true,
  });
  // O prompt vai por stdin: como argumento, o shell do Windows o corrompe.
  child.stdin.write(prompt);
  child.stdin.end();

  currentDocJob = { child, kind, pdfPath, canceled: false };

  let buffer = '';
  let lastMessage = '';

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const event = JSON.parse(trimmed);
        const description = describeEvent(event);
        if (description) send('doc:progress', { kind, description });
        if (event.type === 'result') lastMessage = event.result || lastMessage;
      } catch {
        // Linha fora do formato: ignora em vez de derrubar a geração.
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) lastMessage = text.split('\n').filter(Boolean).pop() || lastMessage;
  });

  child.on('error', (err) => {
    currentDocJob = null;
    send('doc:done', { kind, ok: false, message: `Falha ao executar o Claude: ${err.message}` });
  });

  child.on('close', () => {
    const canceled = currentDocJob?.canceled;
    currentDocJob = null;
    if (canceled) {
      send('doc:done', { kind, ok: false, canceled: true, message: 'Geração cancelada.' });
      return;
    }
    // O veredito é o arquivo existir — não o que o modelo disse ter feito.
    const ok = fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 0;
    send('doc:done', {
      kind,
      ok,
      pdfPath: ok ? pdfPath : null,
      message: ok ? lastMessage : `O PDF não foi gerado. ${lastMessage}`.trim(),
    });
  });

  return { started: true, pdfPath };
}

function cancelDocJob() {
  if (!currentDocJob) return { canceled: false };
  currentDocJob.canceled = true;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(currentDocJob.child.pid), '/t', '/f'], { windowsHide: true });
  } else {
    currentDocJob.child.kill();
  }
  return { canceled: true };
}

// --- Build da imagem --------------------------------------------------------

function buildImage() {
  return new Promise((resolve) => {
    const child = spawn('docker', ['build', '-t', IMAGE_NAME, '.'], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
    });
    const forward = (chunk) => {
      const text = chunk.toString().trim();
      if (text) send('build:log', text);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (err) => resolve({ ok: false, message: String(err) }));
    child.on('close', (code) => resolve({ ok: code === 0, code }));
  });
}

// --- IPC --------------------------------------------------------------------

const outDir = () => loadSettings().outputDir;

// Configurações e motores.
ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_e, patch) => saveSettings(patch));
ipcMain.handle('engines:status', () => enginesStatus());
ipcMain.handle('docker:status', () => dockerStatus());
ipcMain.handle('docker:build', () => buildImage());

// Projetos — o grupo do disco visto como projeto do workspace.
ipcMain.handle('projects:list', () => workspace.listProjects(outDir()));
ipcMain.handle('projects:save', (_e, project) => groups.saveGroup(outDir(), project));
ipcMain.handle('projects:delete', (_e, projectId) => {
  const dir = outDir();
  const result = groups.deleteGroup(dir, projectId);
  // As tarefas do projeto vão junto: sem projeto elas não teriam onde viver.
  if (result.ok) tasks.forgetProject(dir, projectId);
  return result;
});

// Reuniões (a pasta de saída é a fonte da verdade).
ipcMain.handle('meetings:list', (_e, projectId) => workspace.listMeetings(outDir(), projectId));
ipcMain.handle('meetings:get', (_e, id) => workspace.getMeeting(outDir(), id));
ipcMain.handle('meetings:rename', (_e, { id, name }) => {
  const dir = outDir();
  const result = library.renameMeeting(dir, id, name);
  // O id de uma reunião é o nome da pasta: renomear muda o id, e os vínculos
  // de projeto e de tarefa precisam acompanhar para não virarem órfãos.
  if (result.ok && result.id && result.id !== id) {
    groups.renameMeeting(dir, id, result.id);
    tasks.renameMeeting(dir, id, result.id);
  }
  return result;
});
ipcMain.handle('meetings:delete', (_e, { id, files }) => {
  const dir = outDir();
  const result = library.deleteMeeting(dir, id, files);
  if (result.ok) {
    groups.forgetMeeting(dir, id);
    tasks.forgetMeeting(dir, id);
  }
  return result;
});
ipcMain.handle('meetings:assign', (_e, { meetingId, projectId }) =>
  groups.assignMeeting(outDir(), meetingId, projectId));
ipcMain.handle('meetings:read', (_e, filePath) => library.readText(filePath));

// Tarefas do Kanban.
ipcMain.handle('tasks:list', (_e, projectId) => workspace.listTasks(outDir(), projectId));
ipcMain.handle('tasks:save', (_e, task) => tasks.saveTask(outDir(), task));
ipcMain.handle('tasks:move', (_e, { id, status }) => tasks.moveTask(outDir(), id, status));
ipcMain.handle('tasks:delete', (_e, id) => tasks.deleteTask(outDir(), id));

// Pipeline.
ipcMain.handle('job:start', (_e, payload) => startJob(payload));
ipcMain.handle('job:recording', (_e, payload) => startRecordingJob(payload));
ipcMain.handle('job:cancel', () => cancelJob());

// Documentos: o front manda o id da reunião; aqui viram caminho e contexto.
ipcMain.handle('doc:generate', (_e, { kind, meetingId }) => {
  const dir = outDir();
  const meeting = library.getMeeting(dir, meetingId);
  if (!meeting || !meeting.transcript) {
    return { started: false, message: 'Transcrição não encontrada.' };
  }
  return startDocJob({
    kind,
    transcriptPath: meeting.transcript,
    context: meeting.group?.context || '',
    meetingId,
  });
});
ipcMain.handle('doc:cancel', () => cancelDocJob());

// Chat por projeto — o RAG entra no M3 (embeddings + Vector DB).
ipcMain.handle('chat:ask', (_e, { projectId }) => {
  const reunioes = workspace.listMeetings(outDir(), projectId).length;
  return {
    answer: reunioes
      ? `O chat ainda não está ligado à memória do projeto. Este projeto tem ${reunioes} reunião(ões) transcrita(s) prontas para indexar — a busca semântica entra no próximo módulo.`
      : 'Este projeto ainda não tem reuniões. Grave ou importe uma para eu ter o que ler.',
    sources: [],
  };
});

/** Salva uma cópia de um arquivo da reunião onde o usuário escolher. */
ipcMain.handle('meetings:download', async (_e, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, message: 'Arquivo não encontrado.' };
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Salvar cópia',
    defaultPath: path.join(app.getPath('downloads'), path.basename(filePath)),
    filters: [{ name: path.extname(filePath).slice(1).toUpperCase(), extensions: [path.extname(filePath).slice(1)] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };

  try {
    fs.copyFileSync(filePath, result.filePath);
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, message: `Não foi possível salvar: ${err.message}` };
  }
});

ipcMain.handle('dialog:pickOutputDir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Escolher pasta de saída',
    defaultPath: loadSettings().outputDir,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return saveSettings({ outputDir: result.filePaths[0] }).outputDir;
});

ipcMain.handle('dialog:pickVideo', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Escolher vídeo',
    properties: ['openFile'],
    filters: [{ name: 'Vídeo e áudio', extensions: MEDIA_EXTENSIONS }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('shell:showInFolder', (_e, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('shell:openPath', (_e, filePath) => shell.openPath(filePath));

// --- Ciclo de vida ----------------------------------------------------------

app.whenReady().then(() => {
  enableSystemAudioCapture();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Trabalho órfão nunca: se a janela fecha no meio, derruba o job.
app.on('before-quit', () => {
  if (!currentJob) return;
  currentJob.canceled = true;
  if (currentJob.containerName) {
    spawn('docker', ['rm', '-f', currentJob.containerName], { windowsHide: true });
  } else if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(currentJob.child.pid), '/t', '/f'], { windowsHide: true });
  }
});

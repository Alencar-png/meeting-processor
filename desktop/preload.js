'use strict';

/**
 * Ponte entre a janela e o processo principal.
 *
 * A janela não tem acesso a Node: tudo passa por esta API explícita, o que
 * mantém o renderer incapaz de tocar no sistema de arquivos por conta própria.
 * A superfície abaixo é o contrato do Synapse — projetos, reuniões, tarefas,
 * pipeline, documentos e chat.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listeners = {
  'job:event': new Set(),
  'job:log': new Set(),
  'job:closed': new Set(),
  'build:log': new Set(),
  'doc:progress': new Set(),
  'doc:done': new Set(),
};

for (const channel of Object.keys(listeners)) {
  ipcRenderer.on(channel, (_e, payload) => {
    for (const fn of listeners[channel]) fn(payload);
  });
}

contextBridge.exposeInMainWorld('api', {
  // Caminho real de um arquivo solto na janela (File.path saiu do Electron 32+).
  pathForFile: (file) => webUtils.getPathForFile(file),

  // --- Configurações ---
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  enginesStatus: () => ipcRenderer.invoke('engines:status'),
  dockerStatus: () => ipcRenderer.invoke('docker:status'),
  buildImage: () => ipcRenderer.invoke('docker:build'),

  // --- Projetos ---
  listProjects: () => ipcRenderer.invoke('projects:list'),
  saveProject: (project) => ipcRenderer.invoke('projects:save', project),
  deleteProject: (projectId) => ipcRenderer.invoke('projects:delete', projectId),

  // --- Reuniões ---
  listMeetings: (projectId) => ipcRenderer.invoke('meetings:list', projectId),
  getMeeting: (id) => ipcRenderer.invoke('meetings:get', id),
  renameMeeting: (id, name) => ipcRenderer.invoke('meetings:rename', { id, name }),
  deleteMeeting: (id, files) => ipcRenderer.invoke('meetings:delete', { id, files }),
  assignProject: (meetingId, projectId) =>
    ipcRenderer.invoke('meetings:assign', { meetingId, projectId }),
  readFile: (filePath) => ipcRenderer.invoke('meetings:read', filePath),
  downloadFile: (filePath) => ipcRenderer.invoke('meetings:download', filePath),

  // --- Tarefas (Kanban) ---
  listTasks: (projectId) => ipcRenderer.invoke('tasks:list', projectId),
  saveTask: (task) => ipcRenderer.invoke('tasks:save', task),
  moveTask: (id, status) => ipcRenderer.invoke('tasks:move', { id, status }),
  deleteTask: (id) => ipcRenderer.invoke('tasks:delete', id),

  // --- Pipeline: importação e gravação ---
  startJob: (payload) => ipcRenderer.invoke('job:start', payload),
  processRecording: (payload) => ipcRenderer.invoke('job:recording', payload),
  cancelJob: () => ipcRenderer.invoke('job:cancel'),

  // --- Documentos gerados a partir da transcrição ---
  generateDoc: (payload) => ipcRenderer.invoke('doc:generate', payload),
  cancelDoc: () => ipcRenderer.invoke('doc:cancel'),

  // --- Chat por projeto ---
  chatAsk: (payload) => ipcRenderer.invoke('chat:ask', payload),

  // --- Sistema ---
  pickOutputDir: () => ipcRenderer.invoke('dialog:pickOutputDir'),
  pickVideo: () => ipcRenderer.invoke('dialog:pickVideo'),
  showInFolder: (filePath) => ipcRenderer.invoke('shell:showInFolder', filePath),
  openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),

  on: (channel, fn) => {
    if (!listeners[channel]) throw new Error(`Canal desconhecido: ${channel}`);
    listeners[channel].add(fn);
    return () => listeners[channel].delete(fn);
  },
});

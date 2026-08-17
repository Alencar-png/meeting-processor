'use strict';

/**
 * Ponte entre a janela e o processo principal.
 *
 * A janela não tem acesso a Node: tudo passa por esta API explícita, o que
 * mantém o renderer incapaz de tocar no sistema de arquivos por conta própria.
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

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  enginesStatus: () => ipcRenderer.invoke('engines:status'),
  dockerStatus: () => ipcRenderer.invoke('docker:status'),
  buildImage: () => ipcRenderer.invoke('docker:build'),

  startJob: (payload) => ipcRenderer.invoke('job:start', payload),
  cancelJob: () => ipcRenderer.invoke('job:cancel'),

  // Documentos gerados pelo Claude a partir da transcrição.
  startDoc: (payload) => ipcRenderer.invoke('doc:start', payload),
  cancelDoc: () => ipcRenderer.invoke('doc:cancel'),

  // Biblioteca de transcrições.
  listMeetings: () => ipcRenderer.invoke('library:list'),
  getMeeting: (id) => ipcRenderer.invoke('library:get', id),
  renameMeeting: (id, name) => ipcRenderer.invoke('library:rename', { id, name }),
  deleteMeeting: (id, files) => ipcRenderer.invoke('library:delete', { id, files }),
  readFile: (filePath) => ipcRenderer.invoke('library:read', filePath),
  downloadFile: (filePath) => ipcRenderer.invoke('library:download', filePath),

  // Grupos (projetos) e seus contextos.
  listGroups: () => ipcRenderer.invoke('groups:list'),
  saveGroup: (group) => ipcRenderer.invoke('groups:save', group),
  deleteGroup: (groupId) => ipcRenderer.invoke('groups:delete', groupId),
  assignGroup: (meetingId, groupId) =>
    ipcRenderer.invoke('groups:assign', { meetingId, groupId }),

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

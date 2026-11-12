/**
 * Puente seguro entre la interfaz y el proceso principal: expone solo las
 * operaciones de `MatamoscasApi` en `window.matamoscas`.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ApplyProgress, MatamoscasApi, ScoreProgress } from '../shared/ipc';

const api: MatamoscasApi = {
  getAccount: () => ipcRenderer.invoke('account:get'),
  connect: (email, appPassword) => ipcRenderer.invoke('account:connect', email, appPassword),
  disconnect: () => ipcRenderer.invoke('account:disconnect'),
  listFolders: () => ipcRenderer.invoke('mail:folders'),
  listMessages: (path, page) => ipcRenderer.invoke('mail:list', path, page),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  readMessage: (path, emailId) => ipcRenderer.invoke('mail:read', path, emailId),
  extractRules: (path, emailIds) => ipcRenderer.invoke('mail:extractRules', path, emailIds),
  listRules: () => ipcRenderer.invoke('rules:list'),
  createRule: (draft) => ipcRenderer.invoke('rules:create', draft),
  updateRule: (id, patch) => ipcRenderer.invoke('rules:update', id, patch),
  deleteRule: (id) => ipcRenderer.invoke('rules:delete', id),
  compileRule: (id) => ipcRenderer.invoke('rules:compile', id),
  previewRule: (id) => ipcRenderer.invoke('rules:preview', id),
  planRule: (id) => ipcRenderer.invoke('rules:plan', id),
  applyPlan: (token, confirmText) => ipcRenderer.invoke('rules:apply', token, confirmText),
  onApplyProgress: (listener) => {
    const handler = (_e: IpcRendererEvent, progress: ApplyProgress) => listener(progress);
    ipcRenderer.on('rules:progress', handler);
    return () => ipcRenderer.removeListener('rules:progress', handler);
  },
  scoreRule: (id) => ipcRenderer.invoke('rules:score', id),
  onScoreProgress: (listener) => {
    const handler = (_e: IpcRendererEvent, progress: ScoreProgress) => listener(progress);
    ipcRenderer.on('rules:scoreProgress', handler);
    return () => ipcRenderer.removeListener('rules:scoreProgress', handler);
  },
  planScan: (token, emailIds) => ipcRenderer.invoke('rules:planScan', token, emailIds),
  getHistory: () => ipcRenderer.invoke('history:get'),
  undoLast: () => ipcRenderer.invoke('history:undo'),
  hasAnthropicKey: () => ipcRenderer.invoke('settings:hasKey'),
  setAnthropicKey: (key) => ipcRenderer.invoke('settings:setKey', key),
  clearAnthropicKey: () => ipcRenderer.invoke('settings:clearKey'),
};

contextBridge.exposeInMainWorld('matamoscas', api);

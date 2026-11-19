'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('modelSettings', Object.freeze({ read: () => ipcRenderer.invoke('hoshifuru:model:read'), save: (value) => ipcRenderer.invoke('hoshifuru:model:save', { apiBase: value.apiBase, apiKey: value.apiKey, model: value.model }) }));

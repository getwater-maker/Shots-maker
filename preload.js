/**
 * preload.js — contextIsolation 하에서 렌더러에 안전한 API 노출.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listPresets: () => ipcRenderer.invoke('list-presets'),
  listStyles: () => ipcRenderer.invoke('list-styles'),
  openScript: (args) => ipcRenderer.invoke('open-script', args),
  ttsBuild: (args) => ipcRenderer.invoke('tts-build', args),
  imageBuild: (args) => ipcRenderer.invoke('image-build', args),
  videoBuild: (args) => ipcRenderer.invoke('video-build', args),
  exportVrew: (args) => ipcRenderer.invoke('export-vrew', args),
  attachAsset: (args) => ipcRenderer.invoke('attach-asset', args),
  clearAsset: (args) => ipcRenderer.invoke('clear-asset', args),
  bulkAttach: (args) => ipcRenderer.invoke('bulk-attach', args),
  getPresetDetail: (name) => ipcRenderer.invoke('get-preset-detail', name),
  savePreset: (args) => ipcRenderer.invoke('save-preset', args),
  getGeminiKey: () => ipcRenderer.invoke('get-gemini-key'),
  setGeminiKey: (key) => ipcRenderer.invoke('set-gemini-key', key),
  pickFile: (args) => ipcRenderer.invoke('pick-file', args),
  pickDir: () => ipcRenderer.invoke('pick-dir'),
  saveProject: () => ipcRenderer.invoke('save-project'),
  loadProject: () => ipcRenderer.invoke('load-project'),
  setTitle: (args) => ipcRenderer.invoke('set-title', args),
  readAudio: (p) => ipcRenderer.invoke('read-audio', p),
  setAspect: (value) => ipcRenderer.invoke('set-aspect', value),
  makeAll: (args) => ipcRenderer.invoke('make-all', args),
  abort: () => ipcRenderer.invoke('abort'),
  resetProject: () => ipcRenderer.invoke('reset-project'),
  regenGroup: (args) => ipcRenderer.invoke('regen-group', args),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  onLog: (cb) => ipcRenderer.on('log', (_e, line) => cb(line)),
  onDtoUpdate: (cb) => ipcRenderer.on('dto-update', (_e, dto) => cb(dto)),
});

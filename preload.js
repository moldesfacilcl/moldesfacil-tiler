/**
 * preload.js — Puente IPC seguro (contextIsolation: true)
 * Moldes Fácil Tiler
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('tilerAPI', {

  /** Convierte un objeto File del DOM a su ruta en disco (Electron 15+) */
  getPathForFile: (file) => webUtils.getPathForFile(file),


  /** Abre diálogo para seleccionar la carpeta de entrada (moldes) */
  selectInputFolder: () =>
    ipcRenderer.invoke('select-input-folder'),

  /** Abre diálogo para seleccionar carpeta de destino */
  selectOutputFolder: () =>
    ipcRenderer.invoke('select-output-folder'),

  /** Recibe rutas dropeadas (archivos y carpetas) y devuelve lista de PDFs */
  processDroppedPaths: (paths) =>
    ipcRenderer.invoke('process-dropped-paths', paths),

  /** Detecta dimensiones y grid de múltiples PDFs */
  detectAll: (filePaths) =>
    ipcRenderer.invoke('detect-all', filePaths),

  /**
   * Procesa el lote completo: tilea y guarda cada PDF.
   * @param {{ files: {path, outputName}[], outputFolder: string, options: object }} args
   */
  batchTile: (args) =>
    ipcRenderer.invoke('batch-tile', args),

  /** Abre la carpeta de destino en Finder / Explorer */
  openFolder: (folderPath) =>
    ipcRenderer.invoke('open-folder', folderPath),

  /** Suscripción al progreso del procesamiento */
  onProgress: (callback) =>
    ipcRenderer.on('tile-progress', (_event, data) => callback(data)),

  /** Eliminar listener de progreso */
  offProgress: () =>
    ipcRenderer.removeAllListeners('tile-progress'),

  /** Lee un PDF del disco y lo devuelve como ArrayBuffer (para previsualización) */
  readPdfForPreview: (filePath) =>
    ipcRenderer.invoke('read-pdf-for-preview', filePath),

  /** Verifica correo + clave de acceso y navega al app si son correctos */
  verifyAccessKey: (email, key) =>
    ipcRenderer.invoke('verify-access-key', email, key),

  /** Cierra sesión y vuelve al login */
  logout: () =>
    ipcRenderer.invoke('logout'),

  /** Indica que corremos dentro de Electron */
  isElectron: true,

  /** Sube PDFs procesados al sitio web de Moldes Fácil */
  uploadPdfsToSite: (data) =>
    ipcRenderer.invoke('upload-pdfs-to-site', data),

  /** Procesa y sube en un solo paso (sin carpeta de destino) */
  processAndUpload: (data) =>
    ipcRenderer.invoke('process-and-upload', data),

  /** Suscripción al progreso de subida */
  onUploadProgress: (callback) =>
    ipcRenderer.on('upload-progress', (_event, data) => callback(data)),

  /** Suscripción al progreso de process-and-upload */
  onProcessUploadProgress: (callback) =>
    ipcRenderer.on('process-upload-progress', (_event, data) => callback(data)),

  /** Valida si los códigos existen en la base de datos del sitio */
  validateCodes: (codes) =>
    ipcRenderer.invoke('validate-codes', codes),

  /** Carga el historial de cargas guardado en disco */
  loadUploadHistory: () =>
    ipcRenderer.invoke('load-upload-history'),

  /** Devuelve la cantidad de registros pendientes de sincronizar con Google Sheets */
  getSheetsQueueSize: () =>
    ipcRenderer.invoke('get-sheets-queue-size'),

  /** Intenta vaciar la cola de Google Sheets manualmente */
  flushSheetsQueue: () =>
    ipcRenderer.invoke('flush-sheets-queue'),
});

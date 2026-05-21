# Moldes Fácil Tiler — Código Completo
> Generado automáticamente. Contiene todos los archivos fuente del proyecto.

---

## `package.json`

```json
{
  "name": "moldesfacil-tiler",
  "version": "1.0.0",
  "description": "Convierte PDFs plotter a hojas A4 para impresión doméstica — Moldes Fácil",
  "main": "main.js",
  "scripts": {
    "start": "env -u ELECTRON_RUN_AS_NODE NODE_ENV=development electron .",
    "build:mac": "electron-builder --mac",
    "build:win": "electron-builder --win"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.1050.0",
    "googleapis": "^172.0.0",
    "pdf-lib": "^1.17.1"
  },
  "devDependencies": {
    "electron": "^28.3.3",
    "electron-builder": "^26.0.12",
    "electron-reload": "^2.0.0-alpha.1"
  },
  "build": {
    "appId": "cl.moldesfacil.tiler",
    "productName": "Moldes Fácil Tiler",
    "copyright": "Copyright © 2026 Moldes Fácil",
    "files": [
      "main.js",
      "preload.js",
      "renderer/**/*",
      "tiler/**/*"
    ],
    "mac": {
      "category": "public.app-category.productivity",
      "target": [
        {
          "target": "dmg",
          "arch": [
            "arm64",
            "x64"
          ]
        }
      ]
    },
    "win": {
      "target": [
        {
          "target": "nsis",
          "arch": [
            "x64"
          ]
        }
      ]
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true
    }
  },
  "author": "Moldes Fácil",
  "license": "ISC"
}

```

---

## `main.js`

```javascript
/**
 * main.js — Proceso principal Electron
 * Moldes Fácil Tiler
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const crypto     = require('crypto');
const WorkerPool = require('./tiler/workerPool');
const { A4_W, A4_H, LETTER_W, LETTER_H } = require('./tiler/pdfTilerEngine');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { syncToSheets, flushPendingQueue, getQueueSize } = require('./sheets-sync');

const s3 = new S3Client({
  endpoint:    'https://sfo3.digitaloceanspaces.com',
  region:      'sfo3',
  credentials: {
    accessKeyId:     'DO00LEMCYDJQLHAVNF8U',
    secretAccessKey: 'j2wIkyJFw1rblJxjp9kx22yIQnA7oQwfGiNqgcEVjBA',
  },
  forcePathStyle: false,
});

// ── Autenticación local ───────────────────────────────────────────────────────
const ACCESS_EMAIL  = 'info@moldesfacil.cl';
const ACCESS_HASH   = crypto.createHash('sha256').update('MoldesFacil2026').digest('hex');
const SESSION_FILE  = path.join(app.getPath('userData'), 'session.json');
const SESSION_TTL   = 30 * 24 * 60 * 60 * 1000; // 30 días

function isSessionValid() {
  try {
    const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    return s.token === ACCESS_HASH && Date.now() - s.ts < SESSION_TTL;
  } catch { return false; }
}

function saveSession() {
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ token: ACCESS_HASH, ts: Date.now() }));
}

ipcMain.handle('logout', (event) => {
  try { fs.unlinkSync(SESSION_FILE); } catch {}
  BrowserWindow.fromWebContents(event.sender)
    .loadFile(path.join(__dirname, 'renderer', 'login.html'));
});

ipcMain.handle('verify-access-key', (event, email, key) => {
  const emailOk = email.trim().toLowerCase() === ACCESS_EMAIL;
  const hash    = crypto.createHash('sha256').update(key).digest('hex');
  if (emailOk && hash === ACCESS_HASH) {
    saveSession();
    BrowserWindow.fromWebContents(event.sender)
      .loadFile(path.join(__dirname, 'renderer', 'index.html'));
    return { ok: true };
  }
  return { ok: false };
});

// ── Pool de workers PDF (inicialización diferida al primer uso) ───────────────
// En M1 con 8 núcleos usamos 4 workers: los 4 performance cores procesan PDFs,
// los efficiency cores se quedan para la UI de Electron.
let _pool = null;
function getPool() {
  if (!_pool) {
    const workerScript = path.join(__dirname, 'tiler', 'pdfWorker.js');
    const poolSize     = Math.min(4, Math.max(1, os.cpus().length - 1));
    _pool = new WorkerPool(workerScript, poolSize);
    console.log(`[pool] ${poolSize} workers iniciados (${os.cpus().length} CPUs detectadas)`);
  }
  return _pool;
}

// Configuración de cada formato de hoja
const FORMAT_INFO = {
  a4:      { label: 'A4',      tileW: A4_W,     tileH: A4_H },
  letter:  { label: 'Carta',   tileW: LETTER_W, tileH: LETTER_H },
  plotter: { label: 'Plotter', tileW: null,      tileH: null },
};

// ── Hot reload en desarrollo ──────────────────────────────────────────────────
if (process.env.NODE_ENV === 'development') {
  try {
    require('electron-reload')(__dirname, {
      electron: path.join(__dirname, 'node_modules', '.bin', 'electron'),
      hardResetMethod: 'exit',
      watched: [
        path.join(__dirname, 'main.js'),
        path.join(__dirname, 'preload.js'),
        path.join(__dirname, 'renderer'),
        path.join(__dirname, 'tiler'),
      ],
    });
  } catch (e) { /* electron-reload no instalado aún */ }
}

// ── Ventana principal ─────────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width:     1100,
    height:    720,
    minWidth:  820,
    minHeight: 580,
    title:     'Moldes Fácil — Tiler Plotter → A4',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  const startPage = isSessionValid() ? 'renderer/index.html' : 'renderer/login.html';
  win.loadFile(path.join(__dirname, startPage));
  // win.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();
  // Intentar vaciar la cola offline de Sheets al arrancar (espera 4 s para que la red esté lista)
  setTimeout(() => flushPendingQueue().catch(() => {}), 4000);
  // Reintentar cada 5 minutos por si se recupera la conexión
  setInterval(() => flushPendingQueue().catch(() => {}), 5 * 60 * 1000);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate',          () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit',       () => { if (_pool) { _pool.terminate(); _pool = null; } });

// ── IPC: Seleccionar carpeta de ENTRADA (donde están los moldes) ──────────────
ipcMain.handle('select-input-folder', async () => {
  const result = await dialog.showOpenDialog({
    title:       'Seleccionar carpetas con moldes PDF',
    properties:  ['openDirectory', 'multiSelections'],
    buttonLabel: 'Cargar moldes',
  });
  if (result.canceled) return null;
  return result.filePaths;
});

// ── IPC: Seleccionar carpeta de DESTINO ───────────────────────────────────────
ipcMain.handle('select-output-folder', async () => {
  const result = await dialog.showOpenDialog({
    title:      'Seleccionar carpeta de destino para los A4',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Seleccionar carpeta',
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// ── IPC: Procesar rutas arrastradas (archivos y/o carpetas) ───────────────────
// Devuelve lista de {name, path} de todos los PDFs encontrados.
ipcMain.handle('process-dropped-paths', async (_event, paths) => {
  const results = [];

  for (const p of paths) {
    try {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(p).sort();
        for (const entry of entries) {
          if (entry.toLowerCase().endsWith('.pdf') && !entry.startsWith('.')) {
            results.push({ name: entry, path: path.join(p, entry) });
          }
        }
      } else if (p.toLowerCase().endsWith('.pdf')) {
        results.push({ name: path.basename(p), path: p });
      }
    } catch (err) {
      console.warn('process-dropped-paths skip:', p, err.message);
    }
  }

  return results;
});

// ── IPC: Detectar dimensiones de múltiples PDFs (paralelo) ───────────────────
ipcMain.handle('detect-all', async (_event, filePaths) => {
  const pool  = getPool();
  const tasks = filePaths.map(filePath => ({
    type:     'detect',
    filePath,
    name:     path.basename(filePath),
  }));
  // Los workers detectan en paralelo; Promise.all espera a todos
  return pool.runAll(tasks);
});

// ── IPC: Procesar lote completo (paralelo con worker pool) ────────────────────
// Genera un PDF tileado por cada combinación archivo × formato seleccionado.
// Los workers corren en paralelo (hasta 4 simultáneos en M1).
// Crea una carpeta por formato: "[nombre] A4/" y "[nombre] Carta/"
ipcMain.handle('batch-tile', async (event, { files, outputFolder, options, batchFolderName, formats, skipIfExists }) => {
  const pool       = getPool();
  const formatList = (formats && formats.length) ? formats : ['a4'];

  // Determinar prefijo del nombre de carpeta:
  // 1) Carpeta de origen → su nombre
  // 2) Un solo archivo suelto → nombre base del archivo
  // 3) Varios archivos sueltos → solo el label del formato
  const resolvedBatchName = batchFolderName
    || (files.length === 1 ? files[0].name.replace(/\.pdf$/i, '') : null);

  // Crear carpetas de destino ANTES de despachar workers (pueden escribir de inmediato)
  const destFolders = {};
  for (const fmt of formatList) {
    const { label }  = FORMAT_INFO[fmt];
    const folderName = resolvedBatchName ? `${resolvedBatchName} ${label}` : label;
    destFolders[fmt] = path.join(outputFolder, folderName);
    fs.mkdirSync(destFolders[fmt], { recursive: true });
  }

  // Construir tareas: una por cada archivo × formato
  const total    = files.length * formatList.length;
  let   progress = 0;
  const tasks = [];
  for (const file of files) {
    for (const fmt of formatList) {
      const { label, tileW, tileH } = FORMAT_INFO[fmt];
      const _parsed  = parseFileName(file.name.replace(/\.pdf$/i, ''));
      const baseName = _parsed
        ? normalizeOutputName(_parsed.code, _parsed.talla)
        : file.name.replace(/\.pdf$/i, '').replace(/\bMOLDE\b/g, 'molde');

      // Si es plotter, copiar el archivo original sin procesar
      if (fmt === 'plotter') {
        const pdfFileName = `${baseName} Plotter.pdf`;
        const outputPath  = path.join(destFolders[fmt], pdfFileName);
        if (!skipIfExists || !fs.existsSync(outputPath)) {
          fs.copyFileSync(file.path, outputPath);
        }
        event.sender.send('tile-progress', {
          current:  ++progress,
          total,
          fileName: file.name,
          format:   'Plotter',
          phase:    'done',
          skipped:  skipIfExists && fs.existsSync(outputPath),
        });
        continue;
      }

      const paddingX    = file[`paddingX_${fmt}`] || 0;
      const paddingY    = file[`paddingY_${fmt}`] || 0;
      const pdfFileName = `${baseName} ${label}.pdf`;
      const outputPath  = path.join(destFolders[fmt], pdfFileName);

      tasks.push({
        type:        'tile',
        filePath:    file.path,
        name:        file.name,
        format:      label,
        formatKey:   fmt,
        pdfFileName,
        outputPath,
        destFolder:  destFolders[fmt],
        skipIfExists: !!skipIfExists,
        options: {
          ...options,
          tileWidth:   tileW,
          tileHeight:  tileH,
          paddingX,
          paddingY,
          formatLabel: label,
        },
      });
    }
  }

  // Despachar todas las tareas al pool; onDone se llama por cada tarea completada
  const results = await pool.runAll(tasks, (result) => {
    progress++;
    event.sender.send('tile-progress', {
      current:  progress,
      total,
      fileName: result.name,
      format:   result.format,
      phase:    'done',
      skipped:  result.skipped || false,
    });
  });

  return results;
});

// ── IPC: Leer PDF para previsualización (devuelve ArrayBuffer) ────────────────
ipcMain.handle('read-pdf-for-preview', async (_event, filePath) => {
  const buf = fs.readFileSync(filePath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

// ── IPC: Validar códigos contra la API (GET público, sin auth) ────────────────
// Valida código Y talla contra la API.
// Recibe: [{ code, talla }]
// Devuelve: { [`${code}__${talla}`]: { codeExists, tallaExists, availableSizes } | null }
ipcMain.handle('validate-codes', async (_event, items) => {
  const results = {};
  for (const { code, talla } of items) {
    const key = `${code}__${talla}`;
    try {
      const res  = await fetch(`${API_URL}/molds?search=${encodeURIComponent(code)}&itemsPerPage=15`);
      if (!res.ok) { results[key] = null; continue; }
      const data = await res.json();
      const arr  = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
      const mold = arr.find(m => String(m.code).toLowerCase() === code.toLowerCase());
      if (!mold) {
        results[key] = { codeExists: false, tallaExists: null, availableSizes: [] };
      } else {
        const sizes      = Array.isArray(mold.sizes) ? mold.sizes : [];
        const tallaExists = talla
          ? sizes.some(s => String(s).toLowerCase() === String(talla).toLowerCase())
          : true;
        results[key] = { codeExists: true, tallaExists, availableSizes: sizes };
      }
    } catch { results[key] = null; }
  }

  // Registrar en Google Sheets
  const validRows = Object.entries(results)
    .filter(([, v]) => v !== null)
    .map(([key, v]) => {
      const [code, talla] = key.split('__');
      const now = new Date();
      const estado = !v.codeExists          ? 'Código no encontrado'
                   : v.tallaExists === false ? `Talla ${talla} no disponible (tiene: ${v.availableSizes.join(', ')})`
                   : 'OK';
      return [now.toLocaleDateString('es-CL'), now.toLocaleTimeString('es-CL'), code, estado];
    });
  if (validRows.length) syncToSheets('Validación', validRows).catch(() => {});

  return results;
});

// ── IPC: Estado de sincronización con Google Sheets ───────────────────────────
ipcMain.handle('get-sheets-queue-size', () => getQueueSize());

ipcMain.handle('flush-sheets-queue', async () => {
  const remaining = await flushPendingQueue();
  return { remaining };
});

// ── IPC: Cargar historial de cargas ───────────────────────────────────────────
ipcMain.handle('load-upload-history', async () => {
  const histFile = path.join(app.getPath('userData'), 'upload-history.json');
  try { return JSON.parse(fs.readFileSync(histFile, 'utf8')); }
  catch { return []; }
});

// ── IPC: Abrir carpeta en Finder / Explorer ───────────────────────────────────
ipcMain.handle('open-folder', async (_event, folderPath) => {
  const { shell } = require('electron');
  await shell.openPath(folderPath);
  return { ok: true };
});

// ── Parser de nombres de archivo ─────────────────────────────────────────────
// Limpia prefijos de macOS (._) y soporta múltiples convenciones:
//   "T-14 molde 569"    → { code: '569',  talla: '14' }
//   "370A TALLA L"      → { code: '370A', talla: 'L'  }
//   "._576A TALLA 14"   → { code: '576A', talla: '14' } (limpia el prefijo)
function parseFileName(baseName) {
  const name = baseName.replace(/^[._\s]+/, '').trim();
  // Formato: {talla_prefijo} molde {code}
  let m = name.match(/^([^\s]+)\s+molde\s+([^\s]+)$/i);
  if (m) {
    const tallaRaw = m[1];
    return { code: m[2], talla: tallaRaw.startsWith('T-') ? tallaRaw.slice(2) : tallaRaw };
  }
  // Formato: {code} TALLA {talla}  (el código puede ir precedido de cualquier cosa tras limpiar)
  m = name.match(/^([A-Za-z0-9]+)\s+TALLA\s+([A-Za-z0-9]+)/i);
  if (m) return { code: m[1], talla: m[2] };
  return null;
}

// Genera siempre el nombre de salida en formato canónico: "T-{talla} molde {code}"
function normalizeOutputName(code, talla) {
  return `T-${talla} molde ${code}`;
}

// Igual pero con sufijo de formato al final (para archivos ya tileados)
function parseFileNameWithFormat(baseName) {
  const name = baseName.replace(/^[._\s]+/, '').trim();
  // Formato canónico de salida: T-{talla} molde {code} {A4|Carta|Plotter}
  let m = name.match(/^T-([^\s]+)\s+molde\s+([^\s]+)\s+(A4|Carta|Plotter)$/i);
  if (m) return { code: m[2], talla: m[1], tipo: m[3] === 'A4' ? 'A4' : m[3].toLowerCase() };
  // Formato: {talla_prefijo} molde {code} {formato}
  m = name.match(/^([^\s]+)\s+molde\s+([^\s]+)\s+(A4|Carta|Plotter)$/i);
  if (m) {
    const tallaRaw = m[1];
    return { code: m[2], talla: tallaRaw.startsWith('T-') ? tallaRaw.slice(2) : tallaRaw, tipo: m[3] === 'A4' ? 'A4' : m[3].toLowerCase() };
  }
  // Formato: {code} TALLA {talla} {formato}
  m = name.match(/^([A-Za-z0-9]+)\s+TALLA\s+([A-Za-z0-9]+)\s+(A4|Carta|Plotter)$/i);
  if (m) return { code: m[1], talla: m[2], tipo: m[3] === 'A4' ? 'A4' : m[3].toLowerCase() };
  return null;
}

// ── Credenciales API (hardcodeadas para uso interno) ─────────────────────────
const API_URL     = 'http://134.199.211.158:3002/api';
const CREDENTIALS = { email: 'facilmoldes@gmail.com', password: 'MoldesFacil.123' };
let   _cachedToken = null;

async function getValidToken() {
  if (!_cachedToken) {
    const res  = await fetch(`${API_URL}/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(CREDENTIALS),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Login fallido: ${data.message}`);
    _cachedToken = data.access_token;
  }
  return _cachedToken;
}

// ── IPC: Subir PDFs directo a DigitalOcean + asociar en la API ───────────────
ipcMain.handle('upload-pdfs-to-site', async (event, { files }) => {
  const results = { uploaded: 0, errors: [] };

  for (const file of files) {
    try {
      const base    = file.name.replace(/\.pdf$/i, '');
      const parsed  = parseFileNameWithFormat(base);
      if (!parsed) {
        results.errors.push({ name: file.name, error: 'Nombre no reconocido' });
        continue;
      }

      const { code, talla, tipo } = parsed;

      // Subir a DigitalOcean Spaces
      const key    = `pdfs/${code}-${talla}-${tipo}-${Date.now()}.pdf`;
      const buffer = Buffer.from(file.buffer);

      await s3.send(new PutObjectCommand({
        Bucket:      'moldes-facil',
        Key:         key,
        Body:        buffer,
        ACL:         'public-read',
        ContentType: 'application/pdf',
      }));

      const url = `https://moldes-facil.sfo3.cdn.digitaloceanspaces.com/${key}`;

      event.sender.send('upload-progress', {
        name: file.name, code, talla, tipo, url, status: 'uploading',
      });

      // Obtener token válido (hace login automático si no hay uno)
      let token = await getValidToken();

      // Asociar en la API — si expira (401), renovar y reintentar una vez
      let response = await fetch(`${API_URL}/molds/upload-pdf`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body:    JSON.stringify({ code, talla, tipo, url: key }),
      });

      if (response.status === 401) {
        _cachedToken = null;
        token        = await getValidToken();
        response     = await fetch(`${API_URL}/molds/upload-pdf`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body:    JSON.stringify({ code, talla, tipo, url: key }),
        });
      }

      if (!response.ok) throw new Error(`API error: ${response.status}`);

      results.uploaded++;
      event.sender.send('upload-progress', {
        name: file.name, code, talla, tipo, url, status: 'done',
      });

    } catch (err) {
      results.errors.push({ name: file.name, error: err.message });
      event.sender.send('upload-progress', {
        name: file.name, status: 'error', error: err.message,
      });
    }
  }

  return results;
});

// ── IPC: Procesar y subir en un solo paso (sin carpeta de destino) ────────────
ipcMain.handle('process-and-upload', async (event, { files, formats }) => {
  console.log('[upload] handler iniciado, files:', files?.length);
  try {
    const pool       = getPool();
    const formatList = (formats && formats.length) ? formats : ['a4'];
    const FORMAT_OPTS = {
      a4:     { label: 'A4',      tileW: A4_W,     tileH: A4_H },
      letter: { label: 'Carta',   tileW: LETTER_W, tileH: LETTER_H },
      plotter:{ label: 'Plotter', tileW: null,      tileH: null },
    };

    const results = { uploaded: 0, errors: [] };
    const total   = files.length * formatList.length;
    let   done    = 0;

    // ── Función que tilea + sube un archivo×formato ───────────────────────────
    async function processOne(file, fmt, baseName, code, talla) {
      const { label, tileW, tileH } = FORMAT_OPTS[fmt];
      const tipo        = label === 'A4' ? 'A4' : label.toLowerCase();
      const pdfFileName = `${baseName} ${label}.pdf`;

      try {
        let pdfBuffer;

        console.log('[debug] procesando archivo:', file.name, 'formato:', fmt);
        if (fmt === 'plotter') {
          pdfBuffer = await fs.promises.readFile(file.path);
        } else {
          const paddingX   = file[`paddingX_${fmt}`] || 0;
          const paddingY   = file[`paddingY_${fmt}`] || 0;
          const taskResult = await pool.runAll([{
            type:        'tile-to-buffer',
            filePath:    file.path,
            name:        file.name,
            format:      label,
            formatKey:   fmt,
            pdfFileName,
            options: {
              tileWidth:   tileW,
              tileHeight:  tileH,
              paddingX,
              paddingY,
              formatLabel: label,
            },
          }]);
          if (!taskResult[0].ok) throw new Error(taskResult[0].error);
          pdfBuffer = Buffer.from(taskResult[0].pdfBytes);
        }
        console.log('[debug] pdfBuffer listo, tamaño:', pdfBuffer.length);

        const key = `pdfs/${code}-${talla}-${tipo}-${Date.now()}.pdf`;
        await s3.send(new PutObjectCommand({
          Bucket:      'moldes-facil',
          Key:         key,
          Body:        pdfBuffer,
          ACL:         'public-read',
          ContentType: 'application/pdf',
        }));
        const url = `https://moldes-facil.sfo3.cdn.digitaloceanspaces.com/${key}`;

        event.sender.send('upload-progress', { name: pdfFileName, code, talla, tipo, url, status: 'uploading' });

        let token    = await getValidToken();
        console.log('[token]', token.substring(0, 20));
        let response = await fetch(`${API_URL}/molds/upload-pdf`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body:    JSON.stringify({ code, talla, tipo, url: key }),
        });
        console.log('[api response]', response.status);
        if (response.status === 401) {
          _cachedToken = null;
          token        = await getValidToken();
          console.log('[token] renovado:', token.substring(0, 20));
          response     = await fetch(`${API_URL}/molds/upload-pdf`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body:    JSON.stringify({ code, talla, tipo, url: key }),
          });
          console.log('[api response] reintento:', response.status);
        }
        if (!response.ok) throw new Error(`API error: ${response.status}`);

        results.uploaded++;
        event.sender.send('upload-progress', { name: pdfFileName, code, talla, tipo, url, status: 'done' });

      } catch (err) {
        console.error('[error]', file.name, fmt, err.message);
        results.errors.push({ name: pdfFileName, error: err.message });
        event.sender.send('upload-progress', { name: pdfFileName, status: 'error', error: err.message });
      }

      done++;
      event.sender.send('process-upload-progress', { current: done, total, name: pdfFileName, status: 'done' });
    }

    // ── Construir lista de todas las tareas ───────────────────────────────────
    const tasks = [];
    for (const file of files) {
      const parsed = parseFileName(file.name.replace(/\.pdf$/i, ''));
      // Siempre usar nombre canónico en la salida: "T-{talla} molde {code}"
      const baseName = parsed ? normalizeOutputName(parsed.code, parsed.talla) : file.name.replace(/\.pdf$/i, '');
      if (!parsed) {
        for (const fmt of formatList) {
          results.errors.push({ name: file.name, error: 'Nombre no reconocido' });
          event.sender.send('upload-progress', { name: file.name, status: 'error', error: 'Nombre no reconocido' });
          done++;
          event.sender.send('process-upload-progress', { current: done, total, name: file.name, status: 'error' });
        }
        continue;
      }
      const { code, talla } = parsed;
      for (const fmt of formatList) {
        tasks.push({ file, fmt, baseName, code, talla });
      }
    }

    // ── Ejecutar todas las tareas en paralelo (máx. 4 simultáneas) ───────────
    const CONCURRENCY = 4;
    for (let i = 0; i < tasks.length; i += CONCURRENCY) {
      const batch = tasks.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(t => processOne(t.file, t.fmt, t.baseName, t.code, t.talla)));
    }

    // Persistir en historial de cargas local
    const histFile = path.join(app.getPath('userData'), 'upload-history.json');
    try {
      let hist = [];
      try { hist = JSON.parse(fs.readFileSync(histFile, 'utf8')); } catch {}
      hist.unshift({
        ts:       new Date().toISOString(),
        uploaded: results.uploaded,
        errors:   results.errors.length,
        files:    files.map(f => f.name),
      });
      fs.writeFileSync(histFile, JSON.stringify(hist.slice(0, 30)));
    } catch {}

    // Sincronizar a Google Sheets (sin bloquear la respuesta)
    const now   = new Date();
    const fecha = now.toLocaleDateString('es-CL');
    const hora  = now.toLocaleTimeString('es-CL');

    syncToSheets('Historial', [[
      fecha,
      hora,
      results.uploaded,
      results.errors.length,
      formatList.join(' + '),
      files.map(f => f.name).join(' | '),
    ]]).catch(() => {});

    if (results.errors.length) {
      const errorRows = results.errors.map(e => {
        const parsed = parseFileNameWithFormat(e.name.replace(/\.pdf$/i, '')) || {};
        return [fecha, hora, e.name, parsed.code || '—', parsed.talla || '—', parsed.tipo || '—', e.error];
      });
      syncToSheets('Errores', errorRows).catch(() => {});
    }

    // Intentar vaciar la cola offline ahora que hay actividad de red
    flushPendingQueue().catch(() => {});

    return results;
  } catch (err) {
    console.error('[upload] error global:', err);
    throw err;
  }
});


```

---

## `preload.js`

```javascript
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

```

---

## `sheets-sync.js`

```javascript
'use strict';

/**
 * sheets-sync.js — Sincronización con Google Sheets
 * Guarda historial, errores y validaciones en la nube.
 * Si no hay internet, encola los datos y sincroniza cuando vuelve la conexión.
 */

const { google } = require('googleapis');
const { app }    = require('electron');
const path       = require('path');
const fs         = require('fs');

const SPREADSHEET_ID = '1bVJ0rbMzYF1bHbbRdT8HBBRh7w3kw5sykvVM3SDyt0M';
const CREDS_PATH     = path.join(__dirname, 'config', 'gsheets-credentials.json');

const SHEET_NAMES = ['Historial', 'Errores', 'Validación'];

const HEADERS = {
  'Historial':  ['Fecha', 'Hora', 'Subidos OK', 'Con error', 'Formatos', 'Archivos'],
  'Errores':    ['Fecha', 'Hora', 'Archivo', 'Código', 'Talla', 'Formato', 'Error'],
  'Validación': ['Fecha', 'Hora', 'Código', 'Estado'],
};

// ── Cola offline ──────────────────────────────────────────────────────────────
function getQueuePath() {
  return path.join(app.getPath('userData'), 'sheets-queue.json');
}
function loadQueue() {
  try { return JSON.parse(fs.readFileSync(getQueuePath(), 'utf8')); }
  catch { return []; }
}
function saveQueue(q) {
  try { fs.writeFileSync(getQueuePath(), JSON.stringify(q)); } catch {}
}

// ── Autenticación ─────────────────────────────────────────────────────────────
function getAuth() {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheetsClient() {
  const auth = await getAuth().getClient();
  return google.sheets({ version: 'v4', auth });
}

// ── Inicialización de pestañas y cabeceras (se ejecuta una vez) ───────────────
let _initialized = false;

async function initSheets() {
  if (_initialized) return;
  const sheets = await getSheetsClient();

  // Obtener pestañas existentes
  const meta     = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existing = meta.data.sheets.map(s => s.properties.title);

  // Crear las pestañas que falten
  const toCreate = SHEET_NAMES.filter(n => !existing.includes(n));
  if (toCreate.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: toCreate.map(title => ({ addSheet: { properties: { title } } })),
      },
    });
  }

  // Agregar cabeceras si la fila A1 está vacía
  for (const name of SHEET_NAMES) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range:         `${name}!A1`,
    });
    if (!res.data.values?.[0]?.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId:    SPREADSHEET_ID,
        range:            `${name}!A1`,
        valueInputOption: 'RAW',
        requestBody:      { values: [HEADERS[name]] },
      });
    }
  }

  _initialized = true;
  console.log('[sheets] inicializado correctamente');
}

// ── Agregar filas a una pestaña ───────────────────────────────────────────────
async function appendRows(sheetName, rows) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId:    SPREADSHEET_ID,
    range:            `${sheetName}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody:      { values: rows },
  });
}

// ── API pública: sincronizar (con cola offline si falla) ──────────────────────
async function syncToSheets(sheetName, rows) {
  try {
    await initSheets();
    await appendRows(sheetName, rows);
    console.log(`[sheets] ✓ ${rows.length} fila(s) → "${sheetName}"`);
  } catch (err) {
    console.warn(`[sheets] sin conexión, encolando ${rows.length} fila(s):`, err.message);
    const q = loadQueue();
    q.push({ sheetName, rows, ts: new Date().toISOString() });
    saveQueue(q);
  }
}

// ── Vaciar cola pendiente (llamar al arrancar o al recuperar conexión) ─────────
async function flushPendingQueue() {
  const q = loadQueue();
  if (!q.length) return 0;

  console.log(`[sheets] vaciando ${q.length} item(s) pendiente(s)…`);
  const remaining = [];

  try {
    await initSheets();
  } catch {
    return q.length; // sigue sin conexión
  }

  for (const item of q) {
    try {
      await appendRows(item.sheetName, item.rows);
      console.log(`[sheets] ✓ flushed: "${item.sheetName}" (${item.rows.length} filas, encolado ${item.ts})`);
    } catch {
      remaining.push(item);
    }
  }

  saveQueue(remaining);
  const synced = q.length - remaining.length;
  if (synced > 0) console.log(`[sheets] ${synced} item(s) sincronizados, ${remaining.length} pendiente(s)`);
  return remaining.length;
}

// ── Tamaño de la cola (para mostrar en la UI) ─────────────────────────────────
function getQueueSize() {
  return loadQueue().length;
}

module.exports = { syncToSheets, flushPendingQueue, initSheets, getQueueSize };

```

---

## `tiler/pdfTilerEngine.js`

```javascript
/**
 * pdfTilerEngine.js — Motor vectorial plotter → A4 / Carta
 *
 * Estrategia de compresión:
 *  - El contenido fuente se incrusta UNA SOLA VEZ como Form XObject (embedPdf).
 *  - Cada página tile referencia ese XObject con un simple operador /Do + cm.
 *  - Se activa useObjectStreams:true al guardar → compresión de objetos PDF.
 *  - Resultado esperado: ~8-10× menos peso que copyPages.
 *
 * paddingX / paddingY desplazan el origen del grid (en puntos PDF) para que
 * los bordes de tile no coincidan con trazos del patrón. El molde nunca
 * cambia de tamaño ni se rasteriza.
 */

const { PDFDocument, PDFName, StandardFonts, rgb, degrees } = require('pdf-lib');

const PT_PER_MM        = 72 / 25.4;
const A4_W             = 210   * PT_PER_MM;   // ≈ 595.28 pt
const A4_H             = 297   * PT_PER_MM;   // ≈ 841.89 pt
const LETTER_W         = 215.9 * PT_PER_MM;   // ≈ 612.00 pt
const LETTER_H         = 279.4 * PT_PER_MM;   // ≈ 791.97 pt
const PLOTTER_WIDTH_PT = 90 * 10 * PT_PER_MM; // 90 cm en puntos ≈ 2551.18 pt
const AXIS_TOLERANCE   = 0.28;                 // ±28 % de tolerancia al detectar el eje de 90 cm

function colIndexToLabel(index) {
  let label = '', n = index;
  do { label = String.fromCharCode(65 + (n % 26)) + label; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return label;
}

/**
 * Detecta cuál dimensión del PDF corresponde al ancho del plotter (90 cm).
 * Si la altura es más cercana a 90 cm que el ancho, el PDF está en landscape
 * y necesita rotación 90° CCW para que el eje de 90 cm quede horizontal.
 *
 * Devuelve:
 *   needsRotation {boolean} — true si la altura es el eje de 90 cm
 *   plotterW      {number}  — dimensión de 90 cm (eje horizontal del grid)
 *   plotterH      {number}  — dimensión larga (eje vertical del grid, filas)
 */
function detectPlotterAxis(srcW, srcH) {
  const wDiff = Math.abs(srcW - PLOTTER_WIDTH_PT) / PLOTTER_WIDTH_PT;
  const hDiff = Math.abs(srcH - PLOTTER_WIDTH_PT) / PLOTTER_WIDTH_PT;
  if (hDiff < wDiff && hDiff <= AXIS_TOLERANCE) {
    return { needsRotation: true,  plotterW: srcH, plotterH: srcW };
  }
  return { needsRotation: false, plotterW: srcW, plotterH: srcH };
}

async function detectDimensions(sourceBuffer) {
  const srcDoc = await PDFDocument.load(sourceBuffer, { ignoreEncryption: true });
  const pages  = srcDoc.getPages();
  if (!pages.length) throw new Error('PDF sin páginas');
  const { width, height } = pages[0].getSize();
  let userUnit = 1;
  try {
    const uu = pages[0].node.get(PDFName.of('UserUnit'));
    if (uu && typeof uu.asNumber === 'function') userUnit = uu.asNumber();
  } catch {}
  const realW = width * userUnit, realH = height * userUnit;
  const widthMm = Math.round(realW / PT_PER_MM), heightMm = Math.round(realH / PT_PER_MM);
  const { needsRotation, plotterW, plotterH } = detectPlotterAxis(realW, realH);
  const cols = Math.ceil(plotterW / A4_W), rows = Math.ceil(plotterH / A4_H);
  return { widthPt: realW, heightPt: realH, widthMm, heightMm,
           widthCm: Math.round(widthMm/10), heightCm: Math.round(heightMm/10),
           pageCount: pages.length, cols, rows, totalTiles: cols * rows, needsRotation };
}

/**
 * Divide un PDF plotter en mosaicos a escala 1:1.
 *
 * El contenido fuente se incrusta como Form XObject (una copia),
 * y cada tile lo referencia con drawPage + desplazamiento.
 * Esto reduce drásticamente el tamaño vs. copiar la página N veces.
 *
 * @param {Buffer} sourceBuffer
 * @param {object} options
 *   tileWidth  {number}  Ancho tile en pt   (default A4_W)
 *   tileHeight {number}  Alto tile en pt    (default A4_H)
 *   addMarks   {boolean} Cruces de registro (default true)
 *   addLabels  {boolean} Etiquetas A1,B2…   (default true)
 *   paddingX   {number}  Margen izq. extra en pt
 *   paddingY   {number}  Margen sup. extra en pt
 */
async function tilePDF(sourceBuffer, options = {}) {
  const {
    tileWidth   = A4_W,
    tileHeight  = A4_H,
    addMarks    = true,
    addLabels   = true,
    paddingX    = 0,
    paddingY    = 0,
    formatLabel = '',
  } = options;

  // Leer dimensiones del fuente
  const srcDoc = await PDFDocument.load(sourceBuffer, { ignoreEncryption: true });
  const pages  = srcDoc.getPages();
  if (!pages.length) throw new Error('PDF sin páginas');
  const { width: srcW, height: srcH } = pages[0].getSize();

  let userUnit = 1;
  try {
    const uu = pages[0].node.get(PDFName.of('UserUnit'));
    if (uu && typeof uu.asNumber === 'function') userUnit = uu.asNumber();
  } catch {}
  const realSrcW = srcW * userUnit;
  const realSrcH = srcH * userUnit;

  // Detectar qué eje corresponde a los 90 cm del plotter para usarlo como horizontal
  const { needsRotation, plotterW, plotterH } = detectPlotterAxis(realSrcW, realSrcH);

  // plotterW = eje de 90 cm → columnas (A1-A5)
  // plotterH = eje largo   → filas    (A, B, C…)
  const cols = Math.ceil((plotterW + paddingX) / tileWidth);
  const rows = Math.ceil((plotterH + paddingY) / tileHeight);

  // Sin skip de filas/columnas iniciales: el patrón siempre comienza en A1
  // paddingX/paddingY son microajustes internos, no desplazan el inicio del grid.

  const outDoc    = await PDFDocument.create();
  const fontBold  = await outDoc.embedFont(StandardFonts.HelveticaBold);
  const fontLight = await outDoc.embedFont(StandardFonts.Helvetica);

  // ── Incrustar el PDF fuente como Form XObject (UNA SOLA VEZ) ─────────────
  const [embeddedPage] = await outDoc.embedPdf(sourceBuffer, [0]);

  // ── Generar páginas tile ──────────────────────────────────────────────────
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {

      const tilePage = outDoc.addPage([tileWidth, tileHeight]);

      if (!needsRotation) {
        // ── Caso normal: ancho del PDF ≈ 90 cm (portrait plotter) ──────────
        // dx/dy desplazan el fuente para que la región (col,row) quede en [0,0].
        const dx = -(col * tileWidth  - paddingX);
        const dy = -((rows - 1 - row) * tileHeight - paddingY);
        tilePage.drawPage(embeddedPage, {
          x: dx, y: dy,
          width: realSrcW, height: realSrcH,
        });
      } else {
        // ── Caso landscape: altura del PDF ≈ 90 cm → rotar 90° CCW ─────────
        // Tras rotar 90° CCW con ancla (ax, ay), un punto (px, py) del fuente
        // queda en tile: (ax - py, ay + px).
        // El eje de 90 cm (realSrcH) pasa a ser el eje X del tile (columnas);
        // el eje largo (realSrcW) pasa a ser el eje Y (filas).
        const ax = realSrcH - col * tileWidth  + paddingX;
        const ay = -((rows - 1 - row) * tileHeight - paddingY);
        tilePage.drawPage(embeddedPage, {
          x: ax, y: ay,
          width: realSrcW, height: realSrcH,
          rotate: degrees(90),
        });
      }

      if (!addLabels && !addMarks) continue;

      // Convención: LETRA = fila (A, B, C…), NÚMERO = columna (1…5)
      const tileId    = `${colIndexToLabel(row)}${col + 1}`;
      const labelSize = 20;

      if (addLabels) {
        const lw = fontBold.widthOfTextAtSize(tileId, labelSize);
        tilePage.drawText(tileId, {
          x: tileWidth / 2 - lw / 2,
          y: tileHeight - 24,
          size: labelSize, font: fontBold, color: rgb(0.2, 0.2, 0.2),
        });
        tilePage.drawText(`${cols} × ${rows}`, {
          x: 5,
          y: tileHeight - 13,
          size: 9, font: fontLight, color: rgb(0.65, 0.65, 0.65),
        });
        if (formatLabel) {
          const fw = fontLight.widthOfTextAtSize(formatLabel, 35);
          tilePage.drawText(formatLabel, {
            x:       tileWidth  / 2 - fw / 2,
            y:       tileHeight / 2 - 35 / 2,
            size:    35, font: fontLight, color: rgb(0.6, 0.6, 0.6),
            opacity: 0.25,
          });
        }
      }

      if (addMarks) {
        const CS = 7, CO = 5, TL = 6;
        const gray = rgb(0.45, 0.45, 0.45), black = rgb(0, 0, 0);

        for (const [cx, cy] of [
          [CO,           CO          ],
          [tileWidth-CO, CO          ],
          [CO,           tileHeight-CO],
          [tileWidth-CO, tileHeight-CO],
        ]) {
          tilePage.drawLine({ start:{x:cx-CS/2,y:cy}, end:{x:cx+CS/2,y:cy}, thickness:0.5, color:black });
          tilePage.drawLine({ start:{x:cx,y:cy-CS/2}, end:{x:cx,y:cy+CS/2}, thickness:0.5, color:black });
        }

        const mx = tileWidth / 2, my = tileHeight / 2;
        tilePage.drawLine({ start:{x:mx, y:0           }, end:{x:mx,          y:TL           }, thickness:0.4, color:gray });
        tilePage.drawLine({ start:{x:mx, y:tileHeight  }, end:{x:mx,          y:tileHeight-TL}, thickness:0.4, color:gray });
        tilePage.drawLine({ start:{x:0,  y:my          }, end:{x:TL,          y:my           }, thickness:0.4, color:gray });
        tilePage.drawLine({ start:{x:tileWidth, y:my   }, end:{x:tileWidth-TL,y:my           }, thickness:0.4, color:gray });
      }
    }
  }

  // ── Guardar con object streams activos (compresión adicional) ─────────────
  const pdfBytes = await outDoc.save({ useObjectStreams: true });

  return {
    pdfBytes,
    cols, rows, totalPages: cols * rows,
    srcWidthPt: realSrcW, srcHeightPt: realSrcH,
    srcWidthMm: Math.round(realSrcW/PT_PER_MM), srcHeightMm: Math.round(realSrcH/PT_PER_MM),
    needsRotation,
  };
}

module.exports = { tilePDF, detectDimensions, A4_W, A4_H, LETTER_W, LETTER_H, PT_PER_MM };

```

---

## `tiler/pdfWorker.js`

```javascript
/**
 * pdfWorker.js — Worker persistente para operaciones PDF paralelas
 *
 * Recibe tareas via parentPort.on('message') y responde con el resultado.
 * Cada worker vive mientras dure la app; el pool lo reutiliza para múltiples tareas.
 *
 * Tipos de tarea:
 *   { type: 'detect', taskId, filePath, name }
 *   { type: 'tile',   taskId, filePath, name, options, outputPath, destFolder,
 *                     pdfFileName, format, formatKey, skipIfExists }
 */

'use strict';

const { parentPort } = require('worker_threads');
const { tilePDF, detectDimensions } = require('./pdfTilerEngine');
const fs   = require('fs');

parentPort.on('message', async (task) => {
  const { taskId, type, name } = task;

  try {
    // ── Detectar dimensiones ──────────────────────────────────────────────────
    if (type === 'detect') {
      const buffer = await fs.promises.readFile(task.filePath);
      const dims   = await detectDimensions(buffer);

      parentPort.postMessage({
        taskId,
        ok:         true,
        type:       'detect',
        path:       task.filePath,
        name,
        sourceSize: buffer.length,
        ...dims,
      });

    // ── Tilear y guardar ──────────────────────────────────────────────────────
    } else if (type === 'tile-to-buffer') {
      const buffer = await fs.promises.readFile(task.filePath);
      const result = await tilePDF(buffer, task.options);

      parentPort.postMessage({
        taskId,
        ok:          true,
        type:        'tile-to-buffer',
        name,
        pdfFileName: task.pdfFileName,
        format:      task.format,
        formatKey:   task.formatKey,
        pdfBytes:    result.pdfBytes,
        cols:        result.cols,
        rows:        result.rows,
      }, [result.pdfBytes.buffer]);

    } else if (type === 'tile') {

      // Skip si el archivo de salida ya existe (evita reprocesar lotes ya exportados)
      if (task.skipIfExists && fs.existsSync(task.outputPath)) {
        parentPort.postMessage({
          taskId,
          ok:          true,
          type:        'tile',
          skipped:     true,
          name,
          format:      task.format,
          formatKey:   task.formatKey,
          outputPath:  task.outputPath,
          destFolder:  task.destFolder,
          pdfFileName: task.pdfFileName,
        });
        return;
      }

      const buffer = await fs.promises.readFile(task.filePath);
      const result = await tilePDF(buffer, task.options);

      // El worker escribe el archivo directamente:
      // evita transferir los bytes del PDF por IPC (potencialmente varios MB)
      await fs.promises.writeFile(task.outputPath, result.pdfBytes);

      parentPort.postMessage({
        taskId,
        ok:          true,
        type:        'tile',
        skipped:     false,
        name,
        pdfFileName: task.pdfFileName,
        format:      task.format,
        formatKey:   task.formatKey,
        outputPath:  task.outputPath,
        destFolder:  task.destFolder,
        cols:        result.cols,
        rows:        result.rows,
        totalPages:  result.totalPages,
        srcWidthMm:  result.srcWidthMm,
        srcHeightMm: result.srcHeightMm,
        outputSize:  result.pdfBytes.length,
      });
    }

  } catch (err) {
    parentPort.postMessage({
      taskId,
      ok:        false,
      type,
      path:      task.filePath,
      name,
      error:     err.message,
      format:    task.format,
      formatKey: task.formatKey,
    });
  }
});

```

---

## `tiler/workerPool.js`

```javascript
/**
 * workerPool.js — Pool de workers persistentes para operaciones PDF paralelas
 *
 * Crea N workers al inicio y los reutiliza para todas las tareas.
 * Las tareas que llegan cuando todos los workers están ocupados se encolan
 * y se despachan en cuanto un worker queda libre.
 *
 * En MacBook Air M1 (8 núcleos: 4 performance + 4 efficiency) se usan 4 workers,
 * dejando los efficiency cores para la UI de Electron y el sistema operativo.
 */

'use strict';

const { Worker } = require('worker_threads');
const os         = require('os');

class WorkerPool {
  /**
   * @param {string} workerPath  Ruta absoluta al script del worker
   * @param {number} [poolSize]  Número de workers (default: min(4, cpus-1))
   */
  constructor(workerPath, poolSize) {
    this._path    = workerPath;
    this._size    = poolSize ?? Math.min(4, Math.max(1, os.cpus().length - 1));
    this._workers = [];
    this._queue   = [];          // { task, resolve, onDone }
    this._pending = new Map();   // taskId → { resolve, onDone }
    this._taskSeq = 0;

    for (let i = 0; i < this._size; i++) this._spawn();
  }

  // ── Crear un worker y registrar sus handlers ─────────────────────────────────
  _spawn() {
    const w = new Worker(this._path);
    w._busy   = false;
    w._taskId = null;

    w.on('message', (msg) => {
      const p = this._pending.get(msg.taskId);
      if (p) {
        this._pending.delete(msg.taskId);
        if (p.onDone) p.onDone(msg);   // callback de progreso (opcional)
        p.resolve(msg);                 // resuelve la Promise del caller
      }
      w._busy   = false;
      w._taskId = null;
      this._drain();
    });

    w.on('error', (err) => {
      // Si el worker crasheó, resolver su tarea pendiente como error
      if (w._taskId !== null) {
        const p = this._pending.get(w._taskId);
        if (p) {
          this._pending.delete(w._taskId);
          p.resolve({ ok: false, taskId: w._taskId, error: err.message });
        }
      }
      w._busy   = false;
      w._taskId = null;

      // Reemplazar el worker caído por uno nuevo
      this._workers.splice(this._workers.indexOf(w), 1);
      this._spawn();
      this._drain();
    });

    this._workers.push(w);
  }

  // ── Despachar la siguiente tarea encolada al primer worker libre ─────────────
  _drain() {
    if (!this._queue.length) return;
    const free = this._workers.find(w => !w._busy);
    if (!free) return;
    const { task, resolve, onDone } = this._queue.shift();
    this._dispatch(free, task, resolve, onDone);
  }

  _dispatch(worker, task, resolve, onDone) {
    worker._busy   = true;
    worker._taskId = task.taskId;
    this._pending.set(task.taskId, { resolve, onDone });
    worker.postMessage(task);
  }

  // ── API pública ──────────────────────────────────────────────────────────────

  /**
   * Ejecuta una tarea en el pool.
   * @param {object}    task    Objeto con al menos { type }. Se le agrega taskId.
   * @param {Function}  [onDone] Callback llamado cuando la tarea termina (antes de resolver)
   * @returns {Promise<object>} Resultado de la tarea
   */
  run(task, onDone) {
    return new Promise((resolve) => {
      task.taskId = ++this._taskSeq;
      const free  = this._workers.find(w => !w._busy);
      if (free) {
        this._dispatch(free, task, resolve, onDone);
      } else {
        this._queue.push({ task, resolve, onDone });
      }
    });
  }

  /**
   * Ejecuta todas las tareas en paralelo (limitado por el tamaño del pool).
   * @param {object[]}  tasks
   * @param {Function}  [onDone] Callback llamado por cada tarea que termina
   * @returns {Promise<object[]>} Resultados en el mismo orden que tasks
   */
  runAll(tasks, onDone) {
    return Promise.all(tasks.map(task => this.run(task, onDone)));
  }

  /** Termina todos los workers y vacía las colas. */
  terminate() {
    for (const w of this._workers) w.terminate();
    this._workers = [];
    this._queue   = [];
    this._pending.clear();
  }

  get size() { return this._size; }
}

module.exports = WorkerPool;

```

---

## `renderer/login.html`

```html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Moldes Fácil — Tiler</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --brand: #5b3cdc;
      --brand-dark: #3f2aaa;
      --bg: #f4f4f8;
      --surface: #ffffff;
      --border: #e0e0ea;
      --text: #1a1a2e;
      --text-muted: #6b6b80;
      --error: #ef4444;
      --radius: 10px;
    }
    html, body {
      height: 100%; margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      background: var(--bg);
      display: flex; align-items: center; justify-content: center;
      -webkit-app-region: drag;
    }
    .card {
      background: var(--surface);
      border-radius: 16px;
      box-shadow: 0 8px 32px rgba(0,0,0,.12);
      padding: 48px 40px 40px;
      width: 340px;
      -webkit-app-region: no-drag;
    }
    .logo {
      text-align: center;
      margin-bottom: 32px;
    }
    .logo-icon { font-size: 44px; line-height: 1; }
    .logo-title {
      font-size: 20px; font-weight: 700;
      color: var(--brand); margin-top: 10px;
    }
    .logo-sub {
      font-size: 12px; color: var(--text-muted); margin-top: 4px;
    }
    label {
      display: block; font-size: 13px; font-weight: 600;
      color: var(--text); margin-bottom: 8px;
    }
    input[type="password"] {
      width: 100%; padding: 10px 14px;
      border: 1.5px solid var(--border); border-radius: 8px;
      font-size: 14px; color: var(--text);
      outline: none; transition: border-color .15s;
    }
    input[type="password"]:focus { border-color: var(--brand); }
    input[type="password"].error { border-color: var(--error); }
    .error-msg {
      font-size: 12px; color: var(--error);
      margin-top: 6px; min-height: 16px;
    }
    button {
      width: 100%; margin-top: 20px;
      padding: 12px; border: none; border-radius: 8px;
      background: var(--brand); color: #fff;
      font-size: 15px; font-weight: 600; cursor: pointer;
      transition: background .15s;
    }
    button:hover  { background: var(--brand-dark); }
    button:active { opacity: .85; }
    button:disabled { opacity: .5; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <div class="logo-icon">✂️</div>
      <div class="logo-title">Moldes Fácil Tiler</div>
      <div class="logo-sub">Herramienta interna de producción</div>
    </div>

    <label for="emailInput">Correo electrónico</label>
    <input type="email" id="emailInput" placeholder="correo@moldesfacil.cl" autocomplete="email" style="width:100%;padding:10px 14px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;color:var(--text);outline:none;transition:border-color .15s;margin-bottom:16px;" />

    <label for="keyInput">Clave de acceso</label>
    <div style="position:relative;">
      <input type="password" id="keyInput" placeholder="Ingresá la clave" autocomplete="current-password" style="padding-right:40px;" />
      <button id="btnTogglePass" type="button" tabindex="-1" title="Mostrar/ocultar clave"
        style="position:absolute;right:0;top:0;bottom:0;width:38px;background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:16px;display:flex;align-items:center;justify-content:center;margin-top:0;padding:0;">
        👁
      </button>
    </div>
    <label style="display:flex;align-items:center;gap:8px;font-weight:400;font-size:13px;color:var(--text-muted);margin-top:10px;cursor:pointer;">
      <input type="checkbox" id="chkRemember" style="width:15px;height:15px;accent-color:var(--brand);cursor:pointer;" />
      Recordar correo
    </label>
    <div class="error-msg" id="errorMsg"></div>
    <button id="btnLogin">Ingresar</button>
  </div>

  <script>
    const emailInput    = document.getElementById('emailInput');
    const keyInput      = document.getElementById('keyInput');
    const btnLogin      = document.getElementById('btnLogin');
    const errorMsg      = document.getElementById('errorMsg');
    const btnTogglePass = document.getElementById('btnTogglePass');
    const chkRemember   = document.getElementById('chkRemember');

    // Recuperar correo guardado al cargar
    const savedEmail = localStorage.getItem('rememberedEmail');
    if (savedEmail) {
      emailInput.value    = savedEmail;
      chkRemember.checked = true;
      keyInput.focus();
    }

    btnTogglePass.addEventListener('click', () => {
      const showing = keyInput.type === 'text';
      keyInput.type = showing ? 'password' : 'text';
      btnTogglePass.textContent = showing ? '👁' : '🙈';
      keyInput.focus();
    });

    async function tryLogin() {
      const email = emailInput.value.trim();
      const key   = keyInput.value.trim();
      if (!email || !key) return;

      btnLogin.disabled = true;
      btnLogin.textContent = 'Verificando…';
      [emailInput, keyInput].forEach(el => el.classList.remove('error'));
      errorMsg.textContent = '';

      const result = await window.tilerAPI.verifyAccessKey(email, key);

      if (!result.ok) {
        [emailInput, keyInput].forEach(el => el.classList.add('error'));
        errorMsg.textContent = 'Correo o clave incorrectos. Intentá de nuevo.';
        btnLogin.disabled = false;
        btnLogin.textContent = 'Ingresar';
        keyInput.select();
      } else {
        // Guardar o borrar el correo según la preferencia
        if (chkRemember.checked) {
          localStorage.setItem('rememberedEmail', email);
        } else {
          localStorage.removeItem('rememberedEmail');
        }
      }
      // Si ok: main.js navega a index.html automáticamente
    }

    btnLogin.addEventListener('click', tryLogin);
    keyInput.addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });
    emailInput.addEventListener('keydown', e => { if (e.key === 'Enter') keyInput.focus(); });
    emailInput.focus();
  </script>
</body>
</html>

```

---

## `renderer/index.html`

```html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Moldes Fácil — Tiler Plotter → A4</title>
  <link rel="stylesheet" href="styles.css" />
  <!-- pdfjs para renderizar preview del PDF (sin rasterizar el output final) -->
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
</head>
<body>

  <!-- ── Header ─────────────────────────────────────────────────────────── -->
  <header class="app-header">
    <div class="header-brand">
      <span class="header-logo">✂</span>
      <div>
        <span class="header-title">Moldes Fácil</span>
        <span class="header-subtitle">Tiler Plotter → A4</span>
      </div>
    </div>
    <div class="header-hint" id="headerHint">
      Arrastrá PDFs o carpetas para empezar
    </div>
    <button id="btnLogout" title="Cerrar sesión" style="-webkit-app-region:no-drag;background:rgba(255,255,255,0.15);border:none;color:#fff;padding:6px 12px;border-radius:6px;font-size:12px;cursor:pointer;transition:background .15s;" onmouseover="this.style.background='rgba(255,255,255,0.28)'" onmouseout="this.style.background='rgba(255,255,255,0.15)'">
      Cerrar sesión
    </button>
  </header>

  <!-- Modal de advertencia de inactividad -->
  <div id="inactivityModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;align-items:center;justify-content:center;">
    <div style="background:#fff;border-radius:14px;padding:32px 36px;max-width:340px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.2);">
      <div style="font-size:36px;margin-bottom:12px;">⏰</div>
      <p style="font-weight:700;font-size:16px;margin-bottom:8px;">¿Seguís ahí?</p>
      <p style="font-size:13px;color:#666;margin-bottom:24px;">La sesión se cerrará en <b id="inactivityCountdown">60</b> segundos por inactividad.</p>
      <button id="btnStayActive" style="background:#5b3cdc;color:#fff;border:none;padding:10px 28px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;width:100%;">
        Continuar sesión
      </button>
    </div>
  </div>

  <!-- ── Contenido principal ────────────────────────────────────────────── -->
  <main class="app-main">

    <!-- Panel izquierdo: drop zone + lista de archivos -->
    <section class="panel panel-left">

      <!-- Zona superior: drop zone + miniatura del plotter -->
      <div class="top-zone">

        <!-- Drop zone -->
        <div class="drop-zone" id="dropZone">
          <div class="drop-icon">📂</div>
          <p class="drop-primary">Arrastrá la carpeta de moldes aquí</p>
          <p class="drop-secondary">O usá el botón para buscarla en tu computadora</p>
          <button class="btn btn-outline" id="btnSelectInputFolder">
            📁 Seleccionar carpeta de moldes
          </button>
          <button class="btn btn-ghost btn-sm" id="btnSelectFiles" style="margin-top:6px;font-size:12px">
            o elegir archivos individuales
          </button>
          <input type="file" id="fileInput" accept=".pdf" multiple style="display:none" />

          <!-- Overlay de carga (visible mientras se leen archivos desde disco/Drive) -->
          <div id="dropZoneLoading" style="display:none; position:absolute; inset:0; background:rgba(255,255,255,0.88); border-radius:inherit; display:none; flex-direction:column; align-items:center; justify-content:center; gap:12px; z-index:10;">
            <div class="preview-spinner"></div>
            <p id="dropZoneLoadingMsg" style="font-size:13px; color:#555; margin:0; font-weight:500;">Leyendo archivos…</p>
            <div style="width:200px; height:6px; background:#e0e0e0; border-radius:3px; overflow:hidden;">
              <div id="dropZoneProgressBar" style="height:100%; width:0%; background:#4a7aff; border-radius:3px; transition:width 0.3s ease;"></div>
            </div>
          </div>
        </div>

        <!-- Panel miniatura del plotter -->
        <div class="plotter-thumb-panel" id="plotterThumbPanel">
          <div class="thumb-panel-header">
            <span class="thumb-panel-title">Vista plotter</span>
            <div class="thumb-nav" id="thumbNav" style="display:none">
              <button class="thumb-nav-btn" id="btnThumbPrev">‹</button>
              <span class="thumb-nav-label" id="thumbNavLabel">1/1</span>
              <button class="thumb-nav-btn" id="btnThumbNext">›</button>
            </div>
          </div>
          <div class="thumb-canvas-area" id="thumbCanvasArea">
            <div class="thumb-canvas-wrap" id="thumbCanvasWrap">
              <canvas id="thumbCanvas"></canvas>
              <canvas id="thumbGridCanvas" style="position:absolute;top:0;left:0;pointer-events:none;"></canvas>
            </div>
            <div class="thumb-placeholder" id="thumbPlaceholder">
              <div class="thumb-placeholder-icon">📐</div>
              <p>Cargá un archivo<br>para previsualizar</p>
            </div>
            <div class="thumb-loading" id="thumbLoading" style="display:none">
              <div class="preview-spinner"></div>
            </div>
          </div>
          <div class="thumb-info" id="thumbInfo"></div>
          <div class="thumb-legend">
            <span class="thumb-legend-a4">━ A4</span>
            <span class="thumb-legend-letter">━ Carta</span>
          </div>
        </div>

      </div><!-- /.top-zone -->

      <!-- Tabla de archivos -->
      <div class="file-section" id="fileSection" style="display:none">

        <div class="file-section-header">
          <h2 class="section-title">Archivos cargados</h2>
          <div class="file-header-actions">
            <button class="btn btn-smart btn-sm" id="btnBatchAutoAdjust" title="Auto-ajusta el grid para todos los archivos cargados y guarda los ajustes automáticamente">
              ✨ AutoAjustar todos
            </button>
            <button class="btn btn-ghost btn-sm" id="btnClearAll">Limpiar todo</button>
          </div>
        </div>

        <div class="file-table-wrapper">
          <table class="file-table">
            <thead>
              <tr>
                <th class="th-chk"><input type="checkbox" id="chkSelectAll" title="Seleccionar todos" /></th>
                <th>Archivo</th>
                <th>Dimensiones</th>
                <th id="thGridLabel">Grid A4</th>
                <th>Peso</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="fileTableBody">
              <!-- filas dinámicas -->
            </tbody>
          </table>
        </div>

        <div class="file-summary" id="fileSummary"></div>
      </div>

    </section>

    <!-- Panel derecho: configuración + acción -->
    <section class="panel panel-right">

      <h2 class="section-title">Configuración</h2>

      <!-- Formato de hoja de salida -->
      <div class="config-group">
        <label class="config-label">Formato de hoja de salida</label>
        <label class="toggle-row">
          <input type="checkbox" id="chkFormatA4" checked />
          <span class="toggle-label">
            <span class="format-badge">A4</span>
            <span class="format-dims">210 × 297 mm</span>
          </span>
        </label>
        <label class="toggle-row">
          <input type="checkbox" id="chkFormatLetter" />
          <span class="toggle-label">
            <span class="format-badge">Carta</span>
            <span class="format-dims">215.9 × 279.4 mm</span>
          </span>
        </label>
        <label class="toggle-row">
          <input type="checkbox" id="chkFormatPlotter" />
          <span class="toggle-label">
            <span class="format-badge">Plotter</span>
            <span class="format-dims">Archivo original sin procesar</span>
          </span>
        </label>
        <p class="config-hint">El patrón se divide en hojas exactas a escala 1:1, sin reescalado. Podés generar ambos formatos a la vez.</p>
      </div>

      <!-- Marcas y etiquetas -->
      <div class="config-group">
        <label class="config-label">Marcas de ensamblaje</label>
        <label class="toggle-row">
          <input type="checkbox" id="chkMarks" checked />
          <span class="toggle-label">Cruces de registro en esquinas</span>
        </label>
        <label class="toggle-row">
          <input type="checkbox" id="chkLabels" checked />
          <span class="toggle-label">Etiquetas de cuadrícula (A1, B2…)</span>
        </label>
        <p class="config-hint">Las marcas se ubican en los márgenes, fuera del área del patrón.</p>
      </div>

      <!-- Omitir archivos ya exportados -->
      <div class="config-group">
        <label class="config-label">Opciones de procesamiento</label>
        <label class="toggle-row">
          <input type="checkbox" id="chkSkipExisting" />
          <span class="toggle-label">Omitir archivos ya exportados</span>
        </label>
        <p class="config-hint">Si el PDF de salida ya existe en la carpeta destino, no lo regenera. Útil para reanudar lotes interrumpidos.</p>
      </div>

      <!-- Carpeta de destino -->
      <div class="config-group">
        <label class="config-label">Carpeta de destino</label>
        <div class="folder-row">
          <span class="folder-path" id="folderPath">Sin seleccionar</span>
          <button class="btn btn-outline btn-sm" id="btnSelectFolder">Elegir…</button>
        </div>
        <p class="config-hint" id="destFormatHint">Los PDFs se guardan como <em id="destFormatName">nombre_A4.pdf</em> en la carpeta elegida.</p>
      </div>

      <!-- Botones de acción -->
      <div class="action-section">
        <button class="btn btn-primary btn-lg" id="btnProcess" disabled>
          <span id="btnProcessText">⬇ Descargar seleccionados</span>
        </button>
        <button class="btn btn-outline btn-lg" id="btnProcessAll" disabled>
          ⬇ Descargar todos
        </button>

        <!-- Panel conexión con sitio web -->
        <div id="uploadPanel" style="margin-top:12px;">
          <div class="config-group">
            <input type="text"     id="apiUrl"   style="display:none;" />
            <input type="password" id="apiToken" style="display:none;" />
            <button id="btnUploadToSite" class="btn-primary" style="width:100%;">
              ☁️ Cargar al sitio
            </button>
            <div id="uploadStatus" style="margin-top:8px; font-size:12px; color:#666;"></div>
            <button id="btnRetryErrors" style="display:none;margin-top:8px;width:100%;padding:7px;border:1.5px solid #e67e22;background:#fff;color:#e67e22;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">
              🔁 Reintentar archivos con error
            </button>
            <button id="btnDownloadErrorLog" style="display:none;margin-top:6px;width:100%;padding:7px;border:1.5px solid #c0392b;background:#fff;color:#c0392b;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">
              ⬇️ Descargar reporte de errores
            </button>
          </div>

          <!-- Historial de cargas -->
          <details id="historyPanel" style="margin-top:10px;">
            <summary style="font-size:12px;font-weight:600;color:#5b3cdc;cursor:pointer;user-select:none;list-style:none;display:flex;align-items:center;gap:4px;">
              <span id="historyArrow" style="transition:transform .2s;display:inline-block;">▶</span>
              📋 Historial de cargas
            </summary>
            <div id="historyList" style="margin-top:8px;font-size:11px;color:#555;max-height:180px;overflow-y:auto;border-top:1px solid #eee;padding-top:6px;"></div>
          </details>
        </div>

        <p class="action-hint" id="actionHint">Cargá al menos un PDF para continuar</p>
      </div>

      <!-- Barra de progreso -->
      <div class="progress-section" id="progressSection" style="display:none">
        <div class="progress-bar-track">
          <div class="progress-bar-fill" id="progressFill"></div>
        </div>
        <p class="progress-label" id="progressLabel">Preparando…</p>
      </div>

      <!-- Resultados -->
      <div class="results-section" id="resultsSection" style="display:none">
        <div class="results-header">
          <span class="results-icon" id="resultsIcon">✅</span>
          <span class="results-title" id="resultsTitle">Proceso completado</span>
        </div>
        <div class="results-list" id="resultsList"></div>
        <button class="btn btn-outline btn-sm" id="btnOpenFolder" style="display:none">
          Abrir carpeta de destino
        </button>
      </div>

    </section>
  </main>

  <!-- ── Modal de previsualización ──────────────────────────────────────── -->
  <div class="preview-overlay" id="previewOverlay" style="display:none">
    <div class="preview-modal">

      <!-- Header del modal -->
      <div class="preview-modal-header">
        <div class="preview-modal-title">
          <span class="preview-title-icon">🔍</span>
          <span id="previewFileName">Previsualización</span>
        </div>
        <div class="preview-controls">
          <button class="btn btn-ghost btn-sm" id="btnZoomOut" title="Reducir">−</button>
          <span class="zoom-level" id="zoomLabel">100%</span>
          <button class="btn btn-ghost btn-sm" id="btnZoomIn"  title="Ampliar">+</button>
          <button class="btn btn-ghost btn-sm" id="btnZoomFit" title="Ajustar">↔</button>
          <button class="preview-close-btn" id="btnClosePreview" title="Cerrar">✕</button>
        </div>
      </div>

      <!-- Info del grid + sliders de ajuste en tiempo real -->
      <div class="preview-grid-info" id="previewGridInfo">
        <span class="preview-format-toggle">
          <button class="fmt-btn active" id="previewFmtA4">A4</button>
          <button class="fmt-btn" id="previewFmtLetter">Carta</button>
        </span>
        <span id="previewGridText"></span>
        <span class="preview-sliders">
          <span class="preview-slider-item">
            ↔
            <input type="range" id="previewSliderX" min="0" max="200" value="0" step="1" style="width:90px;vertical-align:middle" />
            <span id="previewValX" class="slider-value-sm">0 mm</span>
          </span>
          <span class="preview-slider-item">
            ↕
            <input type="range" id="previewSliderY" min="0" max="290" value="0" step="1" style="width:90px;vertical-align:middle" />
            <span id="previewValY" class="slider-value-sm">0 mm</span>
          </span>
          <span class="preview-slider-hint">Ajustá los bordes de tile para evitar zonas críticas</span>
          <button class="btn-auto-adjust" id="btnAutoAdjust" title="Detecta automáticamente el mejor offset del grid">
            ✨ Auto-ajustar
          </button>
        </span>
      </div>

      <!-- Área de canvas con scroll -->
      <div class="preview-canvas-area" id="previewCanvasArea">
        <div class="preview-canvas-wrapper" id="previewCanvasWrapper">
          <canvas id="previewCanvas"></canvas>
          <!-- Grid overlay con etiquetas (divs absolutos) -->
          <div class="preview-grid-overlay" id="previewGridOverlay"></div>
        </div>
        <!-- Spinner mientras carga -->
        <div class="preview-loading" id="previewLoading">
          <div class="preview-spinner"></div>
          <p>Renderizando patrón…</p>
        </div>
      </div>

      <!-- Footer: guardar ajuste -->
      <div class="preview-footer">
        <span class="preview-padding-info" id="previewPaddingInfo">Ajuste actual: 0 mm × 0 mm</span>
        <button class="btn btn-primary btn-sm" id="btnSaveAdjust">
          💾 Guardar ajuste para este molde
        </button>
      </div>

      <p class="preview-hint">Usá Cmd+Shift+4 para tomar captura de pantalla y compartir con tus clientas</p>
    </div>
  </div>

  <script src="app.js"></script>
</body>
</html>

```

---

## `renderer/app.js`

```javascript
/**
 * app.js — Lógica del renderer
 * Moldes Fácil Tiler
 */

'use strict';

// ── Parser de nombres (espejo del que está en main.js) ───────────────────────
function parseFileName(baseName) {
  const name = baseName.replace(/^[._\s]+/, '').trim();
  let m = name.match(/^([^\s]+)\s+molde\s+([^\s]+)$/i);
  if (m) {
    const tallaRaw = m[1];
    return { code: m[2], talla: tallaRaw.startsWith('T-') ? tallaRaw.slice(2) : tallaRaw };
  }
  m = name.match(/^([A-Za-z0-9]+)\s+TALLA\s+([A-Za-z0-9]+)/i);
  if (m) return { code: m[1], talla: m[2] };
  return null;
}

// ── Estado global ─────────────────────────────────────────────────────────────
let lastResults    = [];
let sessionErrors  = []; // acumula errores de todas las subidas de la sesión
// Resultados de validación de códigos: { [code]: true|false|null|'checking' }
let codeValidation = {};

const state = {
  files:            [],   // { path, name, status, widthMm, heightMm, ..., paddingX_a4, paddingY_a4, paddingX_letter, paddingY_letter, adjusted_a4, adjusted_letter, selected }
  outputFolder:     null,
  sourceFolderName: null, // nombre de la carpeta de origen (para nombrar la carpeta de salida)
  processing:       false,
};

// ── Referencias DOM ───────────────────────────────────────────────────────────
const dropZone       = document.getElementById('dropZone');
const fileInput      = document.getElementById('fileInput');
const btnSelectFiles = document.getElementById('btnSelectFiles');
const fileSection    = document.getElementById('fileSection');
const fileTableBody  = document.getElementById('fileTableBody');
const fileSummary    = document.getElementById('fileSummary');
const btnClearAll    = document.getElementById('btnClearAll');
const chkSelectAll   = document.getElementById('chkSelectAll');

const chkFormatA4      = document.getElementById('chkFormatA4');
const chkFormatLetter  = document.getElementById('chkFormatLetter');
const chkFormatPlotter = document.getElementById('chkFormatPlotter');
const chkMarks        = document.getElementById('chkMarks');
const chkLabels       = document.getElementById('chkLabels');
const folderPathEl    = document.getElementById('folderPath');
const btnSelectFolder = document.getElementById('btnSelectFolder');

const btnSelectInputFolder = document.getElementById('btnSelectInputFolder');
const btnProcess           = document.getElementById('btnProcess');
const btnProcessAll        = document.getElementById('btnProcessAll');
const btnProcessText = document.getElementById('btnProcessText');
const actionHint     = document.getElementById('actionHint');
const headerHint     = document.getElementById('headerHint');

const progressSection= document.getElementById('progressSection');
const progressFill   = document.getElementById('progressFill');
const progressLabel  = document.getElementById('progressLabel');

const resultsSection  = document.getElementById('resultsSection');
const resultsIcon     = document.getElementById('resultsIcon');
const resultsTitle    = document.getElementById('resultsTitle');
const resultsList     = document.getElementById('resultsList');
const btnOpenFolder   = document.getElementById('btnOpenFolder');

const uploadPanel          = document.getElementById('uploadPanel');
const btnUploadToSite      = document.getElementById('btnUploadToSite');
const uploadStatus         = document.getElementById('uploadStatus');
const apiUrlInput          = document.getElementById('apiUrl');
const apiTokenInput        = document.getElementById('apiToken');
const dropZoneLoading      = document.getElementById('dropZoneLoading');
const dropZoneLoadingMsg   = document.getElementById('dropZoneLoadingMsg');
const dropZoneProgressBar  = document.getElementById('dropZoneProgressBar');
const btnRetryErrors       = document.getElementById('btnRetryErrors');
const btnDownloadErrorLog  = document.getElementById('btnDownloadErrorLog');
const btnLogout            = document.getElementById('btnLogout');
const inactivityModal      = document.getElementById('inactivityModal');
const inactivityCountdown  = document.getElementById('inactivityCountdown');
const btnStayActive        = document.getElementById('btnStayActive');

// ── Cierre de sesión por inactividad (15 min) ─────────────────────────────────
const INACTIVITY_MS      = 15 * 60 * 1000; // 15 minutos
const WARNING_BEFORE_MS  = 60 * 1000;       // advertencia 1 min antes
let   inactivityTimer    = null;
let   countdownInterval  = null;

function resetInactivityTimer() {
  clearTimeout(inactivityTimer);
  clearInterval(countdownInterval);
  inactivityModal.style.display = 'none';

  inactivityTimer = setTimeout(() => {
    // Mostrar advertencia con cuenta regresiva de 60 s
    let secsLeft = 60;
    inactivityCountdown.textContent = secsLeft;
    inactivityModal.style.display = 'flex';

    countdownInterval = setInterval(() => {
      secsLeft--;
      inactivityCountdown.textContent = secsLeft;
      if (secsLeft <= 0) {
        clearInterval(countdownInterval);
        window.tilerAPI.logout();
      }
    }, 1000);
  }, INACTIVITY_MS - WARNING_BEFORE_MS);
}

// Resetear timer con cualquier interacción del usuario
['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach(evt =>
  document.addEventListener(evt, resetInactivityTimer, { passive: true })
);

btnStayActive.addEventListener('click', resetInactivityTimer);
btnLogout.addEventListener('click', () => window.tilerAPI.logout());

resetInactivityTimer(); // arrancar el timer al cargar

// ── Drop zone ─────────────────────────────────────────────────────────────────
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.remove('drag-over');

  const rawFiles = [...e.dataTransfer.files];
  if (!rawFiles.length) return;

  const paths = rawFiles
    .map(f => window.tilerAPI.getPathForFile(f))
    .filter(Boolean);

  if (!paths.length) {
    showHint('No se pudo obtener la ruta de los archivos.', 'error');
    return;
  }

  // Si arrastraron una sola carpeta, guardar su nombre para la salida
  if (rawFiles.length === 1) {
    const p = paths[0];
    // Detectar si es carpeta (no tiene extensión .pdf)
    if (!p.toLowerCase().endsWith('.pdf')) {
      state.sourceFolderName = p.split(/[\\/]/).filter(Boolean).pop();
    } else {
      state.sourceFolderName = null;
    }
  } else {
    state.sourceFolderName = null;
  }

  await addPathsToList(paths);
});

// Seleccionar CARPETA de entrada via botón
btnSelectInputFolder.addEventListener('click', async () => {
  const folderPaths = await window.tilerAPI.selectInputFolder();
  if (!folderPaths || folderPaths.length === 0) return;
  // Si es una sola carpeta, guardar su nombre para la salida; si son varias, no hay prefijo único
  state.sourceFolderName = folderPaths.length === 1
    ? folderPaths[0].split(/[\\/]/).filter(Boolean).pop()
    : null;
  await addPathsToList(folderPaths);
});

// Seleccionar archivos individuales via botón secundario
btnSelectFiles.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const paths = [...fileInput.files]
    .map(f => window.tilerAPI.getPathForFile(f))
    .filter(Boolean);
  fileInput.value = '';
  if (paths.length) await addPathsToList(paths);
});

// ── Seleccionar todos ────────────────────────────────────────────────────────
chkSelectAll.addEventListener('change', () => {
  const checked = chkSelectAll.checked;
  state.files.forEach(f => { f.selected = checked; });
  renderTable();
  updateProcessButton();
});

// ── Cambio de formato de hoja → actualiza badge de grid en la tabla ───────────
chkFormatA4.addEventListener('change',      () => { renderTable(); updateFormatLabels(); redrawThumbGrid(); });
chkFormatLetter.addEventListener('change',  () => { renderTable(); updateFormatLabels(); redrawThumbGrid(); });
chkFormatPlotter.addEventListener('change', () => { renderTable(); updateFormatLabels(); redrawThumbGrid(); });

// ── Overlay de carga del drop zone ───────────────────────────────────────────
function showDropLoading(msg, pct) {
  dropZoneLoading.style.display = 'flex';
  dropZone.style.position = 'relative';
  dropZoneLoadingMsg.textContent  = msg;
  dropZoneProgressBar.style.width = `${pct}%`;
}
function hideDropLoading() {
  dropZoneLoading.style.display = 'none';
  dropZoneProgressBar.style.width = '0%';
}

// ── Añadir rutas a la lista ───────────────────────────────────────────────────
async function addPathsToList(paths) {
  showDropLoading('Leyendo archivos desde disco…', 10);
  showHint('Leyendo archivos…');

  const found = await window.tilerAPI.processDroppedPaths(paths);
  if (!found.length) {
    hideDropLoading();
    showHint('No se encontraron PDFs en las rutas indicadas.', 'warn');
    return;
  }

  const existing = new Set(state.files.map(f => f.path));
  const newFiles = found.filter(f => !existing.has(f.path));
  if (!newFiles.length) {
    hideDropLoading();
    showHint('Los archivos ya estaban en la lista.', 'warn');
    return;
  }

  for (const f of newFiles) {
    const baseName = f.name.replace(/\.pdf$/i, '');
    const parsed   = parseFileName(baseName);
    state.files.push({
      path:     f.path,
      name:     f.name,
      status:   'detecting',
      parsedCode:  parsed?.code  || null,
      parsedTalla: parsed?.talla || null,
      paddingX_a4:     0,
      paddingY_a4:     0,
      paddingX_letter: 0,
      paddingY_letter: 0,
      adjusted_a4:     false,
      adjusted_letter: false,
      selected: true,
    });
  }
  renderTable();
  showFileSection(true);
  updateProcessButton();

  showDropLoading(`Detectando ${newFiles.length} archivo(s)…`, 40);
  showHint(`Detectando dimensiones de ${newFiles.length} archivo(s)…`);

  const detectedPaths = newFiles.map(f => f.path);

  // Progreso simulado mientras detectAll trabaja (40% → 90%)
  let pct = 40;
  const progressTick = setInterval(() => {
    pct = Math.min(90, pct + 5);
    showDropLoading(`Detectando ${newFiles.length} archivo(s)…`, pct);
  }, 400);

  const dimResults = await window.tilerAPI.detectAll(detectedPaths);
  clearInterval(progressTick);

  for (const dim of dimResults) {
    const entry = state.files.find(f => f.path === dim.path);
    if (!entry) continue;
    if (dim.ok) {
      Object.assign(entry, {
        status:     'ready',
        widthMm:    dim.widthMm,
        heightMm:   dim.heightMm,
        widthCm:    dim.widthCm,
        heightCm:   dim.heightCm,
        cols:       dim.cols,
        rows:       dim.rows,
        totalTiles: dim.totalTiles,
        pageCount:  dim.pageCount,
        sourceSize: dim.sourceSize,
      });
    } else {
      Object.assign(entry, { status: 'error', error: dim.error });
    }
  }

  showDropLoading('¡Listo!', 100);
  setTimeout(hideDropLoading, 600);

  renderTable();
  updateProcessButton();
  updateHeaderHint();
  autoSelectThumb();

  // Validar combinaciones únicas code+talla contra la API (sin bloquear la UI)
  const pairsMap = new Map();
  state.files.filter(f => f.parsedCode && f.parsedTalla).forEach(f => {
    const key = `${f.parsedCode}__${f.parsedTalla}`;
    if (!pairsMap.has(key)) pairsMap.set(key, { code: f.parsedCode, talla: f.parsedTalla });
  });
  const itemsToValidate = [...pairsMap.values()];

  if (itemsToValidate.length && window.tilerAPI.validateCodes) {
    itemsToValidate.forEach(({ code, talla }) => { codeValidation[`${code}__${talla}`] = 'checking'; });
    renderTable();
    try {
      const valResult = await window.tilerAPI.validateCodes(itemsToValidate);
      Object.assign(codeValidation, valResult);
    } catch {
      itemsToValidate.forEach(({ code, talla }) => { codeValidation[`${code}__${talla}`] = null; });
    }
    renderTable();
    updateUploadPanel();
  }
}

// ── Render tabla ──────────────────────────────────────────────────────────────
function renderTable() {
  updateUploadPanel();
  fileTableBody.innerHTML = '';

  for (let i = 0; i < state.files.length; i++) {
    const f   = state.files[i];
    const tr  = document.createElement('tr');
    tr.dataset.idx = i;

    // Columna checkbox
    const tdChk = document.createElement('td');
    tdChk.className = 'td-chk';
    const chk = document.createElement('input');
    chk.type    = 'checkbox';
    chk.checked = !!f.selected;
    chk.title   = 'Seleccionar para procesar';
    chk.addEventListener('change', () => {
      f.selected = chk.checked;
      updateSelectAllState();
      updateProcessButton();
    });
    tdChk.appendChild(chk);
    tr.appendChild(tdChk);

    // Nombre + info parseada (código y talla) + indicador de validación
    const tdName = document.createElement('td');
    let parsedBadge;
    if (f.parsedCode) {
      const vs  = codeValidation[`${f.parsedCode}__${f.parsedTalla}`];
      let valIcon = '';
      if (vs === 'checking') {
        valIcon = ' <span title="Verificando con el catálogo…" style="color:#888;">⟳</span>';
      } else if (vs === null) {
        valIcon = ' <span title="No se pudo verificar (sin conexión)" style="color:#9ca3af;">?</span>';
      } else if (vs) {
        if (!vs.codeExists) {
          valIcon = ' <span title="Código no encontrado en el catálogo" style="color:#dc2626;font-size:11px;">✗</span>';
        } else if (vs.tallaExists === false) {
          const avail = vs.availableSizes?.length ? ` Disponibles: ${vs.availableSizes.join(', ')}` : '';
          valIcon = ` <span title="Talla ${escHtml(f.parsedTalla)} no disponible para este molde.${avail}" style="color:#d97706;font-size:11px;">⚠</span>`;
        } else {
          valIcon = ' <span title="Código y talla encontrados en el catálogo" style="color:#16a34a;font-size:11px;">✓</span>';
        }
      }
      parsedBadge = `<span style="display:inline-block;margin-left:6px;font-size:10px;background:#ede9ff;color:#5b3cdc;padding:1px 6px;border-radius:4px;font-weight:600;" title="Código y talla detectados del nombre">#${escHtml(f.parsedCode)} · T${escHtml(f.parsedTalla)}${valIcon}</span>`;
    } else {
      parsedBadge = `<span style="display:inline-block;margin-left:6px;font-size:10px;background:#fef3cd;color:#b45309;padding:1px 6px;border-radius:4px;font-weight:600;" title="Nombre no reconocido — verificá que el archivo tenga código y talla">⚠️ sin código</span>`;
    }
    tdName.innerHTML = `<span class="file-name" title="${escHtml(f.path)}">${escHtml(f.name)}</span>${parsedBadge}`;
    tr.appendChild(tdName);

    // Dimensiones
    const tdDims = document.createElement('td');
    if (f.widthMm && f.heightMm) {
      tdDims.innerHTML = `<span class="file-dims">${f.widthCm}×${f.heightCm} cm</span>`;
    } else if (f.status === 'detecting') {
      tdDims.innerHTML = `<span class="file-dims">…</span>`;
    } else {
      tdDims.innerHTML = `<span class="file-dims" style="color:#ef4444">Error</span>`;
    }
    tr.appendChild(tdDims);

    // Grid — recalculado según el formato activo en la UI
    const tdGrid = document.createElement('td');
    if (f.widthMm && f.heightMm) {
      const activeFmt = getDisplayFormat();
      const { wPt: gWpt, hPt: gHpt } = FORMAT_DIMS[activeFmt];
      const gCols = Math.ceil(f.widthMm * PT_PER_MM_PREVIEW / gWpt);
      const gRows = Math.ceil(f.heightMm * PT_PER_MM_PREVIEW / gHpt);
      tdGrid.innerHTML = `<span class="grid-badge">${gCols}×${gRows} = ${gCols * gRows} hojas</span>`;
    } else {
      tdGrid.innerHTML = '—';
    }
    tr.appendChild(tdGrid);

    // Peso (source + output por formato)
    const tdSize = document.createElement('td');
    tdSize.className = 'td-size';
    if (f.status === 'detecting') {
      tdSize.innerHTML = '<span class="size-detecting">…</span>';
    } else if (f.sourceSize) {
      let sizeHtml = `<span class="size-source" title="Archivo plotter original">${formatFileSize(f.sourceSize)}</span>`;
      if (f.outputSizes && Object.keys(f.outputSizes).length) {
        const parts = [];
        if (f.outputSizes.a4)     parts.push(`A4: ${formatFileSize(f.outputSizes.a4)}`);
        if (f.outputSizes.letter) parts.push(`Carta: ${formatFileSize(f.outputSizes.letter)}`);
        sizeHtml += `<br><span class="size-output" title="Archivo(s) exportado(s)">↓ ${parts.join(' · ')}</span>`;
      }
      tdSize.innerHTML = sizeHtml;
    } else {
      tdSize.innerHTML = '<span class="size-detecting">—</span>';
    }
    tr.appendChild(tdSize);

    // Estado
    const tdStatus = document.createElement('td');
    const dotClass = f.status === 'ready'      ? 'ready'
                   : f.status === 'detecting'  ? 'detecting'
                   : f.status === 'processing' ? 'processing'
                   : f.status === 'done'       ? 'done'
                   : 'error';
    const dotTitle = f.status === 'ready'      ? 'Listo'
                   : f.status === 'detecting'  ? 'Detectando…'
                   : f.status === 'processing' ? 'Procesando…'
                   : f.status === 'done'       ? 'Generado'
                   : (f.error || 'Error');

    let statusHtml = `<span class="status-dot ${dotClass}" title="${escHtml(dotTitle)}"></span>`;
    if (f.adjusted_a4 || f.adjusted_letter) {
      const parts = [];
      if (f.adjusted_a4)     parts.push(`A4: ${f.paddingX_a4}×${f.paddingY_a4}mm`);
      if (f.adjusted_letter) parts.push(`Carta: ${f.paddingX_letter}×${f.paddingY_letter}mm`);
      const label = f.adjusted_a4 && f.adjusted_letter ? '↔ A4 · Carta'
                  : f.adjusted_a4                      ? '↔ A4'
                  :                                      '↔ Carta';
      statusHtml += ` <span class="adjusted-badge" title="Ajuste guardado — ${parts.join(' | ')}">${label}</span>`;
    }
    tdStatus.innerHTML = statusHtml;
    tr.appendChild(tdStatus);

    // Acciones (preview + eliminar)
    const tdActions = document.createElement('td');
    tdActions.style.whiteSpace = 'nowrap';

    if ((f.status === 'ready' || f.status === 'done') && f.widthMm && f.heightMm) {
      // Botón Vista previa A4 (visible si A4 está seleccionado)
      if (chkFormatA4.checked) {
        const btnA4p = document.createElement('button');
        btnA4p.className = 'btn-preview-a4';
        btnA4p.innerHTML  = '👁 A4';
        btnA4p.title      = 'Vista previa en A4';
        btnA4p.addEventListener('click', () => openPreview(i, 'a4'));
        tdActions.appendChild(btnA4p);
        tdActions.appendChild(document.createTextNode(' '));
      }
      // Botón Vista previa Carta (visible si Carta está seleccionado)
      if (chkFormatLetter.checked) {
        const btnLetp = document.createElement('button');
        btnLetp.className = 'btn-preview-letter';
        btnLetp.innerHTML  = '👁 Carta';
        btnLetp.title      = 'Vista previa en Carta';
        btnLetp.addEventListener('click', () => openPreview(i, 'letter'));
        tdActions.appendChild(btnLetp);
        tdActions.appendChild(document.createTextNode(' '));
      }
    }

    if (!state.processing) {
      const btnR = document.createElement('button');
      btnR.className   = 'btn-remove';
      btnR.textContent = '×';
      btnR.title       = 'Quitar de la lista';
      btnR.addEventListener('click', () => removeFile(i));
      tdActions.appendChild(btnR);
    }
    tr.appendChild(tdActions);

    fileTableBody.appendChild(tr);
  }

  // Resumen — totales calculados con el formato activo
  const readyCount    = state.files.filter(f => f.status === 'ready' || f.status === 'done').length;
  const selectedCount = state.files.filter(f => f.selected).length;
  const summaryFmt    = getDisplayFormat();
  const { wPt: sWpt, hPt: sHpt, label: sLabel } = FORMAT_DIMS[summaryFmt];
  const totalTiles = state.files
    .filter(f => f.widthMm && f.heightMm)
    .reduce((sum, f) => {
      const c = Math.ceil(f.widthMm * PT_PER_MM_PREVIEW / sWpt);
      const r = Math.ceil(f.heightMm * PT_PER_MM_PREVIEW / sHpt);
      return sum + c * r;
    }, 0);

  fileSummary.textContent = readyCount
    ? `${readyCount} archivo(s) — ${totalTiles} hojas ${sLabel} en total — ${selectedCount} seleccionado(s)`
    : '';

  updateSelectAllState();
}

/** Actualiza el estado del checkbox "seleccionar todos" */
function updateSelectAllState() {
  const total    = state.files.length;
  const selected = state.files.filter(f => f.selected).length;
  chkSelectAll.checked       = total > 0 && selected === total;
  chkSelectAll.indeterminate = selected > 0 && selected < total;
}

// ── Quitar archivo ────────────────────────────────────────────────────────────
function removeFile(idx) {
  state.files.splice(idx, 1);
  renderTable();
  updateProcessButton();
  updateHeaderHint();
  if (!state.files.length) showFileSection(false);
}

// ── Limpiar todo ──────────────────────────────────────────────────────────────
btnClearAll.addEventListener('click', () => {
  state.files = [];
  state.sourceFolderName = null;
  renderTable();
  showFileSection(false);
  updateProcessButton();
  hideResults();
  showHint('Arrastrá PDFs o carpetas para empezar');
});

// ── Carpeta destino ───────────────────────────────────────────────────────────
btnSelectFolder.addEventListener('click', async () => {
  const folder = await window.tilerAPI.selectOutputFolder();
  if (!folder) return;
  state.outputFolder = folder;
  const parts = folder.split('/').filter(Boolean);
  folderPathEl.textContent = '…/' + parts.slice(-2).join('/');
  folderPathEl.title = folder;
  updateProcessButton();
});

// ── Botones procesar ──────────────────────────────────────────────────────────
function updateProcessButton() {
  const selectedReady = state.files.filter(f => f.selected && f.status === 'ready');
  const allReady      = state.files.filter(f => f.status === 'ready');
  const hasFolder     = !!state.outputFolder;

  btnProcess.disabled    = !(!state.processing && selectedReady.length > 0 && hasFolder);
  btnProcessAll.disabled = !(!state.processing && allReady.length > 0 && hasFolder);

  if (state.processing) {
    actionHint.textContent = 'Procesando…';
  } else if (!allReady.length) {
    actionHint.textContent = 'Cargá al menos un PDF para continuar';
  } else if (!hasFolder) {
    actionHint.textContent = 'Elegí una carpeta de destino';
  } else {
    actionHint.textContent =
      `${selectedReady.length} seleccionado(s) · ${allReady.length} listo(s) en total`;
  }
}

btnProcess.addEventListener('click', async () => {
  if (state.processing) return;
  const filesToProcess = state.files.filter(f => f.selected && f.status === 'ready');
  await runBatch(filesToProcess);
});

btnProcessAll.addEventListener('click', async () => {
  if (state.processing) return;
  const filesToProcess = state.files.filter(f => f.status === 'ready');
  await runBatch(filesToProcess);
});

// ── Batch process ─────────────────────────────────────────────────────────────
async function runBatch(filesToProcess) {
  if (!filesToProcess.length || !state.outputFolder) return;

  state.processing = true;
  updateProcessButton();
  btnProcessText.textContent = 'Procesando…';
  hideResults();

  progressSection.style.display = 'flex';
  progressSection.style.flexDirection = 'column';
  progressFill.style.width = '0%';
  progressLabel.textContent = 'Iniciando…';

  const PT_PER_MM = 72 / 25.4;

  // Cada archivo lleva sus paddings independientes por formato (en puntos PDF)
  const files = filesToProcess.map(f => ({
    path:            f.path,
    name:            f.name,
    paddingX_a4:     (f.paddingX_a4     || 0) * PT_PER_MM,
    paddingY_a4:     (f.paddingY_a4     || 0) * PT_PER_MM,
    paddingX_letter: (f.paddingX_letter || 0) * PT_PER_MM,
    paddingY_letter: (f.paddingY_letter || 0) * PT_PER_MM,
  }));

  // Formatos seleccionados
  const formats = [];
  if (chkFormatA4.checked)      formats.push('a4');
  if (chkFormatLetter.checked)  formats.push('letter');
  if (chkFormatPlotter.checked) formats.push('plotter');
  if (!formats.length) {
    showHint('Seleccioná al menos un formato de hoja.', 'warn');
    state.processing = false;
    updateProcessButton();
    return;
  }

  // Opciones globales (sin padding: va por archivo)
  const options = {
    addMarks:  chkMarks.checked,
    addLabels: chkLabels.checked,
  };

  window.tilerAPI.offProgress();
  window.tilerAPI.onProgress((data) => {
    const pct = data.total ? Math.round((data.current / data.total) * 100) : 0;
    progressFill.style.width = pct + '%';
    progressLabel.textContent =
      data.phase === 'processing'
        ? `Procesando ${escHtml(data.fileName)} (${data.current + 1}/${data.total})…`
        : `Listo: ${escHtml(data.fileName)} (${data.current}/${data.total})`;

    if (data.phase === 'processing') {
      const entry = state.files.find(f => f.name === data.fileName);
      if (entry) { entry.status = 'processing'; renderTable(); }
    }
  });

  try {
    const chkSkip = document.getElementById('chkSkipExisting');
    const results = await window.tilerAPI.batchTile({
      files,
      outputFolder:    state.outputFolder,
      options,
      formats,
      batchFolderName: state.sourceFolderName || null,
      skipIfExists:    chkSkip ? chkSkip.checked : false,
    });

    for (const r of results) {
      const entry = state.files.find(f => f.name === r.name);
      if (entry) {
        entry.status = r.ok ? 'done' : 'error';
        if (r.ok && r.outputSize != null) {
          if (!entry.outputSizes) entry.outputSizes = {};
          entry.outputSizes[r.formatKey] = r.outputSize;
        }
      }
    }
    renderTable();
    showResults(results);
    lastResults = results.filter(r => r.ok);
    updateUploadPanel();

  } catch (err) {
    showHint('Error durante el procesamiento: ' + err.message, 'error');
  } finally {
    state.processing = false;
    btnProcessText.textContent = '⬇ Descargar seleccionados';
    updateProcessButton();
    window.tilerAPI.offProgress();
    progressSection.style.display = 'none';
  }
}

// ── Mostrar resultados ────────────────────────────────────────────────────────
function showResults(results) {
  const okCount  = results.filter(r => r.ok).length;
  const errCount = results.length - okCount;

  resultsSection.style.display = 'flex';
  resultsSection.style.flexDirection = 'column';

  if (errCount === 0) {
    resultsIcon.textContent = '✅';
    resultsTitle.textContent = `${okCount} archivo(s) generados correctamente`;
  } else if (okCount === 0) {
    resultsIcon.textContent = '❌';
    resultsTitle.textContent = 'Todos los archivos fallaron';
  } else {
    resultsIcon.textContent = '⚠️';
    resultsTitle.textContent = `${okCount} OK — ${errCount} con errores`;
  }

  resultsList.innerHTML = '';
  for (const r of results) {
    const div = document.createElement('div');
    div.className = `result-item ${r.ok ? 'ok' : 'err'}`;

    let detail = '';
    if (r.ok && r.totalPages) {
      detail = ` — ${r.cols}×${r.rows} = ${r.totalPages} hojas`;
    } else if (!r.ok) {
      detail = ` — ${r.error || 'Error'}`;
    }

    const displayName = r.pdfFileName || r.name;
    div.innerHTML = `
      <span class="result-icon">${r.ok ? '✔' : '✖'}</span>
      <span>${escHtml(displayName)}${escHtml(detail)}</span>
    `;
    resultsList.appendChild(div);
  }

  if (okCount > 0) {
    // Abrir la carpeta donde quedaron los archivos (puede ser subcarpeta "315 A4")
    const firstOk = results.find(r => r.ok);
    const folderToOpen = firstOk?.destFolder || state.outputFolder;
    btnOpenFolder.style.display = 'inline-flex';
    btnOpenFolder.onclick = () => window.tilerAPI.openFolder(folderToOpen);
  } else {
    btnOpenFolder.style.display = 'none';
  }
}

function hideResults() {
  resultsSection.style.display = 'none';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showFileSection(visible) {
  fileSection.style.display = visible ? 'flex' : 'none';
}

function showHint(msg, type) {
  headerHint.textContent = msg;
  headerHint.style.color = type === 'error' ? '#ffaaaa'
                         : type === 'warn'  ? '#ffd080'
                         : type === 'ok'    ? '#86efac'
                         : 'rgba(255,255,255,.65)';
}

function updateHeaderHint() {
  const count = state.files.length;
  if (!count) {
    showHint('Arrastrá PDFs o carpetas para empezar');
  } else {
    const ready = state.files.filter(f => f.status === 'ready').length;
    showHint(`${count} archivo(s) cargado(s) — ${ready} listo(s)`);
  }
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Formatea bytes en B / KB / MB legibles */
function formatFileSize(bytes) {
  if (bytes == null || bytes === 0) return '—';
  if (bytes < 1024)              return bytes + ' B';
  if (bytes < 1024 * 1024)       return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ════════════════════════════════════════════════════════════════════════════
// ── PREVISUALIZACIÓN ──────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

const previewOverlay  = document.getElementById('previewOverlay');
const previewCanvas   = document.getElementById('previewCanvas');
const previewLoading  = document.getElementById('previewLoading');
const previewFileName = document.getElementById('previewFileName');
const previewWrapper  = document.getElementById('previewCanvasWrapper');
const zoomLabel       = document.getElementById('zoomLabel');
const btnZoomIn       = document.getElementById('btnZoomIn');
const btnZoomOut      = document.getElementById('btnZoomOut');
const btnZoomFit      = document.getElementById('btnZoomFit');
const btnClosePreview = document.getElementById('btnClosePreview');
const btnSaveAdjust   = document.getElementById('btnSaveAdjust');
const previewPaddingInfo = document.getElementById('previewPaddingInfo');

// Dimensiones de formatos en puntos PDF
const PT_PER_MM_PREVIEW = 72 / 25.4;
const A4_W_PT     = 210   * PT_PER_MM_PREVIEW;
const A4_H_PT     = 297   * PT_PER_MM_PREVIEW;
const LETTER_W_PT = 215.9 * PT_PER_MM_PREVIEW;
const LETTER_H_PT = 279.4 * PT_PER_MM_PREVIEW;

const FORMAT_DIMS = {
  a4:     { wPt: A4_W_PT,     hPt: A4_H_PT,     label: 'A4' },
  letter: { wPt: LETTER_W_PT, hPt: LETTER_H_PT, label: 'Carta' },
};

/**
 * Devuelve la clave del formato activo en la UI principal.
 * Si solo Carta está marcada → 'letter'; en cualquier otro caso → 'a4'.
 */
function getDisplayFormat() {
  if (!chkFormatA4.checked && chkFormatLetter.checked) return 'letter';
  return 'a4';
}

/**
 * Actualiza el encabezado "Grid A4/Carta" y el hint de nombre de archivo
 * según los formatos seleccionados en los checkboxes.
 */
function updateFormatLabels() {
  const hasA4     = chkFormatA4.checked;
  const hasLetter = chkFormatLetter.checked;

  // Encabezado de columna en la tabla
  const thGrid = document.getElementById('thGridLabel');
  if (thGrid) {
    if (hasA4 && hasLetter) thGrid.textContent = 'Grid A4 / Carta';
    else if (hasLetter)     thGrid.textContent = 'Grid Carta';
    else                    thGrid.textContent = 'Grid A4';
  }

  // Hint de carpeta de destino
  const hintEl = document.getElementById('destFormatHint');
  if (hintEl) {
    if (hasA4 && hasLetter) {
      hintEl.innerHTML = 'Los PDFs se guardan en subcarpetas <em>A4/</em> y <em>Carta/</em> dentro de la carpeta elegida.';
    } else if (hasLetter) {
      hintEl.innerHTML = 'Los PDFs se guardan como <em>nombre_Carta.pdf</em> en la subcarpeta <em>Carta/</em>.';
    } else {
      hintEl.innerHTML = 'Los PDFs se guardan como <em>nombre_A4.pdf</em> en la subcarpeta <em>A4/</em>.';
    }
  }
}

let previewZoom        = 1.0;
let previewRenderScale = 1;
let previewFileIdx     = -1;
let previewFile        = null;
let pdfImageData       = null;
let gridCanvas         = null;

// Offset del PDF dentro del canvas (un tile de margen en cada lado)
let pdfOffsetX = 0;
let pdfOffsetY = 0;

// Formato activo en el preview ('a4' o 'letter')
let previewFormat = 'a4';

// Padding LOCAL al modal (no afecta state global hasta "Guardar")
let previewCurrentPaddingX = 0;
let previewCurrentPaddingY = 0;

// Buffer pendiente POR FORMATO — se acumula al cambiar de tab
// y se escribe a previewFile solo al hacer "Guardar"
let pendingPaddingA4     = { x: 0, y: 0 };
let pendingPaddingLetter = { x: 0, y: 0 };

/** Redibujar el grid en el canvas superpuesto */
function redrawPreviewGrid() {
  if (!pdfImageData || !previewFile || !gridCanvas) return;
  const { wPt, hPt } = FORMAT_DIMS[previewFormat];
  drawGridOnCanvas(gridCanvas, previewFile, previewRenderScale,
                   previewCurrentPaddingX, previewCurrentPaddingY,
                   pdfOffsetX, pdfOffsetY, wPt, hPt);
  updatePreviewInfo();
  updatePreviewPaddingDisplay();
}

/** Actualiza la etiqueta de ajuste en el footer del modal */
function updatePreviewPaddingDisplay() {
  if (previewPaddingInfo) {
    previewPaddingInfo.textContent =
      `Ajuste actual: ↔ ${previewCurrentPaddingX} mm  ↕ ${previewCurrentPaddingY} mm`;
  }
}

/**
 * Abre el modal para el archivo en state.files[idx].
 * @param {number} idx    - índice en state.files
 * @param {string} format - 'a4' | 'letter' (opcional; si se omite usa la selección principal)
 */
async function openPreview(idx, format) {
  const f = state.files[idx];
  if (!f || !f.widthMm) return;

  previewFileIdx = idx;
  previewFile    = f;
  previewOverlay.style.display = 'flex';
  previewLoading.style.display = 'flex';
  pdfImageData = null;
  gridCanvas   = null;

  // Usar el formato pasado como argumento, o el activo en la UI principal
  previewFormat = format || getDisplayFormat();
  const btnA4m  = document.getElementById('previewFmtA4');
  const btnLetm = document.getElementById('previewFmtLetter');
  if (btnA4m)  btnA4m.classList.toggle('active',  previewFormat === 'a4');
  if (btnLetm) btnLetm.classList.toggle('active', previewFormat === 'letter');

  // Inicializar el buffer pendiente con los valores guardados de AMBOS formatos
  pendingPaddingA4     = { x: f.paddingX_a4     || 0, y: f.paddingY_a4     || 0 };
  pendingPaddingLetter = { x: f.paddingX_letter || 0, y: f.paddingY_letter || 0 };

  // Cargar el padding del formato activo en los sliders
  const pending0 = previewFormat === 'a4' ? pendingPaddingA4 : pendingPaddingLetter;
  previewCurrentPaddingX = pending0.x;
  previewCurrentPaddingY = pending0.y;

  const ctx = previewCanvas.getContext('2d');
  ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);

  previewFileName.textContent = f.name;
  syncPreviewSliders();
  updatePreviewPaddingDisplay();
  updateSaveButtonLabel();

  try {
    const arrayBuffer = await window.tilerAPI.readPdfForPreview(f.path);

    // Escala: lado más largo queda en ~760px
    const PREVIEW_MAX = 900;
    const srcMax = Math.max(f.widthMm, f.heightMm) * PT_PER_MM_PREVIEW;
    previewRenderScale = PREVIEW_MAX / srcMax;
    const scale = previewRenderScale;

    const { wPt: activeFmtWpt, hPt: activeFmtHpt } = FORMAT_DIMS[previewFormat];
    const tileWpx = Math.round(activeFmtWpt * scale);
    const tileHpx = Math.round(activeFmtHpt * scale);

    // 1) Renderizar PDF a canvas temporal (tamaño exacto del patrón)
    const offCanvas = document.createElement('canvas');
    await renderPDFtoCanvas(arrayBuffer, offCanvas, scale);

    // 2) Canvas principal = patrón + UN tile de margen en cada lado
    //    → siempre se ve completa la primera y última fila/columna de hojas
    pdfOffsetX = tileWpx;
    pdfOffsetY = tileHpx;

    previewCanvas.width  = offCanvas.width  + 2 * tileWpx;
    previewCanvas.height = offCanvas.height + 2 * tileHpx;

    const ctx = previewCanvas.getContext('2d');
    // Fondo del margen: gris suave (fuera del patrón)
    ctx.fillStyle = '#c8c8d4';
    ctx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
    // Área del patrón: blanco
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(pdfOffsetX, pdfOffsetY, offCanvas.width, offCanvas.height);
    // Blit del PDF renderizado
    ctx.drawImage(offCanvas, pdfOffsetX, pdfOffsetY);

    // Guardar ImageData del canvas completo (para auto-ajuste)
    pdfImageData = ctx.getImageData(0, 0, previewCanvas.width, previewCanvas.height);

    // 3) Canvas superpuesto para el grid (mismo tamaño que el principal)
    gridCanvas = document.createElement('canvas');
    gridCanvas.width  = previewCanvas.width;
    gridCanvas.height = previewCanvas.height;
    gridCanvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
    previewWrapper.appendChild(gridCanvas);

    const { wPt, hPt } = FORMAT_DIMS[previewFormat];
    drawGridOnCanvas(gridCanvas, f, scale,
                     previewCurrentPaddingX, previewCurrentPaddingY,
                     pdfOffsetX, pdfOffsetY, wPt, hPt);

    previewZoom = 0.6;
    applyZoom(previewZoom);
    updatePreviewInfo();

  } catch (err) {
    console.error('Preview error:', err);
  } finally {
    previewLoading.style.display = 'none';
  }
}

function updatePreviewInfo() {
  const f = previewFile;
  if (!f) return;
  const { wPt, hPt, label } = FORMAT_DIMS[previewFormat];
  const PT   = PT_PER_MM_PREVIEW;
  const pxMm = previewCurrentPaddingX;
  const pyMm = previewCurrentPaddingY;
  const srcWpx = f.widthMm  * PT;
  const srcHpx = f.heightMm * PT;
  const pxPx   = pxMm * PT;
  const pyPx   = pyMm * PT;
  const cols = Math.ceil((srcWpx + pxPx) / wPt);
  const rows = Math.ceil((srcHpx + pyPx) / hPt);
  // Compute effective start (same 15% threshold as drawGridOnCanvas)
  const SKIP = 0.15;
  let startRow = 0;
  while (startRow < rows - 1) {
    const dyR = -((rows - 1 - startRow) * hPt - pyPx);
    if ((Math.min(hPt, dyR + srcHpx) - Math.max(0, dyR)) / hPt >= SKIP) break;
    startRow++;
  }
  let startCol = 0;
  while (startCol < cols - 1) {
    const dxC = -(startCol * wPt - pxPx);
    if ((Math.min(wPt, dxC + srcWpx) - Math.max(0, dxC)) / wPt >= SKIP) break;
    startCol++;
  }
  const effCols = cols - startCol;
  const effRows = rows - startRow;
  const el = document.getElementById('previewGridText');
  if (el) el.textContent =
    `${f.widthCm}×${f.heightCm} cm  |  ${effCols} col × ${effRows} fil  |  ${effCols*effRows} hojas ${label}`;
}

/**
 * Actualiza el label del botón Guardar para mostrar cuántos formatos
 * tienen ajuste pendiente (orientación al usuario).
 */
function updateSaveButtonLabel() {
  // Estado del formato activo → volcar al buffer temporalmente para evaluar
  const bufA4  = previewFormat === 'a4'
    ? { x: previewCurrentPaddingX, y: previewCurrentPaddingY }
    : pendingPaddingA4;
  const bufLet = previewFormat === 'letter'
    ? { x: previewCurrentPaddingX, y: previewCurrentPaddingY }
    : pendingPaddingLetter;

  const hasA4  = bufA4.x  > 0 || bufA4.y  > 0;
  const hasLet = bufLet.x > 0 || bufLet.y > 0;

  let label = '💾 Guardar ajuste';
  if (hasA4 && hasLet)  label = '💾 Guardar A4 y Carta';
  else if (hasA4)       label = '💾 Guardar ajuste A4';
  else if (hasLet)      label = '💾 Guardar ajuste Carta';
  btnSaveAdjust.textContent = label;
}

/** Sincroniza los sliders del modal con el padding actual del preview */
function syncPreviewSliders() {
  const px  = document.getElementById('previewSliderX');
  const py  = document.getElementById('previewSliderY');
  const pvx = document.getElementById('previewValX');
  const pvy = document.getElementById('previewValY');
  if (px)  px.value  = previewCurrentPaddingX;
  if (py)  py.value  = previewCurrentPaddingY;
  if (pvx) pvx.textContent = previewCurrentPaddingX + ' mm';
  if (pvy) pvy.textContent = previewCurrentPaddingY + ' mm';
}

// Listeners de sliders del MODAL — solo afectan el preview local
(function hookPreviewSliders() {
  function hookSlider(id, axis) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      const val    = +el.value;
      const valEl  = document.getElementById(axis === 'x' ? 'previewValX' : 'previewValY');
      if (valEl) valEl.textContent = val + ' mm';
      if (axis === 'x') previewCurrentPaddingX = val;
      else              previewCurrentPaddingY = val;
      redrawPreviewGrid();
      updateSaveButtonLabel();
    });
  }
  hookSlider('previewSliderX', 'x');
  hookSlider('previewSliderY', 'y');
})();

// ── Guardar ajuste ────────────────────────────────────────────────────────────
btnSaveAdjust.addEventListener('click', () => {
  if (previewFileIdx < 0 || !previewFile) return;

  // Volcar el formato activo al buffer antes de guardar
  if (previewFormat === 'a4') {
    pendingPaddingA4 = { x: previewCurrentPaddingX, y: previewCurrentPaddingY };
  } else {
    pendingPaddingLetter = { x: previewCurrentPaddingX, y: previewCurrentPaddingY };
  }

  // Escribir AMBOS formatos del buffer a previewFile de una sola vez
  previewFile.paddingX_a4     = pendingPaddingA4.x;
  previewFile.paddingY_a4     = pendingPaddingA4.y;
  previewFile.adjusted_a4     = (pendingPaddingA4.x > 0     || pendingPaddingA4.y > 0);
  previewFile.paddingX_letter = pendingPaddingLetter.x;
  previewFile.paddingY_letter = pendingPaddingLetter.y;
  previewFile.adjusted_letter = (pendingPaddingLetter.x > 0 || pendingPaddingLetter.y > 0);

  renderTable();
  closePreview();
});

/**
 * Renderiza PDF a canvas usando pdfjs (CDN).
 */
async function renderPDFtoCanvas(arrayBuffer, canvas, scale) {
  if (typeof pdfjsLib === 'undefined')
    throw new Error('pdfjs no disponible. Verificá conexión a internet.');
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const pdf  = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const page = await pdf.getPage(1);
  const vp   = page.getViewport({ scale });
  canvas.width  = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
}

/**
 * Dibuja el grid (líneas + etiquetas + zonas de margen) en el canvas superpuesto.
 *
 * @param {HTMLCanvasElement} gc       Canvas del grid
 * @param {object}            f        Archivo con widthMm/heightMm
 * @param {number}            scale    Escala de renderizado
 * @param {number}            pxMm     paddingX en mm (desplazamiento horizontal del grid)
 * @param {number}            pyMm     paddingY en mm (desplazamiento vertical del grid)
 * @param {number}            offsetX  Posición X del PDF dentro del canvas (px)
 * @param {number}            offsetY  Posición Y del PDF dentro del canvas (px)
 */
function drawGridOnCanvas(gc, f, scale, pxMm, pyMm, offsetX = 0, offsetY = 0, tileWpt = A4_W_PT, tileHpt = A4_H_PT) {
  const ctx = gc.getContext('2d');
  ctx.clearRect(0, 0, gc.width, gc.height);

  const tileW  = tileWpt * scale;
  const tileH  = tileHpt * scale;
  const pxPx   = pxMm * PT_PER_MM_PREVIEW * scale;
  const pyPx   = pyMm * PT_PER_MM_PREVIEW * scale;

  const srcWpx = f.widthMm  * PT_PER_MM_PREVIEW * scale;
  const srcHpx = f.heightMm * PT_PER_MM_PREVIEW * scale;

  const cols = Math.ceil((srcWpx + pxPx) / tileW);
  const rows = Math.ceil((srcHpx + pyPx) / tileH);

  // Sin skip de filas/columnas iniciales — la grilla siempre empieza en A1,
  // igual que el engine. paddingX/paddingY son microajustes, no desplazamiento estructural.
  const gridX0 = offsetX - pxPx;
  const gridY0 = offsetY - pyPx;

  // ── Líneas del grid ───────────────────────────────────────────────────
  ctx.strokeStyle = 'rgba(50, 50, 200, 0.45)';
  ctx.lineWidth   = 1;
  ctx.setLineDash([]);

  for (let c = 0; c <= cols; c++) {
    const x = gridX0 + c * tileW;
    if (x < -1 || x > gc.width + 1) continue;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, gc.height); ctx.stroke();
  }
  for (let r = 0; r <= rows; r++) {
    const y = gridY0 + r * tileH;
    if (y < -1 || y > gc.height + 1) continue;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(gc.width, y); ctx.stroke();
  }

  // Borde del patrón
  ctx.strokeStyle = 'rgba(30, 30, 180, 0.85)';
  ctx.lineWidth = 2;
  ctx.strokeRect(offsetX + 0.5, offsetY + 0.5, srcWpx - 1, srcHpx - 1);

  // ── Zonas de margen no imprimible (~5mm) ─────────────────────────────
  const MARGIN_PX = 5 * PT_PER_MM_PREVIEW * scale;
  ctx.fillStyle = 'rgba(255, 80, 80, 0.09)';
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const x = gridX0 + c * tileW;
      const y = gridY0 + r * tileH;
      if (x + tileW < 0 || x > gc.width || y + tileH < 0 || y > gc.height) continue;
      ctx.fillRect(x, y, MARGIN_PX, tileH);
      ctx.fillRect(x + tileW - MARGIN_PX, y, MARGIN_PX, tileH);
      ctx.fillRect(x, y, tileW, MARGIN_PX);
      ctx.fillRect(x, y + tileH - MARGIN_PX, tileW, MARGIN_PX);
    }
  }

  // ── Etiquetas ─────────────────────────────────────────────────────────
  const labelSize = Math.max(8, Math.round(tileW * 0.08));
  ctx.font         = `bold ${labelSize}px Helvetica, Arial, sans-serif`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'top';

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const label = `${colIndexToLabelJS(r)}${c + 1}`;
      const cx    = gridX0 + c * tileW + tileW / 2;
      const cy    = gridY0 + r * tileH + labelSize * 0.5;
      if (cx < 0 || cx > gc.width || cy < 0 || cy > gc.height) continue;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(255,255,255,0.80)';
      ctx.fillRect(cx - tw/2 - 2, cy - 1, tw + 4, labelSize + 2);
      ctx.fillStyle = 'rgba(20, 20, 160, 0.9)';
      ctx.fillText(label, cx, cy);
    }
  }
}

/** Convierte índice a letra (0→A, 1→B…) */
function colIndexToLabelJS(index) {
  let label = '', n = index;
  do { label = String.fromCharCode(65 + (n % 26)) + label; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return label;
}

// ── Zoom ──────────────────────────────────────────────────────────────────────
function applyZoom(z) {
  previewZoom = Math.min(4, Math.max(0.2, z));
  previewWrapper.style.transform       = `scale(${previewZoom})`;
  previewWrapper.style.transformOrigin = 'top center';
  zoomLabel.textContent = Math.round(previewZoom * 100) + '%';
}

btnZoomIn.addEventListener('click',  () => applyZoom(previewZoom + 0.25));
btnZoomOut.addEventListener('click', () => applyZoom(previewZoom - 0.25));
btnZoomFit.addEventListener('click', () => applyZoom(1.0));

// Cerrar modal
btnClosePreview.addEventListener('click', closePreview);
previewOverlay.addEventListener('click', (e) => { if (e.target === previewOverlay) closePreview(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePreview(); });

// ── Toggle de formato en el preview (A4 / Carta) ──────────────────────────────
(function hookFormatToggle() {
  const btnA4     = document.getElementById('previewFmtA4');
  const btnLetter = document.getElementById('previewFmtLetter');
  if (!btnA4 || !btnLetter) return;

  function setFormat(fmt) {
    // Guardar el estado actual del formato que se está abandonando en el buffer
    if (previewFormat === 'a4') {
      pendingPaddingA4 = { x: previewCurrentPaddingX, y: previewCurrentPaddingY };
    } else {
      pendingPaddingLetter = { x: previewCurrentPaddingX, y: previewCurrentPaddingY };
    }

    // Cambiar al nuevo formato y cargar su buffer pendiente
    previewFormat = fmt;
    btnA4.classList.toggle('active', fmt === 'a4');
    btnLetter.classList.toggle('active', fmt === 'letter');

    const pending = fmt === 'a4' ? pendingPaddingA4 : pendingPaddingLetter;
    previewCurrentPaddingX = pending.x;
    previewCurrentPaddingY = pending.y;
    syncPreviewSliders();
    redrawPreviewGrid();
    updateSaveButtonLabel();
  }

  btnA4.addEventListener('click',     () => setFormat('a4'));
  btnLetter.addEventListener('click', () => setFormat('letter'));
})();

function closePreview() {
  previewOverlay.style.display = 'none';
  if (gridCanvas && gridCanvas.parentNode) gridCanvas.parentNode.removeChild(gridCanvas);
  gridCanvas   = null;
  pdfImageData = null;
  previewFile  = null;
  previewFileIdx = -1;
}

// ════════════════════════════════════════════════════════════════════════════
// ── AUTO-AJUSTE DE GRID ───────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

// Botón global "AutoAjustar todos" en el header de la tabla
document.getElementById('btnBatchAutoAdjust')
  .addEventListener('click', () => batchAutoAdjust());

const btnAutoAdjust = document.getElementById('btnAutoAdjust');

btnAutoAdjust.addEventListener('click', async () => {
  if (!pdfImageData || !previewFile) return;

  // Estado visual: procesando
  btnAutoAdjust.textContent = '⏳ Analizando…';
  btnAutoAdjust.disabled    = true;

  // Cedemos el hilo al browser para que renderice el cambio antes de bloquear
  await new Promise(r => setTimeout(r, 16));

  try {
    const result = findOptimalPadding();
    if (result) {
      previewCurrentPaddingX = result.paddingX;
      previewCurrentPaddingY = result.paddingY;
      syncPreviewSliders();
      redrawPreviewGrid();
      updateSaveButtonLabel();
    }
  } finally {
    btnAutoAdjust.textContent = '✨ Auto-ajustar';
    btnAutoAdjust.disabled    = false;
  }
});

/**
 * Función PURA de análisis: busca el offset de grid que minimiza el cruce
 * de líneas del patrón con los bordes de tile.
 *
 * @param {ImageData} imageData  Canvas compuesto (PDF + márgenes)
 * @param {number}    ofsX       Posición X del PDF dentro del canvas (px)
 * @param {number}    ofsY       Posición Y del PDF dentro del canvas (px)
 * @param {number}    scale      Escala de renderizado
 * @param {{ widthMm, heightMm }} fileDims  Dimensiones del patrón
 * @param {string}    format     'a4' | 'letter'
 * @returns {{ paddingX: number, paddingY: number }}  Offsets óptimos en mm
 *
 * Algoritmo:
 *  1. Precalcula colDarkness[x] y rowDarkness[y] (suma de oscuridad por columna/fila).
 *  2. Construye prefix sums para consultas O(1) de bandas.
 *  3. Prueba ~2400 combinaciones (0..200 mm × 0..290 mm, paso 5 mm).
 *  4. Evalúa la oscuridad en bandas de 4 mm a cada lado de los cortes de tile.
 *  5. Devuelve el par con menor score.
 */
function computeOptimalPadding(imageData, ofsX, ofsY, scale, fileDims, format) {
  const data = imageData.data;
  const W    = imageData.width;
  const H    = imageData.height;

  // ── 1. Gradiente Sobel por columna y fila ───────────────────────────
  // Precalcula luminancia (0–255) para acceso rápido en el kernel Sobel.
  const lum = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      lum[y * W + x] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    }
  }

  const colDark = new Float64Array(W);
  const rowDark = new Float64Array(H);
  // Borde 1 px queda en cero (sin vecinos completos); interior usa kernel 3×3.
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const tl = lum[(y - 1) * W + (x - 1)], tc = lum[(y - 1) * W + x], tr = lum[(y - 1) * W + (x + 1)];
      const ml = lum[      y * W + (x - 1)],                              mr = lum[      y * W + (x + 1)];
      const bl = lum[(y + 1) * W + (x - 1)], bc = lum[(y + 1) * W + x], br = lum[(y + 1) * W + (x + 1)];
      const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      const mag = Math.sqrt(gx * gx + gy * gy);
      colDark[x] += mag;
      rowDark[y] += mag;
    }
  }

  // ── 2. Prefix sums ───────────────────────────────────────────────────
  const colPfx = new Float64Array(W + 1);
  const rowPfx = new Float64Array(H + 1);
  for (let x = 0; x < W; x++) colPfx[x + 1] = colPfx[x] + colDark[x];
  for (let y = 0; y < H; y++) rowPfx[y + 1] = rowPfx[y] + rowDark[y];

  const colBand = (x, r) => {
    const lo = Math.max(0, Math.round(x) - r);
    const hi = Math.min(W, Math.round(x) + r + 1);
    return colPfx[hi] - colPfx[lo];
  };
  const rowBand = (y, r) => {
    const lo = Math.max(0, Math.round(y) - r);
    const hi = Math.min(H, Math.round(y) + r + 1);
    return rowPfx[hi] - rowPfx[lo];
  };

  // ── 3. Parámetros de tile en píxeles ────────────────────────────────
  const { wPt, hPt }  = FORMAT_DIMS[format];
  const tileWpx = wPt * scale;
  const tileHpx = hPt * scale;
  const srcWpx  = fileDims.widthMm  * PT_PER_MM_PREVIEW * scale;
  const srcHpx  = fileDims.heightMm * PT_PER_MM_PREVIEW * scale;
  const bandPx  = Math.max(1, Math.round(4 * PT_PER_MM_PREVIEW * scale));

  // ── 4. Búsqueda exhaustiva ───────────────────────────────────────────
  // py y px están acotados para que el auto-ajuste sea un microajuste:
  //   - py ≤ 85 % de la altura del tile → la fila A siempre tiene ≥ 15 % de solape de página
  //   - px ≤ 85 % del ancho del tile    → la col 1 siempre tiene ≥ 15 % de solape de página
  const MAX_PY_MM = Math.floor(tileHpx / PT_PER_MM_PREVIEW / scale * 0.85 / 5) * 5;
  const MAX_PX_MM = Math.floor(tileWpx / PT_PER_MM_PREVIEW / scale * 0.85 / 5) * 5;

  const STEP_MM = 5;
  let bestScore = Infinity, bestPX = 0, bestPY = 0;

  for (let px = 0; px <= MAX_PX_MM; px += STEP_MM) {
    const pxPx = px * PT_PER_MM_PREVIEW * scale;
    const cols = Math.ceil((srcWpx + pxPx) / tileWpx);
    let colScore = 0;
    for (let c = 1; c < cols; c++) {
      const x = ofsX + c * tileWpx - pxPx;
      if (x > 0 && x < W) colScore += colBand(x, bandPx);
    }
    for (let py = 0; py <= MAX_PY_MM; py += STEP_MM) {
      const pyPx = py * PT_PER_MM_PREVIEW * scale;
      const rows = Math.ceil((srcHpx + pyPx) / tileHpx);
      let rowScore = 0;
      for (let r = 1; r < rows; r++) {
        const y = ofsY + r * tileHpx - pyPx;
        if (y > 0 && y < H) rowScore += rowBand(y, bandPx);
      }
      const score = colScore + rowScore;
      if (score < bestScore) { bestScore = score; bestPX = px; bestPY = py; }
    }
  }

  return { paddingX: bestPX, paddingY: bestPY };
}

/**
 * Wrapper que usa las variables globales del modal de preview.
 * Se mantiene por compatibilidad con el botón individual.
 */
function findOptimalPadding() {
  return computeOptimalPadding(
    pdfImageData, pdfOffsetX, pdfOffsetY,
    previewRenderScale, previewFile, previewFormat
  );
}

// ── AUTO-AJUSTE MASIVO ────────────────────────────────────────────────────────
/**
 * Auto-ajusta el grid para TODOS los archivos listos, para cada formato activo.
 * Renderiza cada PDF a un canvas fuera de pantalla y corre el mismo algoritmo
 * que el botón individual del modal, sin necesidad de abrir ningún preview.
 */
async function batchAutoAdjust() {
  const readyFiles = state.files.filter(f => f.status === 'ready' || f.status === 'done');
  if (!readyFiles.length) return;

  const doA4     = chkFormatA4.checked;
  const doLetter = chkFormatLetter.checked;
  if (!doA4 && !doLetter) {
    showHint('Seleccioná al menos un formato para auto-ajustar.', 'warn');
    return;
  }
  // Plotter no tiene grilla que auto-ajustar, se ignora aquí

  const btn = document.getElementById('btnBatchAutoAdjust');
  btn.disabled = true;

  // Escala de renderizado para análisis: el lado más largo queda en ~450 px
  // (menor que el preview para ir más rápido, suficiente para el algoritmo)
  const BATCH_MAX_PX = 900;
  const formatsToRun = [];
  if (doA4)     formatsToRun.push('a4');
  if (doLetter) formatsToRun.push('letter');

  let done = 0;
  for (const f of readyFiles) {
    btn.textContent = `⏳ ${done + 1}/${readyFiles.length}`;
    await new Promise(r => setTimeout(r, 0));  // yield para refrescar UI

    try {
      const arrayBuffer = await window.tilerAPI.readPdfForPreview(f.path);
      const scale = BATCH_MAX_PX / (Math.max(f.widthMm, f.heightMm) * PT_PER_MM_PREVIEW);

      // Renderizar PDF a canvas temporal (una sola vez para todos los formatos)
      const offCanvas = document.createElement('canvas');
      await renderPDFtoCanvas(arrayBuffer, offCanvas, scale);

      for (const fmt of formatsToRun) {
        const { wPt, hPt } = FORMAT_DIMS[fmt];
        const tileWpx = Math.round(wPt * scale);
        const tileHpx = Math.round(hPt * scale);

        // Canvas compuesto con un tile de margen (igual que el modal de preview)
        const comp = document.createElement('canvas');
        comp.width  = offCanvas.width  + 2 * tileWpx;
        comp.height = offCanvas.height + 2 * tileHpx;
        const ctx = comp.getContext('2d');
        ctx.fillStyle = '#c8c8d4';
        ctx.fillRect(0, 0, comp.width, comp.height);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(tileWpx, tileHpx, offCanvas.width, offCanvas.height);
        ctx.drawImage(offCanvas, tileWpx, tileHpx);

        const imgData = ctx.getImageData(0, 0, comp.width, comp.height);
        const result  = computeOptimalPadding(imgData, tileWpx, tileHpx, scale, f, fmt);

        if (fmt === 'a4') {
          f.paddingX_a4  = result.paddingX;
          f.paddingY_a4  = result.paddingY;
          f.adjusted_a4  = result.paddingX > 0 || result.paddingY > 0;
        } else {
          f.paddingX_letter  = result.paddingX;
          f.paddingY_letter  = result.paddingY;
          f.adjusted_letter  = result.paddingX > 0 || result.paddingY > 0;
        }
      }
      done++;
    } catch (err) {
      console.warn('batchAutoAdjust skip:', f.name, err.message);
    }
  }

  renderTable();
  btn.textContent = '✨ AutoAjustar todos';
  btn.disabled    = false;

  const fmtLabel = doA4 && doLetter ? 'A4 y Carta' : doA4 ? 'A4' : 'Carta';
  showHint(`✅ ${done} archivo(s) auto-ajustados (${fmtLabel})`, 'ok');
}

// ════════════════════════════════════════════════════════════════════════════
// ── PANEL MINIATURA DEL PLOTTER ───────────────────────────────────────────
// Muestra el PDF fuente a escala reducida con grids A4 (azul) y
// Carta (naranja) superpuestos para verificar conteos antes de exportar.
// ════════════════════════════════════════════════════════════════════════════

const thumbCanvasEl   = document.getElementById('thumbCanvas');
const thumbGridCvEl   = document.getElementById('thumbGridCanvas');
const thumbPlaceholderEl = document.getElementById('thumbPlaceholder');
const thumbLoadingEl  = document.getElementById('thumbLoading');
const thumbInfoEl     = document.getElementById('thumbInfo');
const thumbNavEl      = document.getElementById('thumbNav');
const thumbNavLabelEl = document.getElementById('thumbNavLabel');
const btnThumbPrev    = document.getElementById('btnThumbPrev');
const btnThumbNext    = document.getElementById('btnThumbNext');

let thumbFileIdx = -1;   // índice del archivo mostrado en el thumb
let thumbScale   = 1;    // escala de renderizado
let thumbOfsX    = 0;    // offset X del PDF dentro del canvas thumb
let thumbOfsY    = 0;    // offset Y del PDF dentro del canvas thumb

/** Selecciona el archivo más reciente listo y renderiza su thumb */
function autoSelectThumb() {
  const readyIdx = [...state.files].map((f, i) => ({ f, i }))
    .filter(({ f }) => f.status === 'ready' || f.status === 'done')
    .map(({ i }) => i);
  if (readyIdx.length) setThumbFile(readyIdx[readyIdx.length - 1]);
  updateThumbNav();
}

/** Establece qué archivo se muestra en el thumb */
function setThumbFile(idx) {
  if (idx === thumbFileIdx) { redrawThumbGrid(); return; }
  thumbFileIdx = idx;
  renderPlotterThumb();
}

/** Renderiza el PDF fuente en el canvas del thumb */
async function renderPlotterThumb() {
  const f = thumbFileIdx >= 0 ? state.files[thumbFileIdx] : null;
  if (!f || !f.widthMm) return;

  thumbPlaceholderEl.style.display = 'none';
  thumbLoadingEl.style.display     = 'flex';
  thumbCanvasEl.style.display      = 'none';

  try {
    const arrayBuffer = await window.tilerAPI.readPdfForPreview(f.path);

    // Escala: lado más largo del plotter → ~210 px
    const THUMB_MAX = 210;
    const srcMaxPt  = Math.max(f.widthMm, f.heightMm) * PT_PER_MM_PREVIEW;
    thumbScale = THUMB_MAX / srcMaxPt;

    // Renderizar el PDF en un canvas temporal
    const offCv = document.createElement('canvas');
    await renderPDFtoCanvas(arrayBuffer, offCv, thumbScale);

    // Margen = ~25% de un tile A4 (compacto pero visible)
    const { wPt: a4w, hPt: a4h } = FORMAT_DIMS['a4'];
    thumbOfsX = Math.round(a4w * thumbScale * 0.25);
    thumbOfsY = Math.round(a4h * thumbScale * 0.25);

    thumbCanvasEl.width  = offCv.width  + 2 * thumbOfsX;
    thumbCanvasEl.height = offCv.height + 2 * thumbOfsY;
    thumbGridCvEl.width  = thumbCanvasEl.width;
    thumbGridCvEl.height = thumbCanvasEl.height;

    const ctx = thumbCanvasEl.getContext('2d');
    ctx.fillStyle = '#c8c8d4';
    ctx.fillRect(0, 0, thumbCanvasEl.width, thumbCanvasEl.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(thumbOfsX, thumbOfsY, offCv.width, offCv.height);
    ctx.drawImage(offCv, thumbOfsX, thumbOfsY);

    thumbCanvasEl.style.display = 'block';
    redrawThumbGrid();
    updateThumbInfo(f);
  } catch (err) {
    console.error('Thumb error:', err);
    thumbPlaceholderEl.style.display = 'flex';
  } finally {
    thumbLoadingEl.style.display = 'none';
  }
}

/** Redibuja solo los grids overlay (sin re-renderizar el PDF) */
function redrawThumbGrid() {
  const f = thumbFileIdx >= 0 ? state.files[thumbFileIdx] : null;
  if (!f || !f.widthMm || !thumbCanvasEl.width) return;

  const ctx = thumbGridCvEl.getContext('2d');
  ctx.clearRect(0, 0, thumbGridCvEl.width, thumbGridCvEl.height);

  if (chkFormatA4.checked)     drawThumbGridLayer(ctx, f, 'a4',     'rgba(40, 80, 220, 0.55)');
  if (chkFormatLetter.checked) drawThumbGridLayer(ctx, f, 'letter', 'rgba(210, 110, 20, 0.60)');

  updateThumbInfo(f);
}

/** Dibuja las líneas de un formato de grid sobre el thumb */
function drawThumbGridLayer(ctx, f, fmt, color) {
  const { wPt, hPt } = FORMAT_DIMS[fmt];
  const tileW  = wPt * thumbScale;
  const tileH  = hPt * thumbScale;
  const srcWpx = f.widthMm  * PT_PER_MM_PREVIEW * thumbScale;
  const srcHpx = f.heightMm * PT_PER_MM_PREVIEW * thumbScale;
  const cols   = Math.ceil(srcWpx / tileW);
  const rows   = Math.ceil(srcHpx / tileH);

  ctx.strokeStyle = color;
  ctx.lineWidth   = 1;

  for (let c = 0; c <= cols; c++) {
    const x = thumbOfsX + c * tileW;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, thumbGridCvEl.height); ctx.stroke();
  }
  for (let r = 0; r <= rows; r++) {
    const y = thumbOfsY + r * tileH;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(thumbGridCvEl.width, y); ctx.stroke();
  }

  // Borde del patrón
  ctx.strokeStyle = color.replace(/[\d.]+\)$/, '0.85)');
  ctx.lineWidth   = 1.5;
  ctx.strokeRect(thumbOfsX + 0.5, thumbOfsY + 0.5, srcWpx - 1, srcHpx - 1);
}

/** Actualiza el panel de conteos bajo el thumb */
function updateThumbInfo(f) {
  if (!f || !f.widthMm) { thumbInfoEl.innerHTML = ''; return; }
  let html = '';
  if (chkFormatA4.checked) {
    const { wPt, hPt } = FORMAT_DIMS['a4'];
    const c = Math.ceil(f.widthMm * PT_PER_MM_PREVIEW / wPt);
    const r = Math.ceil(f.heightMm * PT_PER_MM_PREVIEW / hPt);
    html += `<span class="thumb-count thumb-count-a4">A4: ${c}×${r} = ${c*r}</span>`;
  }
  if (chkFormatLetter.checked) {
    const { wPt, hPt } = FORMAT_DIMS['letter'];
    const c = Math.ceil(f.widthMm * PT_PER_MM_PREVIEW / wPt);
    const r = Math.ceil(f.heightMm * PT_PER_MM_PREVIEW / hPt);
    html += `<span class="thumb-count thumb-count-letter">Carta: ${c}×${r} = ${c*r}</span>`;
  }
  thumbInfoEl.innerHTML = html;
}

/** Actualiza los controles de navegación prev/next */
function updateThumbNav() {
  const readyIdxs = state.files.reduce((acc, f, i) => {
    if (f.status === 'ready' || f.status === 'done') acc.push(i);
    return acc;
  }, []);
  const total = readyIdxs.length;
  thumbNavEl.style.display = total > 1 ? 'flex' : 'none';
  if (total > 0 && thumbFileIdx >= 0) {
    const pos = readyIdxs.indexOf(thumbFileIdx) + 1;
    thumbNavLabelEl.textContent = `${pos > 0 ? pos : 1}/${total}`;
  }
}

btnThumbPrev.addEventListener('click', () => {
  const idxs = state.files.reduce((acc, f, i) => {
    if (f.status === 'ready' || f.status === 'done') acc.push(i);
    return acc;
  }, []);
  const pos = idxs.indexOf(thumbFileIdx);
  if (pos > 0) { setThumbFile(idxs[pos - 1]); updateThumbNav(); }
});

btnThumbNext.addEventListener('click', () => {
  const idxs = state.files.reduce((acc, f, i) => {
    if (f.status === 'ready' || f.status === 'done') acc.push(i);
    return acc;
  }, []);
  const pos = idxs.indexOf(thumbFileIdx);
  if (pos >= 0 && pos < idxs.length - 1) { setThumbFile(idxs[pos + 1]); updateThumbNav(); }
});

// ── Inicialización de labels de formato ───────────────────────────────────────
updateFormatLabels();

// ── Panel de carga al sitio ───────────────────────────────────────────────────
function updateUploadPanel() {
  const hasFiles = state.files && state.files.length > 0;
  btnUploadToSite.disabled = !hasFiles;
  btnUploadToSite.title = hasFiles ? '' : 'Cargá al menos un PDF para subir';

  // Advertencias de validación — distingue entre código no existe vs talla no disponible
  let warnEl = document.getElementById('codeValidationWarn');
  const noCode  = state.files.filter(f => f.parsedCode && codeValidation[`${f.parsedCode}__${f.parsedTalla}`]?.codeExists === false);
  const noTalla = state.files.filter(f => f.parsedCode && codeValidation[`${f.parsedCode}__${f.parsedTalla}`]?.tallaExists === false);

  if (noCode.length || noTalla.length) {
    if (!warnEl) {
      warnEl = document.createElement('div');
      warnEl.id = 'codeValidationWarn';
      warnEl.style.cssText = 'margin:6px 0 0;font-size:11px;padding:6px 8px;border-radius:6px;line-height:1.6;';
      btnUploadToSite.parentNode.insertBefore(warnEl, btnUploadToSite.nextSibling);
    }
    let html = '';
    if (noCode.length) {
      const codes = [...new Set(noCode.map(f => f.parsedCode))].join(', ');
      html += `<div style="color:#b45309;background:#fef3cd;padding:4px 6px;border-radius:4px;margin-bottom:4px;">⚠️ Código(s) no encontrado(s) en el catálogo: <b>${codes}</b>. Creá el producto antes de subir.</div>`;
    }
    if (noTalla.length) {
      const details = [...new Set(noTalla.map(f => {
        const avail = codeValidation[`${f.parsedCode}__${f.parsedTalla}`]?.availableSizes?.join(', ') || '—';
        return `<b>${f.parsedCode}</b> T${f.parsedTalla} (disponibles: ${avail})`;
      }))].join(', ');
      html += `<div style="color:#92400e;background:#fef3cd;padding:4px 6px;border-radius:4px;">⚠️ Talla no disponible para: ${details}. Verificá el panel admin.</div>`;
    }
    warnEl.innerHTML = html;
  } else if (warnEl) {
    warnEl.remove();
  }
}

btnUploadToSite?.addEventListener('click', async () => {
  console.log('files en state:', state.files?.length);
  if (!state.files || state.files.length === 0) {
    uploadStatus.textContent = '⚠️ No hay archivos cargados para subir';
    return;
  }

  const formats = [];
  if (chkFormatA4.checked)      formats.push('a4');
  if (chkFormatLetter.checked)  formats.push('letter');
  if (chkFormatPlotter.checked) formats.push('plotter');
  if (!formats.length) {
    uploadStatus.textContent = '⚠️ Seleccioná al menos un formato';
    return;
  }

  btnUploadToSite.disabled = true;
  uploadStatus.textContent = '⬆️ Procesando y subiendo...';

  const result = await window.tilerAPI.processAndUpload({
    files:   state.files.map(f => ({
      name:            f.name,
      path:            f.path,
      paddingX_a4:     f.paddingX_a4     || 0,
      paddingY_a4:     f.paddingY_a4     || 0,
      paddingX_letter: f.paddingX_letter || 0,
      paddingY_letter: f.paddingY_letter || 0,
    })),
    formats,
  });

  btnUploadToSite.disabled = false;

  // Acumular errores de esta subida en el log de sesión
  if (result.errors.length > 0) {
    const ts = new Date().toLocaleString('es-CL');
    result.errors.forEach(e => sessionErrors.push({ ...e, ts }));
    btnRetryErrors.style.display      = 'block';
    btnDownloadErrorLog.style.display = 'block';
  }

  // Notificación del sistema al terminar
  const notifTitle = result.errors.length === 0
    ? '✅ Carga completada'
    : `⚠️ Carga con ${result.errors.length} error(es)`;
  const notifBody = result.errors.length === 0
    ? `${result.uploaded} archivos subidos correctamente a Moldes Fácil.`
    : `${result.uploaded} subidos · ${result.errors.length} con error. Descargá el reporte para revisar.`;
  new Notification(notifTitle, { body: notifBody, silent: false });

  if (result.errors.length === 0) {
    uploadStatus.innerHTML = `<span style="color:#2a7a2a;">✅ ${result.uploaded} archivos subidos correctamente</span>`;
  } else {
    const errLines = result.errors
      .map(e => `<li style="margin:2px 0;"><b>${e.name}</b> — <span style="color:#999;">${e.error}</span></li>`)
      .join('');
    uploadStatus.innerHTML = `
      <span style="color:#2a7a2a;">✅ ${result.uploaded} subidos</span>
      &nbsp;·&nbsp;
      <span style="color:#c0392b;">⚠️ ${result.errors.length} con error:</span>
      <ul style="margin:6px 0 0 0; padding-left:16px; font-size:11px; max-height:120px; overflow-y:auto;">
        ${errLines}
      </ul>`;
  }
  refreshHistoryIfOpen();
});

// ── Reintentar archivos con error ─────────────────────────────────────────────
btnRetryErrors.addEventListener('click', async () => {
  if (!sessionErrors.length) return;

  // Obtener nombres únicos de archivos con error (sin sufijo de formato)
  const errorNames = new Set(sessionErrors.map(e => e.name));

  // Buscar esos archivos en state.files por nombre base
  const filesToRetry = state.files.filter(f => {
    const base = f.name.replace(/\.pdf$/i, '');
    // Puede matchear el archivo fuente o el archivo tileado con sufijo
    return errorNames.has(f.name) ||
      errorNames.has(`${base} A4.pdf`) ||
      errorNames.has(`${base} Carta.pdf`) ||
      errorNames.has(`${base} Plotter.pdf`) ||
      [...errorNames].some(n => n.startsWith(base));
  });

  if (!filesToRetry.length) {
    uploadStatus.innerHTML = `<span style="color:#e67e22;">⚠️ No se encontraron los archivos originales para reintentar.</span>`;
    return;
  }

  const formats = [];
  if (chkFormatA4.checked)      formats.push('a4');
  if (chkFormatLetter.checked)  formats.push('letter');
  if (chkFormatPlotter.checked) formats.push('plotter');
  if (!formats.length) {
    uploadStatus.textContent = '⚠️ Seleccioná al menos un formato';
    return;
  }

  // Limpiar errores previos de estos archivos para no duplicar
  const retryNames = new Set(filesToRetry.map(f => f.name.replace(/\.pdf$/i, '')));
  sessionErrors = sessionErrors.filter(e =>
    !retryNames.has(e.name.replace(/\s+(A4|Carta|Plotter)\.pdf$/i, '').replace(/\.pdf$/i, ''))
  );

  btnRetryErrors.disabled = true;
  btnUploadToSite.disabled = true;
  uploadStatus.textContent = `🔁 Reintentando ${filesToRetry.length} archivo(s)…`;

  const result = await window.tilerAPI.processAndUpload({
    files: filesToRetry.map(f => ({
      name:            f.name,
      path:            f.path,
      paddingX_a4:     f.paddingX_a4     || 0,
      paddingY_a4:     f.paddingY_a4     || 0,
      paddingX_letter: f.paddingX_letter || 0,
      paddingY_letter: f.paddingY_letter || 0,
    })),
    formats,
  });

  btnRetryErrors.disabled  = false;
  btnUploadToSite.disabled = false;

  if (result.errors.length > 0) {
    const ts = new Date().toLocaleString('es-CL');
    result.errors.forEach(e => sessionErrors.push({ ...e, ts }));
    btnRetryErrors.style.display      = 'block';
    btnDownloadErrorLog.style.display = 'block';
    uploadStatus.innerHTML = `<span style="color:#e67e22;">🔁 Reintento: ${result.uploaded} subidos, ${result.errors.length} siguen con error.</span>`;
  } else {
    btnRetryErrors.style.display = 'none';
    uploadStatus.innerHTML = `<span style="color:#2a7a2a;">✅ Reintento exitoso — ${result.uploaded} archivos subidos.</span>`;
  }

  new Notification(result.errors.length === 0 ? '✅ Reintento completado' : '⚠️ Aún hay errores', {
    body: `${result.uploaded} subidos · ${result.errors.length} con error.`,
  });
  refreshHistoryIfOpen();
});

// ── Descargar reporte de errores de la sesión ─────────────────────────────────
btnDownloadErrorLog.addEventListener('click', () => {
  const fecha  = new Date().toLocaleString('es-CL');
  const linea  = '─'.repeat(50);

  const lines = [
    'REPORTE DE ERRORES — Moldes Fácil Tiler',
    `Generado: ${fecha}`,
    linea,
    `Total de errores en la sesión: ${sessionErrors.length}`,
    '',
    ...sessionErrors.map((e, i) =>
      `${i + 1}. [${e.ts}]\n   Archivo: ${e.name}\n   Error:   ${e.error}`
    ),
    '',
    linea,
    'Revisá estos archivos en el catálogo web y volvé a intentar la carga.',
  ];

  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `errores-tiler-${new Date().toISOString().slice(0,10)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
});

window.tilerAPI.onUploadProgress?.((data) => {
  uploadStatus.textContent = `⬆️ ${data.name} — ${data.status}`;
});

window.tilerAPI.onProcessUploadProgress?.((data) => {
  uploadStatus.textContent = `⬆️ ${data.current}/${data.total} — ${data.name}`;
});

// ── Historial de cargas + estado de sincronización con Google Sheets ──────────
const historyPanel = document.getElementById('historyPanel');
const historyList  = document.getElementById('historyList');
const historyArrow = document.getElementById('historyArrow');

async function renderSheetsSyncStatus() {
  const size = await window.tilerAPI.getSheetsQueueSize?.() ?? 0;
  let syncEl = document.getElementById('sheetsSyncStatus');
  if (!syncEl) {
    syncEl = document.createElement('div');
    syncEl.id = 'sheetsSyncStatus';
    syncEl.style.cssText = 'margin-top:6px;font-size:11px;display:flex;align-items:center;gap:8px;';
    historyList?.parentNode?.insertBefore(syncEl, historyList);
  }
  if (size === 0) {
    syncEl.innerHTML = '<span style="color:#16a34a;">☁️ Google Sheets sincronizado</span>';
  } else {
    syncEl.innerHTML = `
      <span style="color:#b45309;">⏳ ${size} registro(s) pendiente(s) de sincronizar</span>
      <button id="btnSyncNow" style="font-size:11px;padding:2px 8px;border:1px solid #5b3cdc;background:#fff;color:#5b3cdc;border-radius:4px;cursor:pointer;">
        Sincronizar ahora
      </button>`;
    document.getElementById('btnSyncNow')?.addEventListener('click', async () => {
      syncEl.innerHTML = '<span style="color:#888;">⟳ Sincronizando…</span>';
      const res = await window.tilerAPI.flushSheetsQueue();
      await renderSheetsSyncStatus();
      if (res.remaining === 0) loadAndRenderHistory();
    });
  }
}

async function loadAndRenderHistory() {
  if (!window.tilerAPI.loadUploadHistory) return;
  await renderSheetsSyncStatus();
  const hist = await window.tilerAPI.loadUploadHistory();
  if (!hist.length) {
    historyList.innerHTML = '<p style="color:#aaa;font-style:italic;margin:0;">Sin cargas registradas aún.</p>';
    return;
  }
  historyList.innerHTML = hist.slice(0, 20).map(entry => {
    const dt   = new Date(entry.ts).toLocaleString('es-CL', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    const errTag = entry.errors > 0
      ? `<span style="color:#c0392b;margin-left:6px;">⚠️ ${entry.errors} error(es)</span>`
      : `<span style="color:#16a34a;margin-left:6px;">✓ sin errores</span>`;
    return `
      <div style="padding:5px 0;border-bottom:1px solid #f0f0f0;">
        <span style="color:#888;">${dt}</span>
        — <b>${entry.uploaded}</b> subido(s)${errTag}
        <div style="color:#aaa;font-size:10px;margin-top:1px;">${entry.files.slice(0,3).map(escHtml).join(', ')}${entry.files.length > 3 ? ` +${entry.files.length - 3} más` : ''}</div>
      </div>`;
  }).join('');
}

if (historyPanel) {
  historyPanel.addEventListener('toggle', () => {
    if (historyArrow) historyArrow.style.transform = historyPanel.open ? 'rotate(90deg)' : '';
    if (historyPanel.open) loadAndRenderHistory();
  });
}

function refreshHistoryIfOpen() {
  if (historyPanel?.open) loadAndRenderHistory();
}


```

---


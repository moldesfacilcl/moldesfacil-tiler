/**
 * main.js — Proceso principal Electron
 * Moldes Fácil Tiler
 */

// En macOS, crear worker_threads genera SIGCHLD que puede interrumpir un
// readFileSync en el proceso principal con EINTR. Lo atrapamos aquí para
// que no tire abajo toda la app — el worker se reintentará en el próximo uso.
process.on('uncaughtException', (err) => {
  if (err.code === 'EINTR') return; // señal del SO, no es un error real
  console.error('[uncaughtException]', err);
  dialog.showErrorBox('Error inesperado', err.message || String(err));
});

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const crypto     = require('crypto');
const WorkerPool = require('./tiler/workerPool');
const { A4_W, A4_H, LETTER_W, LETTER_H, normalizePlotterPdf } = require('./tiler/pdfTilerEngine');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

let _sheetsSync = null;
function getSheetsModule() {
  if (!_sheetsSync) _sheetsSync = require('./sheets-sync');
  return _sheetsSync;
}
function syncToSheets(...args) { return getSheetsModule().syncToSheets(...args); }
function flushPendingQueue() { return getSheetsModule().flushPendingQueue(); }
function getQueueSize() { return getSheetsModule().getQueueSize(); }

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
const ACCESS_EMAIL  = 'info@moldesfacil.com';
const ACCESS_HASH   = crypto.createHash('sha256').update('MoldesFacil2026').digest('hex');
const SESSION_TTL   = 30 * 24 * 60 * 60 * 1000; // 30 días

function getSessionFile() {
  return path.join(app.getPath('userData'), 'session.json');
}

function isSessionValid() {
  try {
    const s = JSON.parse(fs.readFileSync(getSessionFile(), 'utf8'));
    return s.token === ACCESS_HASH && Date.now() - s.ts < SESSION_TTL;
  } catch { return false; }
}

function saveSession() {
  fs.writeFileSync(getSessionFile(), JSON.stringify({ token: ACCESS_HASH, ts: Date.now() }));
}

ipcMain.handle('logout', (event) => {
  try { fs.unlinkSync(getSessionFile()); } catch {}
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

function requirePlotterContentBounds(file) {
  if (!file.plotterContentBounds) {
    throw new Error('No se pudo medir el contenido del Plotter antes de exportarlo.');
  }
  return file.plotterContentBounds;
}

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
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
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
  mainWindow.loadFile(path.join(__dirname, startPage));
  mainWindow.on('closed', () => { mainWindow = null; });
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();
  // Pre-inicializar el pool de workers 2 s después del arranque, cuando el
  // proceso principal ya terminó de cargar módulos y no hay riesgo de EINTR.
  setTimeout(() => getPool(), 2000);
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

      // Si es plotter, normalizar orientación (90 cm = ancho) y guardar
      if (fmt === 'plotter') {
        const pdfFileName = `${baseName} Plotter.pdf`;
        const outputPath  = path.join(destFolders[fmt], pdfFileName);
        if (!skipIfExists || !fs.existsSync(outputPath)) {
          const srcBuf  = await fs.promises.readFile(file.path);
          const outBuf  = await normalizePlotterPdf(srcBuf, requirePlotterContentBounds(file));
          await fs.promises.writeFile(outputPath, outBuf);
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
  const buf = await fs.promises.readFile(filePath);
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
      const arr  = Array.isArray(data) ? data : (Array.isArray(data?.result) ? data.result : (Array.isArray(data?.data) ? data.data : []));
      const mold = arr.find(m => _norm(m.code) === _norm(code));
      if (!mold) {
        results[key] = { codeExists: false, tallaExists: null, availableSizes: [] };
      } else {
        const sizes          = Array.isArray(mold.sizes) ? mold.sizes : [];
        const canonicalTalla = talla
          ? (sizes.find(s => _normMatch(s) === _normMatch(talla)) ?? null)
          : null;
        const tallaExists    = talla ? canonicalTalla !== null : true;
        results[key] = { codeExists: true, tallaExists, availableSizes: sizes, canonicalTalla };
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

// ── Resolución de talla canónica ─────────────────────────────────────────────
// Consulta la API y devuelve el valor exacto de la talla como está en el catálogo.
// Lanza Error si el código no existe o si la talla no está disponible para ese molde.
const _norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Variantes de género/acento que el catálogo registra en masculino.
// Clave: valor normalizado (sin tildes, minúsculas) de la variante del archivo.
// Valor: forma normalizada equivalente del catálogo.
const TALLA_GENDER_MAP = {
  'unica':   'unico',   // "unica" / "única"  → "Único"
  'pequena': 'pequeno', // "pequeña"          → "Pequeño"
  'mediana': 'mediano', // "mediana"          → "Mediano"
  'adulta':  'adulto',  // "adulta"           → "ADULTO"
  'nina':    'nino',    // "niña"             → "NIÑO"
  'grande':  'grande',  // sin cambio, pero explícito
};

// Normaliza para comparación: quita tildes, minúsculas, y aplica mapa de género.
const _normMatch = s => {
  const base = _norm(s);
  return TALLA_GENDER_MAP[base] ?? base;
};

const _tallaCache = new Map(); // evita llamadas repetidas dentro del mismo batch

async function resolveCanonicalTalla(code, rawTalla) {
  const cacheKey = `${code}__${_normMatch(rawTalla)}`;
  if (_tallaCache.has(cacheKey)) return _tallaCache.get(cacheKey);

  const res = await fetch(`${API_URL}/molds?search=${encodeURIComponent(code)}&itemsPerPage=15`);
  if (!res.ok) throw new Error(`API no disponible al verificar código ${code}`);
  const data = await res.json();
  const arr  = Array.isArray(data) ? data : (Array.isArray(data?.result) ? data.result : (Array.isArray(data?.data) ? data.data : []));
  const mold = arr.find(m => _norm(m.code) === _norm(code));
  if (!mold) throw new Error(`Código ${code} no existe en el catálogo`);

  const sizes = Array.isArray(mold.sizes) ? mold.sizes : [];
  const canonical = sizes.find(s => _normMatch(s) === _normMatch(rawTalla));
  if (!canonical) {
    const available = sizes.join(', ') || '(sin tallas)';
    throw new Error(`Talla "${rawTalla}" no disponible para ${code}. Disponibles: ${available}`);
  }

  _tallaCache.set(cacheKey, canonical);
  return canonical;
}

// ── Credenciales API (hardcodeadas para uso interno) ─────────────────────────
const API_URL     = 'https://api.moldesfacil.com/api';
const CREDENTIALS = { email: 'facilmoldes@gmail.com', password: 'MoldesFacil.123' };
let   _cachedToken  = null;
let   _loginPromise = null;

async function getValidToken() {
  if (_cachedToken) return _cachedToken;
  // Si ya hay un login en curso, esperar ese mismo en vez de lanzar otro
  if (!_loginPromise) {
    _loginPromise = fetch(`${API_URL}/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(CREDENTIALS),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(`Login fallido: ${data.message}`);
        _cachedToken = data.access_token;
        return _cachedToken;
      })
      .finally(() => { _loginPromise = null; });
  }
  return _loginPromise;
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

      const { code, tipo } = parsed;
      const talla = await resolveCanonicalTalla(code, parsed.talla);

      // La regla del sitio es invariable: en Plotter, 90 cm siempre es el ancho.
      const key    = `pdfs/${code}-${talla}-${tipo}-${Date.now()}.pdf`;
      const sourceBuffer = Buffer.from(file.buffer);
      const buffer = tipo === 'plotter'
        ? await normalizePlotterPdf(sourceBuffer, requirePlotterContentBounds(file))
        : sourceBuffer;

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
        _cachedToken  = null;
        _loginPromise = null;
        token         = await getValidToken();
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
    // Pre-calentar el token antes de lanzar las tareas paralelas,
    // así _cachedToken ya está listo y ningún worker dispara un login concurrente.
    await getValidToken();

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
          const srcBuf = await fs.promises.readFile(file.path);
          pdfBuffer = await normalizePlotterPdf(srcBuf, requirePlotterContentBounds(file));
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
    _tallaCache.clear(); // resetear caché por batch
    const tasks = [];
    for (const file of files) {
      const parsed = parseFileName(file.name.replace(/\.pdf$/i, ''));
      if (!parsed) {
        for (const fmt of formatList) {
          results.errors.push({ name: file.name, error: 'Nombre no reconocido' });
          event.sender.send('upload-progress', { name: file.name, status: 'error', error: 'Nombre no reconocido' });
          done++;
          event.sender.send('process-upload-progress', { current: done, total, name: file.name, status: 'error' });
        }
        continue;
      }
      const { code } = parsed;
      let talla;
      try {
        talla = await resolveCanonicalTalla(code, parsed.talla);
      } catch (err) {
        for (const fmt of formatList) {
          results.errors.push({ name: file.name, error: err.message });
          event.sender.send('upload-progress', { name: file.name, status: 'error', error: err.message });
          done++;
          event.sender.send('process-upload-progress', { current: done, total, name: file.name, status: 'error' });
        }
        continue;
      }
      const baseName = normalizeOutputName(code, talla);
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

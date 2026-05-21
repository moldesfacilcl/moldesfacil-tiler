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

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
        needsRotation: dim.needsRotation,
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
    if (formats.includes('plotter')) {
      progressLabel.textContent = 'Midiendo contenido para recortar Plotter...';
      await preparePlotterContentBounds(filesToProcess);
    }

    const files = filesToProcess.map(f => ({
      path:                 f.path,
      name:                 f.name,
      paddingX_a4:          (f.paddingX_a4     || 0) * PT_PER_MM_PREVIEW,
      paddingY_a4:          (f.paddingY_a4     || 0) * PT_PER_MM_PREVIEW,
      paddingX_letter:      (f.paddingX_letter || 0) * PT_PER_MM_PREVIEW,
      paddingY_letter:      (f.paddingY_letter || 0) * PT_PER_MM_PREVIEW,
      plotterContentBounds: f.plotterContentBounds || null,
    }));

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
  const effCols = cols;
  const effRows = rows;
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
 * Mide el contenido visible del Plotter ya orientado.
 * La pagina final conserva 43 pt abajo y como maximo 10 pt arriba.
 */
async function preparePlotterContentBounds(files) {
  for (const file of files) {
    if (file.plotterContentBounds) continue;

    const arrayBuffer = await window.tilerAPI.readPdfForPreview(file.path);
    const maxSourcePt = Math.max(file.widthMm, file.heightMm) * PT_PER_MM_PREVIEW;
    const scale = Math.min(1, 6000 / maxSourcePt);
    const canvas = document.createElement('canvas');
    await renderPDFtoCanvas(arrayBuffer, canvas, scale);

    const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    if (maxX < 0) throw new Error(`No se encontro contenido visible en ${file.name}.`);

    const sourceHeightPt = file.heightMm * PT_PER_MM_PREVIEW;
    file.plotterContentBounds = file.needsRotation
      ? { bottomPt: minX / scale, topPt: (maxX + 1) / scale }
      : { bottomPt: sourceHeightPt - (maxY + 1) / scale, topPt: sourceHeightPt - minY / scale };
  }
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
  // paddingY/paddingX son microajustes: máximo 50 mm en cualquier eje.
  // Un valor mayor desplazaría el grid entero fuera del patrón.
  const MAX_PY_MM = 50;
  const MAX_PX_MM = 50;

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
  uploadStatus.textContent = formats.includes('plotter')
    ? 'Midiendo contenido y recortando Plotter...'
    : 'Procesando y subiendo...';

  try {
    if (formats.includes('plotter')) await preparePlotterContentBounds(state.files);
  } catch (err) {
    btnUploadToSite.disabled = false;
    uploadStatus.textContent = 'Error al medir Plotter: ' + err.message;
    return;
  }

  const result = await window.tilerAPI.processAndUpload({
    files: state.files.map(f => ({
      name:            f.name,
      path:            f.path,
      paddingX_a4:     f.paddingX_a4     || 0,
      paddingY_a4:     f.paddingY_a4     || 0,
      paddingX_letter: f.paddingX_letter || 0,
      paddingY_letter: f.paddingY_letter || 0,
      plotterContentBounds: f.plotterContentBounds || null,
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

  try {
    if (formats.includes('plotter')) await preparePlotterContentBounds(filesToRetry);
  } catch (err) {
    btnRetryErrors.disabled = false;
    btnUploadToSite.disabled = false;
    uploadStatus.textContent = 'Error al medir Plotter: ' + err.message;
    return;
  }

  const result = await window.tilerAPI.processAndUpload({
    files: filesToRetry.map(f => ({
      name:            f.name,
      path:            f.path,
      paddingX_a4:     f.paddingX_a4     || 0,
      paddingY_a4:     f.paddingY_a4     || 0,
      paddingX_letter: f.paddingX_letter || 0,
      paddingY_letter: f.paddingY_letter || 0,
      plotterContentBounds: f.plotterContentBounds || null,
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

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
        const dx = -(col * tileWidth  - paddingX);
        const dy = tileHeight - realSrcH + (row * tileHeight) - paddingY;
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

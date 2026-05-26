'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PDFDocument } = require('pdf-lib');
const {
  A4_W,
  A4_H,
  PLOTTER_BOTTOM_MARGIN_PT,
  PLOTTER_TOP_MARGIN_PT,
  PT_PER_MM,
  detectDimensions,
  normalizePlotterPdf,
  tilePDF,
} = require('../tiler/pdfTilerEngine');

async function createPdf(widthMm, heightMm) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([widthMm * PT_PER_MM, heightMm * PT_PER_MM]);
  page.drawLine({
    start: { x: 0, y: 0 },
    end: { x: 10, y: 10 },
  });
  return Buffer.from(await doc.save());
}

async function pageSizeMm(buffer) {
  const doc = await PDFDocument.load(buffer);
  const { width, height } = doc.getPages()[0].getSize();
  return {
    width: Math.round(width / PT_PER_MM),
    height: Math.round(height / PT_PER_MM),
  };
}

test('keeps a plotter that already has 90 cm as its horizontal width', async () => {
  const original = await createPdf(900, 1400);
  const output = await normalizePlotterPdf(original);

  assert.equal(output, original);
  assert.deepEqual(await pageSizeMm(output), { width: 900, height: 1400 });
});

test('rotates a plotter whose 90 cm side arrives as its height', async () => {
  const original = await createPdf(1400, 900);
  const detected = await detectDimensions(original);
  const output = await normalizePlotterPdf(original);

  assert.equal(detected.needsRotation, true);
  assert.deepEqual(await pageSizeMm(output), { width: 900, height: 1400 });
});

test('rejects plotters with no 90 cm side instead of exporting a wrong orientation', async () => {
  const invalid = await createPdf(1100, 1400);

  await assert.rejects(
    normalizePlotterPdf(invalid),
    /uno de sus lados debe medir 90 cm/
  );
});

test('uses the normalized 90 cm width when generating A4 sheets', async () => {
  const verticalInput = await createPdf(1400, 900);
  const tiled = await tilePDF(verticalInput, {
    tileWidth: A4_W,
    tileHeight: A4_H,
    addLabels: false,
    addMarks: false,
  });

  assert.equal(tiled.needsRotation, true);
  assert.equal(tiled.cols, Math.ceil((900 * PT_PER_MM) / A4_W));
  assert.equal(tiled.rows, Math.ceil((1400 * PT_PER_MM) / A4_H));
});

test('crops an oriented plotter to its visible height plus fixed margins', async () => {
  const original = await createPdf(900, 250);
  const bounds = { bottomPt: 43, topPt: 625.75 };
  const output = await normalizePlotterPdf(original, bounds);
  const size = await pageSizeMm(output);
  const expectedHeightPt = bounds.topPt - bounds.bottomPt
    + PLOTTER_BOTTOM_MARGIN_PT + PLOTTER_TOP_MARGIN_PT;

  assert.equal(size.width, 900);
  assert.equal(size.height, Math.round(expectedHeightPt / PT_PER_MM));
});

test('applies the same exact cropped height while rotating a vertical source', async () => {
  const original = await createPdf(260, 900);
  const bounds = { bottomPt: 43, topPt: 680 };
  const output = await normalizePlotterPdf(original, bounds);
  const size = await pageSizeMm(output);
  const expectedHeightPt = bounds.topPt - bounds.bottomPt
    + PLOTTER_BOTTOM_MARGIN_PT + PLOTTER_TOP_MARGIN_PT;

  assert.equal(size.width, 900);
  assert.equal(size.height, Math.round(expectedHeightPt / PT_PER_MM));
});

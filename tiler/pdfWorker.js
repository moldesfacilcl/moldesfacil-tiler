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

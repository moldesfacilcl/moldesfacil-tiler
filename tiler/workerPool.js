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

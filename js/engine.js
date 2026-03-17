/**
 * StockfishEngine — thin wrapper around a Stockfish Web Worker.
 *
 * Loads stockfish.js from CDN via a Blob URL (avoids CORS worker issues),
 * then exposes a promise-based API for setting options and requesting moves.
 */
class StockfishEngine {
  constructor() {
    this.worker = null;
    this.ready = false;
    this._messageHandlers = [];
    this._readyPromise = null;

    this.DIFFICULTY = [
      { name: 'Beginner',     skill:  0, depth:  1, moveTime:  200 },
      { name: 'Casual',       skill:  3, depth:  4, moveTime:  400 },
      { name: 'Intermediate', skill:  8, depth:  8, moveTime: 1000 },
      { name: 'Advanced',     skill: 13, depth: 13, moveTime: 2000 },
      { name: 'Expert',       skill: 17, depth: 17, moveTime: 3500 },
      { name: 'Master',       skill: 20, depth: 22, moveTime: 5000 },
    ];

    this.currentLevel = 2; // default: Intermediate
  }

  /**
   * Initialise the engine. Returns a promise that resolves when Stockfish
   * has booted and responded "uciok".
   */
  init() {
    if (this._readyPromise) return this._readyPromise;

    this._readyPromise = new Promise(async (resolve, reject) => {
      try {
        const url = 'https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js';
        const res  = await fetch(url);
        const text = await res.text();
        const blob = new Blob([text], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);

        this.worker = new Worker(blobUrl);
        this.worker.onmessage = (e) => this._onMessage(e.data);

        this._waitFor('uciok').then(() => {
          this.ready = true;
          this._applyDifficulty();
          resolve();
        });

        this.worker.postMessage('uci');
      } catch (err) {
        reject(err);
      }
    });

    return this._readyPromise;
  }

  /* ── Public API ──────────────────────────────────────────── */

  setDifficulty(level) {
    this.currentLevel = Math.max(0, Math.min(level, this.DIFFICULTY.length - 1));
    if (this.ready) this._applyDifficulty();
  }

  /**
   * Ask Stockfish for the best move given a FEN position.
   * Returns a promise that resolves to a UCI move string (e.g. "e2e4").
   */
  getBestMove(fen) {
    return new Promise((resolve) => {
      const diff = this.DIFFICULTY[this.currentLevel];
      this.worker.postMessage(`position fen ${fen}`);
      this.worker.postMessage(`go depth ${diff.depth} movetime ${diff.moveTime}`);

      this._waitFor('bestmove').then((line) => {
        const parts = line.split(' ');
        const bestmove = parts[1];
        resolve(bestmove);
      });
    });
  }

  stop() {
    if (this.worker) this.worker.postMessage('stop');
  }

  quit() {
    if (this.worker) {
      this.worker.postMessage('quit');
      this.worker.terminate();
      this.worker = null;
      this.ready = false;
      this._readyPromise = null;
    }
  }

  /* ── Internals ───────────────────────────────────────────── */

  _applyDifficulty() {
    const diff = this.DIFFICULTY[this.currentLevel];
    this._send(`setoption name Skill Level value ${diff.skill}`);
    this._send('isready');
  }

  _send(cmd) {
    if (this.worker) this.worker.postMessage(cmd);
  }

  _onMessage(data) {
    const line = typeof data === 'string' ? data : (data.data || '');
    for (let i = this._messageHandlers.length - 1; i >= 0; i--) {
      const handler = this._messageHandlers[i];
      if (line.startsWith(handler.prefix)) {
        handler.resolve(line);
        this._messageHandlers.splice(i, 1);
      }
    }
  }

  _waitFor(prefix) {
    return new Promise((resolve) => {
      this._messageHandlers.push({ prefix, resolve });
    });
  }
}

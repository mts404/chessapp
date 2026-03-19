/**
 * BoardDetector — Deterministic chess board detection for Duolingo screenshots.
 *
 * Uses histogram-mode brightness per square to find even very-low-contrast
 * boards. Uses global (median) background colors so that avatar/speech-bubble
 * overlaps on individual squares don't break occupancy detection.
 * Classifies pieces by silhouette shape — no AI needed.
 */
class BoardDetector {
  constructor() {
    this._canvas = document.createElement('canvas');
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
  }

  /**
   * @param {HTMLImageElement} img
   * @returns {{ fen, grid, annotatedBase64, boardRect } | null}
   */
  analyze(img) {
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    if (!w || !h) return null;

    this._canvas.width = w;
    this._canvas.height = h;
    this._ctx.drawImage(img, 0, 0, w, h);
    this._imgW = w;
    this._imgH = h;
    this._data = this._ctx.getImageData(0, 0, w, h).data;

    var board = this._findBoard();
    if (!board) {
      console.log('[BoardDetector] Could not find board');
      return null;
    }
    console.log('[BoardDetector] Board rect:', JSON.stringify(board));

    var result = this._analyzeGrid(board);
    var fen = this._gridToFen(result.grid);
    var annotated = this._createAnnotatedCrop(board, result.grid);

    var pCount = 0;
    for (var r = 0; r < 8; r++)
      for (var c = 0; c < 8; c++)
        if (!result.grid[r][c].empty) pCount++;

    console.log('[BoardDetector] Pieces found:', pCount, '| FEN:', fen);
    return { fen: fen, grid: result.grid, annotatedBase64: annotated, boardRect: board };
  }

  /* ───────────── Pixel helpers ───────────────────────────── */

  _grayAt(x, y) {
    var d = this._data, w = this._imgW;
    x = Math.max(0, Math.min(w - 1, Math.round(x)));
    y = Math.max(0, Math.min(this._imgH - 1, Math.round(y)));
    var i = (y * w + x) * 4;
    return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }

  _rgbAt(x, y) {
    var d = this._data, w = this._imgW;
    x = Math.max(0, Math.min(w - 1, Math.round(x)));
    y = Math.max(0, Math.min(this._imgH - 1, Math.round(y)));
    var i = (y * w + x) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  }

  _rgbDist(a, b) {
    var dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  /* ───────────── Board finding ──────────────────────────── */

  /**
   * For a candidate square, find the most common brightness (mode).
   * Because the background is the majority of pixels, this returns the
   * background brightness even when a piece occupies the square.
   */
  _squareModeBrightness(sx, sy, size) {
    var step = Math.max(1, Math.floor(size / 7));
    var bins = new Uint32Array(52);
    for (var y = Math.floor(sy + step); y < sy + size - step; y += step) {
      for (var x = Math.floor(sx + step); x < sx + size - step; x += step) {
        var g = this._grayAt(x, y);
        bins[Math.min(51, Math.floor(g / 5))]++;
      }
    }
    var best = 0, bestC = 0;
    for (var i = 0; i < 52; i++) {
      if (bins[i] > bestC) { bestC = bins[i]; best = i; }
    }
    return best * 5 + 2.5;
  }

  _checkerboardScore(bx, by, bSize) {
    var sq = bSize / 8;
    var even = [], odd = [];
    for (var r = 0; r < 8; r++) {
      for (var c = 0; c < 8; c++) {
        var v = this._squareModeBrightness(bx + c * sq, by + r * sq, sq);
        ((r + c) % 2 === 0 ? even : odd).push(v);
      }
    }
    var em = even.reduce(function (a, b) { return a + b; }, 0) / 32;
    var om = odd.reduce(function (a, b) { return a + b; }, 0) / 32;
    var contrast = Math.abs(em - om);
    var es = Math.sqrt(even.reduce(function (a, v) { return a + (v - em) * (v - em); }, 0) / 32);
    var os = Math.sqrt(odd.reduce(function (a, v) { return a + (v - om) * (v - om); }, 0) / 32);
    return contrast / (0.1 + es + os);
  }

  _findBoard() {
    var W = this._imgW, H = this._imgH;
    var bestScore = -Infinity, bestRect = null;

    var wStep = Math.max(2, Math.floor(W * 0.025));
    var yStep = Math.max(2, Math.floor(H * 0.018));
    var xStep = Math.max(2, Math.floor(W * 0.02));

    for (var bw = Math.floor(W * 0.78); bw <= W; bw += wStep) {
      var bh = bw;
      if (bh > H * 0.85) continue;
      var cx = (W - bw) / 2;
      for (var dx = -W * 0.06; dx <= W * 0.06; dx += xStep) {
        var bx = Math.round(cx + dx);
        if (bx < 0 || bx + bw > W) continue;
        for (var byPct = 0.15; byPct <= 0.58; byPct += 0.018) {
          var by = Math.round(H * byPct);
          if (by + bh > H) continue;
          var s = this._checkerboardScore(bx, by, bw);
          if (s > bestScore) { bestScore = s; bestRect = { x: bx, y: by, w: bw, h: bh }; }
        }
      }
    }

    console.log('[BoardDetector] Best checkerboard score:', bestScore.toFixed(3));
    return (bestScore >= 0.4) ? bestRect : null;
  }

  /* ───────────── Grid analysis ──────────────────────────── */

  /**
   * Get the modal RGB color of a square's background by averaging pixels
   * whose brightness is close to the square's mode brightness.
   */
  _squareColorMode(sx, sy, size) {
    var step = Math.max(1, Math.floor(size / 7));
    var bgGray = this._squareModeBrightness(sx, sy, size);
    var rs = 0, gs = 0, bs = 0, n = 0;
    for (var y = Math.floor(sy + step); y < sy + size - step; y += step) {
      for (var x = Math.floor(sx + step); x < sx + size - step; x += step) {
        if (Math.abs(this._grayAt(x, y) - bgGray) < 15) {
          var c = this._rgbAt(x, y);
          rs += c[0]; gs += c[1]; bs += c[2]; n++;
        }
      }
    }
    if (n === 0) return [240, 240, 240];
    return [Math.round(rs / n), Math.round(gs / n), Math.round(bs / n)];
  }

  _analyzeGrid(board) {
    var sqSize = board.w / 8;

    // Pass 1: compute per-square mode colors and split by parity
    var modes = [], evenCols = [], oddCols = [];
    for (var r = 0; r < 8; r++) {
      modes[r] = [];
      for (var c = 0; c < 8; c++) {
        var col = this._squareColorMode(
          board.x + c * sqSize, board.y + r * sqSize, sqSize);
        modes[r][c] = col;
        ((r + c) % 2 === 0 ? evenCols : oddCols).push(col);
      }
    }

    // Determine which parity is the lighter squares
    var evenBr = this._avgBrightness(evenCols);
    var oddBr = this._avgBrightness(oddCols);
    var lightParity = evenBr >= oddBr ? 0 : 1;

    // Compute robust median background color for each group
    var lightBg = this._medianRGB(lightParity === 0 ? evenCols : oddCols);
    var darkBg  = this._medianRGB(lightParity === 0 ? oddCols : evenCols);

    console.log('[BoardDetector] Light bg:', lightBg, ' Dark bg:', darkBg);

    // Pass 2: occupancy detection using GLOBAL background colors
    var grid = [];
    for (var r2 = 0; r2 < 8; r2++) {
      grid[r2] = [];
      for (var c2 = 0; c2 < 8; c2++) {
        var isLight = ((r2 + c2) % 2 === lightParity);
        var bg = isLight ? lightBg : darkBg;
        grid[r2][c2] = this._detectOccupancy(
          board.x + c2 * sqSize, board.y + r2 * sqSize, sqSize, bg);
      }
    }

    // Pass 3: adaptive piece colour threshold via k-means(2)
    var occupied = [];
    for (var r3 = 0; r3 < 8; r3++)
      for (var c3 = 0; c3 < 8; c3++)
        if (!grid[r3][c3].empty)
          occupied.push({ r: r3, c: c3, br: grid[r3][c3].pieceBrightness });

    if (occupied.length >= 2) {
      occupied.sort(function (a, b) { return a.br - b.br; });
      var m = Math.floor(occupied.length / 2);
      var darkAvg = occupied.slice(0, m).reduce(function (s, o) { return s + o.br; }, 0) / m;
      var lightAvg = occupied.slice(m).reduce(function (s, o) { return s + o.br; }, 0) / (occupied.length - m);
      var thresh = (darkAvg + lightAvg) / 2;
      console.log('[BoardDetector] Piece brightness — dark:', darkAvg.toFixed(1),
        'light:', lightAvg.toFixed(1), 'thresh:', thresh.toFixed(1));
      for (var k = 0; k < occupied.length; k++) {
        var o = occupied[k];
        grid[o.r][o.c].pieceColor = o.br > thresh ? 'w' : 'b';
      }
    } else if (occupied.length === 1) {
      grid[occupied[0].r][occupied[0].c].pieceColor =
        occupied[0].br > 140 ? 'w' : 'b';
    }

    // Pass 4: piece-type classification via silhouette shape
    for (var r4 = 0; r4 < 8; r4++)
      for (var c4 = 0; c4 < 8; c4++)
        if (!grid[r4][c4].empty) {
          var isL = ((r4 + c4) % 2 === lightParity);
          grid[r4][c4].pieceType = this._classifyPieceType(
            board.x + c4 * sqSize, board.y + r4 * sqSize,
            sqSize, isL ? lightBg : darkBg);
        }

    return { grid: grid, lightBg: lightBg, darkBg: darkBg };
  }

  _avgBrightness(cols) {
    var s = 0;
    for (var i = 0; i < cols.length; i++)
      s += 0.299 * cols[i][0] + 0.587 * cols[i][1] + 0.114 * cols[i][2];
    return s / cols.length;
  }

  _medianRGB(cols) {
    var rs = [], gs = [], bs = [];
    for (var i = 0; i < cols.length; i++) {
      rs.push(cols[i][0]); gs.push(cols[i][1]); bs.push(cols[i][2]);
    }
    rs.sort(function (a, b) { return a - b; });
    gs.sort(function (a, b) { return a - b; });
    bs.sort(function (a, b) { return a - b; });
    var m = Math.floor(cols.length / 2);
    return [rs[m], gs[m], bs[m]];
  }

  /**
   * Detect occupancy of a single square using global background color.
   * Returns { empty, bgColor, pieceBrightness }.
   */
  _detectOccupancy(sx, sy, sqSize, bgColor) {
    var margin = sqSize * 0.1;
    var l = Math.floor(sx + margin);
    var t = Math.floor(sy + margin);
    var r = Math.floor(sx + sqSize - margin);
    var b = Math.floor(sy + sqSize - margin);
    var step = Math.max(1, Math.floor(sqSize / 20));

    var pieceN = 0, total = 0, brSum = 0;
    for (var y = t; y < b; y += step) {
      for (var x = l; x < r; x += step) {
        var px = this._rgbAt(x, y);
        total++;
        if (this._rgbDist(px, bgColor) > 30) {
          pieceN++;
          brSum += 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2];
        }
      }
    }

    var ratio = total > 0 ? pieceN / total : 0;
    if (ratio < 0.06) return { empty: true };

    return {
      empty: false,
      pieceBrightness: pieceN > 0 ? brSum / pieceN : 128,
      pieceColor: null,
      pieceType: null,
    };
  }

  /* ───────────── Piece type from silhouette shape ───────── */

  _classifyPieceType(sx, sy, sqSize, bgColor) {
    var margin = sqSize * 0.06;
    var step = Math.max(1, Math.floor(sqSize / 28));
    var left = Math.floor(sx + margin);
    var top  = Math.floor(sy + margin);
    var right  = Math.floor(sx + sqSize - margin);
    var bottom = Math.floor(sy + sqSize - margin);

    // Build binary mask: 1 = piece pixel, 0 = background
    var mask = [];
    for (var y = top; y < bottom; y += step) {
      var row = [];
      for (var x = left; x < right; x += step) {
        row.push(this._rgbDist(this._rgbAt(x, y), bgColor) > 30 ? 1 : 0);
      }
      mask.push(row);
    }

    var mH = mask.length, mW = mask[0] ? mask[0].length : 0;
    if (mH < 4 || mW < 4) return 'P';

    // Bounding box
    var minR = mH, maxR = 0, minC = mW, maxC = 0;
    for (var mr = 0; mr < mH; mr++)
      for (var mc = 0; mc < mW; mc++)
        if (mask[mr][mc]) {
          if (mr < minR) minR = mr;
          if (mr > maxR) maxR = mr;
          if (mc < minC) minC = mc;
          if (mc > maxC) maxC = mc;
        }
    if (maxR <= minR || maxC <= minC) return 'P';

    var pieceH = (maxR - minR) / mH;  // piece height as fraction of square
    var pieceW = (maxC - minC) / mW;

    // Top-20% width ratio
    var topZone = minR + Math.floor((maxR - minR) * 0.2);
    var topMinC = mW, topMaxC = 0;
    for (var tr = minR; tr <= topZone; tr++)
      for (var tc = minC; tc <= maxC; tc++)
        if (mask[tr] && mask[tr][tc]) {
          if (tc < topMinC) topMinC = tc;
          if (tc > topMaxC) topMaxC = tc;
        }
    var topW = (topMaxC > topMinC) ? (topMaxC - topMinC) / (maxC - minC) : 0;

    // Mid-section (40-60%) width as percentage of max width
    var midTop = minR + Math.floor((maxR - minR) * 0.4);
    var midBot = minR + Math.floor((maxR - minR) * 0.6);
    var midMinC = mW, midMaxC = 0;
    for (var mr2 = midTop; mr2 <= midBot; mr2++)
      for (var mc2 = minC; mc2 <= maxC; mc2++)
        if (mask[mr2] && mask[mr2][mc2]) {
          if (mc2 < midMinC) midMinC = mc2;
          if (mc2 > midMaxC) midMaxC = mc2;
        }
    var midW = (midMaxC > midMinC) ? (midMaxC - midMinC) / (maxC - minC) : 0;

    // Left-right asymmetry
    var centerC = Math.floor((minC + maxC) / 2);
    var leftN = 0, rightN = 0;
    for (var ar = minR; ar <= maxR; ar++) {
      for (var ac = minC; ac < centerC; ac++)
        if (mask[ar] && mask[ar][ac]) leftN++;
      for (var ac2 = centerC + 1; ac2 <= maxC; ac2++)
        if (mask[ar] && mask[ar][ac2]) rightN++;
    }
    var totalN = leftN + rightN;
    var asym = totalN > 0 ? Math.abs(leftN - rightN) / totalN : 0;

    // Bottom-20% fill density (pawns have a wide base relative to their size)
    var botZone = maxR - Math.floor((maxR - minR) * 0.2);
    var botFill = 0, botTotal = 0;
    for (var br = botZone; br <= maxR; br++)
      for (var bc = minC; bc <= maxC; bc++) {
        botTotal++;
        if (mask[br] && mask[br][bc]) botFill++;
      }
    var botDensity = botTotal > 0 ? botFill / botTotal : 0;

    // ── Decision tree ──
    if (pieceH < 0.42) return 'P';

    if (asym > 0.13) return 'N';

    if (pieceH > 0.65) {
      if (topW < 0.32) return 'K';
      return 'Q';
    }

    // Medium height, symmetric
    if (topW > 0.50) return 'R';
    return 'B';
  }

  /* ───────────── FEN from grid ──────────────────────────── */

  _gridToFen(grid) {
    var fen = '';
    for (var r = 0; r < 8; r++) {
      var e = 0;
      for (var c = 0; c < 8; c++) {
        var sq = grid[r][c];
        if (sq.empty) { e++; continue; }
        if (e > 0) { fen += e; e = 0; }
        var letter = sq.pieceType || 'P';
        fen += sq.pieceColor === 'w' ? letter : letter.toLowerCase();
      }
      if (e > 0) fen += e;
      if (r < 7) fen += '/';
    }
    return fen;
  }

  /* ───────────── Annotated crop ─────────────────────────── */

  _createAnnotatedCrop(board, grid) {
    var size = board.w;
    var sq = size / 8;
    var pad = Math.max(22, Math.round(sq * 0.35));

    var cv = document.createElement('canvas');
    cv.width = size + pad;
    cv.height = size + pad;
    var cx = cv.getContext('2d');

    cx.fillStyle = '#fff';
    cx.fillRect(0, 0, cv.width, cv.height);
    cx.drawImage(this._canvas, board.x, board.y, size, size, pad, 0, size, size);

    // Draw grid lines for clarity
    cx.strokeStyle = 'rgba(0,0,0,0.15)';
    cx.lineWidth = 1;
    for (var i = 0; i <= 8; i++) {
      cx.beginPath(); cx.moveTo(pad + i * sq, 0); cx.lineTo(pad + i * sq, size); cx.stroke();
      cx.beginPath(); cx.moveTo(pad, i * sq); cx.lineTo(pad + size, i * sq); cx.stroke();
    }

    // Rank / file labels
    cx.fillStyle = '#000';
    cx.font = 'bold ' + Math.round(pad * 0.5) + 'px sans-serif';
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    for (var r = 0; r < 8; r++)
      cx.fillText(String(8 - r), pad / 2, r * sq + sq / 2);
    var files = 'abcdefgh';
    for (var f = 0; f < 8; f++)
      cx.fillText(files[f], pad + f * sq + sq / 2, size + pad / 2);

    // Mark detected pieces
    cx.font = Math.round(sq * 0.22) + 'px sans-serif';
    for (var r2 = 0; r2 < 8; r2++)
      for (var c2 = 0; c2 < 8; c2++)
        if (grid && !grid[r2][c2].empty) {
          var label = (grid[r2][c2].pieceColor === 'w' ? 'W' : 'B') +
                      (grid[r2][c2].pieceType || '?');
          cx.fillStyle = 'rgba(255,0,0,0.7)';
          cx.fillText(label, pad + c2 * sq + sq / 2, r2 * sq + sq * 0.88);
        }

    return cv.toDataURL('image/png').split(',')[1];
  }
}

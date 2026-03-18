/**
 * BoardDetector — Canvas-based chess board detection and analysis.
 *
 * Finds the board region in a screenshot using pixel analysis,
 * identifies occupied squares and piece colors deterministically,
 * and produces a clean annotated crop for AI piece-type identification.
 */
class BoardDetector {
  constructor() {
    this._canvas = document.createElement('canvas');
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
  }

  /**
   * @param {HTMLImageElement} img
   * @returns {{ grid: Array, annotatedBase64: string, boardRect: object } | null}
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
      console.log('[BoardDetector] Variance detection failed, trying positional search…');
      board = this._findBoardBySearch();
    }
    if (!board) {
      console.log('[BoardDetector] Could not detect board');
      return null;
    }

    console.log('[BoardDetector] Board found:', board);

    var sqColors = this._findSquareColors(board);
    if (!sqColors) return null;

    var grid = this._analyzeGrid(board, sqColors);
    var annotatedBase64 = this._createAnnotatedCrop(board);

    return { grid: grid, annotatedBase64: annotatedBase64, boardRect: board };
  }

  /* ── Pixel helpers ─────────────────────────────────────── */

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
    return { r: d[i], g: d[i + 1], b: d[i + 2] };
  }

  _colorDist(c1, c2) {
    return Math.sqrt(
      (c1.r - c2.r) * (c1.r - c2.r) +
      (c1.g - c2.g) * (c1.g - c2.g) +
      (c1.b - c2.b) * (c1.b - c2.b)
    );
  }

  /* ── Board detection: variance-based ───────────────────── */

  _findBoard() {
    var imgW = this._imgW, imgH = this._imgH;

    // Row variance → approximate vertical extent
    var rowVar = new Float32Array(imgH);
    for (var y = 0; y < imgH; y++) {
      var sum = 0, sumSq = 0, n = 0;
      for (var x = 0; x < imgW; x += 3) {
        var v = this._grayAt(x, y);
        sum += v; sumSq += v * v; n++;
      }
      var mean = sum / n;
      rowVar[y] = sumSq / n - mean * mean;
    }

    var rowThresh = this._maxOf(rowVar, imgH) * 0.15;
    var rowRun = this._longestRun(rowVar, rowThresh, imgH);
    if (!rowRun || rowRun.len < imgH * 0.15) return null;

    // Column variance within those rows → horizontal extent
    var colVar = new Float32Array(imgW);
    for (var x2 = 0; x2 < imgW; x2++) {
      var s = 0, s2 = 0, cn = 0;
      for (var y2 = rowRun.start; y2 < rowRun.start + rowRun.len; y2 += 3) {
        var val = this._grayAt(x2, y2);
        s += val; s2 += val * val; cn++;
      }
      var m = s / cn;
      colVar[x2] = s2 / cn - m * m;
    }

    var colThresh = this._maxOf(colVar, imgW) * 0.15;
    var colRun = this._longestRun(colVar, colThresh, imgW);
    if (!colRun || colRun.len < imgW * 0.15) return null;

    var approxSize = Math.min(rowRun.len, colRun.len);
    var approxX = colRun.start + (colRun.len - approxSize) / 2;
    var approxY = rowRun.start + (rowRun.len - approxSize) / 2;

    return this._refineBoard(approxX, approxY, approxSize);
  }

  /* ── Board detection: brute-force positional search ────── */

  _findBoardBySearch() {
    var imgW = this._imgW, imgH = this._imgH;
    var bestScore = -Infinity, bestRect = null;

    // Phone screenshots: board is square, 65-98% of image width, roughly centered
    for (var widthPct = 0.65; widthPct <= 0.99; widthPct += 0.03) {
      var size = Math.round(imgW * widthPct);
      if (size > imgH) continue;

      for (var leftPct = 0.0; leftPct <= 0.15; leftPct += 0.02) {
        var left = Math.round(imgW * leftPct);
        var right = imgW - left;
        var tryLeft = Math.round((left + right - size) / 2);
        if (tryLeft < 0 || tryLeft + size > imgW) continue;

        for (var topPct = 0.04; topPct <= 0.45; topPct += 0.03) {
          var top = Math.round(imgH * topPct);
          if (top + size > imgH) continue;

          var score = this._checkerboardScore(tryLeft, top, size);
          if (score > bestScore) {
            bestScore = score;
            bestRect = { x: tryLeft, y: top, w: size, h: size };
          }
        }
      }
    }

    console.log('[BoardDetector] Search best score:', bestScore);
    return (bestScore >= 0.3) ? bestRect : null;
  }

  /* ── Helpers ───────────────────────────────────────────── */

  _maxOf(arr, len) {
    var m = -Infinity;
    for (var i = 0; i < len; i++) { if (arr[i] > m) m = arr[i]; }
    return m;
  }

  _longestRun(arr, threshold, len) {
    // Tolerates small gaps (up to 3% of length)
    var maxGap = Math.max(3, Math.floor(len * 0.03));
    var best = null, start = 0, gap = 0, inRun = false;

    for (var i = 0; i < len; i++) {
      if (arr[i] > threshold) {
        if (!inRun) { start = i; gap = 0; inRun = true; }
        else { gap = 0; }
      } else if (inRun) {
        gap++;
        if (gap > maxGap) {
          var runLen = (i - gap) - start;
          if (runLen > 0 && (!best || runLen > best.len)) {
            best = { start: start, len: runLen };
          }
          inRun = false;
        }
      }
    }
    if (inRun) {
      var rl = (len - gap) - start;
      if (rl > 0 && (!best || rl > best.len)) {
        best = { start: start, len: rl };
      }
    }
    return best;
  }

  _refineBoard(aX, aY, aSize) {
    var imgW = this._imgW, imgH = this._imgH;
    var sqEst = aSize / 8;
    var step = Math.max(1, Math.round(sqEst * 0.12));
    var range = Math.round(sqEst * 0.8);

    var bestScore = -Infinity, bestRect = null;

    for (var ds = -range; ds <= range; ds += step) {
      var trySize = Math.round(aSize + ds);
      if (trySize < aSize * 0.7 || trySize > aSize * 1.3) continue;

      for (var dx = -range; dx <= range; dx += step) {
        for (var dy = -range; dy <= range; dy += step) {
          var tx = Math.round(aX + dx);
          var ty = Math.round(aY + dy);
          if (tx < 0 || ty < 0 || tx + trySize > imgW || ty + trySize > imgH) continue;

          var score = this._checkerboardScore(tx, ty, trySize);
          if (score > bestScore) {
            bestScore = score;
            bestRect = { x: tx, y: ty, w: trySize, h: trySize };
          }
        }
      }
    }

    console.log('[BoardDetector] Refinement best score:', bestScore);
    return (bestScore >= 0.3) ? bestRect : null;
  }

  /**
   * Score how well a region matches a checkerboard pattern.
   * Samples 8 edge points per square (robust against pieces on corners).
   */
  _checkerboardScore(bx, by, bSize) {
    var sqSize = bSize / 8;
    var m = sqSize * 0.08; // close to edge to avoid pieces
    var lightVals = [], darkVals = [];

    for (var r = 0; r < 8; r++) {
      for (var c = 0; c < 8; c++) {
        var isLight = (r + c) % 2 === 0;
        var sx = bx + c * sqSize;
        var sy = by + r * sqSize;
        var mid = sqSize / 2;

        // 8 points: 4 corners + 4 edge midpoints (near boundaries, away from pieces)
        var pts = [
          this._grayAt(sx + m,           sy + m),
          this._grayAt(sx + sqSize - m,  sy + m),
          this._grayAt(sx + m,           sy + sqSize - m),
          this._grayAt(sx + sqSize - m,  sy + sqSize - m),
          this._grayAt(sx + mid,         sy + m),
          this._grayAt(sx + mid,         sy + sqSize - m),
          this._grayAt(sx + m,           sy + mid),
          this._grayAt(sx + sqSize - m,  sy + mid),
        ];

        // Use the mode-like estimate: sort and take 25th percentile for dark squares,
        // 75th percentile for light squares (background is always the extreme)
        pts.sort(function (a, b) { return a - b; });
        var val;
        if (isLight) {
          val = (pts[5] + pts[6] + pts[7]) / 3; // top 3 (lightest = background)
        } else {
          val = (pts[0] + pts[1] + pts[2]) / 3; // bottom 3 (darkest = background)
        }

        if (isLight) lightVals.push(val);
        else darkVals.push(val);
      }
    }

    var lightMean = lightVals.reduce(function (a, b) { return a + b; }, 0) / lightVals.length;
    var darkMean = darkVals.reduce(function (a, b) { return a + b; }, 0) / darkVals.length;
    var contrast = Math.abs(lightMean - darkMean);

    var lightStd = Math.sqrt(
      lightVals.reduce(function (a, v) { return a + (v - lightMean) * (v - lightMean); }, 0) / lightVals.length
    );
    var darkStd = Math.sqrt(
      darkVals.reduce(function (a, v) { return a + (v - darkMean) * (v - darkMean); }, 0) / darkVals.length
    );

    return contrast / (1 + lightStd + darkStd);
  }

  /* ── Square color detection ────────────────────────────── */

  _findSquareColors(board) {
    var sqSize = board.w / 8;
    var m = sqSize * 0.08;
    var lightSamples = [], darkSamples = [];

    for (var r = 0; r < 8; r++) {
      for (var c = 0; c < 8; c++) {
        var isLight = (r + c) % 2 === 0;
        var sx = board.x + c * sqSize;
        var sy = board.y + r * sqSize;
        var mid = sqSize / 2;
        var pts = [
          [sx + m, sy + m], [sx + sqSize - m, sy + m],
          [sx + m, sy + sqSize - m], [sx + sqSize - m, sy + sqSize - m],
          [sx + mid, sy + m], [sx + mid, sy + sqSize - m],
          [sx + m, sy + mid], [sx + sqSize - m, sy + mid],
        ];
        for (var p = 0; p < pts.length; p++) {
          var color = this._rgbAt(pts[p][0], pts[p][1]);
          if (isLight) lightSamples.push(color);
          else darkSamples.push(color);
        }
      }
    }

    return {
      light: this._robustColorAvg(lightSamples),
      dark: this._robustColorAvg(darkSamples),
    };
  }

  _robustColorAvg(samples) {
    var sorted = samples.slice().sort(function (a, b) {
      return (a.r + a.g + a.b) - (b.r + b.g + b.b);
    });
    var start = Math.floor(sorted.length * 0.25);
    var end = Math.floor(sorted.length * 0.75);
    var mid = sorted.slice(start, end);
    if (!mid.length) mid = sorted;
    return {
      r: Math.round(mid.reduce(function (s, c) { return s + c.r; }, 0) / mid.length),
      g: Math.round(mid.reduce(function (s, c) { return s + c.g; }, 0) / mid.length),
      b: Math.round(mid.reduce(function (s, c) { return s + c.b; }, 0) / mid.length),
    };
  }

  /* ── Per-square occupancy + piece color ────────────────── */

  _analyzeGrid(board, sqColors) {
    var sqSize = board.w / 8;
    var grid = [];

    for (var r = 0; r < 8; r++) {
      grid[r] = [];
      for (var c = 0; c < 8; c++) {
        var isLight = (r + c) % 2 === 0;
        var bgColor = isLight ? sqColors.light : sqColors.dark;
        var sx = board.x + c * sqSize;
        var sy = board.y + r * sqSize;
        grid[r][c] = this._analyzeSquare(sx, sy, sqSize, bgColor);
      }
    }

    // Adaptive piece-color threshold via k-means (k=2) on brightness
    var occupied = [];
    for (var r2 = 0; r2 < 8; r2++) {
      for (var c2 = 0; c2 < 8; c2++) {
        if (!grid[r2][c2].empty) {
          occupied.push({ r: r2, c: c2, brightness: grid[r2][c2].brightness });
        }
      }
    }

    if (occupied.length >= 4) {
      occupied.sort(function (a, b) { return a.brightness - b.brightness; });
      var midIdx = Math.floor(occupied.length / 2);
      var darkAvg = occupied.slice(0, midIdx).reduce(function (s, o) { return s + o.brightness; }, 0) / midIdx;
      var lightAvg = occupied.slice(midIdx).reduce(function (s, o) { return s + o.brightness; }, 0) / (occupied.length - midIdx);
      var thresh = (darkAvg + lightAvg) / 2;

      for (var k = 0; k < occupied.length; k++) {
        var o = occupied[k];
        grid[o.r][o.c].pieceColor = o.brightness > thresh ? 'w' : 'b';
      }
    } else if (occupied.length > 0) {
      for (var k2 = 0; k2 < occupied.length; k2++) {
        grid[occupied[k2].r][occupied[k2].c].pieceColor = occupied[k2].brightness > 128 ? 'w' : 'b';
      }
    }

    return grid;
  }

  _analyzeSquare(sqX, sqY, sqSize, bgColor) {
    var margin = sqSize * 0.15;
    var innerL = Math.floor(sqX + margin);
    var innerT = Math.floor(sqY + margin);
    var innerR = Math.floor(sqX + sqSize - margin);
    var innerB = Math.floor(sqY + sqSize - margin);
    var step = Math.max(1, Math.floor(sqSize / 30));

    var piecePixels = 0, totalPixels = 0, brightSum = 0;
    var distThreshold = 30;

    for (var y = innerT; y < innerB; y += step) {
      for (var x = innerL; x < innerR; x += step) {
        var color = this._rgbAt(x, y);
        var dist = this._colorDist(color, bgColor);
        totalPixels++;
        if (dist > distThreshold) {
          piecePixels++;
          brightSum += 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
        }
      }
    }

    var occupancy = totalPixels > 0 ? piecePixels / totalPixels : 0;
    if (occupancy < 0.06) {
      return { empty: true };
    }

    return {
      empty: false,
      brightness: piecePixels > 0 ? brightSum / piecePixels : 128,
      pieceColor: null,
    };
  }

  /* ── Annotated crop for AI ─────────────────────────────── */

  _createAnnotatedCrop(board) {
    var size = board.w;
    var sqSize = size / 8;
    var pad = Math.max(20, Math.round(sqSize * 0.35));

    var c = document.createElement('canvas');
    c.width = size + pad;
    c.height = size + pad;
    var cx = c.getContext('2d');

    cx.fillStyle = '#ffffff';
    cx.fillRect(0, 0, c.width, c.height);

    cx.drawImage(this._canvas, board.x, board.y, size, size, pad, 0, size, size);

    cx.fillStyle = '#000000';
    cx.font = 'bold ' + Math.round(pad * 0.55) + 'px sans-serif';
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';

    var files = 'abcdefgh';
    for (var r = 0; r < 8; r++) {
      cx.fillText(String(8 - r), pad / 2, r * sqSize + sqSize / 2);
    }
    for (var f = 0; f < 8; f++) {
      cx.fillText(files[f], pad + f * sqSize + sqSize / 2, size + pad / 2);
    }

    return c.toDataURL('image/png').split(',')[1];
  }
}

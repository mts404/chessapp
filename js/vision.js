/**
 * ChessVision — sends a chess board screenshot to Google Gemini
 * and returns the detected FEN piece-placement string.
 */
class ChessVision {
  constructor() {
    this.API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
    this.MODELS   = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
  }

  getApiKey() {
    return localStorage.getItem('gemini_api_key') || '';
  }

  setApiKey(key) {
    localStorage.setItem('gemini_api_key', key.trim());
  }

  hasApiKey() {
    return this.getApiKey().length > 0;
  }

  /**
   * Analyse a chess board screenshot and return the FEN placement string.
   * Tries the primary model first, falls back to lite if rate-limited.
   * @param {string} base64Image — the image data (no data URI prefix)
   * @param {string} mimeType   — e.g. "image/png"
   * @param {function} onStatus — optional callback for progress messages
   * @returns {Promise<string>}   FEN placement (e.g. "rnbqkbnr/pppppppp/...")
   */
  async analyse(base64Image, mimeType, onStatus) {
    const key = this.getApiKey();
    if (!key) throw new Error('No Gemini API key configured');

    let lastError = null;

    for (const model of this.MODELS) {
      try {
        if (onStatus) onStatus(`Trying ${model}…`);
        return await this._callModel(model, key, base64Image, mimeType);
      } catch (err) {
        lastError = err;
        const isRateLimit = err.message.includes('429') ||
                            err.message.toLowerCase().includes('quota') ||
                            err.message.toLowerCase().includes('rate') ||
                            err.message.toLowerCase().includes('limit') ||
                            err.message.toLowerCase().includes('exhausted');
        if (isRateLimit && model !== this.MODELS[this.MODELS.length - 1]) {
          if (onStatus) onStatus(`${model} rate-limited, trying fallback…`);
          continue;
        }
        throw err;
      }
    }

    throw lastError;
  }

  /**
   * Analyse using pre-detected board layout from BoardDetector.
   * The AI only needs to identify piece TYPES — grid alignment, occupancy,
   * and piece colors are already determined by canvas pixel analysis.
   *
   * @param {string}   base64Image — annotated cropped board (PNG, no data URI prefix)
   * @param {string}   mimeType
   * @param {Array}    grid — 8×8 grid from BoardDetector with { empty, pieceColor } per square
   * @param {function} onStatus
   * @returns {Promise<string>} FEN placement string
   */
  async analyseWithHints(base64Image, mimeType, grid, onStatus) {
    const key = this.getApiKey();
    if (!key) throw new Error('No Gemini API key configured');

    const files = 'abcdefgh';
    const hints = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (!grid[r][c].empty) {
          const sq = files[c] + (8 - r);
          const color = grid[r][c].pieceColor === 'w' ? 'White' : 'Black';
          hints.push(sq + ': ' + color + ' piece');
        }
      }
    }

    const prompt = [
      'This is a CROPPED chess board image with rank numbers (1-8 on the left) and file letters (a-h on the bottom).',
      'The board is from White\'s perspective: rank 8 is at the top, rank 1 at the bottom.',
      '',
      'I have already detected which squares contain pieces and their colors using pixel analysis:',
      '',
      hints.join('\n'),
      '',
      'Your ONLY task: identify the PIECE TYPE for each occupied square listed above.',
      '',
      'Piece types:',
      '  King (K/k) — tallest piece with a cross/plus on top',
      '  Queen (Q/q) — tall piece with a crown/spiky top',
      '  Rook (R/r) — castle/tower shape with flat notched top',
      '  Bishop (B/b) — pointed/mitred top, medium height',
      '  Knight (N/n) — horse head shape (only asymmetric piece)',
      '  Pawn (P/p) — smallest piece with a rounded top',
      '',
      'Output the COMPLETE FEN placement string.',
      'UPPERCASE = White piece, lowercase = Black piece, digits = consecutive empty squares.',
      'Exactly 8 ranks separated by 7 "/" characters. Each rank must sum to 8.',
      '',
      'IMPORTANT: Use the exact occupied/empty squares I listed above. Do NOT move, add, or remove any pieces.',
      'If you are unsure about a piece type, use your best guess based on the image.',
    ].join('\n');

    let lastError = null;
    for (const model of this.MODELS) {
      try {
        if (onStatus) onStatus('Identifying pieces with ' + model + '…');

        const imagePart = { inline_data: { mime_type: mimeType, data: base64Image } };

        let answerText = await this._geminiRequest(model, key, [
          { text: prompt }, imagePart,
        ], true);

        let fen = this._tryExtractFen(answerText);
        let error = fen ? this._validatePlacement(fen) : 'No FEN found in response';
        if (!error) return fen;

        // One retry with specific feedback
        const retryPrompt = [
          'Previous answer: ' + (fen || answerText),
          'Problem: ' + error,
          '',
          'Re-read the image using the rank/file labels and my detected layout.',
          'Each rank must have pieces + empty digits = 8.',
          'Return ONLY the corrected FEN placement string.',
        ].join('\n');

        answerText = await this._geminiRequest(model, key, [
          { text: retryPrompt }, imagePart,
        ], true);

        fen = this._tryExtractFen(answerText);
        error = fen ? this._validatePlacement(fen) : 'No FEN found';
        if (!error) return fen;

        throw new Error('FEN invalid after retry: ' + error);
      } catch (err) {
        lastError = err;
        const isRateLimit = err.message.includes('429') ||
                            err.message.toLowerCase().includes('quota') ||
                            err.message.toLowerCase().includes('rate');
        if (isRateLimit && model !== this.MODELS[this.MODELS.length - 1]) {
          if (onStatus) onStatus(model + ' rate-limited, trying fallback…');
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  /**
   * Check that the AI's FEN respects the canvas-detected occupancy.
   * Returns an error string or null if consistent.
   */
  _checkHintConsistency(fen, grid) {
    const ranks = fen.split('/');
    if (ranks.length !== 8) return null; // basic validation handles this

    for (let r = 0; r < 8; r++) {
      let file = 0;
      for (const ch of ranks[r]) {
        if (ch >= '1' && ch <= '8') {
          for (let k = 0; k < parseInt(ch, 10); k++) {
            if (file < 8 && !grid[r][file].empty) {
              return 'Rank ' + (8 - r) + ': square ' + 'abcdefgh'[file] + (8 - r) +
                     ' should have a piece but FEN shows empty';
            }
            file++;
          }
        } else {
          if (file < 8 && grid[r][file].empty) {
            return 'Rank ' + (8 - r) + ': square ' + 'abcdefgh'[file] + (8 - r) +
                   ' should be empty but FEN shows a piece';
            }
          file++;
        }
      }
    }
    return null;
  }

  async _callModel(model, key, base64Image, mimeType) {
    const INITIAL_PROMPT = [
      'You are analyzing a screenshot from a mobile chess app (most likely Duolingo Chess).',
      '',
      'STEP 1 — FIND THE BOARD',
      'The 8×8 chess board is the large grid area in the image.',
      'IGNORE everything that is NOT the board:',
      '• Character avatars, speech bubbles, and thinking poses (these often overlap the top-left of the board — they are NOT chess pieces)',
      '• Buttons, banners, text ("Solve the puzzle", "Great job!", "CONTINUE"), progress bars, status bars, timers',
      '• Anything above, below, or beside the board grid',
      '',
      'STEP 2 — BOARD DETAILS',
      'The Duolingo board has VERY LOW CONTRAST between light and dark squares — both are near-white / light gray. Do not let this confuse you.',
      'The board is from White\'s perspective:',
      '• Top row = rank 8, Bottom row = rank 1',
      '• Left column = file a, Right column = file h',
      '',
      'STEP 3 — COUNT PIECES FIRST',
      'Before identifying individual pieces, COUNT the total number of pieces on the board.',
      'This could be a puzzle position with as few as 2-8 pieces, or a mid-game position.',
      'Most squares will likely be EMPTY. Only record squares that clearly have a chess piece on them.',
      '',
      'STEP 4 — PIECE IDENTIFICATION',
      'Duolingo piece colors:',
      '• WHITE pieces: light blue / silver / pale colored 3D pieces',
      '• BLACK pieces: dark gray / charcoal colored 3D pieces',
      '',
      'Duolingo piece shapes:',
      '• King (K/k): Tallest piece, cross/plus on top',
      '• Queen (Q/q): Tall with crown/spiky top (shorter than king)',
      '• Rook (R/r): Castle/tower with flat notched top',
      '• Bishop (B/b): Pointed/mitred top, medium height',
      '• Knight (N/n): Horse head — the ONLY asymmetric piece',
      '• Pawn (P/p): Smallest piece, simple rounded top',
      '',
      'CRITICAL: Character avatars (cartoon people) are NOT chess pieces. Speech bubbles are NOT chess pieces.',
      '',
      'STEP 5 — SCAN EACH RANK',
      'Go row by row from rank 8 (top) to rank 1 (bottom).',
      'For each row, go square by square from file a (left) to file h (right).',
      'For each square: is there a chess piece or is it empty?',
      'If empty, move on. If a piece is present, identify its type and color.',
      '',
      'STEP 6 — BUILD FEN',
      'UPPERCASE = White (K Q R B N P), lowercase = Black (k q r b n p).',
      'Consecutive empty squares → single digit (1-8). Ranks separated by "/".',
      '',
      'STEP 7 — VALIDATE',
      '• Exactly 8 ranks separated by 7 "/" characters.',
      '• Each rank: piece count + digit values = exactly 8.',
      '• Total piece count should match what you counted in Step 3.',
      '',
      'OUTPUT: The FEN piece-placement string ONLY. One line. No explanation, no markdown.',
      'Example (starting position): rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR',
      'Example (sparse puzzle): Q7/8/8/3n1p2/5qp1/3B4/8/8',
    ].join('\n');

    const imagePart = { inline_data: { mime_type: mimeType, data: base64Image } };
    const MAX_RETRIES = 2;

    let answerText = await this._geminiRequest(model, key, [
      { text: INITIAL_PROMPT }, imagePart,
    ], true);

    let fen = this._tryExtractFen(answerText);
    let validationError = fen ? this._validatePlacement(fen) : 'No FEN found in response';

    if (!validationError) return fen;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const retryPrompt = [
        `Your previous answer was: ${fen || answerText}`,
        `Problem: ${validationError}`,
        '',
        'Look at the chess board screenshot again VERY carefully.',
        'Go square by square, rank by rank, starting from rank 8 (top) to rank 1 (bottom), file a (left) to file h (right).',
        '',
        'For each rank, verify: (count of piece letters) + (sum of empty-square digits) = 8.',
        '',
        'RULES:',
        '- EXACTLY 8 ranks separated by 7 "/" characters.',
        '- Each rank MUST sum to exactly 8.',
        '- UPPERCASE = White, lowercase = Black.',
        '',
        'Return ONLY the corrected FEN piece-placement string.',
      ].join('\n');

      answerText = await this._geminiRequest(model, key, [
        { text: retryPrompt }, imagePart,
      ], true);

      fen = this._tryExtractFen(answerText);
      validationError = fen ? this._validatePlacement(fen) : 'No FEN found in response';

      if (!validationError) return fen;
    }

    throw new Error(`FEN still invalid after ${MAX_RETRIES} retries: ${validationError}  (got "${fen || answerText}")`);
  }

  /**
   * @param {boolean} useThinking — enable thinking mode for careful visual analysis
   */
  async _geminiRequest(model, key, parts, useThinking) {
    const url = `${this.API_BASE}/${model}:generateContent?key=${key}`;

    const generationConfig = {
      temperature: 0.1,
      maxOutputTokens: 1000,
    };

    if (!useThinking) {
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    const body = {
      contents: [{ parts }],
      generationConfig,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const msg = errBody?.error?.message || `HTTP ${res.status}`;
      if (res.status === 403) {
        throw new Error('API key invalid or not authorised. Check Settings.');
      }
      throw new Error(`Gemini API error (${res.status}): ${msg}`);
    }

    const data = await res.json();

    const responseParts = data?.candidates?.[0]?.content?.parts || [];
    let text = responseParts
      .filter(p => p.text && !p.thought)
      .map(p => p.text)
      .join(' ')
      .trim();

    if (!text) {
      text = responseParts.map(p => p.text || '').join(' ').trim();
    }

    return text;
  }

  /**
   * Try to extract a FEN-like placement string. Returns null if nothing found.
   */
  _tryExtractFen(raw) {
    const cleaned = raw.replace(/```/g, '').replace(/\n/g, ' ').trim();
    // Match anything that looks like ranks separated by slashes
    const match = cleaned.match(
      /[rnbqkpRNBQKP1-8]{1,8}(?:\/[rnbqkpRNBQKP1-8]{1,8}){6,7}/
    );
    return match ? match[0] : null;
  }

  /**
   * Validate a FEN placement string. Returns an error message or null if valid.
   */
  _validatePlacement(fen) {
    const ranks = fen.split('/');
    if (ranks.length !== 8) {
      return `Expected 8 ranks but got ${ranks.length}`;
    }

    for (let i = 0; i < 8; i++) {
      let squareCount = 0;
      for (const ch of ranks[i]) {
        if (ch >= '1' && ch <= '8') {
          squareCount += parseInt(ch, 10);
        } else if ('rnbqkpRNBQKP'.includes(ch)) {
          squareCount += 1;
        } else {
          return `Rank ${8 - i} contains invalid character "${ch}"`;
        }
      }
      if (squareCount !== 8) {
        return `Rank ${8 - i} has ${squareCount} squares instead of 8 ("${ranks[i]}")`;
      }
    }

    return null;
  }
}

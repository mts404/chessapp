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

  async _callModel(model, key, base64Image, mimeType) {
    const INITIAL_PROMPT = [
      'You are analyzing a screenshot of a chess board from a mobile chess app (likely Duolingo).',
      '',
      'STEP 1 — LOCATE THE BOARD',
      'Find the 8×8 chess board grid in the image. IGNORE everything outside it: avatars, names, speech bubbles, buttons, banners, text overlays, progress bars, timers, captured piece lists.',
      '',
      'STEP 2 — ORIENTATION',
      'The board is shown from White\'s perspective:',
      '• Top row = rank 8 (Black\'s home rank), Bottom row = rank 1 (White\'s home rank)',
      '• Left column = file a, Right column = file h',
      '',
      'STEP 3 — PIECE IDENTIFICATION',
      'Colors:',
      '• WHITE/LIGHT pieces are the lighter-colored or cream-colored 3D pieces',
      '• BLACK/DARK pieces are the darker-colored 3D pieces',
      '',
      'Shapes (Duolingo-style):',
      '• King (K/k): Tallest piece with a cross/plus on top',
      '• Queen (Q/q): Tall piece with a crown or spiky top (slightly shorter than king)',
      '• Rook (R/r): Castle/tower shape with flat crenellated (notched) top',
      '• Bishop (B/b): Medium height, pointed/mitred top, may have diagonal slit',
      '• Knight (N/n): Horse head — the ONLY piece with an asymmetric/animal shape',
      '• Pawn (P/p): Smallest and simplest piece with a plain rounded top',
      '',
      'COMMON MISTAKES TO AVOID:',
      '• Pawns are ALWAYS the smallest pieces — do not confuse them with bishops',
      '• Rooks have a WIDE flat top — do not confuse with kings',
      '• If a piece looks like a horse, it is ALWAYS a knight',
      '• Count the total number of each piece type to sanity-check (e.g. max 8 pawns per side, max 2 rooks per side in standard play, though promotions can create extras)',
      '',
      'STEP 4 — SCAN EACH RANK',
      'Go row by row from the TOP of the image (rank 8) to the BOTTOM (rank 1).',
      'For each row, go square by square from LEFT (file a) to RIGHT (file h).',
      'For each of the 64 squares, determine: empty, or which piece (type + color).',
      '',
      'STEP 5 — BUILD FEN PLACEMENT STRING',
      'FEN notation: UPPERCASE = White (K Q R B N P), lowercase = Black (k q r b n p).',
      'Consecutive empty squares are written as a single digit (1-8).',
      'Ranks are separated by "/" characters.',
      '',
      'STEP 6 — VALIDATE BEFORE OUTPUTTING',
      '• Count: exactly 8 rank segments separated by exactly 7 "/" characters.',
      '• For EACH rank: (number of piece letters) + (sum of digit values) MUST equal exactly 8.',
      '• Fix any rank that does not sum to 8 before outputting.',
      '',
      'OUTPUT: Print ONLY the FEN piece-placement string. One line. No explanation, no markdown, no backticks.',
      'Example: rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR',
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

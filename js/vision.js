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
      'This is a screenshot from a chess app (likely Duolingo). IGNORE everything except the 8×8 chess board grid.',
      'Ignore any UI elements: avatars, speech bubbles, buttons, banners, text overlays, progress bars.',
      'Focus ONLY on the checkerboard grid and the chess pieces on it.',
      '',
      'The board is from White\'s perspective: rank 1 (bottom row), rank 8 (top row). File a (left), file h (right).',
      'Piece colours: LIGHT/WHITE pieces are the lighter-coloured 3D pieces. DARK/BLACK pieces are the darker-coloured 3D pieces.',
      '',
      'Piece identification guide for Duolingo-style pieces:',
      '- King: tallest piece with a cross/plus on top',
      '- Queen: tall piece with a crown/spiky top',
      '- Rook: piece that looks like a castle/tower with a flat crenellated top',
      '- Bishop: piece with a pointed/mitred top (diagonal slit)',
      '- Knight: piece shaped like a horse head',
      '- Pawn: smallest, simple rounded piece',
      '',
      'TASK: For each of the 8 ranks (top row = rank 8, bottom row = rank 1), go left to right across all 8 files (a-h).',
      'For each square, record the piece or note it is empty.',
      '',
      'Then convert to FEN piece-placement notation:',
      '  K/k=King  Q/q=Queen  R/r=Rook  B/b=Bishop  N/n=Knight  P/p=Pawn',
      '  UPPERCASE = White, lowercase = Black',
      '  Consecutive empty squares → single digit (1-8)',
      '',
      'CRITICAL RULES:',
      '- You MUST output exactly 8 ranks separated by exactly 7 "/" characters.',
      '- Each rank MUST sum to exactly 8 (count of pieces + sum of empty-square digits = 8).',
      '- Double-check your count for each rank before outputting.',
      '',
      'Output ONLY the FEN piece-placement string on one line. No explanation, no markdown.',
      'Example: rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR',
    ].join('\n');

    // First attempt (with thinking enabled for careful analysis)
    let answerText = await this._geminiRequest(model, key, [
      { text: INITIAL_PROMPT },
      { inline_data: { mime_type: mimeType, data: base64Image } },
    ], true);

    let fen = this._tryExtractFen(answerText);
    let validationError = fen ? this._validatePlacement(fen) : 'No FEN found in response';

    if (!validationError) return fen;

    // Auto-retry: send the bad FEN back with the specific error
    const retryPrompt = [
      `Your previous answer was: ${fen || answerText}`,
      `Problem: ${validationError}`,
      '',
      'Look at the chess board in the image again very carefully.',
      'Go square by square, rank by rank, starting from rank 8 (top row) to rank 1 (bottom row).',
      'For each rank, count from file a (left) to file h (right). Verify the total is 8 for every rank.',
      '',
      'RULES:',
      '- EXACTLY 8 ranks separated by 7 "/" characters.',
      '- Each rank: pieces + empty digits MUST sum to exactly 8.',
      '',
      'Return ONLY the corrected FEN piece-placement string.',
    ].join('\n');

    answerText = await this._geminiRequest(model, key, [
      { text: retryPrompt },
      { inline_data: { mime_type: mimeType, data: base64Image } },
    ], true);

    fen = this._tryExtractFen(answerText);
    validationError = fen ? this._validatePlacement(fen) : 'No FEN found in response';

    if (!validationError) return fen;

    throw new Error(`FEN still invalid after retry: ${validationError}  (got "${fen || answerText}")`);
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

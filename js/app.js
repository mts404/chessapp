/* global $, Chessboard, Chess, StockfishEngine, ChessVision */

(function () {
  'use strict';

  /* ── State ───────────────────────────────────────────────── */
  let game        = new Chess();
  let board       = null;
  let engine      = new StockfishEngine();
  let vision      = new ChessVision();
  let playerSide  = 'w';
  let nextToMove  = 'b';
  let aiThinking  = false;
  let engineReady = false;
  let pendingFen    = null;      // FEN waiting for confirmation
  let uploadedImage = null;    // { base64, mimeType }
  let selectedSquare = null;   // square selected for tap-to-move
  let editMode      = false;   // board editor active
  let editPosition  = {};      // position object during editing
  let selectedTool  = null;    // selected palette piece or 'eraser'
  let editFromConfirm = false; // true if editor opened from confirm section

  const PIECE_THEME = 'img/pieces/{piece}.svg';

  /* ── DOM refs ────────────────────────────────────────────── */
  const $fenInput      = $('#fenInput');
  const $fenError      = $('#fenError');
  const $status        = $('#gameStatus');
  const $moveHistory   = $('#moveHistory');
  const $thinking      = $('#thinkingIndicator');
  const $opponentLabel = $('#opponentLabel');
  const $playerLabel   = $('#playerLabel');
  const $visionStatus  = $('#visionStatus');
  const $confirmSec    = $('#confirmSection');
  const $confirmFen    = $('#confirmFen');
  const $analyseBtn    = $('#analyseBtn');
  const $uploadArea    = $('#uploadArea');
  const $editorSec     = $('#editorSection');

  /* ── Board setup ─────────────────────────────────────────── */
  function initBoard() {
    board = Chessboard('chessboard', {
      position:    game.fen(),
      draggable:   true,
      pieceTheme:  PIECE_THEME,
      orientation: playerSide === 'w' ? 'white' : 'black',
      onDragStart: onDragStart,
      onDrop:      onDrop,
      onSnapEnd:   onSnapEnd,
    });

    $(window).on('resize', function () {
      if (board) board.resize();
    });
  }

  /* ── Drag / Drop ─────────────────────────────────────────── */
  function onDragStart(source, piece) {
    if (editMode) {
      handleBoardEditClick(source);
      return false;
    }

    if (game.game_over() || aiThinking || game.turn() !== playerSide) {
      return false;
    }

    // If a piece is already selected and we're touching a destination piece,
    // try the tap-move before allowing drag
    if (selectedSquare && selectedSquare !== source) {
      var tapMove = game.move({
        from: selectedSquare,
        to: source,
        promotion: 'q',
      });
      if (tapMove) {
        clearSelection();
        board.position(game.fen());
        updateUI();
        if (!game.game_over()) {
          window.setTimeout(requestAiMove, 150);
        }
        return false; // cancel drag, move already made
      }
    }

    // Only allow dragging player's pieces
    if (playerSide === 'w' && piece.search(/^b/) !== -1) return false;
    if (playerSide === 'b' && piece.search(/^w/) !== -1) return false;

    // Select this piece (highlights will show during drag too)
    selectSquare(source);
    return true;
  }

  function onDrop(source, target) {
    if (source === target) {
      // Clicked a piece without dragging — keep it selected (onDragStart already selected it)
      return 'snapback';
    }

    clearSelection();

    var move = game.move({
      from: source,
      to: target,
      promotion: 'q',
    });
    if (move === null) return 'snapback';

    updateUI();
    if (!game.game_over()) {
      window.setTimeout(requestAiMove, 150);
    }
  }

  function onSnapEnd() {
    board.position(game.fen());
  }

  /* ── Tap-to-Move helpers ─────────────────────────────────── */
  function handleSquareTap(square) {
    if (game.game_over() || aiThinking || game.turn() !== playerSide) {
      clearSelection();
      return;
    }

    var piece = game.get(square);

    if (selectedSquare) {
      if (selectedSquare === square) {
        clearSelection();
        return;
      }

      var move = game.move({
        from: selectedSquare,
        to: square,
        promotion: 'q',
      });

      clearSelection();

      if (move) {
        board.position(game.fen());
        updateUI();
        if (!game.game_over()) {
          window.setTimeout(requestAiMove, 150);
        }
        return;
      }

      if (piece && piece.color === playerSide) {
        selectSquare(square);
      }
    } else {
      if (piece && piece.color === playerSide) {
        selectSquare(square);
      }
    }
  }

  function selectSquare(square) {
    clearSelection();
    selectedSquare = square;

    $('[data-square="' + square + '"]').addClass('selected-square');

    var moves = game.moves({ square: square, verbose: true });
    for (var i = 0; i < moves.length; i++) {
      var targetSq = $('[data-square="' + moves[i].to + '"]');
      targetSq.addClass(moves[i].captured ? 'legal-capture' : 'legal-move');
    }
  }

  function clearSelection() {
    selectedSquare = null;
    $('.selected-square, .legal-move, .legal-capture')
      .removeClass('selected-square legal-move legal-capture');
  }

  /* ── Board Editor ────────────────────────────────────────── */
  function enterEditMode(fromConfirm) {
    editMode = true;
    editFromConfirm = !!fromConfirm;
    selectedTool = null;
    editPosition = $.extend({}, board.position());
    clearSelection();

    $confirmSec.slideUp(200);
    $editorSec.slideDown(200);
    $('#chessboard').addClass('edit-mode');
    $('.palette-piece').removeClass('active-tool');
  }

  function exitEditMode(save) {
    editMode = false;
    selectedTool = null;
    $('#chessboard').removeClass('edit-mode');
    $editorSec.slideUp(200);

    if (save) {
      var placement = positionToFen(editPosition);
      var turn = nextToMove;
      var fullFen = buildFen(placement, turn);

      var tempGame = new Chess();
      var validation = tempGame.validate_fen(fullFen);
      if (!validation.valid) {
        showVisionStatus('Invalid position: ' + validation.error, 'error');
        return;
      }

      pendingFen = fullFen;
      game.load(fullFen);
      board.position(game.fen(), true);
      $confirmFen.text(fullFen);
      $confirmSec.slideDown(200);
      showVisionStatus('Position updated — review below', 'ok');
    } else {
      if (pendingFen) {
        game.load(pendingFen);
        board.position(game.fen(), true);
      }
      if (editFromConfirm) {
        $confirmSec.slideDown(200);
      }
    }
  }

  function handleBoardEditClick(square) {
    if (!editMode) return;

    if (selectedTool === 'eraser') {
      delete editPosition[square];
    } else if (selectedTool) {
      editPosition[square] = selectedTool;
    }

    board.position(editPosition, false);
  }

  function positionToFen(position) {
    var files = 'abcdefgh';
    var fen = '';
    for (var rank = 8; rank >= 1; rank--) {
      var empty = 0;
      for (var f = 0; f < 8; f++) {
        var sq = files[f] + rank;
        var piece = position[sq];
        if (piece) {
          if (empty > 0) { fen += empty; empty = 0; }
          var color = piece[0];
          var type = piece[1];
          fen += color === 'w' ? type : type.toLowerCase();
        } else {
          empty++;
        }
      }
      if (empty > 0) fen += empty;
      if (rank > 1) fen += '/';
    }
    return fen;
  }

  /* ── AI Move ─────────────────────────────────────────────── */
  async function requestAiMove() {
    if (game.game_over() || game.turn() === playerSide) return;
    if (!engineReady) return;

    setThinking(true);
    aiThinking = true;

    try {
      const uciMove = await engine.getBestMove(game.fen());
      if (!uciMove || uciMove === '(none)') {
        aiThinking = false;
        setThinking(false);
        updateUI();
        return;
      }

      const from  = uciMove.substring(0, 2);
      const to    = uciMove.substring(2, 4);
      const promo = uciMove.length > 4 ? uciMove[4] : undefined;

      game.move({ from, to, promotion: promo });
      board.position(game.fen());
    } catch (e) {
      console.error('Engine error:', e);
    }

    aiThinking = false;
    setThinking(false);
    updateUI();
  }

  /* ── UI Updates ──────────────────────────────────────────── */
  function updateUI() {
    updateStatus();
    updateMoveHistory();
  }

  function updateStatus() {
    let msg = '';
    let cls = '';
    let overlay = '';
    let overlayCls = '';

    if (game.in_checkmate()) {
      const winner = game.turn() === playerSide ? 'AI' : 'You';
      if (winner === 'You') {
        msg = 'Checkmate — you win!';
        cls = 'win';
        overlay = 'Checkmate';
        overlayCls = 'overlay-win';
      } else {
        msg = 'Checkmate — AI wins';
        cls = 'over';
        overlay = 'Checkmate';
        overlayCls = 'overlay-loss';
      }
    } else if (game.in_draw()) {
      msg = 'Draw';
      overlayCls = 'overlay-draw';
      if (game.in_stalemate()) {
        msg = 'Stalemate — draw';
        overlay = 'Stalemate';
      } else if (game.in_threefold_repetition()) {
        msg = 'Threefold repetition — draw';
        overlay = 'Draw';
      } else if (game.insufficient_material()) {
        msg = 'Insufficient material — draw';
        overlay = 'Draw';
      } else {
        overlay = 'Draw';
      }
      cls = 'over';
    } else if (game.in_check()) {
      msg = game.turn() === playerSide ? 'You are in check!' : 'AI is in check';
      cls = 'check';
      overlay = 'Check';
      overlayCls = 'overlay-check';
    } else {
      msg = game.turn() === playerSide
        ? 'Your turn — tap or drag a piece to move'
        : 'AI is thinking…';
    }

    $status.text(msg).attr('class', 'game-status ' + cls);

    const $overlay = $('#boardOverlay');
    if (overlay) {
      $overlay.text(overlay).attr('class', 'board-overlay visible ' + overlayCls);
      // Auto-dismiss "Check" after 2s so it doesn't block the board
      if (overlay === 'Check') {
        clearTimeout(window._checkTimeout);
        window._checkTimeout = setTimeout(function () {
          $overlay.attr('class', 'board-overlay').text('');
        }, 2000);
      }
    } else {
      clearTimeout(window._checkTimeout);
      $overlay.attr('class', 'board-overlay').text('');
    }
  }

  function updateMoveHistory() {
    const history = game.history();
    if (history.length === 0) {
      $moveHistory.html('<p class="empty-history">No moves yet</p>');
      return;
    }

    let html = '';
    for (let i = 0; i < history.length; i += 2) {
      const moveNum   = Math.floor(i / 2) + 1;
      const whiteMove = history[i];
      const blackMove = history[i + 1] || '';
      const isLast      = (i + 2 >= history.length);
      const isLastBlack = (i + 1 === history.length - 1);

      html += '<div class="move-row">';
      html += `<span class="move-num">${moveNum}.</span>`;
      html += `<span class="move-white${isLast && !blackMove ? ' last' : ''}">${whiteMove}</span>`;
      if (blackMove) {
        html += `<span class="move-black${isLastBlack || isLast ? ' last' : ''}">${blackMove}</span>`;
      }
      html += '</div>';
    }

    $moveHistory.html(html);
    $moveHistory.scrollTop($moveHistory[0].scrollHeight);
  }

  function setThinking(on) {
    $thinking.toggleClass('visible', on);
  }

  function updatePlayerLabels() {
    const aiColor   = playerSide === 'w' ? 'Black' : 'White';
    const yourColor = playerSide === 'w' ? 'White' : 'Black';
    const diff = engine.DIFFICULTY[engine.currentLevel];
    $opponentLabel.text(`Stockfish (${diff.name}) — ${aiColor}`);
    $playerLabel.text(`You — ${yourColor}`);
  }

  /* ── Build full FEN from placement + turn ────────────────── */
  function buildFen(placement, turn) {
    // No castling info from a screenshot, assume none; no en-passant
    return `${placement} ${turn} - - 0 1`;
  }

  /* ── FEN Loading ─────────────────────────────────────────── */
  function loadFen(fen) {
    fen = fen.trim();
    const validation = game.validate_fen(fen);
    if (!validation.valid) {
      $fenError.text(validation.error);
      return false;
    }
    $fenError.text('');
    game.load(fen);
    board.position(game.fen(), true);
    updateUI();

    if (game.turn() !== playerSide && !game.game_over()) {
      window.setTimeout(requestAiMove, 400);
    }
    return true;
  }

  /* ── New Game ────────────────────────────────────────────── */
  function newGame(fen) {
    engine.stop();
    aiThinking = false;
    setThinking(false);

    if (fen) {
      game = new Chess(fen);
    } else {
      game = new Chess();
    }

    board.orientation(playerSide === 'w' ? 'white' : 'black');
    board.position(game.fen(), true);
    updateUI();
    updatePlayerLabels();

    if (game.turn() !== playerSide && !game.game_over()) {
      window.setTimeout(requestAiMove, 500);
    }
  }

  /* ── Screenshot Analysis ─────────────────────────────────── */
  async function analyseScreenshot() {
    if (!uploadedImage) return;

    if (!vision.hasApiKey()) {
      showVisionStatus('Set your Gemini API key in Settings below', 'error');
      $('#settingsDetails').attr('open', '');
      return;
    }

    $analyseBtn.prop('disabled', true).text('Analysing…');
    showVisionStatus('Sending screenshot to Gemini…', 'busy');

    try {
      const placement = await vision.analyse(
        uploadedImage.base64,
        uploadedImage.mimeType,
        (msg) => showVisionStatus(msg, 'busy')
      );
      const turn = nextToMove;
      const fullFen = buildFen(placement, turn);

      // Validate the FEN before showing confirmation
      const tempGame = new Chess();
      const validation = tempGame.validate_fen(fullFen);
      if (!validation.valid) {
        showVisionStatus(`Invalid position detected: ${validation.error}`, 'error');
        $analyseBtn.prop('disabled', false).text('Analyse Screenshot');
        return;
      }

      pendingFen = fullFen;

      // Show the detected position on the board for review
      game.load(fullFen);
      board.position(game.fen(), true);

      $confirmFen.text(fullFen);
      $confirmSec.slideDown(200);
      showVisionStatus('Position detected — review below', 'ok');

    } catch (err) {
      console.error('Vision error:', err);
      showVisionStatus(err.message, 'error');
    }

    $analyseBtn.prop('disabled', false).text('Analyse Screenshot');
  }

  function showVisionStatus(msg, type) {
    $visionStatus.text(msg).attr('class', 'status-msg ' + (type || ''));
  }

  /* ── Image Upload Helpers ────────────────────────────────── */
  function handleFile(file) {
    if (!file || !file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = function (e) {
      const dataUrl = e.target.result;
      const base64  = dataUrl.split(',')[1];

      uploadedImage = { base64, mimeType: file.type };

      $('#previewImg').attr('src', dataUrl);
      $('#uploadContent').hide();
      $('#uploadPreview').show();
      $analyseBtn.prop('disabled', false);
      showVisionStatus('');
      $confirmSec.slideUp(100);
    };
    reader.readAsDataURL(file);
  }

  function clearUpload() {
    uploadedImage = null;
    $('#uploadPreview').hide();
    $('#uploadContent').show();
    $('#fileInput').val('');
    $analyseBtn.prop('disabled', true);
    showVisionStatus('');
    $confirmSec.slideUp(100);
  }

  /* ── Event Bindings ──────────────────────────────────────── */
  function bindEvents() {

    /* ── Upload ──────────────────────────────────────────── */
    function openFilePicker(e) {
      if (e) e.stopPropagation();
      document.getElementById('fileInput').click();
    }

    $('#browseBtn').on('click', openFilePicker);
    $uploadArea.on('click', openFilePicker);

    $('#fileInput').on('change', function () {
      handleFile(this.files[0]);
    });

    // Drag & drop
    $uploadArea.on('dragover', function (e) {
      e.preventDefault();
      $(this).addClass('drag-over');
    }).on('dragleave drop', function (e) {
      e.preventDefault();
      $(this).removeClass('drag-over');
    }).on('drop', function (e) {
      const file = e.originalEvent.dataTransfer.files[0];
      handleFile(file);
    });

    $('#removePreview').on('click', function (e) {
      e.stopPropagation();
      clearUpload();
    });

    $analyseBtn.on('click', analyseScreenshot);

    /* ── Board clicks: edit-mode placement + tap-to-move for empty squares.
         Piece squares are handled by onDragStart (chessboard.js callback). ── */
    $('#chessboard').on('mousedown touchstart', function (e) {
      var target = $(e.target);
      var sq = target.is('[data-square]') ? target : target.closest('[data-square]');
      if (!sq || !sq.length) return;
      var square = sq.data('square');

      if (editMode) {
        var pos = board.position();
        if (!pos[square]) {
          e.preventDefault();
          handleBoardEditClick(square);
        }
        return;
      }

      if (!selectedSquare) return;
      var piece = game.get(square);
      if (piece) return;

      e.preventDefault();
      handleSquareTap(square);
    });

    /* ── Confirmation ────────────────────────────────────── */
    $('#confirmBtn').on('click', function () {
      if (pendingFen) {
        $confirmSec.slideUp(200);
        newGame(pendingFen);
        pendingFen = null;
      }
    });

    $('#modifyBtn').on('click', function () {
      enterEditMode(true);
    });

    $('#rejectBtn').on('click', function () {
      $confirmSec.slideUp(200);
      pendingFen = null;
      newGame();
    });

    /* ── Board Editor ────────────────────────────────────── */
    $('#piecePalette').on('click', '.palette-piece', function () {
      var piece = $(this).data('piece');
      if (!piece) return;
      $('.palette-piece').removeClass('active-tool');
      $(this).addClass('active-tool');
      selectedTool = piece;
    });

    $('#clearBoardBtn').on('click', function () {
      editPosition = {};
      board.position(editPosition, false);
    });

    $('#doneEditBtn').on('click', function () {
      exitEditMode(true);
    });

    $('#cancelEditBtn').on('click', function () {
      exitEditMode(false);
    });

    /* ── Side picker ─────────────────────────────────────── */
    $('#sideToggle').on('click', '.toggle-btn', function () {
      const side = $(this).data('side');
      if (side === playerSide) return;

      $('#sideToggle .toggle-btn').removeClass('active');
      $(this).addClass('active');
      playerSide = side;
      updatePlayerLabels();
      board.orientation(playerSide === 'w' ? 'white' : 'black');
    });

    /* ── Next-to-move picker ─────────────────────────────── */
    $('#turnToggle').on('click', '.toggle-btn', function () {
      const turn = $(this).data('turn');
      if (turn === nextToMove) return;

      $('#turnToggle .toggle-btn').removeClass('active');
      $(this).addClass('active');
      nextToMove = turn;
    });

    /* ── Difficulty ──────────────────────────────────────── */
    $('#difficultyGroup').on('click', '.diff-btn', function () {
      const level = parseInt($(this).data('level'), 10);
      $('#difficultyGroup .diff-btn').removeClass('active');
      $(this).addClass('active');
      engine.setDifficulty(level);
      updatePlayerLabels();
    });

    /* ── FEN (advanced) ──────────────────────────────────── */
    $('#loadFenBtn').on('click', function () {
      loadFen($fenInput.val());
    });

    $fenInput.on('keydown', function (e) {
      if (e.key === 'Enter') loadFen($fenInput.val());
    });

    $('#startPosBtn').on('click', function () {
      $fenInput.val('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
      newGame();
    });

    $('#copyFenBtn').on('click', function () {
      const fen = game.fen();
      navigator.clipboard.writeText(fen).then(() => {
        const $btn = $(this);
        $btn.text('Copied!');
        setTimeout(() => $btn.text('Copy Current FEN'), 1500);
      });
    });

    /* ── Game controls ───────────────────────────────────── */
    $('#newGameBtn').on('click', function () { newGame(); });

    $('#undoBtn').on('click', function () {
      if (aiThinking) return;
      if (game.history().length === 0) return;

      // If it's the player's turn, the AI already moved — undo both
      // If it's the AI's turn (shouldn't normally happen), undo just one
      if (game.turn() === playerSide) {
        game.undo(); // undo AI's move
        game.undo(); // undo player's move
      } else {
        game.undo(); // undo player's move only
      }

      board.position(game.fen(), true);
      updateUI();
    });

    $('#flipBtn').on('click', function () {
      board.flip();
    });

    $('#editBoardBtn').on('click', function () {
      if (editMode) return;
      pendingFen = game.fen();
      enterEditMode();
    });

    /* ── API Key ─────────────────────────────────────────── */
    $('#saveKeyBtn').on('click', function () {
      const key = $('#apiKeyInput').val().trim();
      if (!key) { setKeyStatus('Enter a key first', 'error'); return; }
      vision.setApiKey(key);
      setKeyStatus('Key saved', 'ok');
    });

    // Pre-fill if already saved
    const saved = vision.getApiKey();
    if (saved) {
      $('#apiKeyInput').val(saved);
    }
  }

  function setKeyStatus(msg, type) {
    $('#keyStatus').text(msg).attr('class', 'status-msg ' + (type || ''));
  }

  /* ── Bootstrap ───────────────────────────────────────────── */
  async function boot() {
    initBoard();
    bindEvents();
    updateUI();
    updatePlayerLabels();

    $status.text('Loading Stockfish engine…');

    try {
      await engine.init();
      engineReady = true;
      updateUI();

      if (game.turn() !== playerSide) {
        requestAiMove();
      }
    } catch (err) {
      console.error('Failed to load engine:', err);
      $status.text('Failed to load engine — check console')
             .addClass('over');
    }
  }

  $(document).ready(boot);
})();

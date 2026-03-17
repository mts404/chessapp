# Chess AI Opponent

A browser-based chess app that reads screenshots from Duolingo (or any chess app) and lets you continue the game against Stockfish at adjustable difficulty levels.

## Quick Start

```bash
./serve.sh
# or: python3 -m http.server 8080
```

Open **http://localhost:8080** in your browser.

## Setup

1. Get a free Gemini API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Open the app, expand **Settings** at the bottom, paste your key, and click **Save**
3. The key is stored in your browser's localStorage — never sent anywhere except directly to Google's API

## How to Use

1. **Screenshot** your in-progress chess game (Duolingo, Chess.com, Lichess, etc.)
2. **Upload** the screenshot via drag & drop or the file picker
3. **Set toggles** — "You are playing as" (White/Black) and "Next to move" (White/Black)
4. Click **Analyse Screenshot** — Gemini reads the board and detects piece positions
5. **Review** the detected position on the board, then click **Start Playing**
6. **Play!** — drag pieces to make your moves; Stockfish responds automatically

## Features

- **Screenshot recognition** — powered by Google Gemini Vision (free tier: 1,500 requests/day)
- **6 difficulty levels** — Beginner through Master (controls Stockfish skill level + search depth)
- **Side selection** — play as White or Black
- **Turn control** — set whose move it is after loading a position
- **Move history** — standard algebraic notation
- **Undo** — take back your last move pair
- **FEN import** — manual FEN input available under "FEN / Advanced"
- **Duolingo-inspired visuals** — muted piece colors and clean board aesthetic

## Architecture

| Component | Library | Role |
|-----------|---------|------|
| Board UI | [chessboard.js](https://chessboardjs.com/) | Drag-and-drop board |
| Game Logic | [chess.js](https://github.com/jhlywa/chess.js) | Move validation, FEN, game state |
| AI Engine | [Stockfish.js](https://github.com/nicf/stockfish.js) | Web Worker chess engine |
| Vision | [Google Gemini](https://ai.google.dev/) | Screenshot → FEN recognition |

All libraries load from CDN. No build step or package manager required.

## Difficulty Levels

| Level | Stockfish Skill | Search Depth | Think Time |
|-------|----------------|--------------|------------|
| Beginner | 0 | 1 | 200ms |
| Casual | 3 | 4 | 400ms |
| Intermediate | 8 | 8 | 1s |
| Advanced | 13 | 13 | 2s |
| Expert | 17 | 17 | 3.5s |
| Master | 20 | 22 | 5s |

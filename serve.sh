#!/bin/bash
PORT=${1:-8080}
echo "Starting chess app at http://localhost:$PORT"
echo "Press Ctrl+C to stop"
python3 -m http.server "$PORT"

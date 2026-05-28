#!/usr/bin/env bash
set -euo pipefail

export PORT="${PORT:-7860}"
export OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"
export OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
export OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5-coder:7b}"

echo "[$(date -Iseconds)] [STARTUP] Starting internal Ollama service for ${OLLAMA_MODEL}..."
ollama serve >/tmp/ollama.log 2>&1 &
ollama_pid=$!

cleanup() {
  kill "${ollama_pid}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[$(date -Iseconds)] [STARTUP] Waiting for internal Ollama service..."
for attempt in $(seq 1 120); do
  if curl --fail --silent "${OLLAMA_BASE_URL}/api/tags" >/dev/null; then
    echo "[$(date -Iseconds)] [STARTUP] Internal Ollama service is responding."
    break
  fi

  if ! kill -0 "${ollama_pid}" 2>/dev/null; then
    echo "[$(date -Iseconds)] [STARTUP] Ollama exited before becoming ready."
    echo "[$(date -Iseconds)] [STARTUP] Ollama log:"
    cat /tmp/ollama.log || true
    exit 1
  fi

  if [ "${attempt}" -eq 120 ]; then
    echo "[$(date -Iseconds)] [STARTUP] Ollama did not become ready in time."
    echo "[$(date -Iseconds)] [STARTUP] Ollama log:"
    cat /tmp/ollama.log || true
    exit 1
  fi

  sleep 1
done

echo "[$(date -Iseconds)] [STARTUP] Starting public model gateway on port ${PORT}..."
node /home/node/app/server.mjs

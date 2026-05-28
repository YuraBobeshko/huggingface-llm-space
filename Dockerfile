FROM node:20-bookworm-slim

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl zstd \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://ollama.com/install.sh | sh

ENV HOME=/home/node \
    NODE_ENV=production \
    PORT=7860 \
    OLLAMA_HOST=127.0.0.1:11434 \
    OLLAMA_BASE_URL=http://127.0.0.1:11434

ARG OLLAMA_MODEL=qwen2.5-coder:3b
ENV OLLAMA_MODEL=${OLLAMA_MODEL}

WORKDIR /home/node/app
USER node

# Store the model in the built image because a Space runtime disk is ephemeral.
RUN set -eux; \
    ollama serve >/tmp/ollama-build.log 2>&1 & \
    pid=$!; \
    ready=0; \
    for attempt in $(seq 1 120); do \
      if curl --fail --silent "${OLLAMA_BASE_URL}/api/tags" >/dev/null; then ready=1; break; fi; \
      if ! kill -0 "${pid}" 2>/dev/null; then cat /tmp/ollama-build.log; exit 1; fi; \
      sleep 1; \
    done; \
    if [ "${ready}" -ne 1 ]; then cat /tmp/ollama-build.log; kill "${pid}" || true; exit 1; fi; \
    ollama pull "${OLLAMA_MODEL}"; \
    kill "${pid}"; \
    wait "${pid}" || true

COPY --chown=node:node server.mjs start.sh ./
RUN chmod +x ./start.sh

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:7860/health >/dev/null || exit 1

CMD ["./start.sh"]

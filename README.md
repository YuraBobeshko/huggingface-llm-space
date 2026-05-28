---
title: App Generator LLM
sdk: docker
app_port: 7860
---

# App Generator LLM

This is the model-only service for App Generator. It runs Ollama internally and
publishes the small API surface needed by `backend-api`:

- `GET /health`
- `POST /api/generate`

The raw Ollama management API is not public, so clients cannot pull or delete
models in the deployed Space.

## Deploy To Hugging Face

1. Create a new Hugging Face Space and choose **Docker** as the SDK.
2. Put the contents of this directory at the root of the Space repository.
3. Push the repository to Hugging Face:

```bash
git init
git branch -M main
git remote add origin https://huggingface.co/spaces/YOUR_USER/YOUR_SPACE
git add .
git commit -m "Deploy App Generator LLM Space"
git push -u origin main
```

Important: `Dockerfile`, `README.md`, `server.mjs`, and `start.sh` must be
placed at the root of the Hugging Face Space repository, not inside a nested
folder. Hugging Face reads the Docker Space metadata from the root `README.md`
and builds the root `Dockerfile`.

The Docker build downloads `qwen2.5-coder:3b` into the image. This makes the
build slower, but the model remains available after runtime restarts without
depending on persistent Space storage.

For a smaller build on CPU hardware, change the Dockerfile build argument
default from `qwen2.5-coder:3b` to `qwen2.5-coder:1.5b`. For better quality on
slower hardware, try `qwen2.5-coder:7b`.

The model is downloaded during the Docker image build. Do not change
`OLLAMA_MODEL` only as a runtime variable in the Space settings: rebuild the
image with the same model configured at build time and runtime.

## Verify The Space

Replace the URL with the public URL displayed by Hugging Face:

```bash
curl https://YOUR_SPACE.hf.space/health
curl https://YOUR_SPACE.hf.space/api/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Return one short greeting.","stream":false}'
```

The gateway always uses the model configured by `OLLAMA_MODEL`. If the
`model` field is provided, it must match the configured model exactly.

In the Space logs, successful startup includes a `MODEL_INIT status=ok` entry.
Generation requests log `GENERATE_START` and `GENERATE_DONE` with a request id
and duration, without logging the prompt content. If Ollama does not become
ready within two minutes, startup exits and prints the internal Ollama log.

## Connect Backend API

The backend uses the same Ollama-compatible `/api/generate` request shape for
local Ollama and for this Space. This Space intentionally exposes only a small
gateway API, not the full Ollama management API. Only `OLLAMA_BASE_URL`
changes.

For a separately hosted `backend-api` service, set these environment variables
in the hosting dashboard:

```env
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=https://YOUR_SPACE.hf.space
OLLAMA_MODEL=qwen2.5-coder:3b
LLM_FALLBACK_TO_MOCK=false
```

To run the backend locally against the hosted Space:

```powershell
cd ..\backend-api
Copy-Item .env.huggingface.example .env
# Replace YOUR_SPACE in .env with the actual Space URL.
npm run dev
```

To switch the local backend back to local Ollama:

```powershell
Copy-Item .env.local.example .env -Force
npm run dev
```

When running the backend through Docker Compose, local Ollama is still the
default:

```powershell
docker compose up --build
```

For a Dockerized backend using the hosted Space, create
`.env.compose.huggingface` from its example, set its real URL, and start only
the backend service:

```powershell
Copy-Item .env.compose.huggingface.example .env.compose.huggingface
# Replace YOUR_SPACE in .env.compose.huggingface with the actual Space URL.
docker compose --env-file .env.compose.huggingface up --build --no-deps backend
```

The existing backend already sends the compatible `POST /api/generate`
request. The database is not hosted by this Space; configure it separately in
the backend service.

After starting the backend, check the complete connection chain:

```bash
curl http://localhost:4010/health
curl http://localhost:4010/health/dependencies
```

`/health/dependencies` reports `llm=ok` only when the configured model service
responds. Until Neon is implemented in `backend-api`, it intentionally reports
the database as `not_configured` and the current storage as `file`.

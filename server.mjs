import http from "node:http";
import { randomUUID } from "node:crypto";

const port = Number.parseInt(process.env.PORT ?? "7860", 10);
const ollamaBaseUrl =
  process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const model = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:7b";
const maximumBodySize = 1024 * 1024;

const log = (level, event, details) => {
  const line = `[${new Date().toISOString()}] [LLM_GATEWAY] [${event}] ${details}`;
  if (level === "error") {
    console.error(line);
    return;
  }
  console.log(line);
};

class RequestError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const sendJson = (response, statusCode, body) => {
  response.writeHead(statusCode, {
    "access-control-expose-headers": "x-request-id",
    "access-control-allow-origin": "*",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
};

const readJsonBody = (request) =>
  new Promise((resolve, reject) => {
    let raw = "";
    let rejected = false;

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (rejected) {
        return;
      }

      raw += chunk;
      if (Buffer.byteLength(raw, "utf8") > maximumBodySize) {
        rejected = true;
        reject(new RequestError(413, "Request body exceeds 1 MB"));
      }
    });
    request.on("end", () => {
      if (rejected) {
        return;
      }

      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new RequestError(400, "Request body must be valid JSON"));
      }
    });
    request.on("error", reject);
  });

const relayOllamaResponse = async (upstream, response) => {
  const raw = await upstream.text();
  response.writeHead(upstream.status, {
    "access-control-expose-headers": "x-request-id",
    "access-control-allow-origin": "*",
    "content-type":
      upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
  });
  response.end(raw);
};

const checkModelReadiness = async () => {
  const startedAt = Date.now();
  try {
    const upstream = await fetch(`${ollamaBaseUrl}/api/tags`);
    if (!upstream.ok) {
      return {
        status: "unavailable",
        ollama: "unavailable",
        model: "unknown",
        latencyMs: Date.now() - startedAt,
        message: `Ollama tags request returned ${upstream.status}`,
      };
    }

    const payload = await upstream.json();
    const installedModels = Array.isArray(payload.models)
      ? payload.models
          .map((item) => (typeof item?.name === "string" ? item.name : null))
          .filter(Boolean)
      : [];
    const isModelLoaded = installedModels.includes(model);

    return {
      status: isModelLoaded ? "ok" : "unavailable",
      ollama: "ok",
      model: isModelLoaded ? "ready" : "missing",
      latencyMs: Date.now() - startedAt,
      ...(isModelLoaded
        ? {}
        : { message: `Configured model "${model}" is not installed` }),
    };
  } catch (error) {
    return {
      status: "unavailable",
      ollama: "unavailable",
      model: "unknown",
      latencyMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : "Ollama unavailable",
    };
  }
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const requestId = request.headers["x-request-id"]?.toString() ?? randomUUID();
  const requestStartedAt = Date.now();

  response.setHeader("x-request-id", requestId);
  response.on("finish", () => {
    log(
      "info",
      "REQUEST",
      `requestId=${requestId} method=${request.method ?? "UNKNOWN"} path=${url.pathname} status=${response.statusCode} tookMs=${Date.now() - requestStartedAt}`,
    );
  });

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-headers": "content-type, x-request-id, authorization",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-origin": "*",
    });
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    sendJson(response, 200, {
      service: "app-generator-llm",
      model,
      endpoints: ["/health", "/api/generate"],
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    const readiness = await checkModelReadiness();
    log(
      readiness.status === "ok" ? "info" : "error",
      "HEALTH",
      `requestId=${requestId} status=${readiness.status} ollama=${readiness.ollama} model=${readiness.model} tookMs=${readiness.latencyMs}`,
    );
    sendJson(response, readiness.status === "ok" ? 200 : 503, {
      ok: readiness.status === "ok",
      service: "app-generator-llm",
      configuredModel: model,
      checks: readiness,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/generate") {
    try {
      const body = await readJsonBody(request);
      if (typeof body.prompt !== "string" || body.prompt.length === 0) {
        sendJson(response, 400, { message: "prompt must be a non-empty string" });
        return;
      }

      if (body.model !== undefined && body.model !== model) {
        sendJson(response, 400, {
          message: `This Space serves only model "${model}"`,
        });
        return;
      }

      const generationStartedAt = Date.now();
      log(
        "info",
        "GENERATE_START",
        `requestId=${requestId} model=${model} promptChars=${body.prompt.length}`,
      );
      const upstream = await fetch(`${ollamaBaseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, model, stream: false }),
      });
      log(
        upstream.ok ? "info" : "error",
        "GENERATE_DONE",
        `requestId=${requestId} model=${model} upstreamStatus=${upstream.status} tookMs=${Date.now() - generationStartedAt}`,
      );
      await relayOllamaResponse(upstream, response);
    } catch (error) {
      const statusCode = error instanceof RequestError ? error.statusCode : 502;
      log(
        "error",
        "GENERATE_ERROR",
        `requestId=${requestId} status=${statusCode} message="${error instanceof Error ? error.message : "Generation failed"}"`,
      );
      sendJson(response, statusCode, {
        message: error instanceof Error ? error.message : "Generation failed",
      });
    }
    return;
  }

  sendJson(response, 404, { message: "Not found" });
});

server.listen(port, "0.0.0.0", async () => {
  log("info", "STARTUP", `gateway listening on port=${port} configuredModel=${model}`);
  const readiness = await checkModelReadiness();
  log(
    readiness.status === "ok" ? "info" : "error",
    "MODEL_INIT",
    `status=${readiness.status} ollama=${readiness.ollama} model=${readiness.model} tookMs=${readiness.latencyMs}${readiness.message ? ` message="${readiness.message}"` : ""}`,
  );
});

server.on("error", (error) => {
  log("error", "SERVER_ERROR", error.message);
});

import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import type { TabletAdapters } from "@tablet-control/integration-contracts";
import Fastify from "fastify";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionStore } from "./auth.js";
import { createConfig, isPrivateIpv4, type AppConfigOverrides } from "./config.js";
import { ApiProblem } from "./errors.js";
import { createAdapters } from "./adapters/index.js";
import { registerRoutes } from "./routes.js";
import { TalkCoordinator } from "./talk.js";
import { UpdateArtifactStore } from "./update-artifact-store.js";

export interface CreateAppOptions {
  config?: AppConfigOverrides;
  adapters?: TabletAdapters;
  storageDirectory?: string;
  updateArtifactStore?: UpdateArtifactStore;
}

function normalizeClientIp(value: string): string {
  return value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
}

function isLoopbackClient(value: string): boolean {
  return value === "127.0.0.1" || value === "::1";
}

export function createApp(options: CreateAppOptions = {}) {
  const config = createConfig(options.config);
  const adapters = options.adapters ?? createAdapters(config);
  const sessions = new SessionStore();
  const talk = new TalkCoordinator();
  const app = Fastify({ logger: false, bodyLimit: 104857600 });
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const storageDirectory = resolve(options.storageDirectory ?? resolve(process.cwd(), ".local"));
  const updateArtifactStore =
    options.updateArtifactStore ?? new UpdateArtifactStore(resolve(storageDirectory, "updates"));

  void app.register(cookie, { secret: config.sessionSecret, hook: "onRequest" });
  void app.register(multipart, {
    throwFileSizeLimit: true
  });
  void app.register(rateLimit, {
    max: 1000,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.ip
  });
  void app.register(websocket);

  if (config.exposureMode === "lan-validation") {
    app.addHook("onRequest", (request, _reply, done) => {
      const clientIp = normalizeClientIp(request.ip);
      const allowAnyPrivate =
        config.allowedClientIps.length === 0 ||
        config.allowedClientIps.includes("0.0.0.0") ||
        config.allowedClientIps.includes("*");

      const isAllowed =
        isLoopbackClient(clientIp) ||
        config.allowedClientIps.includes(clientIp) ||
        (allowAnyPrivate && isPrivateIpv4(clientIp));

      if (!isAllowed) {
        done(
          new ApiProblem(
            403,
            "FORBIDDEN",
            "This temporary LAN validation controller accepts requests only from approved LAN devices.",
            false
          )
        );
        return;
      }

      done();
    });
  }

  if (config.serveWeb) {
    void app.register(fastifyStatic, {
      root: resolve(sourceDirectory, "../../controller-web/dist"),
      index: ["index.html"],
      wildcard: false
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/") && !request.url.startsWith("/media/")) {
        return reply.sendFile("index.html");
      }
      return reply.status(404).send({
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "Route not found.",
          recoverable: false
        }
      });
    });
  } else {
    app.setNotFoundHandler((_request, reply) => {
      return reply.status(404).send({
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "Route not found.",
          recoverable: false
        }
      });
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiProblem) {
      void reply.status(error.statusCode).send(error.response);
      return;
    }

    const errObj = error as { statusCode?: number; retryAfter?: number | string };
    if (errObj.statusCode === 429) {
      const retryAfter = errObj.retryAfter ?? 60;
      void reply
        .header("retry-after", String(retryAfter))
        .status(429)
        .send({
          ok: false,
          error: {
            code: "RATE_LIMITED",
            message: "Too many requests. Please wait before retrying.",
            recoverable: true
          }
        });
      return;
    }

    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : undefined;

    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      void reply.status(statusCode).send({
        ok: false,
        error: {
          code: statusCode === 429 ? "RATE_LIMITED" : "VALIDATION_ERROR",
          message:
            statusCode === 429
              ? "Request limit reached. Wait briefly before retrying."
              : "The request could not be accepted.",
          recoverable: statusCode === 429
        }
      });
      return;
    }

    void reply.status(500).send({
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected controller error occurred.",
        recoverable: false
      }
    });
  });

  void app.register(registerRoutes, {
    config,
    adapters,
    sessions,
    talk,
    storageDirectory,
    updateArtifactStore
  });

  return app;
}

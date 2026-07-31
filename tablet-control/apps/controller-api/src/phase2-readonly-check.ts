import { createAdapters } from "./adapters/index.js";
import { createConfig } from "./config.js";
import { ApiProblem } from "./errors.js";
import type { StreamKind } from "@tablet-control/shared-types";

interface StreamResult {
  connected: boolean;
  firstChunkReceived: boolean;
  contentType: string | null;
  connectionLatencyMs: number;
}

interface AttemptResult {
  result: "ok" | "failed";
  errorCode?: string;
  details?: StreamResult;
}

async function readOneStream(kind: StreamKind): Promise<StreamResult> {
  const config = createConfig();
  const adapter = createAdapters(config).ipWebcam;
  const connection = await adapter.openReadOnlyStream(kind);
  const reader = connection.body.getReader();
  const timeout = setTimeout(() => {
    void reader.cancel();
    connection.cancel();
  }, config.ipWebcam?.requestTimeoutMs ?? 5_000);

  try {
    const firstChunk = await reader.read();
    return {
      connected: true,
      firstChunkReceived: !firstChunk.done && firstChunk.value.byteLength > 0,
      contentType: connection.diagnostics.contentType,
      connectionLatencyMs: connection.diagnostics.connectionLatencyMs
    };
  } finally {
    clearTimeout(timeout);
    await reader.cancel();
    connection.cancel();
  }
}

async function attemptStream(kind: StreamKind): Promise<AttemptResult> {
  try {
    return { result: "ok", details: await readOneStream(kind) };
  } catch (error) {
    return {
      result: "failed",
      errorCode: error instanceof ApiProblem ? error.response.error.code : "UNKNOWN_STREAM_FAILURE"
    };
  }
}

async function main(): Promise<void> {
  const config = createConfig();
  if (config.adapterMode !== "real-readonly") {
    throw new Error("Phase 2 check requires TABLET_ADAPTER_MODE=real-readonly.");
  }

  const adapter = createAdapters(config).ipWebcam;
  let status: { result: "ok" | "failed"; latencyMs?: number | null; errorCode?: string };
  try {
    const value = await adapter.getStatus();
    status = { result: "ok", latencyMs: value.lastStatusLatencyMs };
  } catch (error) {
    status = {
      result: "failed",
      errorCode: error instanceof ApiProblem ? error.response.error.code : "UNKNOWN_STATUS_FAILURE"
    };
  }

  const video = await attemptStream("video");
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  const audio = await attemptStream("audio");
  const passed = status.result === "ok" && video.result === "ok" && audio.result === "ok";

  console.log(
    JSON.stringify({
      mode: "real-readonly",
      transport: config.ipWebcam?.transport,
      status,
      video,
      audio,
      persistedMedia: false,
      tabletControlCommandsSent: 0
    })
  );
  if (!passed) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  const code = error instanceof ApiProblem ? error.response.error.code : "CONFIGURATION_ERROR";
  console.error(JSON.stringify({ mode: "real-readonly", result: "failed", code }));
  process.exitCode = 1;
}

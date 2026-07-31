import { createApp } from "./app.js";
import { createConfig } from "./config.js";

interface StreamResult {
  connected: boolean;
  firstChunkReceived: boolean;
  contentType: string | null;
  connectionLatencyMs: string | null;
}

async function main(): Promise<void> {
  const config = createConfig();
  if (config.adapterMode !== "real-readonly") {
    throw new Error("Phase 2 proxy check requires TABLET_ADAPTER_MODE=real-readonly.");
  }

  const app = createApp({ config });
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Local controller did not receive a TCP address.");
    }

    const localOrigin = `http://127.0.0.1:${address.port}`;
    const loginResponse = await fetch(localOrigin + "/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: config.adminUsername, password: config.mockAdminPassword })
    });
    const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
    if (!loginResponse.ok || cookie === undefined) {
      throw new Error("Local controller authentication failed.");
    }
    const sessionCookie: string = cookie;

    const statusResponse = await fetch(localOrigin + "/api/v1/camera/status", {
      headers: { cookie: sessionCookie }
    });
    if (!statusResponse.ok) {
      throw new Error("Read-only camera status route failed.");
    }

    async function checkStream(path: string): Promise<StreamResult> {
      const controller = new AbortController();
      const response = await fetch(localOrigin + path, {
        headers: { cookie: sessionCookie },
        signal: controller.signal
      });
      if (!response.ok || response.body === null) {
        throw new Error("Read-only stream route failed.");
      }

      const reader = response.body.getReader();
      try {
        const chunk = await reader.read();
        return {
          connected: true,
          firstChunkReceived: !chunk.done && chunk.value.byteLength > 0,
          contentType: response.headers.get("content-type"),
          connectionLatencyMs: response.headers.get("x-controller-stream-latency-ms")
        };
      } finally {
        await reader.cancel();
        controller.abort();
      }
    }

    const video = await checkStream("/api/v1/camera/stream");
    const audio = await checkStream("/api/v1/camera/audio");
    console.log(
      JSON.stringify({
        mode: "real-readonly",
        controllerBoundTo: "localhost",
        statusRoute: "ok",
        video,
        audio,
        persistedMedia: false,
        tabletControlCommandsSent: 0
      })
    );
  } finally {
    await app.close();
  }
}

try {
  await main();
} catch {
  console.error(JSON.stringify({ mode: "real-readonly", result: "failed" }));
  process.exitCode = 1;
}

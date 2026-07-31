import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { type AppConfig, createConfig } from "./config.js";
import { ReadOnlyIpWebcamAdapter } from "./adapters/readonly-ip-webcam.js";
import { ReadWriteIpWebcamAdapter } from "./adapters/readwrite-ip-webcam.js";

interface Fixture {
  server: Server;
  baseUrl: URL;
  requests: Array<{ method: string; path: string }>;
  waitForStreamClose(): Promise<void>;
}

const servers: Server[] = [];

async function createFixture(): Promise<Fixture> {
  const requests: Array<{ method: string; path: string }> = [];
  let cameraOrientation = "landscape";
  let resolveStreamClose: (() => void) | undefined;
  const streamClosed = new Promise<void>((resolve) => {
    resolveStreamClose = resolve;
  });

  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    requests.push({ method: request.method ?? "", path });

    // Camera control commands (Phase 4D): accept both GET and POST
    if (
      path.startsWith("/ptz") ||
      path.startsWith("/settings/quality") ||
      path.startsWith("/settings/frame_duration") ||
      path.startsWith("/settings/focusmode") ||
      path.startsWith("/settings/video_size") ||
      path.startsWith("/settings/ffc") ||
      path.startsWith("/settings/orientation") ||
      path === "/focus"
    ) {
      if (path.startsWith("/settings/orientation")) {
        cameraOrientation =
          new URL(path, "http://fixture.invalid").searchParams.get("set") ?? cameraOrientation;
      }
      response.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }

    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }

    if (path.startsWith("/status.json")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          curvals: {
            zoom: "100",
            quality: "65",
            video_size: "1280x720",
            ffc: "off",
            orientation: cameraOrientation,
            focusmode: "continuous-video",
            frame_duration: "33333333"
          }
        })
      );
      return;
    }

    if (path === "/video" || path === "/audio.wav") {
      response.writeHead(200, {
        "content-type":
          path === "/video" ? "multipart/x-mixed-replace; boundary=frame" : "audio/wav",
        "cache-control": "no-store"
      });
      const interval = setInterval(() => response.write("fixture-stream-chunk"), 5);
      request.once("close", () => {
        clearInterval(interval);
        resolveStreamClose?.();
      });
      return;
    }

    response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fixture server did not receive a TCP address.");
  }

  return {
    server,
    baseUrl: new URL(`http://127.0.0.1:${address.port}`),
    requests,
    waitForStreamClose: () => streamClosed
  };
}

async function login(app: ReturnType<typeof createApp>) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "admin", password: "test-only-password" }
  });
  const cookieHeader = response.headers["set-cookie"];
  const cookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  if (cookie === undefined) {
    throw new Error("Expected session cookie.");
  }
  const sessionCookie: string = cookie;

  return {
    cookie: sessionCookie.split(";")[0]!,
    csrfToken: (response.json() as { data: { csrfToken: string } }).data.csrfToken
  };
}

function realReadOnlyConfig(baseUrl: URL): Partial<AppConfig> {
  return {
    environment: "test",
    adapterMode: "real-readonly",
    mockAdminPassword: "test-only-password",
    ipWebcam: {
      baseUrl,
      transport: "trusted-lan",
      requestTimeoutMs: 1_000,
      maxReconnectAttempts: 3
    }
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

describe("real-readonly integration safety", () => {
  it("fails closed when real read-only configuration is missing", () => {
    const original = process.env.TABLET_IP_WEBCAM_BASE_URL;
    delete process.env.TABLET_IP_WEBCAM_BASE_URL;
    try {
      expect(() => createConfig({ adapterMode: "real-readonly" })).toThrow(
        "TABLET_IP_WEBCAM_BASE_URL is required"
      );
    } finally {
      if (original === undefined) {
        delete process.env.TABLET_IP_WEBCAM_BASE_URL;
      } else {
        process.env.TABLET_IP_WEBCAM_BASE_URL = original;
      }
    }
  });

  it("accepts 0.0.0.0 as controller bind host in localhost mode", () => {
    const original = process.env.CONTROLLER_BIND_HOST;
    process.env.CONTROLLER_BIND_HOST = "0.0.0.0";
    try {
      // 0.0.0.0 is now allowed in localhost mode for phone connectivity
      const config = createConfig({ adapterMode: "mock" });
      expect(config.bindHost).toBe("0.0.0.0");
    } finally {
      if (original === undefined) {
        delete process.env.CONTROLLER_BIND_HOST;
      } else {
        process.env.CONTROLLER_BIND_HOST = original;
      }
    }
  });

  it("uses GET-only status and closes a stream when the consumer disconnects", async () => {
    const fixture = await createFixture();
    const adapter = new ReadOnlyIpWebcamAdapter({
      baseUrl: fixture.baseUrl,
      transport: "trusted-lan",
      requestTimeoutMs: 1_000,
      maxReconnectAttempts: 3
    });

    const status = await adapter.getStatus();
    expect(status).toMatchObject({
      mode: "real-readonly",
      healthy: true,
      activeCamera: "rear",
      zoom: 1,
      quality: 65,
      fps: 30,
      focusMode: "continuous-video"
    });

    const stream = await adapter.openReadOnlyStream("video");
    const reader = stream.body.getReader();
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    await reader.cancel();
    stream.cancel();
    await fixture.waitForStreamClose();

    expect(fixture.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "GET", path: "/status.json?show_avail=1" }),
        expect.objectContaining({ method: "GET", path: "/video" })
      ])
    );
    expect(fixture.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("returns a typed malformed-response error without accepting HTML as status", async () => {
    const adapter = new ReadOnlyIpWebcamAdapter(
      {
        baseUrl: new URL("http://127.0.0.1:1"),
        transport: "trusted-lan",
        requestTimeoutMs: 1_000,
        maxReconnectAttempts: 0
      },
      (async () =>
        new Response("<html>not-json</html>", {
          headers: { "content-type": "text/html" }
        })) as typeof fetch
    );

    await expect(adapter.getStatus()).rejects.toMatchObject({
      statusCode: 502,
      response: { error: { code: "MALFORMED_RESPONSE" } }
    });
  });

  it("forwards a camera quality command to the real adapter when authorized", async () => {
    const fixture = await createFixture();
    const app = createApp({ config: realReadOnlyConfig(fixture.baseUrl) });
    try {
      const session = await login(app);
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/camera/quality",
        headers: { cookie: session.cookie, "x-csrf-token": session.csrfToken },
        payload: { quality: 70 }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, data: { simulated: false } });
      expect(fixture.requests.some((r) => r.method === "POST" && r.path.includes("quality"))).toBe(
        true
      );
    } finally {
      await app.close();
    }
  });

  it("rejects a camera control command without a CSRF token", async () => {
    const fixture = await createFixture();
    const app = createApp({ config: realReadOnlyConfig(fixture.baseUrl) });
    try {
      const session = await login(app);
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/camera/zoom",
        headers: { cookie: session.cookie }, // no CSRF token
        payload: { zoom: 2 }
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ ok: false, error: { code: "CSRF_REJECTED" } });
      // Command must NOT have reached the adapter
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("ReadWriteIpWebcamAdapter sends camera controls to IP Webcam", async () => {
    const fixture = await createFixture();
    const adapter = new ReadWriteIpWebcamAdapter({
      baseUrl: fixture.baseUrl,
      transport: "trusted-lan",
      requestTimeoutMs: 1_000,
      maxReconnectAttempts: 3
    });

    const result = await adapter.setQuality(75);
    expect(result).toMatchObject({ simulated: false });
    expect(fixture.requests.some((r) => r.method === "POST" && r.path.includes("quality"))).toBe(
      true
    );
  });

  it("validates and confirms a supported camera orientation", async () => {
    const fixture = await createFixture();
    const adapter = new ReadWriteIpWebcamAdapter({
      baseUrl: fixture.baseUrl,
      transport: "trusted-lan",
      requestTimeoutMs: 1_000,
      maxReconnectAttempts: 3
    });

    const result = await adapter.setOrientation("portrait");
    expect(result).toMatchObject({ simulated: false });
    await expect(adapter.getStatus()).resolves.toMatchObject({ orientation: "portrait" });
    expect(
      fixture.requests.some(
        (request) =>
          request.method === "GET" && request.path === "/settings/orientation?set=portrait"
      )
    ).toBe(true);
  });

  it("cancels the upstream stream when a localhost browser connection closes", async () => {
    const fixture = await createFixture();
    const app = createApp({ config: realReadOnlyConfig(fixture.baseUrl) });
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Local controller did not receive a TCP address.");
      }

      const session = await login(app);
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/camera/stream`, {
        headers: { cookie: session.cookie },
        signal: controller.signal
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-controller-stream-mode")).toBe("real-readonly");
      if (response.body === null) {
        throw new Error("Expected a proxied stream body.");
      }

      const reader = response.body.getReader();
      const firstChunk = await reader.read();
      expect(firstChunk.done).toBe(false);
      await reader.cancel();
      controller.abort();
      await fixture.waitForStreamClose();
      expect(fixture.requests).toEqual(
        expect.arrayContaining([expect.objectContaining({ method: "GET", path: "/video" })])
      );
    } finally {
      await app.close();
    }
  });
});

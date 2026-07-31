import type { MediaItem, SignagePlaylist } from "@tablet-control/shared-types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { createMockAdapters } from "./adapters/mock.js";
import { MediaLibrary, MediaStorageError } from "./media-library.js";

type TestApp = ReturnType<typeof createApp>;

const resources: Array<{ app?: TestApp; directory: string }> = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "roshanos-signage-"));
  resources.push({ directory });
  return directory;
}

function testApp(options: Parameters<typeof createApp>[0] = {}): TestApp {
  const directory = temporaryDirectory();
  const app = createApp({
    ...options,
    storageDirectory: directory,
    config: {
      environment: "test",
      mockAdminPassword: "test-only-password",
      ...options.config
    }
  });
  const resource = resources.find((candidate) => candidate.directory === directory);
  if (resource !== undefined) {
    resource.app = app;
  }
  return app;
}

async function login(app: TestApp): Promise<{ cookie: string; csrfToken: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: {
      username: "admin",
      password: "test-only-password"
    }
  });
  const body = response.json() as { data: { csrfToken: string } };
  const setCookie = response.headers["set-cookie"];
  const firstCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (firstCookie === undefined) {
    throw new Error("Expected a session cookie.");
  }
  return {
    cookie: firstCookie.split(";")[0] ?? "",
    csrfToken: body.data.csrfToken
  };
}

function authHeaders(session: { cookie: string; csrfToken: string }): Record<string, string> {
  return {
    cookie: session.cookie,
    "x-csrf-token": session.csrfToken
  };
}

function pngBytes(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04]);
}

function jpegBytes(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
}

function mp4Bytes(): Buffer {
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftyp", 4, "ascii");
  bytes.write("isom", 8, "ascii");
  bytes.writeUInt32BE(0, 12);
  bytes.write("isom", 16, "ascii");
  bytes.write("mp42", 20, "ascii");
  return bytes;
}

function multipartUpload(
  fileName: string,
  mimeType: string,
  bytes: Buffer,
  options: {
    durationSeconds?: string;
    title?: string;
    extraFields?: Record<string, string>;
  } = {}
): { contentType: string; payload: Buffer } {
  const boundary = "----RoshanOSTestBoundary7d9f8a6b";
  const chunks: Buffer[] = [];
  const appendField = (name: string, value: string) => {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        "utf8"
      )
    );
  };

  appendField("durationSeconds", options.durationSeconds ?? "10");
  if (options.title !== undefined) appendField("title", options.title);
  for (const [name, value] of Object.entries(options.extraFields ?? {})) {
    appendField(name, value);
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
      "utf8"
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")
  );
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat(chunks)
  };
}

async function upload(
  app: TestApp,
  session: { cookie: string; csrfToken: string },
  fileName: string,
  mimeType: "image/png" | "image/jpeg" | "video/mp4",
  bytes: Buffer
): Promise<MediaItem> {
  const multipart = multipartUpload(fileName, mimeType, bytes);
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/media/items",
    headers: {
      ...authHeaders(session),
      "content-type": multipart.contentType
    },
    payload: multipart.payload
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { data: MediaItem }).data;
}

afterEach(async () => {
  const pending = resources.splice(0);
  await Promise.all(pending.map(async ({ app }) => app?.close()));
  for (const { directory } of pending) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("secure signage media", () => {
  it("requires an authenticated CSRF-protected upload and rejects mismatched content", async () => {
    const app = testApp();
    const bytes = pngBytes();
    const validUpload = multipartUpload("welcome.png", "image/png", bytes);

    const unauthenticated = await app.inject({
      method: "POST",
      url: "/api/v1/media/items",
      headers: { "content-type": validUpload.contentType },
      payload: validUpload.payload
    });
    expect(unauthenticated.statusCode).toBe(401);

    const session = await login(app);
    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/media/items",
      headers: {
        cookie: session.cookie,
        "content-type": validUpload.contentType
      },
      payload: validUpload.payload
    });
    expect(missingCsrf.statusCode).toBe(403);

    const legacyJson = await app.inject({
      method: "POST",
      url: "/api/v1/media/items",
      headers: authHeaders(session),
      payload: {
        fileName: "welcome.png",
        mimeType: "image/png",
        sizeBytes: bytes.length,
        durationSeconds: 10,
        dataUrl: `data:image/png;base64,${bytes.toString("base64")}`
      }
    });
    expect(legacyJson.statusCode).toBe(415);

    const wrongMagicUpload = multipartUpload("welcome.png", "image/png", Buffer.from("not a png"));
    const wrongMagic = await app.inject({
      method: "POST",
      url: "/api/v1/media/items",
      headers: {
        ...authHeaders(session),
        "content-type": wrongMagicUpload.contentType
      },
      payload: wrongMagicUpload.payload
    });
    expect(wrongMagic.statusCode).toBe(400);

    const wrongExtensionUpload = multipartUpload("welcome.mp4", "image/png", bytes);
    const wrongExtension = await app.inject({
      method: "POST",
      url: "/api/v1/media/items",
      headers: {
        ...authHeaders(session),
        "content-type": wrongExtensionUpload.contentType
      },
      payload: wrongExtensionUpload.payload
    });
    expect(wrongExtension.statusCode).toBe(400);

    const unexpectedMetadataUpload = multipartUpload("welcome.png", "image/png", bytes, {
      extraFields: { sizeBytes: bytes.length.toString() }
    });
    const unexpectedMetadata = await app.inject({
      method: "POST",
      url: "/api/v1/media/items",
      headers: {
        ...authHeaders(session),
        "content-type": unexpectedMetadataUpload.contentType
      },
      payload: unexpectedMetadataUpload.payload
    });
    expect(unexpectedMetadata.statusCode).toBe(400);
  });

  it("hard-deprecates JSON/base64 display routes and displays only multipart library items", async () => {
    const adapters = createMockAdapters();
    const displayMedia = vi.spyOn(adapters.fullyKiosk, "showMedia");
    const app = testApp({ adapters });
    const session = await login(app);
    const bytes = pngBytes();

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/display/image",
      headers: { cookie: session.cookie },
      payload: {
        dataUrl: `data:image/png;base64,${bytes.toString("base64")}`
      }
    });
    expect(missingCsrf.statusCode).toBe(403);

    const legacy = await app.inject({
      method: "POST",
      url: "/api/v1/display/image",
      headers: authHeaders(session),
      payload: {
        fileName: "welcome.png",
        mimeType: "image/png",
        sizeBytes: bytes.length,
        durationSeconds: 10,
        restoreDashboard: true,
        dataUrl: `data:image/png;base64,${bytes.toString("base64")}`
      }
    });
    expect(legacy.statusCode).toBe(410);
    expect(legacy.json()).toMatchObject({
      error: {
        code: "UNSUPPORTED",
        message: expect.stringContaining("multipart")
      }
    });

    const item = await upload(app, session, "welcome.png", "image/png", bytes);
    const displayed = await app.inject({
      method: "POST",
      url: "/api/v1/display/media",
      headers: authHeaders(session),
      payload: {
        mediaId: item.id,
        durationSeconds: 10,
        restoreDashboard: true
      }
    });
    expect(displayed.statusCode).toBe(200);
    expect(displayMedia).toHaveBeenCalledWith("image", "welcome.png");

    const embeddedPayload = await app.inject({
      method: "POST",
      url: "/api/v1/display/media",
      headers: authHeaders(session),
      payload: {
        mediaId: item.id,
        durationSeconds: 10,
        restoreDashboard: true,
        dataUrl: "data:image/png;base64,AAAA"
      }
    });
    expect(embeddedPayload.statusCode).toBe(400);
  });

  it("serves immutable same-origin media with seeking ranges and blocks traversal", async () => {
    const app = testApp();
    const session = await login(app);
    const bytes = pngBytes();
    const item = await upload(app, session, "welcome.png", "image/png", bytes);

    expect(item.url).toMatch(/^\/media\/media_[0-9]{13}_[a-f0-9]{8}$/u);
    expect(item.url).not.toContain("@");

    const full = await app.inject({ method: "GET", url: item.url });
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload).toEqual(bytes);
    expect(full.headers["content-type"]).toContain("image/png");
    expect(full.headers["accept-ranges"]).toBe("bytes");
    expect(full.headers["cache-control"]).toContain("immutable");
    expect(full.headers["x-content-type-options"]).toBe("nosniff");
    expect(full.headers.etag).toMatch(/^"[a-f0-9]{64}"$/u);

    const partial = await app.inject({
      method: "GET",
      url: item.url,
      headers: { range: "bytes=2-5" }
    });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers["content-range"]).toBe(`bytes 2-5/${bytes.length.toString()}`);
    expect(partial.headers["content-length"]).toBe("4");
    expect(partial.rawPayload).toEqual(bytes.subarray(2, 6));

    const suffix = await app.inject({
      method: "GET",
      url: item.url,
      headers: { range: "bytes=-3" }
    });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.rawPayload).toEqual(bytes.subarray(bytes.length - 3));

    const invalidRange = await app.inject({
      method: "GET",
      url: item.url,
      headers: { range: "bytes=0-1,3-4" }
    });
    expect(invalidRange.statusCode).toBe(416);
    expect(invalidRange.headers["content-range"]).toBe(`bytes */${bytes.length.toString()}`);

    const notModified = await app.inject({
      method: "GET",
      url: item.url,
      headers: { "if-none-match": String(full.headers.etag) }
    });
    expect(notModified.statusCode).toBe(304);

    const videoBytes = mp4Bytes();
    const video = await upload(app, session, "loop.mp4", "video/mp4", videoBytes);
    const videoRange = await app.inject({
      method: "GET",
      url: video.url,
      headers: { range: "bytes=4-11" }
    });
    expect(videoRange.statusCode).toBe(206);
    expect(videoRange.headers["content-type"]).toContain("video/mp4");
    expect(videoRange.rawPayload).toEqual(videoBytes.subarray(4, 12));

    const traversal = await app.inject({
      method: "GET",
      url: "/media/%2e%2e%2fcatalog.json"
    });
    expect(traversal.statusCode).not.toBe(200);
    expect(traversal.body).not.toContain(item.checksum);
  });

  it("validates playlist order, timing, mute state, and playback acknowledgements", async () => {
    const app = testApp();
    const session = await login(app);
    const image = await upload(app, session, "welcome.png", "image/png", pngBytes());
    const video = await upload(app, session, "loop.mp4", "video/mp4", mp4Bytes());
    const items = [
      {
        id: video.id,
        type: video.type,
        url: video.url,
        fileName: video.fileName,
        checksum: video.checksum,
        durationSeconds: 42,
        muted: false
      },
      {
        id: image.id,
        type: image.type,
        url: image.url,
        fileName: image.fileName,
        checksum: image.checksum,
        durationSeconds: 7,
        muted: true
      }
    ];

    const saved = await app.inject({
      method: "POST",
      url: "/api/v1/signage/playlist",
      headers: authHeaders(session),
      payload: { loop: false, items }
    });
    expect(saved.statusCode).toBe(200);
    const playlist = (saved.json() as { data: SignagePlaylist }).data;
    expect(playlist.loop).toBe(false);
    expect(playlist.items.map((item) => item.id)).toEqual([video.id, image.id]);
    expect(playlist.items[0]).toMatchObject({
      checksum: video.checksum,
      durationSeconds: 42,
      muted: false
    });
    expect(playlist.revision).toBeGreaterThan(0);

    const invalidDuration = await app.inject({
      method: "POST",
      url: "/api/v1/signage/playlist",
      headers: authHeaders(session),
      payload: {
        items: [{ ...items[0], durationSeconds: 0 }]
      }
    });
    expect(invalidDuration.statusCode).toBe(400);

    const externalUrl = await app.inject({
      method: "POST",
      url: "/api/v1/signage/playlist",
      headers: authHeaders(session),
      payload: {
        items: [{ ...items[0], url: "https://example.invalid/video.mp4" }]
      }
    });
    expect(externalUrl.statusCode).toBe(400);

    const mismatchedChecksum = await app.inject({
      method: "POST",
      url: "/api/v1/signage/playlist",
      headers: authHeaders(session),
      payload: {
        items: [{ ...items[0], checksum: "0".repeat(64) }]
      }
    });
    expect(mismatchedChecksum.statusCode).toBe(400);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/signage/playlist",
      headers: authHeaders(session),
      payload: { items: [items[0], items[0]] }
    });
    expect(duplicate.statusCode).toBe(400);

    const acknowledgementPayload = {
      playerId: "tablet-player",
      playlistRevision: playlist.revision,
      itemId: video.id,
      state: "playing",
      positionSeconds: 3.25
    };
    const withoutCapability = await app.inject({
      method: "POST",
      url: "/api/v1/signage/playback",
      headers: { cookie: session.cookie },
      payload: acknowledgementPayload
    });
    expect(withoutCapability.statusCode).toBe(401);

    const playerUserAgent = "RoshanOS-Test-Player/1.0";
    const playerPage = await app.inject({
      method: "GET",
      url: "/signage-player.html",
      headers: { "user-agent": playerUserAgent }
    });
    const setCookie = playerPage.headers["set-cookie"];
    const firstCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(firstCookie).toContain("roshanos_signage_player=");
    expect(firstCookie).toContain("HttpOnly");
    expect(firstCookie).toContain("SameSite=Strict");
    expect(firstCookie).toContain("Path=/api/v1/signage");
    const playerCookie = firstCookie?.split(";")[0] ?? "";
    expect(playerPage.body).not.toContain(playerCookie.split("=")[1] ?? "not-present");

    const acknowledged = await app.inject({
      method: "POST",
      url: "/api/v1/signage/playback",
      headers: {
        cookie: playerCookie,
        "user-agent": playerUserAgent
      },
      payload: acknowledgementPayload
    });
    expect(acknowledged.statusCode).toBe(200);

    const staleAcknowledgement = await app.inject({
      method: "POST",
      url: "/api/v1/signage/playback",
      headers: {
        cookie: playerCookie,
        "user-agent": playerUserAgent
      },
      payload: {
        ...acknowledgementPayload,
        playlistRevision: playlist.revision + 1,
        positionSeconds: 4
      }
    });
    expect(staleAcknowledgement.statusCode).toBe(409);

    const wrongUserAgent = await app.inject({
      method: "POST",
      url: "/api/v1/signage/playback",
      headers: {
        cookie: playerCookie,
        "user-agent": "Forged-Player/1.0"
      },
      payload: acknowledgementPayload
    });
    expect(wrongUserAgent.statusCode).toBe(401);

    const unauthenticatedState = await app.inject({
      method: "GET",
      url: "/api/v1/signage/playback"
    });
    expect(unauthenticatedState.statusCode).toBe(401);

    const state = await app.inject({
      method: "GET",
      url: "/api/v1/signage/playback",
      headers: { cookie: session.cookie }
    });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({
      data: {
        playerId: "tablet-player",
        itemId: video.id,
        state: "playing",
        positionSeconds: 3.25
      }
    });
  });

  it("ships a recovery-aware player that honors playlist loop state and reports playback", async () => {
    const app = testApp();
    const response = await app.inject({ method: "GET", url: "/signage-player.html" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("max-age=300");
    expect(response.headers["cache-control"]).toContain("stale-if-error=604800");
    expect(response.headers.etag).toMatch(/^"[a-f0-9]{64}"$/u);
    expect(response.headers["content-security-policy"]).toContain("media-src 'self' blob:");
    expect(response.body).toContain("recoverVideo");
    expect(response.body).toContain("video.currentTime");
    expect(response.body).toContain("video.muted = item.muted");
    expect(response.body).toContain("playlist.loop");
    expect(response.body).toContain("/api/v1/signage/playback");
    expect(response.body).toContain("/api/v1/signage/completion");
    expect(response.body).toContain('digest("SHA-256"');
    expect(response.body).toContain('errorPrefix + "ChecksumMismatch"');
    expect(response.body).toContain("playPromise.catch");
    expect(response.body).toContain("roshanos.signage.playlist.v2");
    expect(response.body).toContain("roshanos-signage-media-v2-r");
    expect(response.body).toContain("MAX_CACHE_ITEMS = 100");
    expect(response.body).toContain("MAX_CACHE_BYTES = 192 * 1024 * 1024");
    expect(response.body).toContain("window.localStorage.setItem");
    expect(response.body).toContain("caches.open");
    expect(response.body).toContain("URL.revokeObjectURL");
    expect(response.body).toContain("stageCompletePlaylist");
    expect(response.body).toContain("validateCachedPlaylist");
    expect(response.body).toContain("persistVerifiedPlaylist");
    expect(response.body).not.toContain("scheduleMediaCache");

    const setCookie = response.headers["set-cookie"];
    const firstCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(firstCookie).toContain("roshanos_signage_player=");
    expect(firstCookie).toContain("HttpOnly");
    expect(firstCookie).toContain("SameSite=Strict");

    const script = response.body.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
    expect(script).toBeDefined();
    expect(() => Function(script ?? "")).not.toThrow();

    const notModified = await app.inject({
      method: "GET",
      url: "/signage-player.html",
      headers: { "if-none-match": String(response.headers.etag) }
    });
    expect(notModified.statusCode).toBe(304);
  });

  it("restores managed Home automatically when a protected non-loop player completes", async () => {
    const adapters = createMockAdapters();
    const restoreHome = vi.spyOn(adapters.companion, "restoreDashboard");
    const app = testApp({
      adapters,
      config: {
        adapterMode: "companion",
        companion: {
          baseUrl: "http://100.64.0.2:8765",
          secret: "test-companion-secret",
          requestTimeoutMs: 1000
        },
        ipWebcam: {
          baseUrl: new URL("http://100.64.0.2:8080"),
          transport: "tailscale",
          requestTimeoutMs: 1000,
          maxReconnectAttempts: 0,
          credentials: {
            username: "camera-user",
            password: "test-camera-password"
          }
        }
      }
    });
    const session = await login(app);
    const image = await upload(app, session, "completed.png", "image/png", pngBytes());
    const saved = await app.inject({
      method: "POST",
      url: "/api/v1/signage/playlist",
      headers: authHeaders(session),
      payload: {
        loop: false,
        items: [
          {
            id: image.id,
            type: image.type,
            url: image.url,
            fileName: image.fileName,
            checksum: image.checksum,
            durationSeconds: 1,
            muted: true
          }
        ]
      }
    });
    expect(saved.statusCode).toBe(200);
    const started = await app.inject({
      method: "POST",
      url: "/api/v1/signage/start",
      headers: authHeaders(session)
    });
    expect(started.statusCode).toBe(200);

    const playerUserAgent = "RoshanOS-Completion-Player/1.0";
    const playerPage = await app.inject({
      method: "GET",
      url: "/signage-player.html",
      headers: { "user-agent": playerUserAgent }
    });
    const setCookie = playerPage.headers["set-cookie"];
    const firstCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const playerCookie = firstCookie?.split(";")[0] ?? "";
    const playlistResponse = await app.inject({
      method: "GET",
      url: "/api/v1/signage/playlist",
      headers: { "user-agent": playerUserAgent }
    });
    const playlist = (playlistResponse.json() as { data: SignagePlaylist }).data;
    expect(playlist.enabled).toBe(true);
    expect(playlist.loop).toBe(false);

    const completionPayload = {
      playerId: "tablet-completion-player",
      playlistRevision: playlist.revision,
      itemId: image.id
    };
    const withoutCapability = await app.inject({
      method: "POST",
      url: "/api/v1/signage/completion",
      payload: completionPayload
    });
    expect(withoutCapability.statusCode).toBe(401);
    expect(restoreHome).not.toHaveBeenCalled();

    const staleCompletion = await app.inject({
      method: "POST",
      url: "/api/v1/signage/completion",
      headers: {
        cookie: playerCookie,
        "user-agent": playerUserAgent
      },
      payload: {
        ...completionPayload,
        playlistRevision: playlist.revision + 1
      }
    });
    expect(staleCompletion.statusCode).toBe(409);
    expect(restoreHome).not.toHaveBeenCalled();

    const completed = await app.inject({
      method: "POST",
      url: "/api/v1/signage/completion",
      headers: {
        cookie: playerCookie,
        "user-agent": playerUserAgent
      },
      payload: completionPayload
    });
    expect(completed.statusCode).toBe(200);
    expect(restoreHome).toHaveBeenCalledOnce();
    expect(completed.json()).toMatchObject({
      data: {
        playlist: { enabled: false, loop: false },
        playback: {
          playerId: "tablet-completion-player",
          itemId: null,
          state: "stopped"
        }
      }
    });

    const retried = await app.inject({
      method: "POST",
      url: "/api/v1/signage/completion",
      headers: {
        cookie: playerCookie,
        "user-agent": playerUserAgent
      },
      payload: completionPayload
    });
    expect(retried.statusCode).toBe(200);
    expect(restoreHome).toHaveBeenCalledOnce();
  });

  it("restores managed Home through the companion adapter when signage stops", async () => {
    const adapters = createMockAdapters();
    const restoreHome = vi.spyOn(adapters.companion, "restoreDashboard");
    const openPlayer = vi.spyOn(adapters.companion, "showWebpage");
    const app = testApp({
      adapters,
      config: {
        adapterMode: "companion",
        companion: {
          baseUrl: "http://100.64.0.2:8765",
          secret: "test-companion-secret",
          requestTimeoutMs: 1000
        },
        ipWebcam: {
          baseUrl: new URL("http://100.64.0.2:8080"),
          transport: "tailscale",
          requestTimeoutMs: 1000,
          maxReconnectAttempts: 0,
          credentials: {
            username: "camera-user",
            password: "test-camera-password"
          }
        }
      }
    });
    const session = await login(app);
    const image = await upload(app, session, "welcome.png", "image/png", pngBytes());
    const playlistResponse = await app.inject({
      method: "POST",
      url: "/api/v1/signage/playlist",
      headers: authHeaders(session),
      payload: {
        items: [
          {
            id: image.id,
            type: image.type,
            url: image.url,
            fileName: image.fileName,
            checksum: image.checksum,
            durationSeconds: 10,
            muted: true
          }
        ]
      }
    });
    expect(playlistResponse.statusCode).toBe(200);

    const started = await app.inject({
      method: "POST",
      url: "/api/v1/signage/start",
      headers: {
        ...authHeaders(session),
        host: "100.64.0.1:3000"
      }
    });
    expect(started.statusCode).toBe(200);
    expect(openPlayer).toHaveBeenCalledWith("http://100.64.0.1:3000/signage-player.html");
    expect(openPlayer.mock.calls[0]?.[0]).not.toContain("@");
    expect(openPlayer.mock.calls[0]?.[0]).not.toContain("?");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/signage/stop",
      headers: authHeaders(session)
    });

    expect(response.statusCode).toBe(200);
    expect(restoreHome).toHaveBeenCalledOnce();
  });
});

describe("bounded media library", () => {
  it("enforces decoded file and total-library limits", () => {
    const directory = temporaryDirectory();
    const library = new MediaLibrary(join(directory, "media"), {
      maxFileBytes: 16,
      maxTotalBytes: 18,
      maxItems: 3
    });
    const png = pngBytes();
    const jpeg = jpegBytes();

    library.addMedia(
      {
        fileName: "one.png",
        mimeType: "image/png",
        sizeBytes: png.length,
        durationSeconds: 10
      },
      png
    );

    expect(() =>
      library.addMedia(
        {
          fileName: "two.jpg",
          mimeType: "image/jpeg",
          sizeBytes: jpeg.length,
          durationSeconds: 10
        },
        jpeg
      )
    ).toThrowError(MediaStorageError);

    const tooLarge = mp4Bytes();
    expect(() =>
      library.addMedia(
        {
          fileName: "large.mp4",
          mimeType: "video/mp4",
          sizeBytes: tooLarge.length,
          durationSeconds: 10
        },
        tooLarge
      )
    ).toThrowError(MediaStorageError);
  });
});

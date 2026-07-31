import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { createMockAdapters } from "./adapters/mock.js";

const apps: ReturnType<typeof createApp>[] = [];

async function authenticatedApp() {
  const adapters = createMockAdapters();
  const app = createApp({
    config: {
      environment: "test",
      mockAdminPassword: "remote-test-password"
    },
    adapters
  });
  apps.push(app);
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "admin", password: "remote-test-password" }
  });
  const body = login.json() as { data: { csrfToken: string } };
  const setCookie = login.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (cookieHeader === undefined) throw new Error("Missing test session cookie.");
  return {
    app,
    adapters,
    cookie: cookieHeader.split(";")[0]!,
    csrfToken: body.data.csrfToken
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("RoshanRemoteAgent and structured health", () => {
  it("keeps public controller liveness constant-time and separate from tablet probes", async () => {
    const { app, adapters } = await authenticatedApp();
    const tabletProbe = vi.spyOn(adapters.ipWebcam, "getStatus");

    const response = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      data: {
        controller: "healthy",
        adapters: { ipWebcam: "mock" }
      }
    });
    expect(tabletProbe).not.toHaveBeenCalled();
  });

  it("exposes authenticated component-level tablet health", async () => {
    const { app, cookie } = await authenticatedApp();
    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/v1/tablet/health"
    });
    expect(unauthenticated.statusCode).toBe(401);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/tablet/health",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      data: {
        healthy: true,
        components: {
          controlListener: { state: "healthy" },
          vpnTailscale: { state: "healthy" },
          remoteAgent: { state: "standby" },
          signageService: { state: "healthy" }
        }
      }
    });
  });

  it("defaults remote control off and requires both session and CSRF to enable it", async () => {
    const { app, cookie, csrfToken } = await authenticatedApp();
    const initial = await app.inject({
      method: "GET",
      url: "/api/v1/remote/status",
      headers: { cookie }
    });
    expect(initial.json()).toMatchObject({ data: { enabled: false } });

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/remote/enabled",
      headers: { cookie },
      payload: { enabled: true }
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({
      error: { code: "CSRF_REJECTED" }
    });

    const enabled = await app.inject({
      method: "POST",
      url: "/api/v1/remote/enabled",
      headers: { cookie, "x-csrf-token": csrfToken },
      payload: { enabled: true }
    });
    expect(enabled.statusCode).toBe(200);

    const current = await app.inject({
      method: "GET",
      url: "/api/v1/remote/status",
      headers: { cookie }
    });
    expect(current.json()).toMatchObject({ data: { enabled: true } });
  });

  it("accepts only typed validated actions and has no generic shell route", async () => {
    const { app, cookie, csrfToken } = await authenticatedApp();
    const headers = { cookie, "x-csrf-token": csrfToken };
    await app.inject({
      method: "POST",
      url: "/api/v1/remote/enabled",
      headers,
      payload: { enabled: true }
    });

    const tap = await app.inject({
      method: "POST",
      url: "/api/v1/remote/tap",
      headers,
      payload: { x: 100, y: 200 }
    });
    expect(tap.statusCode).toBe(200);

    const injection = await app.inject({
      method: "POST",
      url: "/api/v1/remote/text",
      headers,
      payload: { text: "hello; reboot" }
    });
    expect(injection.statusCode).toBe(400);
    expect(injection.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" }
    });

    const extraField = await app.inject({
      method: "POST",
      url: "/api/v1/remote/swipe",
      headers,
      payload: {
        startX: 1,
        startY: 1,
        endX: 2,
        endY: 2,
        durationMs: 100,
        command: "reboot"
      }
    });
    expect(extraField.statusCode).toBe(400);

    const shell = await app.inject({
      method: "POST",
      url: "/api/v1/remote/shell",
      headers,
      payload: { command: "id" }
    });
    expect(shell.statusCode).toBe(404);
  });

  it("relays PNG screenshots and records a bounded action audit", async () => {
    const { app, cookie, csrfToken } = await authenticatedApp();
    const headers = { cookie, "x-csrf-token": csrfToken };
    await app.inject({
      method: "POST",
      url: "/api/v1/remote/enabled",
      headers,
      payload: { enabled: true }
    });

    const screenshot = await app.inject({
      method: "POST",
      url: "/api/v1/remote/screenshot",
      headers
    });
    expect(screenshot.statusCode).toBe(200);
    expect(screenshot.headers["content-type"]).toContain("image/png");
    expect(screenshot.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const audit = await app.inject({
      method: "GET",
      url: "/api/v1/remote/audit",
      headers: { cookie }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json()).toMatchObject({
      ok: true,
      data: expect.arrayContaining([
        expect.objectContaining({ action: "remote-enabled", success: true }),
        expect.objectContaining({ action: "screenshot", success: true })
      ])
    });
  });

  it("refuses to close a package that is not in the approved app list", async () => {
    const { app, cookie, csrfToken } = await authenticatedApp();
    const headers = { cookie, "x-csrf-token": csrfToken };
    await app.inject({
      method: "POST",
      url: "/api/v1/remote/enabled",
      headers,
      payload: { enabled: true }
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/remote/close-app",
      headers,
      payload: { packageName: "com.topjohnwu.magisk" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

    const discovered = await app.inject({
      method: "POST",
      url: "/api/v1/remote/close-app",
      headers,
      payload: { packageName: "org.videolan.vlc" }
    });
    expect(discovered.statusCode).toBe(403);
  });
});

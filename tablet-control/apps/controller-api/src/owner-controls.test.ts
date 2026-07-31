import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const apps: ReturnType<typeof createApp>[] = [];

function createTestApp() {
  const app = createApp({
    config: {
      environment: "test",
      mockAdminPassword: "test-only-password"
    }
  });
  apps.push(app);
  return app;
}

async function login(app: ReturnType<typeof createApp>) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "admin", password: "test-only-password" }
  });
  const payload = response.json() as { data: { csrfToken: string } };
  const setCookie = response.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (cookieHeader === undefined) throw new Error("Expected a session cookie.");
  return {
    cookie: cookieHeader.split(";")[0]!,
    csrfToken: payload.data.csrfToken
  };
}

function mutationHeaders(session: { cookie: string; csrfToken: string }) {
  return {
    cookie: session.cookie,
    "x-csrf-token": session.csrfToken
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("authenticated owner controls", () => {
  it("lists approved and discovered apps but never exposes technical packages", async () => {
    const app = createTestApp();
    const session = await login(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/device/apps",
      headers: { cookie: session.cookie }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: Array<{ packageName?: string; status?: string }>;
    };
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ packageName: "com.spotify.music", status: "approved" }),
        expect.objectContaining({ packageName: "org.videolan.vlc", status: "discovered" })
      ])
    );
    expect(body.data.some((appEntry) => appEntry.status === "technical")).toBe(false);
    expect(body.data.some((appEntry) => appEntry.packageName === "com.tailscale.ipn")).toBe(false);
  });

  it("requires CSRF and strict Android package names, then reflects app changes immediately", async () => {
    const app = createTestApp();
    const session = await login(app);

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/device/apps/approve",
      headers: { cookie: session.cookie },
      payload: { packageName: "org.videolan.vlc" }
    });
    expect(missingCsrf.statusCode).toBe(403);

    for (const payload of [
      { packageName: "vlc; reboot" },
      { packageName: "org.videolan.vlc", command: "reboot" }
    ]) {
      const rejected = await app.inject({
        method: "POST",
        url: "/api/v1/device/apps/approve",
        headers: mutationHeaders(session),
        payload
      });
      expect(rejected.statusCode).toBe(400);
    }

    const technical = await app.inject({
      method: "POST",
      url: "/api/v1/device/apps/approve",
      headers: mutationHeaders(session),
      payload: { packageName: "com.tailscale.ipn" }
    });
    expect(technical.statusCode).toBe(400);

    const approved = await app.inject({
      method: "POST",
      url: "/api/v1/device/apps/approve",
      headers: mutationHeaders(session),
      payload: { packageName: "org.videolan.vlc" }
    });
    expect(approved.statusCode).toBe(200);

    const refreshed = await app.inject({
      method: "GET",
      url: "/api/v1/device/apps",
      headers: { cookie: session.cookie }
    });
    expect(refreshed.json()).toMatchObject({
      ok: true,
      data: expect.arrayContaining([
        expect.objectContaining({
          packageName: "org.videolan.vlc",
          status: "approved"
        })
      ])
    });

    const revoked = await app.inject({
      method: "POST",
      url: "/api/v1/device/apps/revoke",
      headers: mutationHeaders(session),
      payload: { packageName: "org.videolan.vlc" }
    });
    expect(revoked.statusCode).toBe(200);
  });

  it("keeps launch restricted to currently approved applications", async () => {
    const app = createTestApp();
    const session = await login(app);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/device/apps/launch",
      headers: mutationHeaders(session),
      payload: { appId: "vlc" }
    });
    expect(rejected.statusCode).toBe(403);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/device/apps/launch",
      headers: mutationHeaders(session),
      payload: { appId: "spotify" }
    });
    expect(accepted.statusCode).toBe(200);
  });

  it("uses a strict typed wake/sleep request", async () => {
    const app = createTestApp();
    const session = await login(app);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/device/screen",
      headers: mutationHeaders(session),
      payload: { on: false, shell: "input keyevent" }
    });
    expect(rejected.statusCode).toBe(400);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/device/screen",
      headers: mutationHeaders(session),
      payload: { on: false }
    });
    expect(accepted.statusCode).toBe(200);

    const status = await app.inject({
      method: "GET",
      url: "/api/v1/tablet/status",
      headers: { cookie: session.cookie }
    });
    expect(status.json()).toMatchObject({ data: { screenOn: false } });
  });

  it("requires explicit reboot confirmation and rate-limits reboot to one per ten minutes", async () => {
    const invalidApp = createTestApp();
    const invalidSession = await login(invalidApp);
    const rejected = await invalidApp.inject({
      method: "POST",
      url: "/api/v1/device/reboot",
      headers: mutationHeaders(invalidSession),
      payload: { confirm: false }
    });
    expect(rejected.statusCode).toBe(400);

    const app = createTestApp();
    const session = await login(app);
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/device/reboot",
      headers: mutationHeaders(session),
      payload: { confirm: true }
    });
    expect(accepted.statusCode).toBe(200);

    const rateLimited = await app.inject({
      method: "POST",
      url: "/api/v1/device/reboot",
      headers: mutationHeaders(session),
      payload: { confirm: true }
    });
    expect(rateLimited.statusCode).toBe(429);
  });

  it("allows only the exact service restart allowlist", async () => {
    const invalidApp = createTestApp();
    const invalidSession = await login(invalidApp);
    const rejected = await invalidApp.inject({
      method: "POST",
      url: "/api/v1/services/tailscale/restart",
      headers: mutationHeaders(invalidSession),
      payload: {}
    });
    expect(rejected.statusCode).toBe(400);

    const bodyRejected = await invalidApp.inject({
      method: "POST",
      url: "/api/v1/services/core/restart",
      headers: mutationHeaders(invalidSession),
      payload: { command: "reboot" }
    });
    expect(bodyRejected.statusCode).toBe(400);

    const app = createTestApp();
    const session = await login(app);

    for (const service of ["core", "media", "vpn", "remote"]) {
      const accepted = await app.inject({
        method: "POST",
        url: `/api/v1/services/${service}/restart`,
        headers: mutationHeaders(session),
        payload: {}
      });
      expect(accepted.statusCode).toBe(200);
    }
  });

  it("uses a strict 15-minute maintenance action and exposes protected status", async () => {
    const app = createTestApp();
    const session = await login(app);

    const initial = await app.inject({
      method: "GET",
      url: "/api/v1/dpc/status",
      headers: { cookie: session.cookie }
    });
    expect(initial.json()).toMatchObject({
      data: { deviceOwner: true, maintenance: { active: false } }
    });

    for (const payload of [
      { action: "status" },
      { action: "enter", durationMinutes: 60 },
      { action: "exit", durationMinutes: 15 }
    ]) {
      const rejected = await app.inject({
        method: "POST",
        url: "/api/v1/dpc/maintenance",
        headers: mutationHeaders(session),
        payload
      });
      expect(rejected.statusCode).toBe(400);
    }

    const entered = await app.inject({
      method: "POST",
      url: "/api/v1/dpc/maintenance",
      headers: mutationHeaders(session),
      payload: { action: "enter", durationMinutes: 15 }
    });
    expect(entered.statusCode).toBe(200);

    const active = await app.inject({
      method: "GET",
      url: "/api/v1/dpc/status",
      headers: { cookie: session.cookie }
    });
    expect(active.json()).toMatchObject({
      data: { maintenance: { active: true } }
    });
  });

  it("resets only owner PIN rate-limit state and rejects every request body", async () => {
    const invalidApp = createTestApp();
    const invalidSession = await login(invalidApp);
    const rejected = await invalidApp.inject({
      method: "POST",
      url: "/api/v1/admin/pin/rate-limit/reset",
      headers: mutationHeaders(invalidSession),
      payload: { pin: "123456" }
    });
    expect(rejected.statusCode).toBe(400);

    const app = createTestApp();
    const session = await login(app);
    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/admin/pin/rate-limit/reset",
      headers: { cookie: session.cookie }
    });
    expect(missingCsrf.statusCode).toBe(403);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/admin/pin/rate-limit/reset",
      headers: mutationHeaders(session)
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      ok: true,
      data: { simulated: true }
    });
  });

  it("rejects local display URLs before dispatching them to a tablet adapter", async () => {
    const app = createTestApp();
    const session = await login(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/display/webpage",
      headers: mutationHeaders(session),
      payload: {
        url: "http://127.0.0.1:8765/private",
        durationSeconds: 30,
        restoreDashboard: true
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" }
    });
  });
});

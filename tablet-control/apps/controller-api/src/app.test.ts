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
    payload: {
      username: "admin",
      password: "test-only-password"
    }
  });

  const payload = response.json() as {
    ok: true;
    data: { csrfToken: string };
  };
  const setCookie = response.headers["set-cookie"];
  if (setCookie === undefined) {
    throw new Error("Expected session cookie.");
  }

  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (cookie === undefined) {
    throw new Error("Expected a session cookie value.");
  }

  return {
    cookie: cookie.split(";")[0],
    csrfToken: payload.data.csrfToken
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("controller API", () => {
  it("exposes public mock health", async () => {
    const app = createTestApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      data: { mode: "mock", controller: "healthy" }
    });
  });

  it("requires authentication for tablet status", async () => {
    const app = createTestApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/tablet/status" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: "UNAUTHENTICATED" }
    });
  });

  it("creates a session and requires CSRF for mutations", async () => {
    const app = createTestApp();
    const session = await login(app);

    const status = await app.inject({
      method: "GET",
      url: "/api/v1/tablet/status",
      headers: { cookie: session.cookie }
    });
    expect(status.statusCode).toBe(200);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/camera/zoom",
      headers: { cookie: session.cookie },
      payload: { zoom: 2 }
    });
    expect(rejected.statusCode).toBe(403);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/camera/zoom",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken
      },
      payload: { zoom: 2 }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      ok: true,
      data: { simulated: true }
    });
  });

  it("reports present tablet torch capability as unsupported", async () => {
    const app = createTestApp();
    const session = await login(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/camera/torch",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken
      },
      payload: { enabled: true }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED" }
    });
  });

  it("requires explicit confirmation before a reboot action", async () => {
    const app = createTestApp();
    const session = await login(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/device/reboot",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" }
    });
  });
});

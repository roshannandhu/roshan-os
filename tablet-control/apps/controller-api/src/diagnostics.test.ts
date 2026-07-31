import { afterEach, describe, expect, it } from "vitest";
import { createMockAdapters } from "./adapters/mock.js";
import { createApp } from "./app.js";

const apps: ReturnType<typeof createApp>[] = [];

async function authenticatedApp() {
  const app = createApp({
    config: {
      environment: "test",
      mockAdminPassword: "diagnostics-test-password"
    },
    adapters: createMockAdapters()
  });
  apps.push(app);
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "admin", password: "diagnostics-test-password" }
  });
  const body = login.json() as { data: { csrfToken: string } };
  const setCookie = login.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (cookieHeader === undefined) throw new Error("Missing test session cookie.");
  return {
    app,
    cookie: cookieHeader.split(";")[0]!,
    csrfToken: body.data.csrfToken
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("protected tablet diagnostics routes", () => {
  it("requires an authenticated controller session to read the journal", async () => {
    const { app, cookie } = await authenticatedApp();

    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/v1/tablet/diagnostics"
    });
    expect(unauthenticated.statusCode).toBe(401);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/tablet/diagnostics",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      data: {
        schemaVersion: 1,
        entryCount: 1,
        events: [
          {
            level: "info",
            component: "companion",
            event: "mock_started"
          }
        ]
      }
    });
  });

  it("requires CSRF and clears only through the protected mutation", async () => {
    const { app, cookie, csrfToken } = await authenticatedApp();

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/tablet/diagnostics/clear",
      headers: { cookie },
      payload: {}
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({
      error: { code: "CSRF_REJECTED" }
    });

    const cleared = await app.inject({
      method: "POST",
      url: "/api/v1/tablet/diagnostics/clear",
      headers: { cookie, "x-csrf-token": csrfToken },
      payload: {}
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({
      ok: true,
      data: {
        cleared: true,
        removedEntries: 1,
        remainingEntries: 0
      }
    });

    const after = await app.inject({
      method: "GET",
      url: "/api/v1/tablet/diagnostics",
      headers: { cookie }
    });
    expect(after.json()).toMatchObject({
      ok: true,
      data: { entryCount: 0, events: [] }
    });
  });
});

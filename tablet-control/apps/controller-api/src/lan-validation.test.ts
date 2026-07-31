import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createConfig } from "./config.js";

const apps: ReturnType<typeof createApp>[] = [];

function createLanValidationConfig() {
  return createConfig({
    environment: "test",
    exposureMode: "lan-validation",
    bindHost: "192.168.40.10",
    allowedClientIps: ["192.168.40.20"],
    serveWeb: true,
    adapterMode: "real-readonly",
    sessionSecret: "test-only-session-secret-with-at-least-thirty-two-characters",
    mockAdminPassword: "test-only-strong-temporary-password",
    ipWebcam: {
      baseUrl: new URL("http://127.0.0.1:8080"),
      transport: "trusted-lan",
      requestTimeoutMs: 1_000,
      maxReconnectAttempts: 3
    }
  });
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("temporary LAN validation configuration", () => {
  it("requires a strong password, session secret, private bind address, and approved phone", () => {
    expect(() =>
      createConfig({
        exposureMode: "lan-validation",
        bindHost: "192.168.40.10",
        allowedClientIps: ["192.168.40.20"],
        serveWeb: true,
        adapterMode: "real-readonly",
        mockAdminPassword: "too-short",
        sessionSecret: "test-only-session-secret-with-at-least-thirty-two-characters",
        ipWebcam: {
          baseUrl: new URL("http://127.0.0.1:8080"),
          transport: "trusted-lan",
          requestTimeoutMs: 1_000,
          maxReconnectAttempts: 3
        }
      })
    ).toThrow("temporary controller password");

    expect(() =>
      createConfig({
        ...createLanValidationConfig(),
        allowedClientIps: ["203.0.113.4"]
      })
    ).toThrow("private IPv4");

    expect(() =>
      createConfig({
        ...createLanValidationConfig(),
        companion: { baseUrl: "http://127.0.0.1:8765", secret: "test", requestTimeoutMs: 1_000 }
      })
    ).toThrow("TABLET_COMPANION_BASE_URL must not be a loopback");

    expect(() =>
      createConfig({
        ...createLanValidationConfig(),
        fully: { baseUrl: "http://localhost:2323", adminPassword: "test", requestTimeoutMs: 1_000 }
      })
    ).toThrow("TABLET_FULLY_BASE_URL must not be a loopback");
  });

  it("rejects a non-approved remote client before serving controller routes", async () => {
    const app = createApp({ config: createLanValidationConfig() });
    apps.push(app);

    const rejected = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      remoteAddress: "192.168.40.99"
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    const allowed = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      remoteAddress: "192.168.40.20"
    });
    expect(allowed.statusCode).toBe(200);
  });
});

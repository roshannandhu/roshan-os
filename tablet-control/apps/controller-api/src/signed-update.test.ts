import type {
  ControllerUpdateArtifact,
  SignedUpdateActionResult,
  SignedUpdateStatus,
  TailscaleEnrollmentStatus
} from "@tablet-control/shared-types";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdapters } from "./adapters/index.js";
import { createMockAdapters } from "./adapters/mock.js";
import { ReadWriteCompanionAdapter } from "./adapters/readwrite-companion.js";
import { createApp } from "./app.js";
import { createConfig, parseControllerPublicOrigin } from "./config.js";
import { UpdateArtifactStore } from "./update-artifact-store.js";

type TestApp = ReturnType<typeof createApp>;

const resources: Array<{ app?: TestApp; directory: string }> = [];

function signedUpdateStatus(): SignedUpdateStatus {
  return {
    state: "idle",
    currentVersionCode: 21,
    currentVersionName: "2.1",
    baseVersionCode: null,
    baseVersionName: null,
    targetVersionCode: null,
    targetVersionName: null,
    startedAtMs: null,
    updatedAtMs: null,
    lastAppliedAtMs: 1_722_000_000_000,
    lastRollbackAtMs: null,
    lastRolledBackFromVersionCode: null,
    errorCode: null,
    progress: {
      downloadedBytes: 0,
      expectedBytes: null
    },
    controllerOrigin: {
      configured: true,
      state: "ready",
      host: "controller.tailnet.ts.net"
    },
    installCapability: {
      deviceOwner: true,
      selfUpdatePermissionGranted: true,
      silentSelfUpdateCapable: true,
      installerUiAllowed: false
    },
    rollback: {
      platformApiPresent: true,
      permissionGranted: true,
      supported: true,
      available: true,
      rollbackId: 7,
      versionRolledBackFrom: 21,
      versionRolledBackTo: 20,
      reasonCode: null,
      requestedForLastUpdate: true,
      dataPolicy: "retain",
      bootFailureAutoRollbackGuaranteed: false
    }
  };
}

function actionResult(code: string): SignedUpdateActionResult {
  return {
    accepted: true,
    code,
    update: signedUpdateStatus()
  };
}

function tailscaleEnrollmentStatus(): TailscaleEnrollmentStatus {
  return {
    state: "enrolling",
    code: "WAITING_FOR_TAILNET",
    startedAtMs: 1_722_000_000_000,
    finishedAtMs: 0,
    deadlineAtMs: 1_722_000_120_000,
    timeoutSeconds: 120,
    deviceOwner: true,
    tailscaleInstalled: true,
    tailscaleEnabled: true,
    tailscaleVersion: "1.84.0",
    alwaysOnVpnConfigured: true,
    vpnTransportDetected: false,
    vpnValidated: false,
    tailnetAddressDetected: false,
    credentialConsumptionProven: false,
    transientAuthKeyPresent: true,
    supportedPolicies: {
      authKey: true,
      forceEnabled: true,
      onboardingFlow: true
    },
    appliedNonSecretPolicy: {
      alwaysOnVpnPackage: true,
      forceEnabled: true,
      onboardingHidden: true
    }
  };
}

function apkBytes(size = 12): Buffer {
  const bytes = Buffer.alloc(size, 0x5a);
  bytes.set([0x50, 0x4b, 0x03, 0x04], 0);
  return bytes;
}

function multipartApk(
  bytes: Buffer,
  fileName = "roshancore.apk",
  mimeType = "application/vnd.android.package-archive"
): { contentType: string; payload: Buffer } {
  const boundary = "----RoshanOSSignedUpdateBoundary";
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
        "utf8"
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")
    ])
  };
}

function testApp(maxFileBytes = 64): {
  app: TestApp;
  adapters: ReturnType<typeof createMockAdapters>;
} {
  const directory = mkdtempSync(join(tmpdir(), "roshanos-update-"));
  const adapters = createMockAdapters();
  const app = createApp({
    storageDirectory: directory,
    updateArtifactStore: new UpdateArtifactStore(join(directory, "updates"), {
      maxFileBytes
    }),
    adapters,
    config: {
      environment: "test",
      adapterMode: "companion",
      mockAdminPassword: "test-only-password",
      controllerPublicOrigin: "https://controller.tailnet.ts.net",
      companion: {
        baseUrl: "http://tablet.invalid:8765",
        secret: "artifact-bearer-test-secret",
        requestTimeoutMs: 500,
        transport: "tailscale"
      }
    }
  });
  resources.push({ app, directory });
  return { app, adapters };
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
  const setCookie = response.headers["set-cookie"];
  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (cookie === undefined) {
    throw new Error("Expected a session cookie.");
  }
  return {
    cookie: cookie.split(";")[0] ?? "",
    csrfToken: (response.json() as { data: { csrfToken: string } }).data.csrfToken
  };
}

async function uploadArtifact(
  app: TestApp,
  session: { cookie: string; csrfToken: string },
  bytes: Buffer
): Promise<ControllerUpdateArtifact> {
  const upload = multipartApk(bytes);
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/update/artifacts",
    headers: {
      cookie: session.cookie,
      "x-csrf-token": session.csrfToken,
      "content-type": upload.contentType
    },
    payload: upload.payload
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { data: ControllerUpdateArtifact }).data;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  const pending = resources.splice(0);
  await Promise.all(pending.map(async ({ app }) => app?.close()));
  for (const { directory } of pending) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("signed update artifact pipeline", () => {
  it("requires owner authentication and CSRF, then hashes and atomically catalogs an APK", async () => {
    const { app } = testApp();
    const bytes = apkBytes();
    const multipart = multipartApk(bytes);

    const unauthenticated = await app.inject({
      method: "POST",
      url: "/api/v1/update/artifacts",
      headers: { "content-type": multipart.contentType },
      payload: multipart.payload
    });
    expect(unauthenticated.statusCode).toBe(401);

    const session = await login(app);
    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/update/artifacts",
      headers: {
        cookie: session.cookie,
        "content-type": multipart.contentType
      },
      payload: multipart.payload
    });
    expect(missingCsrf.statusCode).toBe(403);

    const artifact = await uploadArtifact(app, session, bytes);
    expect(artifact).toMatchObject({
      fileName: "roshancore.apk",
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
    expect(artifact.id).toMatch(/^update_[0-9]{13}_[a-f0-9]{16}$/u);
  });

  it("enforces the configured file limit and APK signature without buffering a 128 MiB body", async () => {
    const { app } = testApp(16);
    const session = await login(app);
    const oversized = multipartApk(apkBytes(17));
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/update/artifacts",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken,
        "content-type": oversized.contentType
      },
      payload: oversized.payload
    });
    expect(response.statusCode).toBe(413);

    const invalid = multipartApk(Buffer.from("not an apk"));
    const invalidResponse = await app.inject({
      method: "POST",
      url: "/api/v1/update/artifacts",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken,
        "content-type": invalid.contentType
      },
      payload: invalid.payload
    });
    expect(invalidResponse.statusCode).toBe(400);
  });

  it("serves exact bytes only to the Companion bearer without cookies, redirects, or query tokens", async () => {
    const { app } = testApp();
    const session = await login(app);
    const bytes = apkBytes();
    const artifact = await uploadArtifact(app, session, bytes);
    const url = `/api/v1/update/artifacts/${artifact.id}/apk`;

    const cookieOnly = await app.inject({
      method: "GET",
      url,
      headers: { cookie: session.cookie }
    });
    expect(cookieOnly.statusCode).toBe(401);

    const wrongBearer = await app.inject({
      method: "GET",
      url,
      headers: { authorization: "Bearer wrong" }
    });
    expect(wrongBearer.statusCode).toBe(401);

    const queryToken = await app.inject({
      method: "GET",
      url: `${url}?token=artifact-bearer-test-secret`,
      headers: { authorization: "Bearer artifact-bearer-test-secret" }
    });
    expect(queryToken.statusCode).toBe(400);
    expect(queryToken.body).not.toContain("artifact-bearer-test-secret");

    const response = await app.inject({
      method: "GET",
      url,
      headers: { authorization: "Bearer artifact-bearer-test-secret" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(bytes);
    expect(response.headers["content-type"]).toBe("application/vnd.android.package-archive");
    expect(response.headers["content-length"]).toBe(bytes.length.toString());
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.location).toBeUndefined();
    expect(response.headers["set-cookie"]).toBeUndefined();

    const traversal = await app.inject({
      method: "GET",
      url: "/api/v1/update/artifacts/%2e%2e/apk",
      headers: { authorization: "Bearer artifact-bearer-test-secret" }
    });
    expect(traversal.statusCode).not.toBe(200);
  });

  it("builds the install URL only from validated runtime authority and calls the exact tablet contract", async () => {
    const { app, adapters } = testApp();
    const configure = vi
      .spyOn(adapters.companion, "configureUpdateControllerOrigin")
      .mockResolvedValue(actionResult("CONTROLLER_ORIGIN_CONFIGURED"));
    const requestUpdate = vi
      .spyOn(adapters.companion, "requestUpdate")
      .mockResolvedValue(actionResult("UPDATE_ACCEPTED"));
    const session = await login(app);
    const bytes = apkBytes();
    const artifact = await uploadArtifact(app, session, bytes);

    const missingCsrf = await app.inject({
      method: "POST",
      url: `/api/v1/update/artifacts/${artifact.id}/install`,
      headers: { cookie: session.cookie, host: "attacker.example" },
      payload: {}
    });
    expect(missingCsrf.statusCode).toBe(403);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/update/artifacts/${artifact.id}/install`,
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken,
        host: "attacker.example",
        "x-forwarded-host": "also-attacker.example",
        "x-forwarded-proto": "http"
      },
      payload: {}
    });
    expect(response.statusCode).toBe(200);
    expect(configure).toHaveBeenCalledWith("https://controller.tailnet.ts.net");
    expect(requestUpdate).toHaveBeenCalledWith(
      `https://controller.tailnet.ts.net/api/v1/update/artifacts/${artifact.id}/apk`,
      artifact.sha256
    );
    expect(configure.mock.invocationCallOrder[0]).toBeLessThan(
      requestUpdate.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );
    expect(response.body).not.toContain("attacker.example");
  });

  it("protects strict status and confirmed rollback as owner-only operations", async () => {
    const { app, adapters } = testApp();
    vi.spyOn(adapters.companion, "getUpdateStatus").mockResolvedValue(signedUpdateStatus());
    const rollback = vi
      .spyOn(adapters.companion, "requestUpdateRollback")
      .mockResolvedValue(actionResult("ROLLBACK_ACCEPTED"));

    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/v1/update/status"
    });
    expect(unauthenticated.statusCode).toBe(401);

    const session = await login(app);
    const status = await app.inject({
      method: "GET",
      url: "/api/v1/update/status",
      headers: { cookie: session.cookie }
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      data: {
        currentVersionCode: 21,
        installCapability: { installerUiAllowed: false },
        rollback: { bootFailureAutoRollbackGuaranteed: false }
      }
    });

    const unconfirmed = await app.inject({
      method: "POST",
      url: "/api/v1/update/rollback",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken
      },
      payload: { confirm: false }
    });
    expect(unconfirmed.statusCode).toBe(400);

    const extraField = await app.inject({
      method: "POST",
      url: "/api/v1/update/rollback",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken
      },
      payload: { confirm: true, force: true }
    });
    expect(extraField.statusCode).toBe(400);

    const confirmed = await app.inject({
      method: "POST",
      url: "/api/v1/update/rollback",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken
      },
      payload: { confirm: true }
    });
    expect(confirmed.statusCode).toBe(200);
    expect(rollback).toHaveBeenCalledOnce();
  });
});

describe("strict signed-update configuration and adapter contract", () => {
  it("accepts only credential-free HTTPS ts.net origins and canonicalizes them", () => {
    expect(parseControllerPublicOrigin("https://Controller.Tailnet.ts.net:443/")).toBe(
      "https://controller.tailnet.ts.net"
    );

    for (const invalid of [
      "http://controller.tailnet.ts.net",
      "https://ts.net",
      "https://controller.example.com",
      "https://user@controller.tailnet.ts.net",
      "https://controller.tailnet.ts.net:8443",
      "https://controller.tailnet.ts.net/path",
      "https://controller.tailnet.ts.net?token=value",
      "https://controller.tailnet.ts.net?",
      "https://controller.tailnet.ts.net#fragment",
      "https://controller.tailnet.ts.net#",
      "https://@controller.tailnet.ts.net",
      "https://controller.tailnet.ts.net:0443",
      "https:\\\\controller.tailnet.ts.net",
      " https://controller.tailnet.ts.net",
      "https://controller.tailnet.ts.net."
    ]) {
      expect(() => parseControllerPublicOrigin(invalid)).toThrow("CONTROLLER_PUBLIC_ORIGIN");
    }
  });

  it("keeps IP Webcam optional in Companion mode but required in real-readonly mode", async () => {
    vi.stubEnv("TABLET_IP_WEBCAM_BASE_URL", "");
    vi.stubEnv("TABLET_IP_WEBCAM_USERNAME", "");
    vi.stubEnv("TABLET_IP_WEBCAM_PASSWORD", "");

    const config = createConfig({
      environment: "test",
      adapterMode: "companion",
      companion: {
        baseUrl: "http://tablet.invalid:8765",
        secret: "companion-test-secret",
        requestTimeoutMs: 500,
        transport: "tailscale"
      }
    });
    expect(config.ipWebcam).toBeUndefined();
    await expect(createAdapters(config).ipWebcam.getStatus()).resolves.toMatchObject({
      healthy: false,
      transport: "tailscale"
    });

    expect(() =>
      createConfig({
        environment: "test",
        adapterMode: "real-readonly"
      })
    ).toThrow("TABLET_IP_WEBCAM_BASE_URL");
  });

  it("accepts production Companion startup without IP Webcam only when public authority is pinned", () => {
    vi.stubEnv("TABLET_IP_WEBCAM_BASE_URL", "");
    vi.stubEnv("TABLET_IP_WEBCAM_USERNAME", "");
    vi.stubEnv("TABLET_IP_WEBCAM_PASSWORD", "");
    const productionBase = {
      environment: "production" as const,
      adapterMode: "companion" as const,
      serveWeb: true,
      mockAdminPassword: "a-production-password-with-20-characters",
      sessionSecret: "a-production-session-secret-with-at-least-32-characters",
      companion: {
        baseUrl: "http://tablet.invalid:8765",
        secret: "companion-test-secret",
        requestTimeoutMs: 500,
        transport: "tailscale" as const
      }
    };
    expect(
      createConfig({
        ...productionBase,
        controllerPublicOrigin: "https://controller.tailnet.ts.net"
      }).ipWebcam
    ).toBeUndefined();
    expect(() => createConfig(productionBase)).toThrow("CONTROLLER_PUBLIC_ORIGIN");
  });

  it("sends exact update request bodies and rejects non-strict tablet status", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        ok: true,
        data: String(input).endsWith("/status")
          ? signedUpdateStatus()
          : actionResult("UPDATE_ACCEPTED")
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new ReadWriteCompanionAdapter({
      baseUrl: "http://tablet.invalid:8765",
      secret: "adapter-secret",
      requestTimeoutMs: 500,
      transport: "tailscale"
    });

    await adapter.configureUpdateControllerOrigin("https://controller.tailnet.ts.net");
    await adapter.requestUpdate(
      "https://controller.tailnet.ts.net/api/v1/update/artifacts/update_1722000000000_0123456789abcdef/apk",
      "a".repeat(64)
    );
    await adapter.getUpdateStatus();
    await adapter.requestUpdateRollback();

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ origin: "https://controller.tailnet.ts.net" })
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        url: "https://controller.tailnet.ts.net/api/v1/update/artifacts/update_1722000000000_0123456789abcdef/apk",
        sha256: "a".repeat(64)
      })
    });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "GET" });
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ confirm: true })
    });

    vi.stubGlobal("fetch", async () =>
      Response.json({
        ok: true,
        data: { ...signedUpdateStatus(), unexpected: true }
      })
    );
    await expect(adapter.getUpdateStatus()).rejects.toMatchObject({
      response: {
        error: {
          code: "MALFORMED_RESPONSE"
        }
      }
    });
  });
});

describe("protected Tailscale enrollment forwarding", () => {
  it("requires owner CSRF, forwards only the exact bounded request, and never echoes the auth key", async () => {
    const { app, adapters } = testApp();
    const status = tailscaleEnrollmentStatus();
    const enroll = vi.spyOn(adapters.companion, "enrollTailscale").mockResolvedValue({
      accepted: true,
      code: "ENROLLMENT_STARTED",
      enrollment: status
    });
    vi.spyOn(adapters.companion, "getTailscaleEnrollmentStatus").mockResolvedValue(status);
    const authKey = "tskey-auth-k1234567890abcDEF-1234567890abcDEF";

    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/v1/tailscale/enrollment/status"
    });
    expect(unauthenticated.statusCode).toBe(401);

    const session = await login(app);
    const statusResponse = await app.inject({
      method: "GET",
      url: "/api/v1/tailscale/enrollment/status",
      headers: { cookie: session.cookie }
    });
    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.json()).toMatchObject({
      data: {
        state: "enrolling",
        transientAuthKeyPresent: true,
        credentialConsumptionProven: false
      }
    });

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/tailscale/enrollment",
      headers: { cookie: session.cookie },
      payload: { authKey, timeoutSeconds: 120 }
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.body).not.toContain(authKey);

    const extraField = await app.inject({
      method: "POST",
      url: "/api/v1/tailscale/enrollment",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken
      },
      payload: { authKey, timeoutSeconds: 120, advertiseExitNode: true }
    });
    expect(extraField.statusCode).toBe(400);
    expect(extraField.body).not.toContain(authKey);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/tailscale/enrollment",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken
      },
      payload: { authKey, timeoutSeconds: 120 }
    });
    expect(accepted.statusCode).toBe(200);
    expect(enroll).toHaveBeenCalledWith(authKey, 120);
    expect(accepted.body).not.toContain(authKey);
  });

  it("uses the exact Companion routes and strictly validates secret-free status", async () => {
    const status = tailscaleEnrollmentStatus();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        ok: true,
        data: String(input).endsWith("/status")
          ? status
          : {
              accepted: true,
              code: "ENROLLMENT_STARTED",
              enrollment: status
            }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new ReadWriteCompanionAdapter({
      baseUrl: "http://tablet.invalid:8765",
      secret: "adapter-secret",
      requestTimeoutMs: 500,
      transport: "tailscale"
    });
    const authKey = "tskey-auth-k1234567890abcDEF-1234567890abcDEF";

    await adapter.enrollTailscale(authKey, 120);
    await adapter.getTailscaleEnrollmentStatus();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://tablet.invalid:8765/api/v1/companion/tailscale/enroll",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: JSON.stringify({ authKey, timeoutSeconds: 120 })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://tablet.invalid:8765/api/v1/companion/tailscale/enrollment/status",
      expect.objectContaining({ method: "GET", redirect: "error" })
    );

    vi.stubGlobal("fetch", async () =>
      Response.json({
        ok: true,
        data: { ...status, authKey }
      })
    );
    await expect(adapter.getTailscaleEnrollmentStatus()).rejects.toMatchObject({
      response: {
        error: {
          code: "MALFORMED_RESPONSE"
        }
      }
    });
  });
});

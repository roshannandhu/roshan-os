import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadWriteCompanionAdapter } from "./adapters/readwrite-companion.js";

const config = {
  baseUrl: "http://roshancore.invalid:8765",
  secret: "remote-adapter-test-secret",
  requestTimeoutMs: 500,
  transport: "tailscale" as const
};

function serverHealth() {
  const now = Date.now();
  const component = (state: string, details: Record<string, unknown> = {}) => ({
    state,
    checkedAtMs: now,
    lastHealthyAtMs: state === "healthy" || state === "standby" ? now : 0,
    degradedReason: null,
    details
  });
  return {
    healthy: true,
    supervisorStartedAtMs: now - 1000,
    reconciledAtMs: now,
    reconciliationReason: "test",
    degradedReasons: [],
    components: {
      controlListener: component("healthy"),
      wifi: component("healthy", { connected: true }),
      vpnTailscale: component("healthy"),
      internalMedia: component("healthy"),
      ipWebcamFallback: component("standby"),
      remoteAgent: component("standby"),
      signageService: component("healthy"),
      supervisor: component("healthy")
    }
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RoshanCore remote and health adapter", () => {
  it("parses structured health and sends the bearer credential", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: serverHealth() }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new ReadWriteCompanionAdapter(config);

    await expect(adapter.getServerHealth()).resolves.toMatchObject({
      healthy: true,
      components: { remoteAgent: { state: "standby" } }
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://roshancore.invalid:8765/api/v1/companion/server-health",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer remote-adapter-test-secret"
        })
      })
    );
  });

  it("routes only typed remote commands", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: true,
        data: { simulated: false, message: "accepted" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new ReadWriteCompanionAdapter(config);

    await adapter.remoteSwipe(1, 2, 3, 4, 250);
    await adapter.remoteKey("BACK");
    await adapter.remoteText("RoshanOS 01");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://roshancore.invalid:8765/api/v1/companion/remote/swipe",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          startX: 1,
          startY: 2,
          endX: 3,
          endY: 4,
          durationMs: 250
        })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://roshancore.invalid:8765/api/v1/companion/remote/key",
      expect.objectContaining({ body: JSON.stringify({ key: "BACK" }) })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://roshancore.invalid:8765/api/v1/companion/remote/text",
      expect.objectContaining({ body: JSON.stringify({ text: "RoshanOS 01" }) })
    );
  });

  it("validates a bounded PNG screenshot relay", async () => {
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00
    ]);
    const fetchMock = vi.fn(
      async () =>
        new Response(png, {
          status: 200,
          headers: { "content-type": "image/png" }
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new ReadWriteCompanionAdapter(config);

    await expect(adapter.getRemoteScreenshot()).resolves.toEqual(png);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://roshancore.invalid:8765/api/v1/companion/remote/screenshot",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: expect.objectContaining({
          authorization: "Bearer remote-adapter-test-secret",
          accept: "image/png"
        })
      })
    );
  });

  it("maps disabled and rate-limited upstream responses without hiding the cause", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            ok: false,
            error: { code: "CONFLICT", message: "RoshanRemoteAgent is disabled." }
          },
          { status: 409 }
        )
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            ok: false,
            error: { code: "RATE_LIMITED", message: "Wait before retrying." }
          },
          { status: 429 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new ReadWriteCompanionAdapter(config);

    await expect(adapter.remoteTap(1, 1)).rejects.toMatchObject({
      statusCode: 409,
      response: { error: { code: "CONFLICT" } }
    });
    await expect(adapter.remoteTap(1, 1)).rejects.toMatchObject({
      statusCode: 429,
      response: { error: { code: "RATE_LIMITED" } }
    });
  });
});

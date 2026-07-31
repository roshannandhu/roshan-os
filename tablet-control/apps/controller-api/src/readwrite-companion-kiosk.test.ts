import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadWriteCompanionKioskAdapter } from "./adapters/readwrite-companion-kiosk.js";

const config = {
  baseUrl: "http://companion.invalid:8765",
  secret: "test-only-secret",
  requestTimeoutMs: 500
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Companion kiosk adapter", () => {
  it("reads display status with the Companion authorization header", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: true,
        data: {
          installed: true,
          foreground: true,
          dashboardConfigured: true,
          displayMode: "dashboard"
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new ReadWriteCompanionKioskAdapter(config);
    await expect(adapter.getDisplayMode()).resolves.toBe("dashboard");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://companion.invalid:8765/api/v1/companion/kiosk/status",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer test-only-secret"
        })
      })
    );
  });

  it("routes display mutations to the dedicated kiosk endpoints", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: true,
        data: { accepted: true, simulated: false }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new ReadWriteCompanionKioskAdapter(config);
    await adapter.showWebpage("https://controller.invalid/health");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://companion.invalid:8765/api/v1/companion/kiosk/webpage",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ url: "https://controller.invalid/health" })
      })
    );

    await adapter.showLiveText("Live status");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://companion.invalid:8765/api/v1/companion/kiosk/live-text",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "Live status" })
      })
    );

    await adapter.clearLiveText();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://companion.invalid:8765/api/v1/companion/kiosk/clear-live-text",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("fails closed on unauthorized and malformed responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new ReadWriteCompanionKioskAdapter(config);
    await expect(adapter.getDisplayMode()).rejects.toMatchObject({
      statusCode: 401,
      response: { error: { code: "UNAUTHENTICATED" } }
    });
    await expect(adapter.getDisplayMode()).rejects.toMatchObject({
      statusCode: 502,
      response: { error: { code: "MALFORMED_RESPONSE" } }
    });
  });

  it("routes media display to webpage media endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, data: { simulated: false, message: "Loaded" } }))
      );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new ReadWriteCompanionKioskAdapter(config);
    const res = await adapter.showMedia("image", "private.jpg");
    expect(res.message).toBe("Loaded");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://companion.invalid:8765/api/v1/companion/kiosk/webpage",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ url: "http://127.0.0.1:3001/media/private.jpg" })
      })
    );
  });

  it("parses Device Owner status and sends only typed maintenance actions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          data: {
            deviceOwner: true,
            restrictions: { no_factory_reset: true },
            statusBarDisabled: true,
            maintenance: {
              active: false,
              expiresAt: 0,
              remainingSeconds: 0
            },
            lockTaskPackagesCount: 3
          }
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          data: { simulated: false, message: "Maintenance enabled." }
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new ReadWriteCompanionKioskAdapter(config);
    await expect(adapter.getDpcStatus()).resolves.toMatchObject({
      deviceOwner: true,
      maintenance: { active: false }
    });
    await adapter.setMaintenanceMode({ action: "enter", durationMinutes: 15 });

    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://companion.invalid:8765/api/v1/companion/dpc/maintenance",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "enter", durationMinutes: 15 })
      })
    );
  });
});

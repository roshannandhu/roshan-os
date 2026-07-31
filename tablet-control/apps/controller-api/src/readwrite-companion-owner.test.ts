import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadWriteCompanionAdapter } from "./adapters/readwrite-companion.js";

const config = {
  baseUrl: "http://roshancore.invalid:8765",
  secret: "owner-adapter-test-secret",
  requestTimeoutMs: 500,
  transport: "tailscale" as const
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RoshanCore owner-control adapter", () => {
  it("returns approved and discovered apps while filtering technical packages", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: true,
        data: [
          {
            id: "spotify",
            label: "Spotify",
            packageName: "com.spotify.music",
            status: "approved"
          },
          {
            id: "vlc",
            label: "VLC",
            packageName: "org.videolan.vlc",
            status: "discovered"
          },
          {
            id: "tailscale",
            label: "Tailscale",
            packageName: "com.tailscale.ipn",
            status: "technical"
          }
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new ReadWriteCompanionAdapter(config);

    await expect(adapter.listApps()).resolves.toEqual([
      expect.objectContaining({ id: "spotify", status: "approved" }),
      expect.objectContaining({ id: "vlc", status: "discovered" })
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://roshancore.invalid:8765/api/v1/companion/apps",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer owner-adapter-test-secret"
        })
      })
    );
  });

  it("maps only typed owner operations to their bounded Android endpoints", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        ok: true,
        data: String(input).endsWith("/admin/pin/rate-limit/reset")
          ? { reset: true, pinState: "READY" }
          : { simulated: false, message: "accepted" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new ReadWriteCompanionAdapter(config);

    await adapter.approveApp("org.videolan.vlc");
    await adapter.revokeApp("com.spotify.music");
    await adapter.setScreenOn(false);
    await adapter.rebootDevice();
    await adapter.restartService("vpn");
    await adapter.resetAdminPinRateLimit();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://roshancore.invalid:8765/api/v1/companion/apps/approve",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ packageName: "org.videolan.vlc" })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://roshancore.invalid:8765/api/v1/companion/apps/revoke",
      expect.objectContaining({
        body: JSON.stringify({ packageName: "com.spotify.music" })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://roshancore.invalid:8765/api/v1/companion/screen",
      expect.objectContaining({ body: JSON.stringify({ on: false }) })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "http://roshancore.invalid:8765/api/v1/companion/device/reboot",
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchMock.mock.calls[3]?.[1]).not.toHaveProperty("body");
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "http://roshancore.invalid:8765/api/v1/companion/services/restart",
      expect.objectContaining({ body: JSON.stringify({ service: "vpn" }) })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      "http://roshancore.invalid:8765/api/v1/companion/admin/pin/rate-limit/reset",
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchMock.mock.calls[5]?.[1]).not.toHaveProperty("body");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadWriteCompanionAdapter } from "./adapters/readwrite-companion.js";

const config = {
  baseUrl: "http://roshancore.invalid:8765",
  secret: "telemetry-adapter-test-secret",
  requestTimeoutMs: 500,
  transport: "tailscale" as const
};

function component(
  state: "healthy" | "standby" = "healthy",
  details: Record<string, unknown> = {}
) {
  return {
    state,
    checkedAtMs: 1_700_000_010_000,
    lastHealthyAtMs: 1_700_000_010_000,
    degradedReason: null,
    details
  };
}

function strictCompanionStatus() {
  return {
    mode: "companion",
    online: true,
    batteryPercent: 82,
    charging: true,
    batteryTemperatureC: 34.2,
    brightness: 120,
    brightnessMode: "automatic",
    screenTimeoutMs: 300_000,
    screenOrientation: "auto",
    screenOn: true,
    keyguardLocked: false,
    deviceLocked: false,
    displayMode: "dashboard",
    touchLock: false,
    mediaVolume: 8,
    mediaVolumeMax: 25,
    storageFreeMb: 8192,
    uptimeSeconds: 184_293,
    connectivity: {
      wifiEnabled: true,
      wifiConnected: true,
      wifiSsid: "RoshanOS Test",
      wifiRssiDbm: -52,
      wifiSignalLevel: 3,
      wifiSignalState: "good",
      internetCapable: true,
      internetValidated: true
    },
    memory: {
      availableBytes: 1_500_000_000,
      totalBytes: 3_000_000_000,
      lowMemory: false,
      lowMemoryThresholdBytes: 256_000_000
    },
    foregroundApp: {
      state: "approved",
      packageName: "com.spotify.music",
      label: "Spotify"
    },
    boot: {
      lastBootAtMs: 1_700_000_000_000,
      uptimeSeconds: 184_293,
      recoveryState: "succeeded",
      recoveryVerifiedAtMs: 1_700_000_010_000
    },
    update: {
      state: "installed",
      versionName: "2.0",
      versionCode: 2,
      firstInstalledAtMs: 1_690_000_000_000,
      lastAppliedAtMs: 1_700_000_000_000,
      pendingSystemUpdateState: "unknown"
    },
    enrolled: true,
    credentialState: "ready",
    credentialVersion: 2,
    pinState: "READY",
    pairingActive: false,
    remoteControl: {
      enabled: true,
      allowedKeys: ["HOME", "BACK"],
      screenWidth: 1200,
      screenHeight: 1920,
      maxActionsPerMinute: 60,
      maxScreenshotsPerMinute: 20
    },
    serverHealth: {
      healthy: true,
      homeReady: true,
      supervisorStartedAtMs: 1_700_000_000_000,
      reconciledAtMs: 1_700_000_010_000,
      reconciliationReason: "periodic",
      degradedReasons: [],
      components: {
        controlListener: component(),
        wifi: component("healthy", { connected: true }),
        vpnTailscale: component(),
        internalMedia: component(),
        ipWebcamFallback: component("standby"),
        remoteAgent: component(),
        signageService: component(),
        resources: component("healthy", {
          lowMemory: false,
          availableBytes: 1_500_000_000
        }),
        supervisor: component()
      }
    }
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RoshanCore strict telemetry adapter", () => {
  it("maps the complete authenticated Android telemetry payload", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: strictCompanionStatus() }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new ReadWriteCompanionAdapter(config);

    await expect(adapter.getStatus()).resolves.toMatchObject({
      mode: "companion",
      transport: "tailscale",
      mediaVolumeMax: 25,
      brightnessMode: "automatic",
      screenTimeoutMs: 300_000,
      keyguardLocked: false,
      deviceLocked: false,
      connectivity: {
        wifiSsid: "RoshanOS Test",
        wifiSignalState: "good",
        internetValidated: true
      },
      memory: {
        availableBytes: 1_500_000_000,
        lowMemory: false
      },
      foregroundApp: {
        state: "approved",
        packageName: "com.spotify.music",
        label: "Spotify"
      },
      boot: {
        recoveryState: "succeeded",
        uptimeSeconds: 184_293
      },
      update: {
        state: "installed",
        versionName: "2.0",
        versionCode: 2
      },
      wifiConnected: true,
      tailscaleConnected: true,
      ipWebcamHealthy: false
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://roshancore.invalid:8765/api/v1/companion/status",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer telemetry-adapter-test-secret"
        })
      })
    );
  });

  it("rejects unknown or malformed nested telemetry instead of silently dropping it", async () => {
    const malformed = strictCompanionStatus();
    const data = {
      ...malformed,
      connectivity: {
        ...malformed.connectivity,
        privateNetworkAddress: "100.64.0.2"
      }
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true, data }))
    );
    const adapter = new ReadWriteCompanionAdapter(config);

    await expect(adapter.getStatus()).rejects.toMatchObject({
      statusCode: 502,
      response: {
        error: {
          code: "MALFORMED_RESPONSE"
        }
      }
    });
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

Object.defineProperty(window, "isSecureContext", { value: true, writable: true });
Object.defineProperty(URL, "createObjectURL", {
  configurable: true,
  writable: true,
  value: vi.fn(() => "blob:tablet-screen-test")
});
Object.defineProperty(URL, "revokeObjectURL", {
  configurable: true,
  writable: true,
  value: vi.fn()
});

const mockStatus = {
  mode: "mock",
  online: true,
  batteryPercent: 82,
  charging: true,
  batteryTemperatureC: 34.2,
  mediaVolume: 8,
  mediaVolumeMax: 15,
  brightness: 120,
  brightnessMode: "automatic",
  screenTimeoutMs: 300_000,
  screenOrientation: "auto",
  screenOn: true,
  keyguardLocked: false,
  deviceLocked: false,
  wifiConnected: true,
  tailscaleConnected: true,
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
    uptimeSeconds: 184293,
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
  transport: "mock",
  readOnlyLatencyMs: 0,
  ipWebcamHealthy: true,
  fullyKioskHealthy: true,
  companionHealthy: true,
  storageFreeMb: 8192,
  uptimeSeconds: 184293
};

const mockCamera = {
  mode: "mock",
  healthy: true,
  activeCamera: "rear",
  orientation: "landscape",
  listeningEnabled: true,
  zoom: 1,
  quality: 65,
  resolution: "1280x720",
  fps: 15,
  focusMode: null,
  hasTorch: false,
  transport: "mock",
  lastStatusLatencyMs: 0
};

const mockSignedUpdateStatus = {
  state: "idle",
  currentVersionCode: 2,
  currentVersionName: "2.0",
  baseVersionCode: null,
  baseVersionName: null,
  targetVersionCode: null,
  targetVersionName: null,
  startedAtMs: null,
  updatedAtMs: null,
  lastAppliedAtMs: 1_700_000_000_000,
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
    host: "controller.example.ts.net"
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
    available: false,
    rollbackId: null,
    versionRolledBackFrom: null,
    versionRolledBackTo: null,
    reasonCode: null,
    requestedForLastUpdate: false,
    dataPolicy: "retain",
    bootFailureAutoRollbackGuaranteed: false
  }
};

const mockCapabilities = {
  mode: "mock",
  camera: {
    stream: false,
    select: false,
    zoom: false,
    focus: false,
    fps: false,
    resolution: false,
    quality: false,
    snapshot: false,
    orientation: true,
    torch: false
  },
  listeningAudio: false,
  pushToTalk: true,
  display: {
    message: true,
    liveText: true,
    webpage: false,
    black: false,
    media: false,
    restoreDashboard: false
  },
  device: {
    telemetry: false,
    brightness: false,
    volume: true,
    mute: false,
    orientation: true,
    appLauncher: true,
    appManagement: true,
    screenControl: true,
    touchLock: true,
    remoteControl: true,
    reboot: true,
    serviceRestart: true,
    maintenance: true,
    adminPinRecovery: true
  }
};

let mockRemoteEnabled = false;
let mockMaintenanceActive = false;
let mockApps: Array<{
  id: string;
  label: string;
  packageName: string;
  status: "approved" | "discovered" | "technical";
}> = [];
let mockDiagnosticEvents: Array<{
  sequence: number;
  timestampMs: number;
  level: "info" | "warn" | "error";
  component: string;
  event: string;
  fields: Record<string, string>;
}> = [];

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

beforeEach(() => {
  mockRemoteEnabled = false;
  mockMaintenanceActive = false;
  mockDiagnosticEvents = [
    {
      sequence: 1,
      timestampMs: 1_700_000_000_000,
      level: "info",
      component: "companion",
      event: "service_started",
      fields: { trigger: "boot" }
    }
  ];
  mockApps = [
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
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/auth/session")) {
        return mockResponse(
          {
            ok: false,
            error: { code: "UNAUTHENTICATED", message: "No session", recoverable: false }
          },
          401
        );
      }

      if (url.endsWith("/auth/login")) {
        return mockResponse({
          ok: true,
          data: {
            username: "admin",
            csrfToken: "test-csrf",
            expiresAt: Date.now() + 1000,
            mode: "mock"
          }
        });
      }

      if (url.endsWith("/tablet/status")) {
        return mockResponse({ ok: true, data: mockStatus });
      }

      if (url.endsWith("/tablet/health")) {
        const now = Date.now();
        const component = (state: string) => ({
          state,
          checkedAtMs: now,
          lastHealthyAtMs: now,
          degradedReason: null,
          details: {}
        });
        return mockResponse({
          ok: true,
          data: {
            healthy: true,
            homeReady: true,
            supervisorStartedAtMs: now - 1000,
            reconciledAtMs: now,
            reconciliationReason: "test",
            degradedReasons: [],
            components: {
              controlListener: component("healthy"),
              wifi: component("healthy"),
              vpnTailscale: component("healthy"),
              internalMedia: component("healthy"),
              ipWebcamFallback: component("standby"),
              remoteAgent: component(mockRemoteEnabled ? "healthy" : "standby"),
              signageService: component("healthy"),
              resources: component("healthy"),
              supervisor: component("healthy")
            }
          }
        });
      }

      if (url.endsWith("/tablet/diagnostics")) {
        return mockResponse({
          ok: true,
          data: {
            schemaVersion: 1,
            generatedAtMs: 1_700_000_000_100,
            entryCount: mockDiagnosticEvents.length,
            oldestSequence: mockDiagnosticEvents[0]?.sequence ?? null,
            newestSequence: mockDiagnosticEvents.at(-1)?.sequence ?? null,
            limits: {
              maxEntries: 256,
              maxFileBytes: 128 * 1024,
              maxFieldsPerEntry: 8,
              maxFieldValueChars: 96
            },
            events: mockDiagnosticEvents
          }
        });
      }

      if (url.endsWith("/tablet/diagnostics/clear")) {
        const removedEntries = mockDiagnosticEvents.length;
        mockDiagnosticEvents = [];
        return mockResponse({
          ok: true,
          data: {
            cleared: true,
            removedEntries,
            remainingEntries: 0
          }
        });
      }

      if (url.endsWith("/update/status")) {
        return mockResponse({ ok: true, data: mockSignedUpdateStatus });
      }

      if (url.endsWith("/remote/status")) {
        return mockResponse({
          ok: true,
          data: {
            enabled: mockRemoteEnabled,
            allowedKeys: ["BACK", "HOME"],
            screenWidth: 800,
            screenHeight: 1280,
            maxActionsPerMinute: 90,
            maxScreenshotsPerMinute: 30
          }
        });
      }

      if (url.endsWith("/remote/audit")) {
        return mockResponse({ ok: true, data: [] });
      }

      if (url.endsWith("/remote/enabled")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { enabled?: boolean };
        mockRemoteEnabled = body.enabled === true;
        return mockResponse({
          ok: true,
          data: {
            simulated: true,
            message: mockRemoteEnabled
              ? "Mock RoshanRemoteAgent enabled."
              : "Mock RoshanRemoteAgent disabled."
          }
        });
      }

      if (url.endsWith("/dpc/status")) {
        return mockResponse({
          ok: true,
          data: {
            deviceOwner: true,
            restrictions: {},
            statusBarDisabled: !mockMaintenanceActive,
            maintenance: {
              active: mockMaintenanceActive,
              expiresAt: mockMaintenanceActive ? Date.now() + 15 * 60_000 : 0,
              remainingSeconds: mockMaintenanceActive ? 900 : 0
            },
            lockTaskPackagesCount: 3
          }
        });
      }

      if (url.endsWith("/dpc/maintenance")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { action?: string };
        mockMaintenanceActive = body.action === "enter";
        return mockResponse({
          ok: true,
          data: {
            simulated: true,
            message: mockMaintenanceActive
              ? "Mock maintenance enabled."
              : "Mock maintenance disabled."
          }
        });
      }

      if (url.endsWith("/camera/status")) {
        return mockResponse({ ok: true, data: mockCamera });
      }

      if (url.endsWith("/capabilities")) {
        return mockResponse({ ok: true, data: mockCapabilities });
      }

      if (url.endsWith("/version")) {
        return mockResponse({
          ok: true,
          data: {
            apiBuildVersion: "test",
            webBuildVersion: "test",
            gitCommit: "test",
            buildTimestamp: "test",
            adapterMode: "mock",
            staticBundle: "not-served",
            serviceWorker: "disabled"
          }
        });
      }

      if (url.endsWith("/device/apps")) {
        return mockResponse({
          ok: true,
          data: mockApps
        });
      }

      if (url.endsWith("/device/apps/technical")) {
        return mockResponse({
          ok: true,
          data: [
            { packageName: "com.tabletcontrol.companion", label: "RoshanOS Companion" },
            { packageName: "com.android.settings", label: "Settings" }
          ]
        });
      }

      if (url.endsWith("/device/apps/approve")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { packageName?: string };
        mockApps = mockApps.map((app) =>
          app.packageName === body.packageName ? { ...app, status: "approved" } : app
        );
        return mockResponse({
          ok: true,
          data: { simulated: true, message: "Mock app approved." }
        });
      }

      if (url.endsWith("/device/apps/revoke")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { packageName?: string };
        mockApps = mockApps.map((app) =>
          app.packageName === body.packageName ? { ...app, status: "discovered" } : app
        );
        return mockResponse({
          ok: true,
          data: { simulated: true, message: "Mock app revoked." }
        });
      }

      return mockResponse({
        ok: true,
        data: { simulated: true, message: "Mock action completed." }
      });
    })
  );
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible"
  });
  cleanup();
  localStorage.clear();
});

describe("App", () => {
  it("signs into mock mode and exposes all controller tabs", async () => {
    render(<App />);

    await screen.findByRole("heading", { name: "RoshanOS Controller" });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Controller password"), {
      target: { value: "phase-1-local-only" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await screen.findByRole("tab", { name: "Live" });
    expect(screen.getByRole("tab", { name: "Talk" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Display" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Device" })).toBeInTheDocument();
  });

  it("saves the active tab to localStorage when switching", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "RoshanOS Controller" });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Controller password"), {
      target: { value: "phase-1-local-only" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("tab", { name: "Device" });

    fireEvent.click(screen.getByRole("tab", { name: "Device" }));
    expect(localStorage.getItem("tc-tab")).toBe("device");
  });

  it("restores the active tab from localStorage on mount", async () => {
    localStorage.setItem("tc-tab", "device");
    render(<App />);
    await screen.findByRole("heading", { name: "RoshanOS Controller" });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Controller password"), {
      target: { value: "phase-1-local-only" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("tabpanel", { name: "Device controls" });
    expect(screen.getByRole("tabpanel", { name: "Device controls" })).toBeInTheDocument();
    expect(screen.getByText("Good · RoshanOS Test")).toBeInTheDocument();
    expect(screen.getByText("Spotify")).toBeInTheDocument();
    expect(screen.getByText(/Recovery succeeded · .* uptime/u)).toBeInTheDocument();
    expect(screen.getByText("RoshanOS 2.0 (2)")).toBeInTheDocument();
  });

  it("uses pointer interactions for hold-to-talk", async () => {
    render(<App />);

    await screen.findByRole("heading", { name: "RoshanOS Controller" });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Controller password"), {
      target: { value: "phase-1-local-only" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("tab", { name: "Talk" });
    fireEvent.click(screen.getByRole("tab", { name: "Talk" }));

    const talkButton = screen.getByRole("button", { name: "HOLD TO TALK" });
    fireEvent.pointerDown(talkButton);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "TRANSMITTING" })).toBeInTheDocument()
    );
    fireEvent.pointerUp(screen.getByRole("button", { name: "TRANSMITTING" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "HOLD TO TALK" })).toBeInTheDocument()
    );
  });

  it("exposes accessible camera and screen orientation controls", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "RoshanOS Controller" });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Controller password"), {
      target: { value: "phase-1-local-only" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("button", { name: "Landscape" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    fireEvent.click(screen.getByRole("tab", { name: "Device" }));
    expect(screen.getByLabelText("Tablet screen orientation")).toBeInTheDocument();
  });

  it("offers animated/live text and launches only listed approved apps", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "RoshanOS Controller" });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Controller password"), {
      target: { value: "phase-1-local-only" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    fireEvent.click(await screen.findByRole("tab", { name: "Display" }));
    expect(screen.getByRole("button", { name: "Show animated message" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Live tablet text"), {
      target: { value: "Live tablet update" }
    });
    await waitFor(
      () =>
        expect(vi.mocked(fetch)).toHaveBeenCalledWith(
          "/api/v1/display/live-text",
          expect.objectContaining({ method: "POST" })
        ),
      { timeout: 2000 }
    );

    fireEvent.click(screen.getByRole("tab", { name: "Apps" }));
    expect(screen.queryByText("Tailscale")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open VLC" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Open Spotify" }));
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        "/api/v1/device/apps/launch",
        expect.objectContaining({ method: "POST" })
      )
    );
  });

  it("approves and revokes only visible non-technical apps with an immediate refresh", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "RoshanOS Controller" });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Controller password"), {
      target: { value: "phase-1-local-only" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Apps" }));

    expect(screen.queryByText("Tailscale")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Approve VLC" }));
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        "/api/v1/device/apps/approve",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ packageName: "org.videolan.vlc" })
        })
      )
    );
    expect(await screen.findByRole("button", { name: "Open VLC" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Revoke VLC" }));
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        "/api/v1/device/apps/revoke",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ packageName: "org.videolan.vlc" })
        })
      )
    );
    expect(await screen.findByRole("button", { name: "Approve VLC" })).toBeInTheDocument();
  });

  it("sends typed screen, service restart, and explicitly confirmed reboot actions", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "RoshanOS Controller" });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Controller password"), {
      target: { value: "phase-1-local-only" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Device" }));

    expect(
      screen.getAllByRole("button", { name: /^Restart /u }).map((button) => button.textContent)
    ).toEqual([
      expect.stringContaining("RoshanCore"),
      expect.stringContaining("RoshanMedia"),
      expect.stringContaining("Private network"),
      expect.stringContaining("Remote agent")
    ]);

    fireEvent.click(await screen.findByRole("button", { name: "Sleep screen" }));
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        "/api/v1/device/screen",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ on: false })
        })
      )
    );

    fireEvent.click(screen.getByRole("button", { name: /^Restart Private network/u }));
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        "/api/v1/services/vpn/restart",
        expect.objectContaining({ method: "POST", body: JSON.stringify({}) })
      )
    );

    const callsBeforeReboot = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => String(input).endsWith("/device/reboot")).length;
    fireEvent.click(screen.getByRole("button", { name: "Reboot tablet" }));
    expect(await screen.findByRole("heading", { name: "Reboot RoshanOS?" })).toBeInTheDocument();
    expect(
      vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/device/reboot"))
    ).toHaveLength(callsBeforeReboot);

    fireEvent.click(screen.getByRole("button", { name: "Confirm reboot" }));
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        "/api/v1/device/reboot",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ confirm: true })
        })
      )
    );
  });

  it("shows protected RoshanCore health and default-off remote controls in Admin", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "RoshanOS Controller" });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Controller password"), {
      target: { value: "phase-1-local-only" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    fireEvent.click(await screen.findByRole("tab", { name: "Admin" }));
    expect(await screen.findByText("RoshanCore server health")).toBeInTheDocument();
    expect(screen.getByText("RoshanRemoteAgent")).toBeInTheDocument();
    expect(await screen.findByText("Disabled")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Enable remote" }));
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        "/api/v1/remote/enabled",
        expect.objectContaining({ method: "POST" })
      )
    );
    expect(await screen.findByText("Enabled")).toBeInTheDocument();
  });

  it("reads and clears the protected bounded tablet diagnostic journal", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "RoshanOS Controller" });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Controller password"), {
      target: { value: "phase-1-local-only" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Admin" }));

    expect(
      await screen.findByRole("heading", { name: "RoshanOS diagnostic journal" })
    ).toBeInTheDocument();
    expect(await screen.findByText("companion.service_started")).toBeInTheDocument();
    expect(screen.getByText("trigger=boot")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear journal" }));
    expect(
      await screen.findByRole("heading", { name: "Clear tablet diagnostics?" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm clear" }));

    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        "/api/v1/tablet/diagnostics/clear",
        expect.objectContaining({
          method: "POST",
          headers: expect.any(Headers),
          body: JSON.stringify({})
        })
      )
    );
    const clearCall = vi
      .mocked(fetch)
      .mock.calls.find(([input]) => String(input).endsWith("/tablet/diagnostics/clear"));
    expect(new Headers(clearCall?.[1]?.headers).get("x-csrf-token")).toBe("test-csrf");
    expect(
      await screen.findByText("No diagnostic events are currently stored.")
    ).toBeInTheDocument();
  });

  it("runs live screen only by owner opt-in, without overlap, and pauses while hidden", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "RoshanOS Controller" });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Controller password"), {
      target: { value: "phase-1-local-only" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Admin" }));
    fireEvent.click(await screen.findByRole("button", { name: "Enable remote" }));
    expect(await screen.findByText("Enabled")).toBeInTheDocument();

    const defaultFetch = vi.mocked(fetch).getMockImplementation();
    if (defaultFetch === undefined) throw new Error("Missing default fetch mock.");
    let screenshotCalls = 0;
    let firstScreenshotSignal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/remote/screenshot")) {
        screenshotCalls++;
        if (screenshotCalls === 1) {
          firstScreenshotSignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            firstScreenshotSignal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true }
            );
          });
        }
        return new Response(
          Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
          { headers: { "content-type": "image/png" } }
        );
      }
      return defaultFetch(input, init);
    });
    const createObjectUrl = vi.mocked(URL.createObjectURL);
    createObjectUrl.mockClear();
    createObjectUrl.mockReturnValue("blob:live-screen-test");

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Start live screen" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screenshotCalls).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(screenshotCalls).toBe(1);
    expect(createObjectUrl).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden"
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(firstScreenshotSignal?.aborted).toBe(true);
    expect(screenshotCalls).toBe(1);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible"
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screenshotCalls).toBe(2);
    expect(createObjectUrl).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Stop live screen" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(screenshotCalls).toBe(2);
    expect(screen.getByText("Live screen stopped.")).toBeInTheDocument();
  });

  it("requires confirmation for bounded 15-minute Device Owner maintenance", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "RoshanOS Controller" });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Controller password"), {
      target: { value: "phase-1-local-only" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Admin" }));

    expect(await screen.findByText("Protected owner maintenance")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Enter for 15 minutes" }));
    expect(
      await screen.findByRole("heading", { name: "Temporarily relax protections?" })
    ).toBeInTheDocument();
    expect(
      vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith("/dpc/maintenance"))
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Confirm 15-minute maintenance" }));
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        "/api/v1/dpc/maintenance",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ action: "enter", durationMinutes: 15 })
        })
      )
    );
    expect(await screen.findByRole("button", { name: "Exit maintenance now" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Reset owner PIN lockout" }));
    expect(
      await screen.findByRole("heading", { name: "Clear owner PIN lockout?" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm lockout reset" }));
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        "/api/v1/admin/pin/rate-limit/reset",
        expect.objectContaining({ method: "POST" })
      )
    );
    const resetCall = vi
      .mocked(fetch)
      .mock.calls.find(([input]) => String(input).endsWith("/admin/pin/rate-limit/reset"));
    expect(resetCall?.[1]?.body).toBeUndefined();
    expect(new Headers(resetCall?.[1]?.headers).has("content-type")).toBe(false);
  });
});

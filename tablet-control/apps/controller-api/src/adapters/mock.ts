import type {
  AdapterActionResult,
  CompanionAdapter,
  FullyKioskAdapter,
  IpWebcamAdapter,
  ReadOnlyStreamConnection,
  TabletAdapters
} from "@tablet-control/integration-contracts";
import {
  CameraStatusSchema,
  type ApprovedApp,
  type CameraName,
  type CameraOrientation,
  type CameraStatus,
  type DiagnosticClearResult,
  type DiagnosticEvent,
  type DiagnosticSnapshot,
  type DisplayMode,
  type DpcMaintenanceAction,
  type DpcStatus,
  type RemoteAuditEvent,
  type RemoteControlStatus,
  type RemoteKey,
  type ScreenOrientation,
  type ServerComponentHealth,
  type ServerHealth,
  type ServiceRestartTarget,
  type SignedUpdateActionResult,
  type SignedUpdateStatus,
  type StreamKind,
  type TailscaleEnrollmentActionResult,
  type TailscaleEnrollmentStatus,
  type TabletStatus
} from "@tablet-control/shared-types";
import { ApiProblem } from "../errors.js";

function simulated(message: string): AdapterActionResult {
  return {
    simulated: true,
    message
  };
}

export class MockIpWebcamAdapter implements IpWebcamAdapter {
  private readonly status: CameraStatus = {
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

  public async getStatus(): Promise<CameraStatus> {
    return { ...this.status };
  }

  public async openReadOnlyStream(kind: StreamKind): Promise<ReadOnlyStreamConnection> {
    return {
      diagnostics: {
        mode: "mock",
        kind,
        contentType: null,
        connectionLatencyMs: 0,
        transport: "mock",
        maxReconnectAttempts: 0,
        readOnly: true
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        }
      }),
      cancel() {
        return;
      }
    };
  }

  public async selectCamera(camera: CameraName): Promise<AdapterActionResult> {
    this.status.activeCamera = camera;
    return simulated("Mock camera changed to " + camera + ".");
  }

  public async setOrientation(orientation: CameraOrientation): Promise<AdapterActionResult> {
    this.status.orientation = orientation;
    return simulated("Mock camera orientation changed to " + orientation + ".");
  }

  public async setZoom(zoom: number): Promise<AdapterActionResult> {
    this.status.zoom = zoom;
    return simulated("Mock zoom changed to " + zoom + "×.");
  }

  public async getSnapshot(): Promise<Uint8Array> {
    throw new ApiProblem(501, "UNSUPPORTED", "Snapshot is not available in mock mode.", false);
  }

  public async setFocus(mode: string): Promise<AdapterActionResult> {
    this.status.focusMode = mode as CameraStatus["focusMode"];
    return simulated("Mock focus changed to " + mode + ".");
  }

  public async triggerAutofocus(): Promise<AdapterActionResult> {
    return simulated("Mock autofocus triggered.");
  }

  public async setFps(fps: number): Promise<AdapterActionResult> {
    this.status.fps = fps as CameraStatus["fps"];
    return simulated("Mock FPS changed to " + fps + ".");
  }

  public async setResolution(resolution: string): Promise<AdapterActionResult> {
    this.status.resolution = resolution as CameraStatus["resolution"];
    return simulated("Mock resolution changed to " + resolution + ".");
  }

  public async setQuality(quality: number): Promise<AdapterActionResult> {
    this.status.quality = quality;
    return simulated("Mock quality changed to " + quality + "%.");
  }

  public async setTorch(_enabled: boolean): Promise<AdapterActionResult> {
    return simulated(
      "Torch remains unavailable in the mock because the documented hardware lacks flash."
    );
  }
}

export class MockFullyKioskAdapter implements FullyKioskAdapter {
  private displayMode: DisplayMode = "dashboard";
  private maintenanceExpiresAt = 0;

  public async getDisplayMode(): Promise<DisplayMode> {
    return this.displayMode;
  }

  public async showMessage(text: string, _durationSeconds?: number): Promise<AdapterActionResult> {
    this.displayMode = "message";
    return simulated("Mock display shows message: " + text.slice(0, 40));
  }

  public async showLiveText(text: string): Promise<AdapterActionResult> {
    this.displayMode = "message";
    return simulated("Mock display updates live text: " + text.slice(0, 40));
  }

  public async clearLiveText(): Promise<AdapterActionResult> {
    return simulated("Mock live text cleared.");
  }

  public async showMedia(kind: "image" | "video", fileName: string): Promise<AdapterActionResult> {
    this.displayMode = kind;
    return simulated("Mock display shows " + kind + " " + fileName + ".");
  }

  public async showWebpage(url: string): Promise<AdapterActionResult> {
    this.displayMode = "webpage";
    return simulated("Mock display opens " + url + ".");
  }

  public async setDashboardStartUrl(url: string): Promise<AdapterActionResult> {
    this.displayMode = "dashboard";
    return simulated("Mock dashboard start URL set to " + url + ".");
  }

  public async showBlack(): Promise<AdapterActionResult> {
    this.displayMode = "black";
    return simulated("Mock display is black.");
  }

  public async restoreDashboard(): Promise<AdapterActionResult> {
    this.displayMode = "dashboard";
    return simulated("Mock display restored dashboard.");
  }

  public async getDpcStatus(): Promise<DpcStatus> {
    const now = Date.now();
    const active = this.maintenanceExpiresAt > now;
    return {
      deviceOwner: true,
      restrictions: {
        no_factory_reset: !active,
        no_install_apps: !active,
        no_uninstall_apps: !active
      },
      statusBarDisabled: !active,
      maintenance: {
        active,
        expiresAt: active ? this.maintenanceExpiresAt : 0,
        remainingSeconds: active
          ? Math.max(0, Math.ceil((this.maintenanceExpiresAt - now) / 1_000))
          : 0
      },
      lockTaskPackagesCount: 3
    };
  }

  public async setMaintenanceMode(input: DpcMaintenanceAction): Promise<AdapterActionResult> {
    if (input.action === "enter") {
      this.maintenanceExpiresAt = Date.now() + input.durationMinutes * 60_000;
      return simulated("Mock maintenance mode enabled for 15 minutes.");
    }
    this.maintenanceExpiresAt = 0;
    return simulated("Mock maintenance mode disabled.");
  }
}

export class MockCompanionAdapter implements CompanionAdapter {


  private readonly apps: ApprovedApp[] = [
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
  private readonly status: TabletStatus = {
    mode: "mock",
    online: true,
    batteryPercent: 82,
    charging: true,
    batteryTemperatureC: 34.2,
    mediaVolume: 8,
    mediaVolumeMax: 15,
    brightness: 120,
    brightnessMode: "manual",
    screenTimeoutMs: 300_000,
    screenOrientation: "auto",
    screenOn: true,
    keyguardLocked: false,
    deviceLocked: false,
    connectivity: {
      wifiEnabled: true,
      wifiConnected: true,
      wifiSsid: "RoshanOS Test",
      wifiRssiDbm: -48,
      wifiSignalLevel: 4,
      wifiSignalState: "excellent",
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
      state: "roshanos",
      packageName: "com.tabletcontrol.companion",
      label: "RoshanOS"
    },
    boot: {
      lastBootAtMs: Date.now() - 184_293_000,
      uptimeSeconds: 184_293,
      recoveryState: "succeeded",
      recoveryVerifiedAtMs: Date.now() - 184_200_000
    },
    update: {
      state: "installed",
      versionName: "mock",
      versionCode: 1,
      firstInstalledAtMs: Date.now() - 86_400_000,
      lastAppliedAtMs: Date.now() - 86_400_000,
      pendingSystemUpdateState: "unknown"
    },
    wifiConnected: true,
    tailscaleConnected: true,
    transport: "mock",
    readOnlyLatencyMs: 0,
    ipWebcamHealthy: true,
    fullyKioskHealthy: false,
    companionHealthy: false,
    storageFreeMb: 8192,
    uptimeSeconds: 184293
  };
  private signedUpdateStatus: SignedUpdateStatus = {
    state: "idle",
    currentVersionCode: 1,
    currentVersionName: "mock",
    baseVersionCode: null,
    baseVersionName: null,
    targetVersionCode: null,
    targetVersionName: null,
    startedAtMs: null,
    updatedAtMs: null,
    lastAppliedAtMs: null,
    lastRollbackAtMs: null,
    lastRolledBackFromVersionCode: null,
    errorCode: null,
    progress: {
      downloadedBytes: 0,
      expectedBytes: null
    },
    controllerOrigin: {
      configured: false,
      state: "unconfigured",
      host: null
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
  private tailscaleEnrollmentStatus: TailscaleEnrollmentStatus = {
    state: "never_requested",
    code: "NONE",
    startedAtMs: 0,
    finishedAtMs: 0,
    deadlineAtMs: 0,
    timeoutSeconds: 0,
    deviceOwner: true,
    tailscaleInstalled: true,
    tailscaleEnabled: true,
    tailscaleVersion: "mock",
    alwaysOnVpnConfigured: true,
    vpnTransportDetected: true,
    vpnValidated: true,
    tailnetAddressDetected: true,
    credentialConsumptionProven: false,
    transientAuthKeyPresent: false,
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

  private previousVolume = this.status.mediaVolume;
  private remoteEnabled = false;
  private readonly remoteAudit: RemoteAuditEvent[] = [];
  private diagnosticEvents: DiagnosticEvent[] = [
    {
      sequence: 1,
      timestampMs: Date.now(),
      level: "info",
      component: "companion",
      event: "mock_started",
      fields: { source: "mock" }
    }
  ];

  public async getStatus(): Promise<TabletStatus> {
    return { ...this.status };
  }

  public async setBrightness(value: number): Promise<AdapterActionResult> {
    this.status.brightness = value;
    return simulated("Mock brightness changed to " + value + ".");
  }

  public async setVolume(value: number): Promise<AdapterActionResult> {
    this.status.mediaVolume = value;
    return simulated("Mock media volume changed to " + value + ".");
  }

  public async setMuted(muted: boolean): Promise<AdapterActionResult> {
    if (muted) {
      this.previousVolume = this.status.mediaVolume;
      this.status.mediaVolume = 0;
    } else {
      this.status.mediaVolume = this.previousVolume;
    }

    return simulated(muted ? "Mock media output muted." : "Mock media output restored.");
  }

  public async setScreenOrientation(orientation: ScreenOrientation): Promise<AdapterActionResult> {
    this.status.screenOrientation = orientation;
    return simulated("Mock screen orientation changed to " + orientation + ".");
  }

  public async setScreenOn(on: boolean): Promise<AdapterActionResult> {
    this.status.screenOn = on;
    return simulated(on ? "Mock screen woke." : "Mock screen slept.");
  }

  public async setTouchLock(on: boolean): Promise<AdapterActionResult> {
    this.status.touchLock = on;
    return simulated("Mock touch lock " + (on ? "enabled." : "disabled."));
  }

  public async listApps(): Promise<ApprovedApp[]> {
    return [...this.apps];
  }

  public async listTechnicalApps(): Promise<{ packageName: string; label: string }[]> {
    return [
      { packageName: "com.tabletcontrol.companion", label: "RoshanOS Companion" },
      { packageName: "com.android.settings", label: "Settings" }
    ];
  }

  public async approveApp(packageName: string): Promise<AdapterActionResult> {
    const app = this.apps.find(
      (candidate) => candidate.packageName === packageName && candidate.status === "discovered"
    );
    if (app === undefined) {
      throw new ApiProblem(
        400,
        "VALIDATION_ERROR",
        "Only a discovered non-technical application can be approved.",
        false
      );
    }
    app.status = "approved";
    return simulated("Mock approved " + app.label + ".");
  }

  public async revokeApp(packageName: string): Promise<AdapterActionResult> {
    const app = this.apps.find(
      (candidate) => candidate.packageName === packageName && candidate.status === "approved"
    );
    if (app === undefined) {
      throw new ApiProblem(404, "UNSUPPORTED", "The approved app was not found.", false);
    }
    app.status = "discovered";
    return simulated("Mock revoked " + app.label + ".");
  }

  public async launchApp(appId: string): Promise<AdapterActionResult> {
    const app = this.apps.find(
      (candidate) => candidate.id === appId && candidate.status === "approved"
    );
    if (app === undefined) {
      throw new ApiProblem(404, "UNSUPPORTED", "The approved app is not installed.", false);
    }
    return simulated("Mock opened " + app.label + ".");
  }

  public async rebootDevice(): Promise<AdapterActionResult> {
    return simulated("Mock RoshanOS reboot scheduled.");
  }

  public async restartService(service: ServiceRestartTarget): Promise<AdapterActionResult> {
    return simulated("Mock " + service + " service restart requested.");
  }

  public async resetAdminPinRateLimit(): Promise<AdapterActionResult> {
    return simulated("Mock owner PIN failed-attempt counters cleared.");
  }

  public async controlMedia(
    action: "play-pause" | "next" | "previous"
  ): Promise<AdapterActionResult> {
    return simulated(`Mock media action ${action} executed.`);
  }

  public async beginTalk(): Promise<AdapterActionResult> {
    return simulated("Mock Companion started tablet speaker playback.");
  }

  public async endTalk(): Promise<AdapterActionResult> {
    return simulated("Mock Companion stopped tablet speaker playback.");
  }

  public async restoreDashboard(): Promise<AdapterActionResult> {
    return simulated("Mock Companion restored managed dashboard.");
  }

  public async showClockOnly(): Promise<AdapterActionResult> {
    return simulated("Mock Companion switched to clock only.");
  }

  public async setClockColor(color: string): Promise<AdapterActionResult> {
    return simulated("Mock Companion set clock color to " + color);
  }

  public async showWebpage(url: string): Promise<AdapterActionResult> {
    return simulated(`Mock Companion opened webpage: ${url}`);
  }

  public async findSound(durationSeconds: number = 15): Promise<AdapterActionResult> {
    return simulated(`Mock find sound playing for ${durationSeconds}s`);
  }

  public async stopFindSound(): Promise<AdapterActionResult> {
    return simulated("Mock find sound stopped.");
  }

  public async sendAudioFrame(_data: Uint8Array): Promise<void> {
    return Promise.resolve();
  }

  public async getServerHealth(): Promise<ServerHealth> {
    const now = Date.now();
    const healthy = (
      state: ServerComponentHealth["state"],
      details: Record<string, unknown> = {}
    ): ServerComponentHealth => ({
      state,
      checkedAtMs: now,
      lastHealthyAtMs: now,
      degradedReason: null,
      details
    });
    return {
      healthy: true,
      supervisorStartedAtMs: now - 60_000,
      reconciledAtMs: now,
      reconciliationReason: "mock",
      degradedReasons: [],
      components: {
        controlListener: healthy("healthy", { port: 8765 }),
        wifi: healthy("healthy", { enabled: true, connected: true }),
        vpnTailscale: healthy("healthy", { vpnTransportAvailable: true }),
        internalMedia: healthy("healthy", { serviceRunning: true }),
        ipWebcamFallback: healthy("standby", { packageEnabled: true }),
        remoteAgent: healthy(this.remoteEnabled ? "healthy" : "standby", {
          enabledByOwner: this.remoteEnabled,
          genericShellAvailable: false
        }),
        signageService: healthy("healthy", { renderer: "mock" }),
        supervisor: healthy("healthy", { running: true })
      }
    };
  }

  public async getDiagnostics(): Promise<DiagnosticSnapshot> {
    const events = this.diagnosticEvents.map((event) => ({
      ...event,
      fields: { ...event.fields }
    }));
    return {
      schemaVersion: 1,
      generatedAtMs: Date.now(),
      entryCount: events.length,
      oldestSequence: events[0]?.sequence ?? null,
      newestSequence: events.at(-1)?.sequence ?? null,
      limits: {
        maxEntries: 256,
        maxFileBytes: 128 * 1024,
        maxFieldsPerEntry: 8,
        maxFieldValueChars: 96
      },
      events
    };
  }

  public async clearDiagnostics(): Promise<DiagnosticClearResult> {
    const removedEntries = this.diagnosticEvents.length;
    this.diagnosticEvents = [];
    return {
      cleared: true,
      removedEntries,
      remainingEntries: 0
    };
  }

  public async getRemoteStatus(): Promise<RemoteControlStatus> {
    return {
      enabled: this.remoteEnabled,
      allowedKeys: [
        "BACK",
        "HOME",
        "RECENTS",
        "ENTER",
        "DPAD_UP",
        "DPAD_DOWN",
        "DPAD_LEFT",
        "DPAD_RIGHT",
        "MEDIA_PLAY_PAUSE",
        "MEDIA_NEXT",
        "MEDIA_PREVIOUS",
        "VOLUME_UP",
        "VOLUME_DOWN"
      ],
      screenWidth: 800,
      screenHeight: 1280,
      maxActionsPerMinute: 90,
      maxScreenshotsPerMinute: 30
    };
  }

  public async setRemoteEnabled(enabled: boolean): Promise<AdapterActionResult> {
    this.remoteEnabled = enabled;
    this.recordRemote(enabled ? "remote-enabled" : "remote-disabled", true);
    return simulated(`Mock RoshanRemoteAgent ${enabled ? "enabled" : "disabled"}.`);
  }

  public async getRemoteScreenshot(): Promise<Uint8Array> {
    this.requireRemoteEnabled();
    this.recordRemote("screenshot", true);
    return Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5,
      0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x64,
      0xf8, 0x0f, 0x00, 0x01, 0x05, 0x01, 0x01, 0x27, 0x18, 0xe3, 0x66, 0x00, 0x00, 0x00, 0x00,
      0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
    ]);
  }

  public async remoteTap(_x: number, _y: number): Promise<AdapterActionResult> {
    this.requireRemoteEnabled();
    this.recordRemote("tap", true);
    return simulated("Mock remote tap accepted.");
  }

  public async remoteSwipe(
    _startX: number,
    _startY: number,
    _endX: number,
    _endY: number,
    _durationMs: number
  ): Promise<AdapterActionResult> {
    this.requireRemoteEnabled();
    this.recordRemote("swipe", true);
    return simulated("Mock remote swipe accepted.");
  }

  public async remoteKey(key: RemoteKey): Promise<AdapterActionResult> {
    this.requireRemoteEnabled();
    this.recordRemote(`key-${key.toLowerCase()}`, true);
    return simulated(`Mock allowlisted key ${key} accepted.`);
  }

  public async remoteText(_text: string): Promise<AdapterActionResult> {
    this.requireRemoteEnabled();
    this.recordRemote("text", true);
    return simulated("Mock bounded text accepted.");
  }

  public async closeApprovedApp(packageName: string): Promise<AdapterActionResult> {
    this.requireRemoteEnabled();
    if (
      !this.apps.some(
        (app) =>
          app.packageName === packageName && (app.status === undefined || app.status === "approved")
      )
    ) {
      throw new ApiProblem(403, "FORBIDDEN", "Only an approved application can be closed.", false);
    }
    this.recordRemote("close-app", true);
    return simulated("Mock approved application closed.");
  }

  public async getRemoteAudit(): Promise<RemoteAuditEvent[]> {
    return this.remoteAudit.map((event) => ({ ...event }));
  }

  private requireRemoteEnabled(): void {
    if (!this.remoteEnabled) {
      throw new ApiProblem(409, "CONFLICT", "RoshanRemoteAgent is disabled.", false);
    }
  }

  private recordRemote(action: string, success: boolean): void {
    this.remoteAudit.push({ timestamp: Date.now(), action, success });
    if (this.remoteAudit.length > 100) {
      this.remoteAudit.splice(0, this.remoteAudit.length - 100);
    }
  }

  public async getCameraStatus(): Promise<CameraStatus> {
    return CameraStatusSchema.parse({
      mode: "companion",
      healthy: true,
      activeCamera: "rear",
      transport: "trusted-lan",
      lastStatusLatencyMs: 0
    });
  }

  public async openCameraStream(kind: StreamKind): Promise<ReadOnlyStreamConnection> {
    return {
      diagnostics: {
        mode: "companion",
        kind,
        contentType:
          kind === "video" ? "multipart/x-mixed-replace; boundary=mjpegboundary" : "audio/wav",
        connectionLatencyMs: 0,
        transport: "trusted-lan",
        maxReconnectAttempts: 0,
        readOnly: true
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        }
      }),
      cancel() {
        return;
      }
    };
  }

  public async getCameraSnapshot(): Promise<Uint8Array> {
    throw new ApiProblem(501, "UNSUPPORTED", "Snapshot is not available in mock mode.", false);
  }

  public async selectCamera(camera: CameraName): Promise<AdapterActionResult> {
    return simulated("Mock camera switched to " + camera + ".");
  }

  private signedUpdateAction(code: string): SignedUpdateActionResult {
    return {
      accepted: true,
      code,
      update: structuredClone(this.signedUpdateStatus)
    };
  }

  public async configureUpdateControllerOrigin(origin: string): Promise<SignedUpdateActionResult> {
    this.signedUpdateStatus = {
      ...this.signedUpdateStatus,
      controllerOrigin: {
        configured: true,
        state: "ready",
        host: new URL(origin).hostname
      },
      updatedAtMs: Date.now()
    };
    return this.signedUpdateAction("CONTROLLER_ORIGIN_CONFIGURED");
  }

  public async requestUpdate(_url: string, _sha256: string): Promise<SignedUpdateActionResult> {
    const now = Date.now();
    this.signedUpdateStatus = {
      ...this.signedUpdateStatus,
      state: "downloading",
      baseVersionCode: this.signedUpdateStatus.currentVersionCode,
      baseVersionName: this.signedUpdateStatus.currentVersionName,
      startedAtMs: now,
      updatedAtMs: now,
      errorCode: null,
      progress: {
        downloadedBytes: 0,
        expectedBytes: null
      }
    };
    return this.signedUpdateAction("UPDATE_ACCEPTED");
  }

  public async getUpdateStatus(): Promise<SignedUpdateStatus> {
    return structuredClone(this.signedUpdateStatus);
  }

  public async requestUpdateRollback(): Promise<SignedUpdateActionResult> {
    const now = Date.now();
    this.signedUpdateStatus = {
      ...this.signedUpdateStatus,
      state: "rolled_back",
      updatedAtMs: now,
      lastRollbackAtMs: now,
      lastRolledBackFromVersionCode: this.signedUpdateStatus.currentVersionCode
    };
    return this.signedUpdateAction("ROLLBACK_ACCEPTED");
  }

  public async enrollTailscale(
    _authKey: string,
    timeoutSeconds: number
  ): Promise<TailscaleEnrollmentActionResult> {
    const now = Date.now();
    this.tailscaleEnrollmentStatus = {
      ...this.tailscaleEnrollmentStatus,
      state: "enrolling",
      code: "WAITING_FOR_TAILNET",
      startedAtMs: now,
      finishedAtMs: 0,
      deadlineAtMs: now + timeoutSeconds * 1_000,
      timeoutSeconds,
      credentialConsumptionProven: false,
      transientAuthKeyPresent: true
    };
    return {
      accepted: true,
      code: "ENROLLMENT_STARTED",
      enrollment: structuredClone(this.tailscaleEnrollmentStatus)
    };
  }

  public async getTailscaleEnrollmentStatus(): Promise<TailscaleEnrollmentStatus> {
    return structuredClone(this.tailscaleEnrollmentStatus);
  }
}

export function createMockAdapters(): TabletAdapters {
  return {
    ipWebcam: new MockIpWebcamAdapter(),
    fullyKiosk: new MockFullyKioskAdapter(),
    companion: new MockCompanionAdapter()
  };
}

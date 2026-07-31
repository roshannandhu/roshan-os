import type {
  AdapterActionResult,
  CompanionAdapter,
  ReadOnlyStreamConnection
} from "@tablet-control/integration-contracts";
import {
  CameraStatusSchema,
  ApprovedAppSchema,
  CompanionStatusPayloadSchema,
  DiagnosticClearResultSchema,
  DiagnosticSnapshotSchema,
  RemoteAuditEventSchema,
  RemoteControlStatusSchema,
  ServerHealthSchema,
  SignedUpdateActionResultSchema,
  SignedUpdateStatusSchema,
  TailscaleEnrollmentActionResultSchema,
  TailscaleEnrollmentStatusSchema,
  TabletStatusSchema,
  type ApprovedApp,
  type CameraName,
  type CameraStatus,
  type DiagnosticClearResult,
  type DiagnosticSnapshot,
  type RemoteAuditEvent,
  type RemoteControlStatus,
  type RemoteKey,
  type ScreenOrientation,
  type ServerHealth,
  type ServiceRestartTarget,
  type SignedUpdateActionResult,
  type SignedUpdateStatus,
  type StreamKind,
  type TailscaleEnrollmentActionResult,
  type TailscaleEnrollmentStatus,
  type TabletStatus
} from "@tablet-control/shared-types";
import type { CompanionConfig } from "../config.js";
import { ApiProblem } from "../errors.js";

export class ReadWriteCompanionAdapter implements CompanionAdapter {
  public constructor(private readonly config: CompanionConfig) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const headers: Record<string, string> = { authorization: `Bearer ${this.config.secret}` };
    const init: RequestInit = {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(this.config.requestTimeoutMs)
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (
        error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        throw new ApiProblem(504, "TIMEOUT", "Companion request timed out.", true);
      }
      throw new ApiProblem(502, "TABLET_OFFLINE", "Companion is unreachable.", true);
    }

    if (response.status === 401) {
      throw new ApiProblem(
        401,
        "UNAUTHENTICATED",
        "Companion rejected the authorization header.",
        false
      );
    }

    if (!response.ok) {
      const upstream = (await response.json().catch(() => undefined)) as
        { error?: { message?: string } } | undefined;
      const message =
        upstream?.error?.message ??
        `Companion returned ${response.status.toString()} for ${method} ${path}`;
      if (response.status === 400) {
        throw new ApiProblem(400, "VALIDATION_ERROR", message, false);
      }
      if (response.status === 403) {
        throw new ApiProblem(403, "FORBIDDEN", message, false);
      }
      if (response.status === 409) {
        throw new ApiProblem(409, "CONFLICT", message, false);
      }
      if (response.status === 429) {
        throw new ApiProblem(429, "RATE_LIMITED", message, true);
      }
      throw new ApiProblem(502, "INTERNAL_ERROR", message, true);
    }

    const json = (await response.json().catch(() => undefined)) as
      | {
          ok: boolean;
          data?: T;
          error?: { code: string; message: string };
        }
      | undefined;
    if (json === undefined) {
      throw new ApiProblem(502, "MALFORMED_RESPONSE", "Companion returned invalid JSON.", true);
    }
    if (!json.ok || json.data === undefined) {
      const msg = json.error?.message ?? "Companion returned ok=false";
      throw new ApiProblem(502, "INTERNAL_ERROR", msg, true);
    }

    return json.data;
  }

  public async getStatus(): Promise<TabletStatus> {
    const raw = await this.call<unknown>("GET", "/api/v1/companion/status");
    const parsed = CompanionStatusPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "Companion returned malformed strict device telemetry.",
        true
      );
    }
    const data = parsed.data;
    const serverHealth = ServerHealthSchema.safeParse(data.serverHealth);
    const components = serverHealth.success ? serverHealth.data.components : undefined;
    const wifiDetails = components?.wifi.details;
    return TabletStatusSchema.parse({
      mode: "companion",
      online: true,
      batteryPercent: data.batteryPercent,
      charging: data.charging,
      batteryTemperatureC: data.batteryTemperatureC,
      mediaVolume: data.mediaVolume,
      mediaVolumeMax: data.mediaVolumeMax,
      brightness: data.brightness,
      brightnessMode: data.brightnessMode,
      screenTimeoutMs: data.screenTimeoutMs,
      screenOrientation: data.screenOrientation,
      screenOn: data.screenOn,
      keyguardLocked: data.keyguardLocked,
      deviceLocked: data.deviceLocked,
      displayMode: data.displayMode,
      touchLock: data.touchLock,
      wifiConnected:
        data.connectivity.wifiConnected ??
        (typeof wifiDetails?.connected === "boolean" ? wifiDetails.connected : null),
      tailscaleConnected:
        components === undefined ? null : components.vpnTailscale.state === "healthy",
      connectivity: data.connectivity,
      memory: data.memory,
      foregroundApp: data.foregroundApp,
      boot: data.boot,
      update: data.update,
      transport: this.config.transport ?? "trusted-lan",
      readOnlyLatencyMs: 0,
      ipWebcamHealthy: components?.ipWebcamFallback.state === "healthy",
      fullyKioskHealthy: null,
      companionHealthy: true,
      storageFreeMb: data.storageFreeMb,
      uptimeSeconds: data.uptimeSeconds
    });
  }

  public async setBrightness(value: number): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/brightness", { value });
  }

  public async setVolume(value: number): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/volume", { value });
  }

  public async setMuted(muted: boolean): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/mute", { muted });
  }

  public async setScreenOrientation(orientation: ScreenOrientation): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/orientation", {
      orientation
    });
  }

  public async setScreenOn(on: boolean): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/screen", { on });
  }

  public async setTouchLock(on: boolean): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/touch_lock", { on });
  }

  public async listApps(): Promise<ApprovedApp[]> {
    const data = await this.call<unknown>("GET", "/api/v1/companion/apps");
    const parsed = ApprovedAppSchema.array().safeParse(data);
    if (!parsed.success) {
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "Companion returned a malformed application list.",
        true
      );
    }
    return parsed.data.filter((app) => app.status !== "technical");
  }

  public async listTechnicalApps(): Promise<{ packageName: string; label: string }[]> {
    const data = await this.call<unknown>("GET", "/api/v1/companion/apps/technical");
    if (!Array.isArray(data)) {
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "Companion returned a malformed technical application list.",
        true
      );
    }
    return data as { packageName: string; label: string }[];
  }

  public async approveApp(packageName: string): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/apps/approve", {
      packageName
    });
  }

  public async revokeApp(packageName: string): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/apps/revoke", {
      packageName
    });
  }

  public async launchApp(appId: string): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/apps/launch", { appId });
  }

  public async rebootDevice(): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/device/reboot");
  }

  public async restartService(service: ServiceRestartTarget): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/services/restart", {
      service
    });
  }

  public async resetAdminPinRateLimit(): Promise<AdapterActionResult> {
    const result = await this.call<{ reset?: unknown }>(
      "POST",
      "/api/v1/companion/admin/pin/rate-limit/reset"
    );
    if (result.reset !== true) {
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "Companion did not confirm the owner PIN lockout reset.",
        true
      );
    }
    return {
      simulated: false,
      message: "Owner PIN failed-attempt and cooldown counters were cleared."
    };
  }

  public async restoreDashboard(): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/kiosk/restore", {});
  }

  public async showClockOnly(): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/kiosk/clock", {});
  }

  public async setClockColor(color: string): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/kiosk/clock-color", { color });
  }

  public async showWebpage(url: string): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/kiosk/webpage", { url });
  }

  public async controlMedia(
    action: "play-pause" | "next" | "previous"
  ): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/media", { action });
  }

  public async findSound(durationSeconds: number = 15): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/device/find/sound", {
      durationSeconds
    });
  }

  public async stopFindSound(): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/device/find/sound/stop", {});
  }

  public async beginTalk(): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/audio/start");
  }

  public async endTalk(): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/audio/stop");
  }

  public async sendAudioFrame(data: Uint8Array): Promise<void> {
    const url = `${this.config.baseUrl}/api/v1/companion/audio/frame`;
    const body = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength
    ) as ArrayBuffer;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.secret}`,
        "content-type": "application/octet-stream"
      },
      body,
      signal: AbortSignal.timeout(500)
    });
    if (!response.ok) {
      throw new ApiProblem(
        502,
        "INTERNAL_ERROR",
        `Audio frame failed: ${response.status.toString()}`,
        true
      );
    }
  }

  public async getServerHealth(): Promise<ServerHealth> {
    const data = await this.call<unknown>("GET", "/api/v1/companion/server-health");
    const parsed = ServerHealthSchema.safeParse(data);
    if (!parsed.success) {
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "Companion returned malformed structured server health.",
        true
      );
    }
    return parsed.data;
  }

  public async getDiagnostics(): Promise<DiagnosticSnapshot> {
    const data = await this.call<unknown>("GET", "/api/v1/companion/diagnostics");
    const parsed = DiagnosticSnapshotSchema.safeParse(data);
    if (!parsed.success) {
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "Companion returned a malformed diagnostic journal.",
        true
      );
    }
    return parsed.data;
  }

  public async clearDiagnostics(): Promise<DiagnosticClearResult> {
    const data = await this.call<unknown>("POST", "/api/v1/companion/diagnostics/clear", {});
    const parsed = DiagnosticClearResultSchema.safeParse(data);
    if (!parsed.success) {
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "Companion did not confirm that its diagnostic journal was cleared.",
        true
      );
    }
    return parsed.data;
  }

  public async getRemoteStatus(): Promise<RemoteControlStatus> {
    const data = await this.call<unknown>("GET", "/api/v1/companion/remote/status");
    const parsed = RemoteControlStatusSchema.safeParse(data);
    if (!parsed.success) {
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "Companion returned malformed RoshanRemoteAgent status.",
        true
      );
    }
    return parsed.data;
  }

  public async setRemoteEnabled(enabled: boolean): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/remote/enabled", { enabled });
  }

  public async getRemoteScreenshot(): Promise<Uint8Array> {
    const response = await this.rawRemoteCall(
      "POST",
      "/api/v1/companion/remote/screenshot",
      "image/png"
    );
    const bytes = await this.readBoundedBody(response, 16 * 1024 * 1024);
    if (
      bytes.length < 8 ||
      bytes[0] !== 0x89 ||
      bytes[1] !== 0x50 ||
      bytes[2] !== 0x4e ||
      bytes[3] !== 0x47
    ) {
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "Companion screenshot is not a valid PNG.",
        true
      );
    }
    return bytes;
  }

  public async remoteTap(x: number, y: number): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/remote/tap", {
      x,
      y
    });
  }

  public async remoteSwipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    durationMs: number
  ): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/remote/swipe", {
      startX,
      startY,
      endX,
      endY,
      durationMs
    });
  }

  public async remoteKey(key: RemoteKey): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/remote/key", {
      key
    });
  }

  public async remoteText(text: string): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/remote/text", {
      text
    });
  }

  public async closeApprovedApp(packageName: string): Promise<AdapterActionResult> {
    return this.call<AdapterActionResult>("POST", "/api/v1/companion/remote/close-app", {
      packageName
    });
  }

  public async getRemoteAudit(): Promise<RemoteAuditEvent[]> {
    const data = await this.call<unknown>("GET", "/api/v1/companion/remote/audit");
    const parsed = RemoteAuditEventSchema.array().max(100).safeParse(data);
    if (!parsed.success) {
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "Companion returned a malformed remote audit log.",
        true
      );
    }
    return parsed.data;
  }

  private async rawRemoteCall(
    method: "GET" | "POST",
    path: string,
    expectedContentType: string
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.config.secret}`,
          accept: expectedContentType
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.config.requestTimeoutMs)
      });
    } catch (error) {
      if (
        error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        throw new ApiProblem(504, "TIMEOUT", "Remote screenshot timed out.", true);
      }
      throw new ApiProblem(502, "TABLET_OFFLINE", "Companion is unreachable.", true);
    }
    if (response.status === 401) {
      throw new ApiProblem(401, "UNAUTHENTICATED", "Companion rejected authorization.", false);
    }
    if (response.status === 409) {
      throw new ApiProblem(409, "CONFLICT", "RoshanRemoteAgent is disabled.", false);
    }
    if (response.status === 429) {
      throw new ApiProblem(429, "RATE_LIMITED", "Remote screenshot rate limit reached.", true);
    }
    if (!response.ok) {
      throw new ApiProblem(
        502,
        "INTERNAL_ERROR",
        `Companion returned ${response.status.toString()} for remote screenshot.`,
        true
      );
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith(expectedContentType)) {
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "Companion returned an unexpected screenshot content type.",
        true
      );
    }
    return response;
  }

  private async readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
    if (response.body === null) {
      throw new ApiProblem(502, "MALFORMED_RESPONSE", "Companion returned an empty body.", true);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > maxBytes) {
          throw new ApiProblem(
            502,
            "MALFORMED_RESPONSE",
            "Companion screenshot exceeded the size limit.",
            true
          );
        }
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  private async proxyCall<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.call<T>(method, path, body);
  }

  public async getCameraStatus(): Promise<CameraStatus> {
    const data = await this.proxyCall<Record<string, unknown>>(
      "GET",
      "/api/v1/companion/camera/status"
    );
    if (data === undefined || data.state === undefined) {
      return CameraStatusSchema.parse({
        mode: "companion",
        healthy: false,
        activeCamera: null,
        transport: this.config.transport ?? "trusted-lan",
        lastStatusLatencyMs: null
      });
    }
    return CameraStatusSchema.parse({
      mode: "companion",
      healthy: (data as Record<string, unknown>).state === "healthy",
      activeCamera: (data as Record<string, unknown>).activeCamera ?? null,
      transport: this.config.transport ?? "trusted-lan",
      lastStatusLatencyMs: null,
      listeningEnabled: null,
      zoom: null,
      quality: null,
      resolution: null,
      fps: null,
      focusMode: null,
      hasTorch: false
    });
  }

  public async openCameraStream(kind: StreamKind): Promise<ReadOnlyStreamConnection> {
    const endpoint =
      kind === "video" ? "/api/v1/companion/camera/video" : "/api/v1/companion/camera/audio";
    const expectedFragment = kind === "video" ? "multipart/x-mixed-replace" : "audio/";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    const startedAt = performance.now();

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${endpoint}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.config.secret}`,
          accept: kind === "video" ? "multipart/x-mixed-replace,image/*" : "audio/wav,audio/*"
        },
        redirect: "error",
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ApiProblem(504, "TIMEOUT", "Companion camera stream timed out.", true);
      }
      throw new ApiProblem(
        502,
        "STREAM_FAILURE",
        "Companion camera stream could not be opened.",
        true
      );
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429) {
      controller.abort();
      throw new ApiProblem(429, "RATE_LIMITED", "Camera stream client limit reached.", false);
    }

    if (response.status === 409) {
      controller.abort();
      throw new ApiProblem(
        409,
        "CONFLICT",
        "Audio stream already in use by another client.",
        false
      );
    }

    if (!response.ok) {
      controller.abort();
      throw new ApiProblem(
        502,
        "STREAM_FAILURE",
        `Companion camera returned HTTP ${response.status}`,
        true
      );
    }

    const ct = response.headers.get("content-type") ?? "";
    if (!ct.includes(expectedFragment) && !ct.includes("image/") && !ct.includes("audio/")) {
      controller.abort();
      throw new ApiProblem(
        502,
        "STREAM_FAILURE",
        `Companion returned unexpected content type for ${kind} stream.`,
        true
      );
    }

    const contentType = response.headers.get("content-type") ?? null;
    return {
      diagnostics: {
        mode: "companion",
        kind,
        contentType,
        connectionLatencyMs: Math.round(performance.now() - startedAt),
        transport: this.config.transport ?? "trusted-lan",
        maxReconnectAttempts: 3,
        readOnly: true
      },
      body: response.body!,
      cancel() {
        controller.abort();
      }
    };
  }

  public async getCameraSnapshot(): Promise<Uint8Array> {
    const url = `${this.config.baseUrl}/api/v1/companion/camera/snapshot`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.config.secret}`,
          accept: "image/jpeg"
        },
        redirect: "error",
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ApiProblem(504, "TIMEOUT", "Companion camera snapshot timed out.", true);
      }
      throw new ApiProblem(502, "CAMERA_OFFLINE", "Companion camera snapshot failed.", true);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      controller.abort();
      throw new ApiProblem(
        502,
        "CAMERA_OFFLINE",
        `Companion camera snapshot returned HTTP ${response.status}`,
        true
      );
    }

    const ct = response.headers.get("content-type") ?? "";
    if (!ct.includes("image/jpeg") && !ct.includes("image/jpg")) {
      controller.abort();
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "Companion returned unexpected content type for snapshot.",
        true
      );
    }

    const body = response.body;
    if (body === null) {
      controller.abort();
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "Companion returned empty snapshot body.",
        true
      );
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    const maxBytes = 2_097_152;
    const bodyTimer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        totalSize += result.value.length;
        if (totalSize > maxBytes) {
          throw new ApiProblem(502, "MALFORMED_RESPONSE", "Snapshot exceeded size limit.", true);
        }
        chunks.push(result.value);
      }
      const combined = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      return combined;
    } finally {
      clearTimeout(bodyTimer);
      controller.abort();
      reader.cancel().catch(() => {});
    }
  }

  public async selectCamera(camera: CameraName): Promise<AdapterActionResult> {
    return this.proxyCall<AdapterActionResult>("POST", "/api/v1/companion/camera/select", {
      camera
    });
  }

  private parseUpdateAction(data: unknown): SignedUpdateActionResult {
    const parsed = SignedUpdateActionResultSchema.safeParse(data);
    if (!parsed.success) {
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "Companion returned a malformed signed-update action result.",
        true
      );
    }
    return parsed.data;
  }

  public async configureUpdateControllerOrigin(origin: string): Promise<SignedUpdateActionResult> {
    const data = await this.call<unknown>("POST", "/api/v1/companion/update/controller-origin", {
      origin
    });
    return this.parseUpdateAction(data);
  }

  public async requestUpdate(url: string, sha256: string): Promise<SignedUpdateActionResult> {
    const data = await this.call<unknown>("POST", "/api/v1/companion/update/request", {
      url,
      sha256
    });
    return this.parseUpdateAction(data);
  }

  public async getUpdateStatus(): Promise<SignedUpdateStatus> {
    const data = await this.call<unknown>("GET", "/api/v1/companion/update/status");
    const parsed = SignedUpdateStatusSchema.safeParse(data);
    if (!parsed.success) {
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "Companion returned malformed strict signed-update status.",
        true
      );
    }
    return parsed.data;
  }

  public async requestUpdateRollback(): Promise<SignedUpdateActionResult> {
    const data = await this.call<unknown>("POST", "/api/v1/companion/update/rollback", {
      confirm: true
    });
    return this.parseUpdateAction(data);
  }

  public async enrollTailscale(
    authKey: string,
    timeoutSeconds: number
  ): Promise<TailscaleEnrollmentActionResult> {
    const data = await this.call<unknown>("POST", "/api/v1/companion/tailscale/enroll", {
      authKey,
      timeoutSeconds
    });
    const parsed = TailscaleEnrollmentActionResultSchema.safeParse(data);
    if (!parsed.success) {
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "Companion returned a malformed Tailscale enrollment result.",
        true
      );
    }
    return parsed.data;
  }

  public async getTailscaleEnrollmentStatus(): Promise<TailscaleEnrollmentStatus> {
    const data = await this.call<unknown>("GET", "/api/v1/companion/tailscale/enrollment/status");
    const parsed = TailscaleEnrollmentStatusSchema.safeParse(data);
    if (!parsed.success) {
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "Companion returned malformed strict Tailscale enrollment status.",
        true
      );
    }
    return parsed.data;
  }
}

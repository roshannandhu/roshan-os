import {
  MEDIA_MAX_FILE_BYTES,
  SignedUpdateActionResultSchema,
  SignedUpdateStatusSchema,
  TailscaleEnrollmentActionResultSchema,
  TailscaleEnrollmentStatusSchema,
  UPDATE_MAX_APK_BYTES
} from "@tablet-control/shared-types";
import type {
  ApprovedApp,
  AdapterMode,
  ApiResponse,
  CameraOrientation,
  CameraStatus,
  ControllerCapabilities,
  DiagnosticClearResult,
  DiagnosticSnapshot,
  DpcMaintenanceAction,
  DpcStatus,
  MediaItem,
  MediaMimeType,
  RemoteAuditEvent,
  RemoteControlStatus,
  RemoteKey,
  ScreenOrientation,
  ServerHealth,
  ServiceRestartTarget,
  SignedUpdateActionResult,
  SignedUpdateStatus,
  SignagePlaybackState,
  SignagePlaylist,
  SignagePlaylistUpdate,
  TailscaleEnrollmentActionResult,
  TailscaleEnrollmentStatus,
  TabletStatus,
  ControllerUpdateArtifact
} from "@tablet-control/shared-types";

export interface SessionData {
  username: string;
  csrfToken: string;
  expiresAt: number;
  mode: AdapterMode;
}

export interface ActionResult {
  simulated: boolean;
  message: string;
}

export interface VersionData {
  environment: string;
  adapterMode: AdapterMode;
  mock: boolean;
  gitCommit: string;
  apiBuild: string;
  webBuild: string;
  serviceWorker: string;
  buildTimestamp: string;
  companionVersion?: string;
  cameraAgentVersion?: string;
  kioskVersion?: string;
}

export interface LocationData {
  mode: string;
  hasFix: boolean;
  gpsEnabled?: boolean;
  networkEnabled?: boolean;
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number | null;
  lastFixTime?: number | null;
}

export interface SignedUpdateInstallResult {
  artifact: ControllerUpdateArtifact;
  controllerOrigin: string;
  originResult: SignedUpdateActionResult;
  requestResult: SignedUpdateActionResult;
}

function mediaMimeTypeForFile(file: File): MediaMimeType | undefined {
  if (
    file.type === "image/jpeg" ||
    file.type === "image/png" ||
    file.type === "image/webp" ||
    file.type === "video/mp4"
  ) {
    return file.type;
  }
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) return "image/jpeg";
  if (lowerName.endsWith(".png")) return "image/png";
  if (lowerName.endsWith(".webp")) return "image/webp";
  if (lowerName.endsWith(".mp4")) return "video/mp4";
  return undefined;
}

export class ControllerApiError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryAfter?: number
  ) {
    super(message);
    this.name = "ControllerApiError";
  }
}

export class ControllerApi {
  private csrfToken: string | undefined;

  public async session(): Promise<SessionData> {
    const session = await this.request<SessionData>("/api/v1/auth/session");
    this.csrfToken = session.csrfToken;
    return session;
  }

  public async login(username: string, password: string): Promise<SessionData> {
    const session = await this.request<SessionData>("/api/v1/auth/login", {
      method: "POST",
      body: { username, password },
      includeCsrf: false
    });
    this.csrfToken = session.csrfToken;
    return session;
  }

  public async logout(): Promise<void> {
    await this.request<{ loggedOut: boolean }>("/api/v1/auth/logout", {
      method: "POST"
    });
    this.csrfToken = undefined;
  }

  public async tabletStatus(): Promise<TabletStatus> {
    return this.request<TabletStatus>("/api/v1/tablet/status");
  }

  public async tabletHealth(): Promise<ServerHealth> {
    return this.request<ServerHealth>("/api/v1/tablet/health");
  }

  public async tabletDiagnostics(): Promise<DiagnosticSnapshot> {
    return this.request<DiagnosticSnapshot>("/api/v1/tablet/diagnostics");
  }

  public async clearTabletDiagnostics(): Promise<DiagnosticClearResult> {
    return this.mutate<DiagnosticClearResult>("/api/v1/tablet/diagnostics/clear", {});
  }

  public async remoteStatus(): Promise<RemoteControlStatus> {
    return this.request<RemoteControlStatus>("/api/v1/remote/status");
  }

  public async setRemoteEnabled(enabled: boolean): Promise<ActionResult> {
    return this.mutate("/api/v1/remote/enabled", { enabled });
  }

  public async remoteScreenshot(signal?: AbortSignal): Promise<Blob> {
    const headers = new Headers({ accept: "image/png" });
    if (this.csrfToken !== undefined) {
      headers.set("x-csrf-token", this.csrfToken);
    }
    const response = await fetch("/api/v1/remote/screenshot", {
      method: "POST",
      headers,
      credentials: "include",
      signal
    });
    if (!response.ok) {
      let payload: ApiResponse<never> | undefined;
      try {
        payload = (await response.json()) as ApiResponse<never>;
      } catch {
        payload = undefined;
      }
      if (payload !== undefined && !payload.ok) {
        throw new ControllerApiError(payload.error.code, payload.error.message);
      }
      throw new ControllerApiError(
        "MALFORMED_RESPONSE",
        "The controller could not capture the tablet screen."
      );
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("image/png")) {
      throw new ControllerApiError(
        "MALFORMED_RESPONSE",
        "The controller returned an unexpected screenshot format."
      );
    }
    const blob = await response.blob();
    if (blob.size <= 8 || blob.size > 16 * 1024 * 1024) {
      throw new ControllerApiError(
        "MALFORMED_RESPONSE",
        "The controller returned an invalid screenshot size."
      );
    }
    return blob;
  }

  public async remoteTap(x: number, y: number): Promise<ActionResult> {
    return this.mutate("/api/v1/remote/tap", { x, y });
  }

  public async remoteSwipe(input: {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    durationMs: number;
  }): Promise<ActionResult> {
    return this.mutate("/api/v1/remote/swipe", input);
  }

  public async remoteKey(key: RemoteKey): Promise<ActionResult> {
    return this.mutate("/api/v1/remote/key", { key });
  }

  public async remoteText(text: string): Promise<ActionResult> {
    return this.mutate("/api/v1/remote/text", { text });
  }

  public async closeApprovedApp(packageName: string): Promise<ActionResult> {
    return this.mutate("/api/v1/remote/close-app", { packageName });
  }

  public async remoteAudit(): Promise<RemoteAuditEvent[]> {
    return this.request<RemoteAuditEvent[]>("/api/v1/remote/audit");
  }

  public async cameraStatus(): Promise<CameraStatus> {
    return this.request<CameraStatus>("/api/v1/camera/status");
  }

  public async capabilities(): Promise<ControllerCapabilities> {
    return this.request<ControllerCapabilities>("/api/v1/capabilities");
  }

  public async getVersion(): Promise<VersionData> {
    return this.request<VersionData>("/api/v1/version");
  }

  public async selectCamera(camera: "front" | "rear"): Promise<ActionResult> {
    return this.mutate("/api/v1/camera/select", { camera });
  }

  public async setCameraOrientation(orientation: CameraOrientation): Promise<ActionResult> {
    return this.mutate("/api/v1/camera/orientation", { orientation });
  }

  public async setZoom(zoom: number): Promise<ActionResult> {
    return this.mutate("/api/v1/camera/zoom", { zoom });
  }

  public async setQuality(quality: number): Promise<ActionResult> {
    return this.mutate("/api/v1/camera/quality", { quality });
  }

  public async setFocus(mode: string): Promise<ActionResult> {
    return this.mutate("/api/v1/camera/focus", { mode });
  }

  public async triggerAutofocus(): Promise<ActionResult> {
    return this.mutate("/api/v1/camera/autofocus", {});
  }

  public async setFps(fps: 10 | 15 | 30): Promise<ActionResult> {
    return this.mutate("/api/v1/camera/fps", { fps });
  }

  public async setResolution(resolution: string): Promise<ActionResult> {
    return this.mutate("/api/v1/camera/resolution", { resolution });
  }

  public async setBrightness(brightness: number): Promise<ActionResult> {
    return this.mutate("/api/v1/device/brightness", { brightness });
  }

  public async setVolume(volume: number): Promise<ActionResult> {
    return this.mutate("/api/v1/device/volume", { volume });
  }

  public async setMuted(enabled: boolean): Promise<ActionResult> {
    return this.mutate("/api/v1/device/mute", { enabled });
  }

  public async setScreenOrientation(orientation: ScreenOrientation): Promise<ActionResult> {
    return this.mutate("/api/v1/device/orientation", { orientation });
  }

  public async setScreenOn(on: boolean): Promise<ActionResult> {
    return this.mutate("/api/v1/device/screen", { on });
  }

  public async setTouchLock(on: boolean): Promise<ActionResult> {
    return this.mutate("/api/v1/device/touch_lock", { on });
  }

  public async listApps(): Promise<ApprovedApp[]> {
    const apps = await this.request<ApprovedApp[]>("/api/v1/device/apps");
    return apps.filter((app) => app.status !== "technical");
  }

  public async listTechnicalApps(): Promise<{ packageName: string; label: string }[]> {
    return this.request<{ packageName: string; label: string }[]>("/api/v1/device/apps/technical");
  }

  public async approveApp(packageName: string): Promise<ActionResult> {
    return this.mutate("/api/v1/device/apps/approve", { packageName });
  }

  public async revokeApp(packageName: string): Promise<ActionResult> {
    return this.mutate("/api/v1/device/apps/revoke", { packageName });
  }

  public async launchApp(appId: string): Promise<ActionResult> {
    return this.mutate("/api/v1/device/apps/launch", { appId });
  }

  public async rebootDevice(): Promise<ActionResult> {
    return this.mutate("/api/v1/device/reboot", { confirm: true });
  }

  public async restartService(service: ServiceRestartTarget): Promise<ActionResult> {
    return this.mutate(`/api/v1/services/${service}/restart`, {});
  }

  public async controlMedia(action: "play-pause" | "next" | "previous"): Promise<ActionResult> {
    return this.mutate("/api/v1/device/media", { action });
  }

  public async showMessage(input: {
    text: string;
    textSize: "small" | "medium" | "large";
    background: "dark" | "light" | "accent";
    durationSeconds: number;
    restoreDashboard: boolean;
  }): Promise<ActionResult> {
    return this.mutate("/api/v1/display/message", input);
  }

  public async showLiveText(text: string): Promise<ActionResult> {
    return this.mutate("/api/v1/display/live-text", { text });
  }

  public async clearLiveText(): Promise<ActionResult> {
    return this.mutate("/api/v1/display/live-text/clear", {});
  }

  public async showWebpage(input: {
    url: string;
    durationSeconds: number;
    restoreDashboard: boolean;
  }): Promise<ActionResult> {
    return this.mutate("/api/v1/display/webpage", input);
  }

  public async showMedia(
    kind: "image" | "video",
    file: File,
    durationSeconds: number,
    restoreDashboard: boolean
  ): Promise<ActionResult> {
    const mimeType = mediaMimeTypeForFile(file);
    if (
      mimeType === undefined ||
      (kind === "image" && mimeType === "video/mp4") ||
      (kind === "video" && mimeType !== "video/mp4")
    ) {
      throw new ControllerApiError(
        "VALIDATION_ERROR",
        kind === "video" ? "Select an MP4 video." : "Select a JPEG, PNG, or WebP image."
      );
    }
    if (file.size <= 0 || file.size > MEDIA_MAX_FILE_BYTES) {
      throw new ControllerApiError("VALIDATION_ERROR", "Media files must be no larger than 50 MB.");
    }
    const item = await this.uploadMedia(file, Math.max(1, durationSeconds || 10));
    return this.mutate("/api/v1/display/media", {
      mediaId: item.id,
      durationSeconds,
      restoreDashboard
    });
  }

  public async showBlack(): Promise<ActionResult> {
    return this.mutate("/api/v1/display/black", {});
  }

  public async showClockOnly(): Promise<ActionResult> {
    return this.mutate("/api/v1/display/clock", {});
  }

  public async setClockColor(color: string): Promise<ActionResult> {
    return this.mutate("/api/v1/display/clock-color", { color });
  }

  public async restoreDashboard(): Promise<ActionResult> {
    return this.mutate("/api/v1/display/restore", {});
  }

  public async getSignagePlaylist(): Promise<SignagePlaylist> {
    return this.request<SignagePlaylist>("/api/v1/signage/playlist");
  }

  public async updateSignagePlaylist(data: SignagePlaylistUpdate): Promise<ActionResult> {
    await this.mutate<SignagePlaylist>("/api/v1/signage/playlist", data);
    return { simulated: false, message: "Signage playlist saved." };
  }

  public async uploadMedia(
    file: File,
    durationSeconds = 10,
    onProgress?: (percent: number) => void
  ): Promise<MediaItem> {
    const mimeType = mediaMimeTypeForFile(file);
    if (mimeType === undefined) {
      throw new ControllerApiError("VALIDATION_ERROR", "Select a JPEG, PNG, WebP, or MP4 file.");
    }
    if (file.size <= 0 || file.size > MEDIA_MAX_FILE_BYTES) {
      throw new ControllerApiError("VALIDATION_ERROR", "Media files must be no larger than 50 MB.");
    }

    const csrfToken = this.csrfToken;
    if (csrfToken === undefined) {
      throw new ControllerApiError(
        "UNAUTHENTICATED",
        "Sign in again before uploading signage media."
      );
    }

    const form = new FormData();
    form.append("durationSeconds", durationSeconds.toString());
    const uploadBody = file.type === mimeType ? file : new Blob([file], { type: mimeType });
    form.append("file", uploadBody, file.name);

    return new Promise<MediaItem>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("POST", "/api/v1/media/items");
      request.withCredentials = true;
      request.timeout = 300_000;
      request.setRequestHeader("accept", "application/json");
      request.setRequestHeader("x-csrf-token", csrfToken);
      request.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress?.(Math.min(99, Math.round((event.loaded / event.total) * 100)));
        }
      });
      request.addEventListener("load", () => {
        let payload: ApiResponse<MediaItem>;
        try {
          payload = JSON.parse(request.responseText) as ApiResponse<MediaItem>;
        } catch {
          reject(
            new ControllerApiError(
              "MALFORMED_RESPONSE",
              "The controller returned an invalid upload response."
            )
          );
          return;
        }

        if (typeof payload !== "object" || payload === null || typeof payload.ok !== "boolean") {
          reject(
            new ControllerApiError(
              "MALFORMED_RESPONSE",
              "The controller returned an unexpected upload response."
            )
          );
          return;
        }
        if (!payload.ok) {
          const retryAfterHeader = request.getResponseHeader("retry-after");
          reject(
            new ControllerApiError(
              payload.error.code,
              payload.error.message,
              retryAfterHeader === null ? undefined : Number.parseInt(retryAfterHeader, 10)
            )
          );
          return;
        }
        if (request.status < 200 || request.status >= 300) {
          reject(new ControllerApiError("HTTP_ERROR", "The controller rejected this upload."));
          return;
        }

        onProgress?.(100);
        resolve(payload.data);
      });
      request.addEventListener("error", () => {
        reject(
          new ControllerApiError(
            "NETWORK_ERROR",
            "The media upload could not reach the controller."
          )
        );
      });
      request.addEventListener("timeout", () => {
        reject(
          new ControllerApiError("NETWORK_ERROR", "The media upload timed out before it completed.")
        );
      });
      request.addEventListener("abort", () => {
        reject(new ControllerApiError("NETWORK_ERROR", "The media upload was cancelled."));
      });
      request.send(form);
    });
  }

  public async getSignagePlayback(): Promise<SignagePlaybackState | null> {
    return this.request<SignagePlaybackState | null>("/api/v1/signage/playback");
  }

  public async startSignage(): Promise<ActionResult> {
    return this.mutate("/api/v1/signage/start", {});
  }

  public async stopSignage(): Promise<ActionResult> {
    return this.mutate("/api/v1/signage/stop", {});
  }

  public async getLocation(): Promise<LocationData> {
    return this.request<LocationData>("/api/v1/location");
  }

  public async setLocationMode(mode: string): Promise<ActionResult> {
    return this.mutate("/api/v1/location/mode", { mode });
  }

  public async findSound(durationSeconds = 15): Promise<ActionResult> {
    return this.mutate("/api/v1/device/find/sound", { durationSeconds });
  }

  public async stopFindSound(): Promise<ActionResult> {
    return this.mutate("/api/v1/device/find/sound/stop", {});
  }

  public async getDpcStatus(): Promise<DpcStatus> {
    return this.request<DpcStatus>("/api/v1/dpc/status");
  }

  public async setMaintenanceMode(input: DpcMaintenanceAction): Promise<ActionResult> {
    return this.mutate("/api/v1/dpc/maintenance", input);
  }

  public async resetAdminPinRateLimit(): Promise<ActionResult> {
    return this.request("/api/v1/admin/pin/rate-limit/reset", { method: "POST" });
  }

  public async getSignedUpdateStatus(): Promise<SignedUpdateStatus> {
    const data = await this.request<unknown>("/api/v1/update/status");
    const parsed = SignedUpdateStatusSchema.safeParse(data);
    if (!parsed.success) {
      throw new ControllerApiError(
        "MALFORMED_RESPONSE",
        "The controller returned malformed signed-update status."
      );
    }
    return parsed.data;
  }

  public async getTailscaleEnrollmentStatus(): Promise<TailscaleEnrollmentStatus> {
    const data = await this.request<unknown>("/api/v1/tailscale/enrollment/status");
    const parsed = TailscaleEnrollmentStatusSchema.safeParse(data);
    if (!parsed.success) {
      throw new ControllerApiError(
        "MALFORMED_RESPONSE",
        "The controller returned malformed Tailscale enrollment status."
      );
    }
    return parsed.data;
  }

  public async enrollTailscale(
    authKey: string,
    timeoutSeconds: number
  ): Promise<TailscaleEnrollmentActionResult> {
    if (
      authKey.length < 32 ||
      authKey.length > 256 ||
      !/^tskey-auth-[A-Za-z0-9_-]+$/u.test(authKey) ||
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 30 ||
      timeoutSeconds > 300
    ) {
      throw new ControllerApiError(
        "VALIDATION_ERROR",
        "Enter a valid one-off Tailscale auth key and a timeout from 30 to 300 seconds."
      );
    }
    const data = await this.mutate<unknown>("/api/v1/tailscale/enrollment", {
      authKey,
      timeoutSeconds
    });
    const parsed = TailscaleEnrollmentActionResultSchema.safeParse(data);
    if (!parsed.success) {
      throw new ControllerApiError(
        "MALFORMED_RESPONSE",
        "The controller returned a malformed Tailscale enrollment result."
      );
    }
    return parsed.data;
  }

  public async uploadUpdateArtifact(
    file: File,
    onProgress?: (percent: number) => void
  ): Promise<ControllerUpdateArtifact> {
    if (!file.name.toLowerCase().endsWith(".apk")) {
      throw new ControllerApiError("VALIDATION_ERROR", "Select an Android APK file.");
    }
    if (file.size <= 0 || file.size > UPDATE_MAX_APK_BYTES) {
      throw new ControllerApiError(
        "VALIDATION_ERROR",
        "RoshanOS update APKs must be no larger than 128 MiB."
      );
    }

    const csrfToken = this.csrfToken;
    if (csrfToken === undefined) {
      throw new ControllerApiError(
        "UNAUTHENTICATED",
        "Sign in again before uploading a RoshanOS update."
      );
    }

    const form = new FormData();
    const uploadBody =
      file.type === "application/vnd.android.package-archive" ||
      file.type === "application/octet-stream"
        ? file
        : new Blob([file], { type: "application/vnd.android.package-archive" });
    form.append("file", uploadBody, file.name);

    return new Promise<ControllerUpdateArtifact>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("POST", "/api/v1/update/artifacts");
      request.withCredentials = true;
      request.timeout = 600_000;
      request.setRequestHeader("accept", "application/json");
      request.setRequestHeader("x-csrf-token", csrfToken);
      request.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress?.(Math.min(99, Math.round((event.loaded / event.total) * 100)));
        }
      });
      request.addEventListener("load", () => {
        let payload: ApiResponse<ControllerUpdateArtifact>;
        try {
          payload = JSON.parse(request.responseText) as ApiResponse<ControllerUpdateArtifact>;
        } catch {
          reject(
            new ControllerApiError(
              "MALFORMED_RESPONSE",
              "The controller returned an invalid update upload response."
            )
          );
          return;
        }

        if (typeof payload !== "object" || payload === null || typeof payload.ok !== "boolean") {
          reject(
            new ControllerApiError(
              "MALFORMED_RESPONSE",
              "The controller returned an unexpected update upload response."
            )
          );
          return;
        }
        if (!payload.ok) {
          const retryAfterHeader = request.getResponseHeader("retry-after");
          reject(
            new ControllerApiError(
              payload.error.code,
              payload.error.message,
              retryAfterHeader === null ? undefined : Number.parseInt(retryAfterHeader, 10)
            )
          );
          return;
        }
        if (request.status < 200 || request.status >= 300) {
          reject(
            new ControllerApiError("HTTP_ERROR", "The controller rejected this update upload.")
          );
          return;
        }

        onProgress?.(100);
        resolve(payload.data);
      });
      request.addEventListener("error", () => {
        reject(
          new ControllerApiError(
            "NETWORK_ERROR",
            "The update upload could not reach the controller."
          )
        );
      });
      request.addEventListener("timeout", () => {
        reject(
          new ControllerApiError(
            "NETWORK_ERROR",
            "The update upload timed out before it completed."
          )
        );
      });
      request.addEventListener("abort", () => {
        reject(new ControllerApiError("NETWORK_ERROR", "The update upload was cancelled."));
      });
      request.send(form);
    });
  }

  public async installUpdateArtifact(artifactId: string): Promise<SignedUpdateInstallResult> {
    if (artifactId.length === 0 || artifactId.length > 128) {
      throw new ControllerApiError(
        "VALIDATION_ERROR",
        "The update artifact identifier is invalid."
      );
    }
    return this.mutate<SignedUpdateInstallResult>(
      `/api/v1/update/artifacts/${encodeURIComponent(artifactId)}/install`,
      {}
    );
  }

  public async rollbackSignedUpdate(): Promise<SignedUpdateActionResult> {
    const data = await this.mutate<unknown>("/api/v1/update/rollback", { confirm: true });
    const parsed = SignedUpdateActionResultSchema.safeParse(data);
    if (!parsed.success) {
      throw new ControllerApiError(
        "MALFORMED_RESPONSE",
        "The controller returned a malformed signed-update rollback result."
      );
    }
    return parsed.data;
  }

  private async mutate<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "POST", body });
  }

  private async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      includeCsrf?: boolean;
    } = {}
  ): Promise<T> {
    const method = options.method ?? "GET";
    const headers = new Headers();

    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
    }

    if (method !== "GET" && options.includeCsrf !== false && this.csrfToken !== undefined) {
      headers.set("x-csrf-token", this.csrfToken);
    }

    const response = await fetch(path, {
      method,
      headers,
      credentials: "include",
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    let payload: ApiResponse<T>;
    try {
      payload = (await response.json()) as ApiResponse<T>;
    } catch {
      throw new ControllerApiError(
        "MALFORMED_RESPONSE",
        "The controller returned an invalid response. Reload the app and try again."
      );
    }

    if (typeof payload !== "object" || payload === null || typeof payload.ok !== "boolean") {
      throw new ControllerApiError(
        "MALFORMED_RESPONSE",
        "The controller returned an unexpected response. Reload the app and try again."
      );
    }

    if (!payload.ok) {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;
      throw new ControllerApiError(payload.error.code, payload.error.message, retryAfter);
    }

    if (!response.ok) {
      throw new ControllerApiError("HTTP_ERROR", "The controller rejected this request.");
    }

    return payload.data;
  }
}

export const controllerApi = new ControllerApi();

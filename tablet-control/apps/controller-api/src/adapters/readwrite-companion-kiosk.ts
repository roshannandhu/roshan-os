import type { AdapterActionResult, FullyKioskAdapter } from "@tablet-control/integration-contracts";
import {
  DpcStatusSchema,
  type DisplayMode,
  type DpcMaintenanceAction,
  type DpcStatus
} from "@tablet-control/shared-types";
import type { CompanionConfig } from "../config.js";
import { ApiProblem } from "../errors.js";

interface KioskStatus {
  installed: boolean;
  foreground: boolean;
  dashboardConfigured: boolean;
  displayMode: DisplayMode;
}

export class ReadWriteCompanionKioskAdapter implements FullyKioskAdapter {
  public constructor(private readonly config: CompanionConfig) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.config.secret}`
    };
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.config.requestTimeoutMs)
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${path}`, init);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new ApiProblem(
        502,
        timedOut ? "TIMEOUT" : "TABLET_OFFLINE",
        timedOut ? "Companion kiosk request timed out." : "Companion kiosk is unavailable.",
        true
      );
    }
    if (response.status === 401) {
      throw new ApiProblem(
        401,
        "UNAUTHENTICATED",
        "Companion kiosk rejected the authorization header.",
        false
      );
    }

    let payload: {
      ok: boolean;
      data?: T;
      error?: { code?: string; message?: string };
    };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "Companion kiosk returned malformed JSON.",
        true
      );
    }
    if (!response.ok || !payload.ok || payload.data === undefined) {
      throw new ApiProblem(
        response.status === 400 ? 400 : 502,
        response.status === 400 ? "VALIDATION_ERROR" : "INTERNAL_ERROR",
        payload.error?.message ?? "Companion kiosk request failed.",
        response.status >= 500
      );
    }
    return payload.data;
  }

  public async getDisplayMode(): Promise<DisplayMode> {
    const status = await this.call<KioskStatus>("GET", "/api/v1/companion/kiosk/status");
    return status.displayMode;
  }

  public async showMessage(text: string, durationSeconds = 5): Promise<AdapterActionResult> {
    return this.call("POST", "/api/v1/companion/kiosk/message", { text, durationSeconds });
  }

  public async showLiveText(text: string): Promise<AdapterActionResult> {
    return this.call("POST", "/api/v1/companion/kiosk/live-text", { text });
  }

  public async clearLiveText(): Promise<AdapterActionResult> {
    return this.call("POST", "/api/v1/companion/kiosk/clear-live-text");
  }

  public async showMedia(_kind: "image" | "video", fileName: string): Promise<AdapterActionResult> {
    const mediaUrl = `http://127.0.0.1:3001/media/${encodeURIComponent(fileName)}`;
    return this.showWebpage(mediaUrl);
  }

  public async showWebpage(url: string): Promise<AdapterActionResult> {
    return this.call("POST", "/api/v1/companion/kiosk/webpage", { url });
  }

  public async setDashboardStartUrl(url: string): Promise<AdapterActionResult> {
    return this.call("POST", "/api/v1/companion/kiosk/dashboard", { url });
  }

  public async showBlack(): Promise<AdapterActionResult> {
    return this.call("POST", "/api/v1/companion/kiosk/black");
  }

  public async restoreDashboard(): Promise<AdapterActionResult> {
    return this.call("POST", "/api/v1/companion/kiosk/restore");
  }

  public async getLocation(): Promise<unknown> {
    return this.call("GET", "/api/v1/companion/location");
  }

  public async setLocationMode(mode: string): Promise<AdapterActionResult> {
    return this.call("POST", "/api/v1/companion/location/mode", { mode });
  }

  public async findSound(durationSeconds = 15): Promise<AdapterActionResult> {
    return this.call("POST", "/api/v1/companion/device/find/sound", { durationSeconds });
  }

  public async stopFindSound(): Promise<AdapterActionResult> {
    return this.call("POST", "/api/v1/companion/device/find/sound/stop");
  }

  public async getDpcStatus(): Promise<DpcStatus> {
    const data = await this.call<unknown>("GET", "/api/v1/companion/dpc/status");
    const parsed = DpcStatusSchema.safeParse(data);
    if (!parsed.success) {
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "Companion returned malformed Device Owner status.",
        true
      );
    }
    return parsed.data;
  }

  public async setMaintenanceMode(input: DpcMaintenanceAction): Promise<AdapterActionResult> {
    return this.call("POST", "/api/v1/companion/dpc/maintenance", input);
  }
}

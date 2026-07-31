import type { AdapterActionResult, FullyKioskAdapter } from "@tablet-control/integration-contracts";
import type { DisplayMode, DpcMaintenanceAction, DpcStatus } from "@tablet-control/shared-types";
import type { FullyKioskConfig } from "../config.js";
import { ApiProblem } from "../errors.js";

export class ReadWriteFullyKioskAdapter implements FullyKioskAdapter {
  private displayMode: DisplayMode = "dashboard";

  public constructor(private readonly config: FullyKioskConfig) {}

  private async call(cmd: string, extra: Record<string, string> = {}): Promise<void> {
    const url = new URL("/", this.config.baseUrl);
    url.searchParams.set("cmd", cmd);
    url.searchParams.set("type", "json");
    url.searchParams.set("password", this.config.adminPassword);
    for (const [k, v] of Object.entries(extra)) {
      url.searchParams.set(k, v);
    }

    const response = await fetch(url, {
      signal: AbortSignal.timeout(this.config.requestTimeoutMs)
    });

    if (!response.ok) {
      throw new ApiProblem(
        502,
        "INTERNAL_ERROR",
        `Fully Remote Admin returned ${response.status.toString()} for cmd=${cmd}`,
        true
      );
    }

    const body = (await response.json()) as { status: string; statustext?: string };
    if (body.status !== "OK") {
      throw new ApiProblem(
        502,
        "INTERNAL_ERROR",
        `Fully Remote Admin error: ${body.statustext ?? cmd}`,
        true
      );
    }
  }

  public async getDisplayMode(): Promise<DisplayMode> {
    return this.displayMode;
  }

  public async showMessage(text: string, _durationSeconds?: number): Promise<AdapterActionResult> {
    await this.call("showToast", { text });
    this.displayMode = "message";
    return { simulated: true, message: "Toast displayed on tablet." };
  }

  public async showLiveText(_text: string): Promise<AdapterActionResult> {
    throw new ApiProblem(
      501,
      "UNSUPPORTED",
      "Live text is available only through Wall Tablet Companion.",
      false
    );
  }

  public async clearLiveText(): Promise<AdapterActionResult> {
    throw new ApiProblem(
      501,
      "UNSUPPORTED",
      "Live text is available only through Wall Tablet Companion.",
      false
    );
  }

  public async showMedia(
    _kind: "image" | "video",
    _fileName: string
  ): Promise<AdapterActionResult> {
    throw new ApiProblem(
      501,
      "UNSUPPORTED",
      "showMedia requires a controller-served media endpoint (Phase 6).",
      false
    );
  }

  public async showWebpage(url: string): Promise<AdapterActionResult> {
    await this.call("loadURL", { url });
    this.displayMode = "webpage";
    return { simulated: true, message: "Fully loaded URL." };
  }

  public async setDashboardStartUrl(url: string): Promise<AdapterActionResult> {
    await this.call("setStringSetting", { key: "startURL", value: url });
    await this.call("loadStartURL");
    this.displayMode = "dashboard";
    return { simulated: true, message: "Fully dashboard URL was updated and loaded." };
  }

  public async showBlack(): Promise<AdapterActionResult> {
    await this.call("loadURL", { url: "file:///sdcard/black.html" });
    this.displayMode = "black";
    return { simulated: true, message: "Fully loaded black page." };
  }

  public async restoreDashboard(): Promise<AdapterActionResult> {
    await this.call("loadStartURL");
    this.displayMode = "dashboard";
    return { simulated: true, message: "Fully reloaded start URL." };
  }

  public async getDpcStatus(): Promise<DpcStatus> {
    return {
      deviceOwner: false,
      maintenance: {
        active: false,
        expiresAt: 0,
        remainingSeconds: 0
      }
    };
  }

  public async setMaintenanceMode(_input: DpcMaintenanceAction): Promise<AdapterActionResult> {
    throw new ApiProblem(
      501,
      "UNSUPPORTED",
      "Protected maintenance requires RoshanCore Companion mode.",
      false
    );
  }
}

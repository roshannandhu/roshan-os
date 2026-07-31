import type { AdapterActionResult } from "@tablet-control/integration-contracts";
import type { CameraName, CameraOrientation } from "@tablet-control/shared-types";
import { ApiProblem } from "../errors.js";
import { ReadOnlyIpWebcamAdapter } from "./readonly-ip-webcam.js";

export class ReadWriteIpWebcamAdapter extends ReadOnlyIpWebcamAdapter {
  private nextCameraSwitchAt = 0;

  public async selectCamera(camera: CameraName): Promise<AdapterActionResult> {
    const settleDelayMs = this.nextCameraSwitchAt - Date.now();
    if (settleDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, settleDelayMs));
    }

    const expectedFfc = camera === "front" ? "on" : "off";
    const current = await this.getStatus();
    if (current.activeCamera === camera) {
      return { simulated: false, message: `Camera is already set to ${camera}.` };
    }

    try {
      await super.selectCamera(camera);
    } catch {
      await this.sendControlGet(`/settings/ffc?set=${expectedFfc}`);
    }

    this.nextCameraSwitchAt = Date.now() + 2_000;

    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      try {
        const polled = await this.getStatus();
        if (polled.activeCamera === camera) {
          return { simulated: false, message: `Camera switched to ${camera}.` };
        }
      } catch {
        // Camera provider is re-initializing
      }
    }

    return { simulated: false, message: `Camera switched to ${camera}.` };
  }

  public async setOrientation(orientation: CameraOrientation): Promise<AdapterActionResult> {
    await this.sendControlGet(`/settings/orientation?set=${encodeURIComponent(orientation)}`);
    const confirmed = await this.getStatus();
    if (confirmed.orientation !== orientation) {
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "IP Webcam did not confirm the requested camera orientation.",
        true
      );
    }
    return { simulated: false, message: `Camera orientation set to ${orientation}.` };
  }

  public async setZoom(zoom: number): Promise<AdapterActionResult> {
    await this.requireAdvancedControlSupport();
    // zoom is a multiplier (1.0–4.0); convert to avail.zoom index
    // avail.zoom = [100, 103, 106, …, 400] — steps of 3
    const zoomPercent = Math.max(100, Math.min(400, Math.round(zoom * 100)));
    const index = Math.round((zoomPercent - 100) / 3);
    await this.sendControlPost(`/ptz?zoom=${index}`);
    return { simulated: false, message: `Camera zoom set to ${zoom.toFixed(1)}×.` };
  }

  public async setFocus(mode: string): Promise<AdapterActionResult> {
    await this.requireAdvancedControlSupport();
    await this.sendControlGet(`/settings/focusmode?set=${encodeURIComponent(mode)}`);
    return { simulated: false, message: `Focus mode set to ${mode}.` };
  }

  public async triggerAutofocus(): Promise<AdapterActionResult> {
    await this.requireAdvancedControlSupport();
    await this.sendControlPost("/focus");
    return { simulated: false, message: "Autofocus triggered." };
  }

  public async setFps(fps: number): Promise<AdapterActionResult> {
    await this.requireAdvancedControlSupport();
    // frame_duration is nanoseconds; IP Webcam uses integer nanosecond values
    const ns = Math.round(1e9 / fps);
    await this.sendControlPost(`/settings/frame_duration?set=${ns}`);
    return { simulated: false, message: `Camera FPS set to ${fps}.` };
  }

  public async setResolution(resolution: string): Promise<AdapterActionResult> {
    await this.requireAdvancedControlSupport();
    await this.sendControlGet(`/settings/video_size?set=${encodeURIComponent(resolution)}`);
    return { simulated: false, message: `Camera resolution set to ${resolution}.` };
  }

  public async setQuality(quality: number): Promise<AdapterActionResult> {
    await this.requireAdvancedControlSupport();
    await this.sendControlPost(`/settings/quality?set=${quality}`);
    return { simulated: false, message: `Camera quality set to ${quality}%.` };
  }

  private async sendControlGet(path: string): Promise<void> {
    const { response, controller } = await this.getResponse(path, "*/*");
    // Drain the short "ok" text body and release the connection
    await response.text().catch(() => undefined);
    controller.abort();
    if (!response.ok) {
      if (response.status === 500 || response.status === 400) {
        throw new ApiProblem(
          400,
          "UNSUPPORTED",
          "IP Webcam does not support this setting combination.",
          false
        );
      }
      throw new ApiProblem(502, "CAMERA_OFFLINE", "IP Webcam rejected the control command.", true);
    }
  }

  private async requireAdvancedControlSupport(): Promise<void> {
    const status = await this.getStatus();
    if (!status.healthy) {
      throw new ApiProblem(
        502,
        "CAMERA_OFFLINE",
        "IP Webcam is not ready for a camera control.",
        true
      );
    }
    if (status.activeCamera === "front") {
      throw new ApiProblem(
        422,
        "UNSUPPORTED",
        "Front-camera advanced controls are disabled until its safe profile is fully verified.",
        false
      );
    }
  }

  private async sendControlPost(path: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    const headers: Record<string, string> = { accept: "*/*" };
    const authHeader = this.basicAuthHeader();
    if (authHeader !== undefined) {
      headers["authorization"] = authHeader;
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(new URL(path, this.config.baseUrl), {
        method: "POST",
        headers,
        redirect: "error",
        signal: controller.signal
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ApiProblem(504, "TIMEOUT", "IP Webcam did not respond before the timeout.", true);
      }
      throw new ApiProblem(
        502,
        "CAMERA_OFFLINE",
        "IP Webcam could not be reached by the local controller.",
        true
      );
    } finally {
      clearTimeout(timeout);
    }

    controller.abort();

    if (response.status === 401 || response.status === 403) {
      throw new ApiProblem(
        401,
        "UNAUTHENTICATED",
        "IP Webcam rejected the control command credentials.",
        false
      );
    }

    if (!response.ok) {
      if (response.status === 500 || response.status === 400) {
        throw new ApiProblem(
          400,
          "UNSUPPORTED",
          "IP Webcam does not support this setting combination.",
          false
        );
      }
      throw new ApiProblem(502, "CAMERA_OFFLINE", "IP Webcam rejected the control command.", true);
    }
  }
}

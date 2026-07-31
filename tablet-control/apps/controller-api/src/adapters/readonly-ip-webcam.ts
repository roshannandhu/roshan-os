import type {
  AdapterActionResult,
  IpWebcamAdapter,
  ReadOnlyStreamConnection
} from "@tablet-control/integration-contracts";
import {
  CameraStatusSchema,
  type CameraName,
  type CameraOrientation,
  type CameraStatus,
  type StreamKind
} from "@tablet-control/shared-types";
import type { IpWebcamReadOnlyConfig } from "../config.js";
import { ApiProblem } from "../errors.js";

import { Buffer } from "node:buffer";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableBoundedNumber(
  value: unknown,
  min: number,
  max: number,
  integer = false
): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < min ||
    parsed > max ||
    (integer && !Number.isInteger(parsed))
  ) {
    return null;
  }

  return parsed;
}

const FOCUS_MODES = ["off", "auto", "macro", "continuous-video", "continuous-picture"] as const;
type FocusMode = (typeof FOCUS_MODES)[number];

function nullableFocusMode(value: unknown): FocusMode | null {
  return (FOCUS_MODES as readonly unknown[]).includes(value) ? (value as FocusMode) : null;
}

export class ReadOnlyIpWebcamAdapter implements IpWebcamAdapter {
  public constructor(
    protected readonly config: IpWebcamReadOnlyConfig,
    protected readonly fetchImplementation: typeof fetch = fetch
  ) {}

  public async getStatus(): Promise<CameraStatus> {
    const { response, controller, connectionLatencyMs } = await this.getResponse(
      "/status.json?show_avail=1",
      "application/json"
    );
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      controller.abort();
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "IP Webcam returned an unexpected status response.",
        true
      );
    }

    let payload: unknown;
    try {
      payload = await this.readBoundedJson(response, controller);
    } catch (error) {
      if (error instanceof ApiProblem) throw error;
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "IP Webcam returned malformed status JSON.",
        true
      );
    }

    if (!isRecord(payload)) {
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "IP Webcam status JSON has an unexpected shape.",
        true
      );
    }

    if (typeof payload.lensFacing === "string") {
      return CameraStatusSchema.parse({
        mode: "real-readonly",
        healthy: payload.status === "healthy",
        activeCamera: payload.lensFacing === "front" ? "front" : "rear",
        orientation: "landscape",
        listeningEnabled: true,
        zoom: typeof payload.zoomRatio === "number" ? payload.zoomRatio : 1.0,
        quality: 85,
        resolution: "1920x1080",
        fps: 30,
        focusMode: "auto",
        hasTorch: false,
        transport: this.config.transport,
        lastStatusLatencyMs: connectionLatencyMs
      });
    }

    const currentValues = isRecord(payload.curvals) ? payload.curvals : {};
    // IP Webcam reports zoom as a percent string ("100" = 1.0×, "400" = 4.0×)
    const zoomPercent = Number(currentValues.zoom);
    const zoomMultiplier =
      Number.isFinite(zoomPercent) && zoomPercent >= 100 && zoomPercent <= 400
        ? zoomPercent / 100
        : null;
    // frame_duration is nanoseconds; convert to whole FPS
    const frameDuration = Number(currentValues.frame_duration);
    const fps =
      Number.isFinite(frameDuration) && frameDuration > 0 ? Math.round(1e9 / frameDuration) : null;
    return CameraStatusSchema.parse({
      mode: "real-readonly",
      healthy: true,
      activeCamera:
        typeof currentValues.ffc === "string"
          ? currentValues.ffc === "off"
            ? "rear"
            : "front"
          : null,
      orientation:
        currentValues.orientation === "landscape" ||
        currentValues.orientation === "portrait" ||
        currentValues.orientation === "upsidedown" ||
        currentValues.orientation === "upsidedown_portrait"
          ? currentValues.orientation
          : null,
      listeningEnabled: null,
      zoom: zoomMultiplier,
      quality: nullableBoundedNumber(currentValues.quality, 1, 100, true),
      resolution: typeof currentValues.video_size === "string" ? currentValues.video_size : null,
      fps,
      focusMode: nullableFocusMode(currentValues.focusmode),
      hasTorch: false,
      transport: this.config.transport,
      lastStatusLatencyMs: connectionLatencyMs
    });
  }

  public async openReadOnlyStream(kind: StreamKind): Promise<ReadOnlyStreamConnection> {
    const endpoint = kind === "video" ? "/video" : "/audio.wav";
    const accept = kind === "video" ? "multipart/x-mixed-replace,image/*" : "audio/wav,audio/*";
    const { response, controller, connectionLatencyMs } = await this.getResponse(endpoint, accept);
    if (response.body === null) {
      controller.abort();
      throw new ApiProblem(
        502,
        "STREAM_FAILURE",
        "IP Webcam opened an empty stream response.",
        true
      );
    }

    const ct = response.headers.get("content-type") ?? "";
    const expectedFragment = kind === "video" ? "multipart/x-mixed-replace" : "audio/";
    if (!ct.includes(expectedFragment)) {
      controller.abort();
      throw new ApiProblem(
        502,
        "STREAM_FAILURE",
        `IP Webcam returned an unexpected content type for the ${kind} stream.`,
        true
      );
    }

    return {
      diagnostics: {
        mode: "real-readonly",
        kind,
        contentType: response.headers.get("content-type"),
        connectionLatencyMs,
        transport: this.config.transport,
        maxReconnectAttempts: this.config.maxReconnectAttempts,
        readOnly: true
      },
      body: response.body,
      cancel() {
        controller.abort();
      }
    };
  }

  public async getSnapshot(): Promise<Uint8Array> {
    const { response, controller } = await this.getResponse("/shot.jpg", "image/jpeg");
    const ct = response.headers.get("content-type") ?? "";
    if (!ct.includes("image/jpeg") && !ct.includes("image/jpg")) {
      controller.abort();
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "IP Webcam returned an unexpected content type for the snapshot.",
        true
      );
    }
    return this.readBoundedBytes(response, controller, 2_097_152);
  }

  public async triggerAutofocus(): Promise<AdapterActionResult> {
    return this.blockMutation();
  }

  protected async postJson(endpoint: string, body: unknown): Promise<unknown> {
    const url = new URL(endpoint, this.config.baseUrl).toString();
    const headers: Record<string, string> = { "content-type": "application/json" };
    const authHeader = this.basicAuthHeader();
    if (authHeader !== undefined) {
      headers["authorization"] = authHeader;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await this.fetchImplementation(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!response.ok) {
        throw new ApiProblem(
          502,
          "STREAM_FAILURE",
          `Camera command failed: HTTP ${response.status}`,
          true
        );
      }
      return await response.json();
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof ApiProblem) throw error;
      throw new ApiProblem(
        502,
        "CAMERA_OFFLINE",
        `Camera agent request failed: ${error instanceof Error ? error.message : String(error)}`,
        true
      );
    }
  }

  public async selectCamera(camera: CameraName): Promise<AdapterActionResult> {
    await this.postJson("/select", { camera });
    return { simulated: false, message: `Switched camera to ${camera}` };
  }

  public async setOrientation(_orientation: CameraOrientation): Promise<AdapterActionResult> {
    return this.blockMutation();
  }

  public async setZoom(_zoom: number): Promise<AdapterActionResult> {
    return this.blockMutation();
  }

  public async setFocus(_mode: string): Promise<AdapterActionResult> {
    return this.blockMutation();
  }

  public async setFps(_fps: number): Promise<AdapterActionResult> {
    return this.blockMutation();
  }

  public async setResolution(_resolution: string): Promise<AdapterActionResult> {
    return this.blockMutation();
  }

  public async setQuality(_quality: number): Promise<AdapterActionResult> {
    return this.blockMutation();
  }

  public async setTorch(_enabled: boolean): Promise<AdapterActionResult> {
    return this.blockMutation();
  }

  private async blockMutation(): Promise<AdapterActionResult> {
    throw new ApiProblem(
      409,
      "ACTION_REQUIRES_APPROVAL",
      "Real read-only mode never sends an IP Webcam control request.",
      false
    );
  }

  protected async readBoundedBytes(
    response: Response,
    controller: AbortController,
    maxBytes: number
  ): Promise<Uint8Array> {
    const body = response.body;
    if (body === null) {
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "IP Webcam returned an empty response body.",
        true
      );
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    const bodyTimer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      while (true) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            throw new ApiProblem(504, "TIMEOUT", "IP Webcam response body timed out.", true);
          }
          throw new ApiProblem(
            502,
            "MALFORMED_RESPONSE",
            "IP Webcam response body read failed.",
            true
          );
        }
        if (result.done) break;
        totalSize += result.value.length;
        if (totalSize > maxBytes) {
          throw new ApiProblem(
            502,
            "MALFORMED_RESPONSE",
            "IP Webcam response exceeded the size limit.",
            true
          );
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

  protected async readBoundedJson(
    response: Response,
    controller: AbortController
  ): Promise<unknown> {
    const body = response.body;
    if (body === null) {
      throw new ApiProblem(
        502,
        "MALFORMED_RESPONSE",
        "IP Webcam returned an empty status body.",
        true
      );
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";
    // ponytail: 64KB cap — IP Webcam status JSON is ~3KB; raise if IP Webcam version grows payload
    const maxBytes = 65_536;
    const bodyTimer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      while (true) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            throw new ApiProblem(
              502,
              "MALFORMED_RESPONSE",
              "IP Webcam status body timed out before valid JSON arrived.",
              true
            );
          }
          throw new ApiProblem(
            502,
            "MALFORMED_RESPONSE",
            "IP Webcam status body read failed.",
            true
          );
        }

        if (!result.done) {
          accumulated += decoder.decode(result.value, { stream: true });
          if (accumulated.length > maxBytes) {
            throw new ApiProblem(
              502,
              "MALFORMED_RESPONSE",
              "IP Webcam status body exceeded size limit.",
              true
            );
          }
        }

        try {
          return JSON.parse(accumulated);
        } catch {
          // not complete JSON yet — keep reading
        }

        if (result.done) {
          throw new ApiProblem(
            502,
            "MALFORMED_RESPONSE",
            "IP Webcam returned malformed status JSON.",
            true
          );
        }
      }
    } finally {
      clearTimeout(bodyTimer);
      controller.abort();
      reader.cancel().catch(() => {});
    }
  }

  protected basicAuthHeader(): string | undefined {
    if (!this.config.credentials) {
      return undefined;
    }
    const encoded = Buffer.from(
      `${this.config.credentials.username}:${this.config.credentials.password}`
    ).toString("base64");
    return `Basic ${encoded}`;
  }

  protected async getResponse(
    path: string,
    accept: string
  ): Promise<{ response: Response; controller: AbortController; connectionLatencyMs: number }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    const startedAt = performance.now();

    const headers: Record<string, string> = { accept };
    const authHeader = this.basicAuthHeader();
    if (authHeader !== undefined) {
      headers["authorization"] = authHeader;
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(new URL(path, this.config.baseUrl), {
        method: "GET",
        headers,
        redirect: "error",
        signal: controller.signal
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ApiProblem(
          504,
          "TIMEOUT",
          "IP Webcam did not respond before the read-only timeout.",
          true
        );
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

    if (response.status === 401 || response.status === 403) {
      controller.abort();
      throw new ApiProblem(
        401,
        "UNAUTHENTICATED",
        this.config.credentials
          ? "IP Webcam rejected the request. Check that the credentials match what was entered in IP Webcam."
          : "IP Webcam requires authentication. Run the credential setup and restart the controller.",
        false
      );
    }

    if (!response.ok) {
      controller.abort();
      throw new ApiProblem(
        502,
        "CAMERA_OFFLINE",
        "IP Webcam returned an unsuccessful read-only response.",
        true
      );
    }

    return {
      response,
      controller,
      connectionLatencyMs: Math.round(performance.now() - startedAt)
    };
  }
}

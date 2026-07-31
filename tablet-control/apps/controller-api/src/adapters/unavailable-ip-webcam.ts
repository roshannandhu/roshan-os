import type {
  AdapterActionResult,
  IpWebcamAdapter,
  ReadOnlyStreamConnection
} from "@tablet-control/integration-contracts";
import type {
  CameraName,
  CameraOrientation,
  CameraStatus,
  StreamKind,
  Transport
} from "@tablet-control/shared-types";
import { ApiProblem } from "../errors.js";

export class UnavailableIpWebcamAdapter implements IpWebcamAdapter {
  public constructor(private readonly transport: Exclude<Transport, "mock"> = "trusted-lan") {}

  public async getStatus(): Promise<CameraStatus> {
    return {
      mode: "companion",
      healthy: false,
      activeCamera: null,
      orientation: null,
      listeningEnabled: null,
      zoom: null,
      quality: null,
      resolution: null,
      fps: null,
      focusMode: null,
      hasTorch: false,
      transport: this.transport,
      lastStatusLatencyMs: null
    };
  }

  private unavailable(): never {
    throw new ApiProblem(
      501,
      "NOT_CONFIGURED",
      "The optional IP Webcam fallback is not configured. RoshanCore camera remains available.",
      false
    );
  }

  public async openReadOnlyStream(_kind: StreamKind): Promise<ReadOnlyStreamConnection> {
    return this.unavailable();
  }

  public async getSnapshot(): Promise<Uint8Array> {
    return this.unavailable();
  }

  public async selectCamera(_camera: CameraName): Promise<AdapterActionResult> {
    return this.unavailable();
  }

  public async setOrientation(_orientation: CameraOrientation): Promise<AdapterActionResult> {
    return this.unavailable();
  }

  public async setZoom(_zoom: number): Promise<AdapterActionResult> {
    return this.unavailable();
  }

  public async setFocus(_mode: string): Promise<AdapterActionResult> {
    return this.unavailable();
  }

  public async triggerAutofocus(): Promise<AdapterActionResult> {
    return this.unavailable();
  }

  public async setFps(_fps: number): Promise<AdapterActionResult> {
    return this.unavailable();
  }

  public async setResolution(_resolution: string): Promise<AdapterActionResult> {
    return this.unavailable();
  }

  public async setQuality(_quality: number): Promise<AdapterActionResult> {
    return this.unavailable();
  }

  public async setTorch(_enabled: boolean): Promise<AdapterActionResult> {
    return this.unavailable();
  }
}

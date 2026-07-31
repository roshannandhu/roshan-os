import type { TabletAdapters } from "@tablet-control/integration-contracts";
import type { AppConfig } from "../config.js";
import { createMockAdapters } from "./mock.js";
import { ReadWriteCompanionAdapter } from "./readwrite-companion.js";
import { ReadWriteCompanionKioskAdapter } from "./readwrite-companion-kiosk.js";
import { ReadWriteIpWebcamAdapter } from "./readwrite-ip-webcam.js";
import { UnavailableIpWebcamAdapter } from "./unavailable-ip-webcam.js";

export function createAdapters(config: AppConfig): TabletAdapters {
  if (config.adapterMode === "mock") {
    return createMockAdapters();
  }

  if (config.adapterMode === "companion" && config.companion === undefined) {
    throw new Error("Companion adapter mode requires Companion configuration.");
  }

  if (config.adapterMode === "real-readonly") {
    if (config.ipWebcam === undefined) {
      throw new Error("Real read-only adapter mode requires IP Webcam configuration.");
    }
    const mocks = createMockAdapters();
    return { ...mocks, ipWebcam: new ReadWriteIpWebcamAdapter(config.ipWebcam) };
  }

  const companion = config.companion;
  if (companion === undefined) {
    throw new Error("Companion adapter mode requires Companion configuration.");
  }

  return {
    ipWebcam:
      config.ipWebcam === undefined
        ? new UnavailableIpWebcamAdapter(companion.transport ?? "trusted-lan")
        : new ReadWriteIpWebcamAdapter(config.ipWebcam),
    fullyKiosk: new ReadWriteCompanionKioskAdapter(companion),
    companion: new ReadWriteCompanionAdapter(companion)
  };
}

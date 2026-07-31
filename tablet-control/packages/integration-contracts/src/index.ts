import type {
  ApprovedApp,
  CameraOrientation,
  CameraName,
  CameraStatus,
  DisplayMode,
  DiagnosticClearResult,
  DiagnosticSnapshot,
  DpcMaintenanceAction,
  DpcStatus,
  RemoteAuditEvent,
  RemoteControlStatus,
  RemoteKey,
  ScreenOrientation,
  ServerHealth,
  ServiceRestartTarget,
  SignedUpdateActionResult,
  SignedUpdateStatus,
  StreamDiagnostics,
  StreamKind,
  TailscaleEnrollmentActionResult,
  TailscaleEnrollmentStatus,
  TabletStatus
} from "@tablet-control/shared-types";

export interface AdapterActionResult {
  simulated: boolean;
  message: string;
}

export interface IpWebcamAdapter {
  getStatus(): Promise<CameraStatus>;
  openReadOnlyStream(kind: StreamKind): Promise<ReadOnlyStreamConnection>;
  getSnapshot(): Promise<Uint8Array>;
  selectCamera(camera: CameraName): Promise<AdapterActionResult>;
  setOrientation(orientation: CameraOrientation): Promise<AdapterActionResult>;
  setZoom(zoom: number): Promise<AdapterActionResult>;
  setFocus(mode: string): Promise<AdapterActionResult>;
  triggerAutofocus(): Promise<AdapterActionResult>;
  setFps(fps: number): Promise<AdapterActionResult>;
  setResolution(resolution: string): Promise<AdapterActionResult>;
  setQuality(quality: number): Promise<AdapterActionResult>;
  setTorch(enabled: boolean): Promise<AdapterActionResult>;
}

export interface ReadOnlyStreamConnection {
  diagnostics: StreamDiagnostics;
  body: ReadableStream<Uint8Array>;
  cancel(): void;
}

export interface FullyKioskAdapter {
  getDisplayMode(): Promise<DisplayMode>;
  showMessage(text: string, durationSeconds?: number): Promise<AdapterActionResult>;
  showLiveText(text: string): Promise<AdapterActionResult>;
  clearLiveText(): Promise<AdapterActionResult>;
  showMedia(kind: "image" | "video", fileName: string): Promise<AdapterActionResult>;
  showWebpage(url: string): Promise<AdapterActionResult>;
  setDashboardStartUrl(url: string): Promise<AdapterActionResult>;
  showBlack(): Promise<AdapterActionResult>;
  restoreDashboard(): Promise<AdapterActionResult>;
  getLocation?(): Promise<unknown>;
  setLocationMode?(mode: string): Promise<AdapterActionResult>;
  findSound?(durationSeconds?: number): Promise<AdapterActionResult>;
  stopFindSound?(): Promise<AdapterActionResult>;
  getDpcStatus(): Promise<DpcStatus>;
  setMaintenanceMode(input: DpcMaintenanceAction): Promise<AdapterActionResult>;
}

export interface CompanionAdapter {
  getStatus(): Promise<TabletStatus>;
  setBrightness(value: number): Promise<AdapterActionResult>;
  setVolume(value: number): Promise<AdapterActionResult>;
  setMuted(muted: boolean): Promise<AdapterActionResult>;
  setScreenOrientation(orientation: ScreenOrientation): Promise<AdapterActionResult>;
  setScreenOn(on: boolean): Promise<AdapterActionResult>;
  setTouchLock(on: boolean): Promise<AdapterActionResult>;
  listApps(): Promise<ApprovedApp[]>;
  listTechnicalApps(): Promise<{ packageName: string; label: string }[]>;
  approveApp(packageName: string): Promise<AdapterActionResult>;
  revokeApp(packageName: string): Promise<AdapterActionResult>;
  launchApp(appId: string): Promise<AdapterActionResult>;
  rebootDevice(): Promise<AdapterActionResult>;
  restartService(service: ServiceRestartTarget): Promise<AdapterActionResult>;
  resetAdminPinRateLimit(): Promise<AdapterActionResult>;
  restoreDashboard(): Promise<AdapterActionResult>;
  showClockOnly(): Promise<AdapterActionResult>;
  setClockColor(color: string): Promise<AdapterActionResult>;
  showWebpage(url: string): Promise<AdapterActionResult>;
  controlMedia(action: "play-pause" | "next" | "previous"): Promise<AdapterActionResult>;
  findSound(durationSeconds?: number): Promise<AdapterActionResult>;
  stopFindSound(): Promise<AdapterActionResult>;
  beginTalk(): Promise<AdapterActionResult>;
  endTalk(): Promise<AdapterActionResult>;
  sendAudioFrame(data: Uint8Array): Promise<void>;
  getServerHealth(): Promise<ServerHealth>;
  getDiagnostics(): Promise<DiagnosticSnapshot>;
  clearDiagnostics(): Promise<DiagnosticClearResult>;
  getRemoteStatus(): Promise<RemoteControlStatus>;
  setRemoteEnabled(enabled: boolean): Promise<AdapterActionResult>;
  getRemoteScreenshot(): Promise<Uint8Array>;
  remoteTap(x: number, y: number): Promise<AdapterActionResult>;
  remoteSwipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    durationMs: number
  ): Promise<AdapterActionResult>;
  remoteKey(key: RemoteKey): Promise<AdapterActionResult>;
  remoteText(text: string): Promise<AdapterActionResult>;
  closeApprovedApp(packageName: string): Promise<AdapterActionResult>;
  getRemoteAudit(): Promise<RemoteAuditEvent[]>;
  getCameraStatus(): Promise<CameraStatus>;
  openCameraStream(kind: StreamKind): Promise<ReadOnlyStreamConnection>;
  getCameraSnapshot(): Promise<Uint8Array>;
  selectCamera(camera: CameraName): Promise<AdapterActionResult>;
  configureUpdateControllerOrigin(origin: string): Promise<SignedUpdateActionResult>;
  requestUpdate(url: string, sha256: string): Promise<SignedUpdateActionResult>;
  getUpdateStatus(): Promise<SignedUpdateStatus>;
  requestUpdateRollback(): Promise<SignedUpdateActionResult>;
  enrollTailscale(
    authKey: string,
    timeoutSeconds: number
  ): Promise<TailscaleEnrollmentActionResult>;
  getTailscaleEnrollmentStatus(): Promise<TailscaleEnrollmentStatus>;
}

export interface TabletAdapters {
  ipWebcam: IpWebcamAdapter;
  fullyKiosk: FullyKioskAdapter;
  companion: CompanionAdapter;
}

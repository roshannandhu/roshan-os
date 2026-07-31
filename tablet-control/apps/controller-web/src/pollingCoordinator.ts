import type {
  ApprovedApp,
  CameraStatus,
  ControllerCapabilities,
  ServerHealth,
  TabletStatus
} from "@tablet-control/shared-types";
import type { ControllerApi, LocationData, VersionData } from "./api";

export interface PollingCallbacks {
  onStatus: (status: TabletStatus) => void;
  onCamera: (camera: CameraStatus) => void;
  onCapabilities: (caps: ControllerCapabilities) => void;
  onVersion: (version: VersionData) => void;
  onApps: (apps: ApprovedApp[]) => void;
  onLocation: (location: LocationData) => void;
  onHealth: (health: ServerHealth) => void;
  onError: (error: Error) => void;
}

interface CircuitBreaker {
  failures: number;
  lastFailure: number;
  open: boolean;
}

const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;

function createCircuitBreaker(): CircuitBreaker {
  return { failures: 0, lastFailure: 0, open: false };
}

function shouldSkipCircuit(breaker: CircuitBreaker): boolean {
  if (!breaker.open) return false;
  if (Date.now() - breaker.lastFailure > CIRCUIT_BREAKER_COOLDOWN_MS) {
    breaker.open = false;
    return false;
  }
  return true;
}

function recordFailure(breaker: CircuitBreaker): void {
  breaker.failures++;
  breaker.lastFailure = Date.now();
  if (breaker.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    breaker.open = true;
  }
}

function recordSuccess(breaker: CircuitBreaker): void {
  breaker.failures = 0;
  breaker.open = false;
}

function exponentialBackoff(attempt: number, baseMs = 1000, maxMs = 30_000): number {
  const jitter = Math.random() * 0.3 + 0.85;
  const delay = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  return Math.round(delay * jitter);
}

export class PollingCoordinator {
  private api: ControllerApi;
  private callbacks: PollingCallbacks;
  private aborted = false;
  private visible = true;
  private intervals: Map<string, ReturnType<typeof setInterval>> = new Map();
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private attemptCounts: Map<string, number> = new Map();
  private lastSequence = 0;
  private activeTab: string = "live";

  constructor(api: ControllerApi, callbacks: PollingCallbacks) {
    this.api = api;
    this.callbacks = callbacks;
    this.setupVisibilityListener();
  }

  private setupVisibilityListener(): void {
    if (typeof document === "undefined") return;
    document.addEventListener("visibilitychange", () => {
      this.visible = document.visibilityState === "visible";
      if (this.visible) {
        this.refreshOnce();
      }
    });
  }

  public setTab(tab: string): void {
    this.activeTab = tab;
  }

  public getTab(): string {
    return this.activeTab;
  }

  public start(): void {
    this.schedule("telemetry", 5_000, () => this.pollTelemetry());
    this.schedule("health", 10_000, () => this.pollHealth());
    this.schedule("capabilities", 30_000, () => this.pollCapabilities());
    this.schedule("apps", 30_000, () => this.pollApps());
    this.schedule("location", 30_000, () => this.pollLocation());
    this.refreshOnce();
  }

  private schedule(name: string, intervalMs: number, fn: () => Promise<void>): void {
    const interval = setInterval(() => {
      void fn();
    }, intervalMs);
    this.intervals.set(name, interval);
  }

  public getInterval(intervalMs: number): number {
    if (!this.visible) {
      return intervalMs * 6;
    }
    return intervalMs;
  }

  private async pollTelemetry(): Promise<void> {
    if (shouldSkipCircuit(this.getBreaker("telemetry"))) return;
    const seq = ++this.lastSequence;
    try {
      const [status, camera] = await Promise.all([
        this.api.tabletStatus().catch(() => null),
        this.api.cameraStatus().catch(() => null)
      ]);
      if (seq < this.lastSequence) return;
      if (status) this.callbacks.onStatus(status);
      if (camera) this.callbacks.onCamera(camera);
      recordSuccess(this.getBreaker("telemetry"));
      this.attemptCounts.set("telemetry", 0);
    } catch (error) {
      this.handleError("telemetry", error as Error);
    }
  }

  private async pollHealth(): Promise<void> {
    if (shouldSkipCircuit(this.getBreaker("health"))) return;
    try {
      const health = await this.api.tabletHealth();
      this.callbacks.onHealth(health);
      recordSuccess(this.getBreaker("health"));
    } catch (error) {
      this.handleError("health", error as Error);
    }
  }

  private async pollCapabilities(): Promise<void> {
    if (shouldSkipCircuit(this.getBreaker("capabilities"))) return;
    try {
      const caps = await this.api.capabilities();
      this.callbacks.onCapabilities(caps);
      recordSuccess(this.getBreaker("capabilities"));
    } catch (error) {
      this.handleError("capabilities", error as Error);
    }
  }

  private async pollApps(): Promise<void> {
    if (shouldSkipCircuit(this.getBreaker("apps"))) return;
    try {
      const apps = await this.api.listApps();
      this.callbacks.onApps(apps);
      recordSuccess(this.getBreaker("apps"));
    } catch (error) {
      this.handleError("apps", error as Error);
    }
  }

  private async pollLocation(): Promise<void> {
    if (shouldSkipCircuit(this.getBreaker("location"))) return;
    try {
      const loc = await this.api.getLocation();
      this.callbacks.onLocation(loc);
      recordSuccess(this.getBreaker("location"));
    } catch (error) {
      this.handleError("location", error as Error);
    }
  }

  public async refreshOnce(): Promise<void> {
    if (shouldSkipCircuit(this.getBreaker("refresh"))) return;
    try {
      const [status, camera, caps, version, apps, location, health] = await Promise.all([
        this.api.tabletStatus().catch(() => null),
        this.api.cameraStatus().catch(() => null),
        this.api.capabilities().catch(() => null),
        this.api.getVersion().catch(() => null),
        this.api.listApps().catch(() => []),
        this.api.getLocation().catch(() => null),
        this.api.tabletHealth().catch(() => null)
      ]);
      if (status) this.callbacks.onStatus(status);
      if (camera) this.callbacks.onCamera(camera);
      if (caps) this.callbacks.onCapabilities(caps);
      if (version) this.callbacks.onVersion(version);
      this.callbacks.onApps(apps);
      if (location) this.callbacks.onLocation(location);
      if (health) this.callbacks.onHealth(health);
      recordSuccess(this.getBreaker("refresh"));
      this.attemptCounts.set("refresh", 0);
    } catch (error) {
      this.handleError("refresh", error as Error);
    }
  }

  private getBreaker(name: string): CircuitBreaker {
    if (!this.circuitBreakers.has(name)) {
      this.circuitBreakers.set(name, createCircuitBreaker());
    }
    return this.circuitBreakers.get(name)!;
  }

  private handleError(name: string, error: Error): void {
    const attempt = (this.attemptCounts.get(name) ?? 0) + 1;
    this.attemptCounts.set(name, attempt);
    recordFailure(this.getBreaker(name));
    this.callbacks.onError(error);

    if (attempt < 5) {
      const delay = exponentialBackoff(attempt);
      setTimeout(() => {
        if (!this.aborted) {
          void this.pollByName(name);
        }
      }, delay);
    }
  }

  private async pollByName(name: string): Promise<void> {
    switch (name) {
      case "telemetry":
        await this.pollTelemetry();
        break;
      case "health":
        await this.pollHealth();
        break;
      case "capabilities":
        await this.pollCapabilities();
        break;
      case "apps":
        await this.pollApps();
        break;
      case "location":
        await this.pollLocation();
        break;
    }
  }

  public stop(): void {
    this.aborted = true;
    for (const interval of this.intervals.values()) {
      clearInterval(interval);
    }
    this.intervals.clear();
  }
}

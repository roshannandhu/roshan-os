import * as Dialog from "@radix-ui/react-dialog";
import {
  Activity,
  AppWindow,
  Camera,
  CircleAlert,
  Clock,
  Gauge,
  Image,
  LayoutGrid,
  LockKeyhole,
  MessageSquareText,
  MonitorSmartphone,
  Moon,
  Music,
  Radio,
  RotateCw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  TabletSmartphone,
  Volume2,
  MapPin,
  Film,
  Wifi,
  X
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApprovedApp,
  CameraOrientation,
  CameraStatus,
  ControllerCapabilities,
  DiagnosticSnapshot,
  DpcMaintenanceAction,
  DpcStatus,
  RemoteAuditEvent,
  RemoteControlStatus,
  RemoteKey,
  ScreenOrientation,
  ServerHealth,
  ServiceRestartTarget,
  SignageItem,
  SignagePlaybackState,
  SignagePlaylist,
  TabletStatus
} from "@tablet-control/shared-types";
import type { ReactNode } from "react";
import type { ControllerApi, LocationData } from "./api.js";
import { useVideoStream } from "./hooks/useVideoStream.js";
import { useAudioStream } from "./hooks/useAudioStream.js";
import type { AudioState, VideoState } from "./stream-states.js";
import { SignedUpdatePanel } from "./signed-update-panel.js";
import { TailscaleEnrollmentPanel } from "./tailscale-enrollment-panel.js";

export type TabId =
  "live" | "talk" | "display" | "device" | "apps" | "music" | "location" | "admin";

export interface Notice {
  tone: "info" | "success" | "error";
  message: string;
}

const panelClass =
  "rounded-3xl border border-zinc-800 bg-zinc-950/80 p-4 shadow-[0_12px_40px_rgba(0,0,0,0.22)]";

const CONTROLLER_SCREENSHOTS_PER_MINUTE = 20;
const LIVE_SCREEN_MIN_INTERVAL_MS = 3_000;

const RESTARTABLE_SERVICES: readonly {
  id: ServiceRestartTarget;
  label: string;
  description: string;
}[] = [
  { id: "core", label: "RoshanCore", description: "Control listener and supervisor" },
  { id: "media", label: "RoshanMedia", description: "Camera and microphone pipeline" },
  { id: "vpn", label: "Private network", description: "VPN policy and Wi-Fi reconciliation" },
  { id: "remote", label: "Remote agent", description: "Bounded remote-control service" }
];

function unavailable(value: number | boolean | string | null, suffix = ""): string {
  if (value === null) return "Not reported";
  return String(value) + suffix;
}

function formatBytes(value: number | null): string {
  if (value === null) return "Not reported";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1000 && unitIndex < units.length - 1) {
    amount /= 1000;
    unitIndex += 1;
  }
  const digits = amount >= 10 || unitIndex === 0 ? 0 : 1;
  return `${amount.toFixed(digits)} ${units[unitIndex]}`;
}

function formatDurationSeconds(value: number | null): string {
  if (value === null) return "Not reported";
  const days = Math.floor(value / 86_400);
  const hours = Math.floor((value % 86_400) / 3_600);
  const minutes = Math.floor((value % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function serviceHealthBadge(state: string): string {
  switch (state) {
    case "healthy":
      return "bg-emerald-950 text-emerald-300 border-emerald-900";
    case "starting":
    case "standby":
      return "bg-cyan-950 text-cyan-300 border-cyan-900";
    case "degraded":
      return "bg-amber-950 text-amber-300 border-amber-900";
    case "unavailable":
    case "stopped":
      return "bg-rose-950 text-rose-300 border-rose-900";
    default:
      return "bg-zinc-800 text-zinc-300 border-zinc-700";
  }
}

function formatTimeout(value: number | null): string {
  if (value === null) return "timeout not reported";
  if (value % 60_000 === 0) return `${(value / 60_000).toString()} min timeout`;
  if (value % 1_000 === 0) return `${(value / 1_000).toString()} sec timeout`;
  return `${value.toString()} ms timeout`;
}

function formatTelemetryTime(value: number | null): string {
  if (value === null) return "Not reported";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function titleCaseTelemetryState(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function streamBadgeCls(state: string): string {
  if (state === "connected") return "bg-emerald-950 text-emerald-300";
  if (state === "exhausted" || state === "blocked") return "bg-rose-950 text-rose-300";
  return "bg-amber-950 text-amber-300";
}

function streamStateLabel(state: string): string {
  const labels: Record<string, string> = {
    connecting: "connecting",
    connected: "live",
    reconnecting: "retrying",
    exhausted: "stopped",
    hidden: "paused",
    blocked: "blocked"
  };
  return labels[state] ?? state;
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={panelClass + " " + className}>{children}</section>;
}

export function StatusHeader({
  status,
  videoState,
  audioState
}: {
  status: TabletStatus;
  videoState: VideoState;
  audioState: AudioState;
}) {
  /* const modeLabel =
    status.mode === "real-readonly"
      ? "Live integration · camera controls active"
      : "Mock controller · no real tablet actions";

  */
  const modeLabel =
    status.mode === "companion"
      ? "Live tablet integration"
      : status.mode === "real-readonly"
        ? "Live camera integration"
        : "Tablet control system";
  const showStreamRow = videoState !== "idle" || audioState !== "idle";

  return (
    <header className="sticky top-0 z-20 border-b border-zinc-800 bg-black/95 px-4 pb-3 pt-4 backdrop-blur">
      <div className="mx-auto flex max-w-xl items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-label={status.online ? "Tablet online" : "Tablet offline"}
            className={
              "h-3 w-3 shrink-0 rounded-full " + (status.online ? "bg-emerald-400" : "bg-rose-400")
            }
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-zinc-100">RoshanOS device</p>
            <p className="truncate text-xs text-zinc-400">{modeLabel}</p>
          </div>
        </div>
        <div className="shrink-0 rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs text-zinc-300">
          {status.batteryPercent === null
            ? status.mode === "real-readonly"
              ? "Camera-only status"
              : "Tablet telemetry unavailable"
            : `${status.batteryPercent}% · ${status.charging ? "Charging" : "Battery"} · ${status.batteryTemperatureC?.toFixed(1) ?? "—"}°C`}
        </div>
      </div>
      {showStreamRow && (
        <div className="mx-auto mt-1.5 flex max-w-xl gap-2">
          {videoState !== "idle" && (
            <span className={"rounded-full px-2 py-0.5 text-xs " + streamBadgeCls(videoState)}>
              Cam: {streamStateLabel(videoState)}
            </span>
          )}
          {audioState !== "idle" && (
            <span className={"rounded-full px-2 py-0.5 text-xs " + streamBadgeCls(audioState)}>
              Mic: {streamStateLabel(audioState)}
            </span>
          )}
        </div>
      )}
    </header>
  );
}

export function BottomTabs({
  activeTab,
  onChange
}: {
  activeTab: TabId;
  onChange: (tab: TabId) => void;
}) {
  const tabs: Array<{ id: TabId; label: string; icon: typeof Camera }> = [
    { id: "live", label: "Live", icon: Camera },
    { id: "talk", label: "Talk", icon: Radio },
    { id: "display", label: "Display", icon: MonitorSmartphone },
    { id: "device", label: "Device", icon: Settings2 },
    { id: "apps", label: "Apps", icon: LayoutGrid },
    { id: "music", label: "Music", icon: Music },
    { id: "location", label: "Location", icon: MapPin },
    { id: "admin", label: "Admin", icon: LockKeyhole }
  ];

  return (
    <nav
      aria-label="Controller sections"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-zinc-800 bg-black/95 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur overflow-x-auto"
    >
      <div
        role="tablist"
        className="mx-auto flex w-max min-w-full justify-between gap-1 sm:grid sm:w-auto sm:grid-cols-8 sm:justify-center"
      >
        {tabs.map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={id + "-panel"}
              onClick={() => onChange(id)}
              className={
                "flex min-h-12 flex-col items-center justify-center rounded-2xl px-2 text-xs font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 " +
                (active
                  ? "bg-cyan-400 text-slate-950"
                  : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200")
              }
            >
              <Icon aria-hidden="true" size={18} strokeWidth={active ? 2.5 : 2} />
              <span className="mt-0.5">{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export function NoticeBar({ notice }: { notice: Notice | undefined }) {
  if (notice === undefined) {
    return null;
  }

  const toneClass = {
    info: "border-cyan-900 bg-cyan-950/70 text-cyan-100",
    success: "border-emerald-900 bg-emerald-950/70 text-emerald-100",
    error: "border-rose-900 bg-rose-950/70 text-rose-100"
  }[notice.tone];

  return (
    <div aria-live="polite" className={"rounded-2xl border px-3 py-2 text-sm " + toneClass}>
      {notice.message}
    </div>
  );
}

function ReadOnlyVideo({
  src,
  onLoad,
  onError
}: {
  src: string | undefined;
  onLoad: () => void;
  onError: () => void;
}) {
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const image = imageRef.current;
    if (image === null) return;
    if (src === undefined) {
      image.removeAttribute("src");
      return;
    }
    image.src = src;
    return () => {
      image.removeAttribute("src");
    };
  }, [src]);

  return (
    <img
      ref={imageRef}
      alt="Live video from the tablet camera"
      onLoad={onLoad}
      onError={onError}
      className="absolute inset-0 h-full w-full object-cover"
    />
  );
}

function ReadOnlyAudio({
  src,
  muted,
  onLoad,
  onError,
  onBlocked
}: {
  src: string | undefined;
  muted: boolean;
  onLoad: () => void;
  onError: () => void;
  onBlocked: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio === null) return;
    audio.muted = muted;
  }, [muted]);

  const stableOnBlocked = useRef(onBlocked);
  useEffect(() => {
    stableOnBlocked.current = onBlocked;
  }, [onBlocked]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio === null || src === undefined) return;
    audio.src = src;
    audio.load();
    void audio.play().catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        stableOnBlocked.current();
      }
    });
    return () => {
      audio.pause();
      audio.src = "";
      audio.load();
    };
  }, [src]);

  return (
    <audio
      ref={audioRef}
      controls
      preload="none"
      className="w-full"
      onCanPlay={onLoad}
      onError={onError}
    />
  );
}

export function LivePanel({
  camera,
  busy,
  streamAvailable,
  onVideoStateChange,
  onAudioStateChange,
  onSelectCamera,
  onOrientation,
  onZoom,
  onQuality,
  onFps,
  onResolution,
  onFocus,
  onAutofocus
}: {
  camera: CameraStatus;
  busy: boolean;
  streamAvailable: boolean;
  onVideoStateChange?: (state: VideoState) => void;
  onAudioStateChange?: (state: AudioState) => void;
  onSelectCamera: (camera: "front" | "rear") => void;
  onOrientation: (orientation: CameraOrientation) => void;
  onZoom: (zoom: number) => void;
  onQuality: (quality: number) => void;
  onFps: (fps: 10 | 15 | 30) => void;
  onResolution: (resolution: string) => void;
  onFocus: (mode: string) => void;
  onAutofocus: () => void;
}) {
  const streamPanelRef = useRef<HTMLDivElement>(null);
  const [audioMuted, setAudioMuted] = useState(false);
  const [fullscreenMessage, setFullscreenMessage] = useState<string | undefined>();
  const [stabilityStartedAt, setStabilityStartedAt] = useState<number | undefined>();
  const [stabilityElapsedSeconds, setStabilityElapsedSeconds] = useState(0);

  const video = useVideoStream(streamAvailable);
  const audio = useAudioStream(streamAvailable);
  const frontCameraRestricted = camera.activeCamera === "front";
  const controlsDisabled = busy || frontCameraRestricted;

  useEffect(() => {
    onVideoStateChange?.(video.state);
  }, [video.state, onVideoStateChange]);
  useEffect(() => {
    onAudioStateChange?.(audio.state);
  }, [audio.state, onAudioStateChange]);

  useEffect(() => {
    if (stabilityStartedAt === undefined) {
      return;
    }

    const updateElapsed = () => {
      setStabilityElapsedSeconds(Math.floor((Date.now() - stabilityStartedAt) / 1_000));
    };
    updateElapsed();
    const interval = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(interval);
  }, [stabilityStartedAt]);

  async function toggleFullscreen(): Promise<void> {
    const panel = streamPanelRef.current;
    if (panel === null || !document.fullscreenEnabled) {
      setFullscreenMessage("Fullscreen is not available in this browser.");
      return;
    }

    try {
      if (document.fullscreenElement === panel) {
        await document.exitFullscreen();
        setFullscreenMessage("Fullscreen closed.");
      } else {
        await panel.requestFullscreen();
        setFullscreenMessage("Fullscreen opened. Rotate the phone to test landscape.");
      }
    } catch {
      setFullscreenMessage(
        "The browser declined fullscreen. Keep the controller in its normal layout."
      );
    }
  }

  const reconnectAll = useCallback(() => {
    video.retry();
    audio.retry();
  }, [video, audio]);

  const cameraControls = (
    <>
      <Panel>
        <div className="grid grid-cols-2 gap-2">
          {(["rear", "front"] as const).map((cameraName) => (
            <button
              key={cameraName}
              type="button"
              disabled={busy}
              onClick={() => onSelectCamera(cameraName)}
              className={
                "min-h-12 rounded-2xl border px-3 text-sm font-semibold capitalize disabled:opacity-50 " +
                (camera.activeCamera === cameraName
                  ? "border-cyan-300 bg-cyan-300 text-slate-950"
                  : "border-zinc-800 bg-zinc-800 text-zinc-200")
              }
            >
              {cameraName} camera
            </button>
          ))}
        </div>
        <div className="mt-3 rounded-xl border border-zinc-800 bg-black/50 p-3 text-xs text-zinc-500">
          Torch unavailable — this tablet has no camera flash hardware.
        </div>
      </Panel>
      <Panel>
        <fieldset>
          <legend className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <RotateCw aria-hidden="true" size={18} className="text-cyan-300" />
            Camera view orientation
          </legend>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {(
              [
                ["landscape", "Landscape"],
                ["portrait", "Portrait"],
                ["upsidedown", "Rotate 180°"],
                ["upsidedown_portrait", "Portrait 180°"]
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                disabled={busy}
                aria-pressed={camera.orientation === value}
                onClick={() => onOrientation(value)}
                className={
                  "min-h-12 rounded-2xl border px-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:opacity-50 " +
                  (camera.orientation === value
                    ? "border-cyan-300 bg-cyan-300 text-slate-950"
                    : "border-zinc-800 bg-zinc-800 text-zinc-200")
                }
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs text-zinc-400">
            Rotates the IP Webcam stream without changing camera, resolution, or FPS.
          </p>
        </fieldset>
      </Panel>
      <Panel>
        <div className="flex items-center justify-between gap-3">
          <label
            htmlFor="zoom"
            className="flex items-center gap-2 text-sm font-semibold text-zinc-200"
          >
            <SlidersHorizontal aria-hidden="true" size={18} className="text-cyan-300" /> Zoom
          </label>
          <output className="text-sm text-cyan-200">{camera.zoom?.toFixed(1) ?? "—"}×</output>
        </div>
        <input
          id="zoom"
          aria-label="Camera zoom"
          className="mt-3 w-full accent-cyan-300"
          type="range"
          min="1"
          max="4"
          step="0.03"
          value={camera.zoom ?? 1}
          disabled={controlsDisabled}
          onChange={(event) => onZoom(Number(event.target.value))}
        />
      </Panel>
      <details className={panelClass}>
        <summary className="cursor-pointer list-none text-sm font-semibold text-zinc-100">
          Advanced camera settings
        </summary>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm text-zinc-300">
            Quality
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="1"
                max="100"
                step="1"
                value={camera.quality ?? 49}
                disabled={controlsDisabled}
                onChange={(event) => onQuality(Number(event.target.value))}
                className="flex-1 accent-cyan-300"
              />
              <output className="w-10 text-right text-xs text-cyan-200">
                {camera.quality ?? "—"}%
              </output>
            </div>
          </label>
          <label className="grid gap-1 text-sm text-zinc-300">
            FPS
            <select
              value={camera.fps ?? 30}
              disabled={controlsDisabled}
              onChange={(event) => onFps(Number(event.target.value) as 10 | 15 | 30)}
              className="rounded-xl border border-zinc-800 bg-black px-3 py-2 text-zinc-100"
            >
              <option value={10}>10 FPS</option>
              <option value={15}>15 FPS</option>
              <option value={30}>30 FPS</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm text-zinc-300">
            Resolution
            <select
              value={camera.resolution ?? "1920x1080"}
              disabled={controlsDisabled}
              onChange={(event) => onResolution(event.target.value)}
              className="rounded-xl border border-zinc-800 bg-black px-3 py-2 text-zinc-100"
            >
              <option value="1920x1088">1920 × 1088</option>
              <option value="1920x1080">1920 × 1080</option>
              <option value="1280x720">1280 × 720</option>
              <option value="960x720">960 × 720</option>
              <option value="960x540">960 × 540</option>
              <option value="640x480">640 × 480</option>
              <option value="640x360">640 × 360</option>
              <option value="320x240">320 × 240</option>
              <option value="160x96">160 × 96</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm text-zinc-300">
            Focus mode
            <select
              value={camera.focusMode ?? "continuous-video"}
              disabled={controlsDisabled}
              onChange={(event) => onFocus(event.target.value)}
              className="rounded-xl border border-zinc-800 bg-black px-3 py-2 text-zinc-100"
            >
              <option value="off">Off</option>
              <option value="auto">Auto</option>
              <option value="macro">Macro</option>
              <option value="continuous-video">Continuous video</option>
              <option value="continuous-picture">Continuous picture</option>
            </select>
          </label>
        </div>
        <button
          type="button"
          disabled={controlsDisabled}
          onClick={onAutofocus}
          className="mt-3 min-h-10 w-full rounded-xl border border-zinc-800 px-3 text-sm font-semibold text-zinc-200 disabled:opacity-50"
        >
          Trigger autofocus
        </button>
        {camera.mode !== "mock" && (
          <button
            type="button"
            onClick={() => window.open("/api/v1/camera/snapshot", "_blank")}
            className="mt-2 min-h-10 w-full rounded-xl border border-zinc-800 px-3 text-sm font-semibold text-zinc-200"
          >
            Open snapshot
          </button>
        )}
        <p className="mt-3 text-xs text-zinc-500">
          Status latency: {camera.lastStatusLatencyMs ?? "not measured"} ms · transport:{" "}
          {camera.transport}
        </p>
        {frontCameraRestricted && (
          <p className="mt-2 text-xs text-amber-200">
            Front-camera advanced controls are temporarily disabled while its safe profile is
            verified.
          </p>
        )}
      </details>
    </>
  );

  if (streamAvailable) {
    return (
      <div id="live-panel" role="tabpanel" aria-label="Live camera" className="space-y-4">
        <Panel className="overflow-hidden p-0">
          <div ref={streamPanelRef} className="relative aspect-[4/3] bg-black">
            <ReadOnlyVideo src={video.src} onLoad={video.onLoad} onError={video.onError} />
            {video.state === "exhausted" && (
              <div className="absolute inset-0 grid place-items-center bg-black/90">
                <p className="text-sm text-rose-300">
                  Video stream stopped after 3 retries. Use Reconnect to try again.
                </p>
              </div>
            )}
            {video.state === "reconnecting" && (
              <div className="absolute bottom-3 left-3 rounded-full bg-black/80 px-2.5 py-1 text-xs text-amber-200">
                Reconnecting video…
              </div>
            )}
            <span className="absolute left-3 top-3 rounded-full bg-black/80 px-2.5 py-1 text-xs font-semibold text-cyan-200">
              LIVE · {camera.activeCamera?.toUpperCase() ?? "—"}
            </span>
          </div>
        </Panel>
        <Panel>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-zinc-100">Tablet microphone</h2>
              <p className="mt-1 text-sm text-zinc-400">
                Browser playback requires a user gesture and is never recorded.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void toggleFullscreen()}
                className="min-h-10 rounded-xl border border-zinc-800 px-3 text-sm font-semibold text-zinc-200"
              >
                Fullscreen
              </button>
              <button
                type="button"
                onClick={reconnectAll}
                className="min-h-10 rounded-xl border border-zinc-800 px-3 text-sm font-semibold text-zinc-200"
              >
                Reconnect
              </button>
            </div>
          </div>
          <div className="mt-3">
            <ReadOnlyAudio
              src={audio.src}
              muted={audioMuted}
              onLoad={audio.onLoad}
              onError={audio.onError}
              onBlocked={audio.onBlocked}
            />
            {audio.state === "blocked" && (
              <p className="mt-2 text-sm text-amber-200">
                Audio was blocked by the browser. Click the play button above to start listening.
              </p>
            )}
            {audio.state === "exhausted" && (
              <p className="mt-2 text-sm text-rose-300">
                Audio stream stopped after 3 retries. Use Reconnect to try again.
              </p>
            )}
            {audio.state === "reconnecting" && (
              <p className="mt-2 text-xs text-amber-200">Reconnecting audio…</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setAudioMuted((value) => !value)}
            className="mt-3 min-h-10 rounded-xl border border-zinc-800 px-3 text-sm font-semibold text-zinc-200"
          >
            {audioMuted ? "Unmute local listening" : "Mute local listening"}
          </button>
          {fullscreenMessage === undefined ? null : (
            <p className="mt-3 text-sm text-zinc-400">{fullscreenMessage}</p>
          )}
        </Panel>
        <Panel>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-zinc-100">Stream stability</h2>
              <p className="mt-1 text-sm text-zinc-400">
                Keeps no recording and does not change the tablet.
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                setStabilityStartedAt((value) => (value === undefined ? Date.now() : undefined))
              }
              className="min-h-10 rounded-xl border border-zinc-800 px-3 text-sm font-semibold text-zinc-200"
            >
              {stabilityStartedAt === undefined ? "Start" : "Stop"}
            </button>
          </div>
          <p className="mt-3 text-sm text-cyan-200">
            {stabilityStartedAt === undefined
              ? "Not running"
              : `Running ${stabilityElapsedSeconds} seconds`}
          </p>
        </Panel>
        {cameraControls}
      </div>
    );
  }

  return (
    <div id="live-panel" role="tabpanel" aria-label="Live controls" className="space-y-4">
      <Panel className="overflow-hidden p-0">
        <div className="relative aspect-[4/3] bg-gradient-to-br from-cyan-950 via-zinc-900 to-black">
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            <div>
              <Camera aria-hidden="true" className="mx-auto mb-3 text-cyan-300" size={46} />
              <p className="text-base font-semibold text-zinc-100">Mock live video</p>
              <p className="mt-1 text-sm text-zinc-400">
                Mock mode does not open the tablet stream.
              </p>
            </div>
          </div>
          <span className="absolute left-3 top-3 rounded-full bg-black/80 px-2.5 py-1 text-xs font-semibold text-cyan-200">
            MOCK · {camera.activeCamera?.toUpperCase() ?? "UNKNOWN"}
          </span>
        </div>
      </Panel>
      {cameraControls}
    </div>
  );
}

export function TalkPanel({
  transmitting,
  volume,
  busy,
  readOnly,
  pushToTalkAvailable,
  volumeAvailable,
  onTalkStart,
  onTalkStop,
  onVolume
}: {
  transmitting: boolean;
  volume: number | null;
  busy: boolean;
  readOnly: boolean;
  pushToTalkAvailable: boolean | undefined;
  volumeAvailable: boolean | undefined;
  onTalkStart: () => void;
  onTalkStop: () => void;
  onVolume: (volume: number) => void;
}) {
  const [talkMode, setTalkMode] = useState<"hold" | "tap">("hold");
  const [listenActive, setListenActive] = useState(false);
  const audio = useAudioStream(listenActive);

  const isSecure = window.isSecureContext;
  if (readOnly || pushToTalkAvailable !== true || !isSecure) {
    return (
      <div id="talk-panel" role="tabpanel" aria-label="Talk controls" className="space-y-4">
        <Panel className="text-center">
          <h2 className="text-sm font-medium text-zinc-400">
            {!isSecure ? "Microphone Unavailable" : "Two-way talk unavailable"}
          </h2>
          <button
            type="button"
            disabled
            aria-disabled="true"
            aria-label="Hold to talk — unavailable"
            className="mx-auto mt-6 grid h-52 w-52 cursor-not-allowed place-items-center rounded-full border-8 border-zinc-800 bg-zinc-900 text-center font-bold text-zinc-600"
          >
            <span>
              <Radio aria-hidden="true" className="mx-auto mb-2" size={35} />
              HOLD TO TALK
            </span>
          </button>
          {!isSecure ? (
            <p className="mt-6 text-sm leading-6 text-amber-200">
              Microphone access requires a secure context. Please connect via HTTPS or directly to
              the LAN IP.
            </p>
          ) : pushToTalkAvailable === undefined ? (
            <p className="mt-6 text-sm leading-6 text-zinc-500">
              Checking whether this tablet supports talkback.
            </p>
          ) : pushToTalkAvailable === false ? (
            <p className="mt-6 text-sm leading-6 text-amber-200">
              Talkback is not configured for this tablet.
            </p>
          ) : (
            <p className="mt-6 text-sm leading-6 text-zinc-500">
              This tablet is connected in read-only mode.
            </p>
          )}
          <p className="mt-2 text-xs text-zinc-500">
            Live listening (read-only) is available from the Live tab.
          </p>
        </Panel>
      </div>
    );
  }

  return (
    <div id="talk-panel" role="tabpanel" aria-label="Talk controls" className="space-y-4">
      <Panel className="text-center">
        <div className="flex justify-center gap-4 mb-4">
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="radio"
              name="talkMode"
              value="hold"
              checked={talkMode === "hold"}
              onChange={() => setTalkMode("hold")}
              className="accent-cyan-400"
            />
            Hold
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="radio"
              name="talkMode"
              value="tap"
              checked={talkMode === "tap"}
              onChange={() => setTalkMode("tap")}
              className="accent-cyan-400"
            />
            Tap
          </label>
        </div>
        <p className="text-sm font-medium text-zinc-400">
          {transmitting ? "Transmitting to tablet" : "Ready to talk"}
        </p>
        <button
          type="button"
          aria-pressed={transmitting}
          disabled={busy && !transmitting}
          onPointerDown={() => {
            if (talkMode === "hold") onTalkStart();
          }}
          onPointerUp={() => {
            if (talkMode === "hold") onTalkStop();
          }}
          onPointerCancel={() => {
            if (talkMode === "hold") onTalkStop();
          }}
          onPointerLeave={(event) => {
            if (talkMode === "hold" && event.buttons === 1) onTalkStop();
          }}
          onClick={() => {
            if (talkMode === "tap") {
              if (transmitting) onTalkStop();
              else onTalkStart();
            }
          }}
          className={
            "mx-auto mt-6 grid h-52 w-52 place-items-center rounded-full border-8 text-center font-bold disabled:opacity-50 " +
            (transmitting
              ? "border-rose-300 bg-rose-400 text-rose-950"
              : "border-cyan-300 bg-cyan-400 text-slate-950")
          }
        >
          <span>
            <Radio aria-hidden="true" className="mx-auto mb-2" size={35} />
            {transmitting ? "TRANSMITTING" : talkMode === "hold" ? "HOLD TO TALK" : "TAP TO TALK"}
          </span>
        </button>
        <p className="mx-auto mt-6 max-w-xs text-sm text-zinc-400">
          {talkMode === "hold"
            ? "Pointer release, cancellation, or leaving the control stops transmission."
            : "Tap once to start transmitting, tap again to stop."}
        </p>
      </Panel>
      <Panel>
        <div className="flex items-center justify-between mb-4">
          <label
            htmlFor="listen-tablet"
            className="flex items-center gap-2 text-sm font-semibold text-zinc-200"
          >
            Listen to tablet
          </label>
          <input
            id="listen-tablet"
            type="checkbox"
            checked={listenActive}
            onChange={(e) => setListenActive(e.target.checked)}
            className="h-5 w-5 rounded border-zinc-700 bg-zinc-800 accent-cyan-400"
          />
        </div>
        {listenActive && (
          <div className="mb-4">
            <ReadOnlyAudio
              src={audio.src}
              muted={transmitting || !listenActive}
              onLoad={audio.onLoad}
              onError={audio.onError}
              onBlocked={audio.onBlocked}
            />
            {audio.state === "connecting" || audio.state === "reconnecting" ? (
              <p className="text-xs text-amber-200 mt-2">Connecting to audio stream...</p>
            ) : null}
            {transmitting ? (
              <p className="text-xs text-rose-300 mt-2">
                Listen muted while transmitting (half-duplex).
              </p>
            ) : null}
          </div>
        )}
      </Panel>
      <Panel>
        <div className="flex items-center justify-between">
          <label
            htmlFor="speaker-volume"
            className="flex items-center gap-2 text-sm font-semibold text-zinc-200"
          >
            <Volume2 aria-hidden="true" size={18} className="text-cyan-300" />
            Tablet speaker volume
          </label>
          <output className="text-sm text-cyan-200">{volume ?? "—"}/15</output>
        </div>
        <input
          id="speaker-volume"
          className="mt-3 w-full accent-cyan-300"
          type="range"
          min="0"
          max="15"
          value={volume ?? 0}
          disabled={busy || volumeAvailable !== true}
          onChange={(event) => onVolume(Number(event.target.value))}
        />
      </Panel>
    </div>
  );
}

function SignageManagerPanel({
  disabled,
  controllerApi,
  runAction
}: {
  disabled: boolean;
  controllerApi: ControllerApi;
  runAction: (action: () => Promise<{ message: string }>) => void;
}) {
  const [playlist, setPlaylist] = useState<SignagePlaylist>({
    enabled: false,
    loop: true,
    items: [],
    revision: 0,
    updatedAt: 0
  });
  const [playback, setPlayback] = useState<SignagePlaybackState | null>(null);
  const [playbackFresh, setPlaybackFresh] = useState(false);
  const [loading, setLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);

  const loadPlaylist = useCallback(async () => {
    try {
      const next = await controllerApi.getSignagePlaylist();
      if (
        typeof next === "object" &&
        next !== null &&
        typeof next.enabled === "boolean" &&
        typeof next.loop === "boolean" &&
        Array.isArray(next.items) &&
        Number.isInteger(next.revision)
      ) {
        setPlaylist(next);
      }
    } catch {
      return;
    }
  }, [controllerApi]);

  const loadPlayback = useCallback(async () => {
    try {
      const next = await controllerApi.getSignagePlayback();
      if (
        next === null ||
        (typeof next === "object" &&
          typeof next.state === "string" &&
          Number.isFinite(next.receivedAt))
      ) {
        setPlayback(next);
        setPlaybackFresh(next !== null && Date.now() - next.receivedAt <= 30_000);
      }
    } catch {
      return;
    }
  }, [controllerApi]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      void loadPlaylist();
      void loadPlayback();
    }, 0);
    const poll = window.setInterval(() => {
      void loadPlaylist();
      void loadPlayback();
    }, 5000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(poll);
    };
  }, [loadPlayback, loadPlaylist]);

  const savePlaylist = (newItems: SignageItem[], loop = playlist.loop) => {
    const updated = { ...playlist, loop, items: newItems };
    setPlaylist(updated);
    runAction(async () => {
      const result = await controllerApi.updateSignagePlaylist({ loop, items: newItems });
      await loadPlaylist();
      return result;
    });
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined) return;

    setLoading(true);
    setUploadProgress(0);
    runAction(async () => {
      try {
        const media = await controllerApi.uploadMedia(
          file,
          file.type === "video/mp4" ? 60 : 10,
          setUploadProgress
        );
        const newItem: SignageItem = {
          id: media.id,
          type: media.type,
          url: media.url,
          fileName: media.fileName,
          checksum: media.checksum,
          durationSeconds: media.type === "video" ? 60 : 10,
          muted: true
        };
        const items = [...playlist.items, newItem];
        await controllerApi.updateSignagePlaylist({ items, loop: playlist.loop });
        await loadPlaylist();
        return {
          message: `${media.fileName} was uploaded and added to the signage playlist.`
        };
      } finally {
        setLoading(false);
        setUploadProgress(null);
      }
    });
  };

  const updateItemDuration = (index: number, seconds: number) => {
    const newItems = [...playlist.items];
    const item = newItems[index];
    if (item === undefined) return;
    newItems[index] = {
      ...item,
      durationSeconds: Math.min(3600, Math.max(1, seconds))
    };
    savePlaylist(newItems);
  };

  const toggleItemMute = (index: number) => {
    const newItems = [...playlist.items];
    const item = newItems[index];
    if (item === undefined) return;
    newItems[index] = { ...item, muted: !item.muted };
    savePlaylist(newItems);
  };

  const removeItem = (index: number) => {
    savePlaylist(playlist.items.filter((_, itemIndex) => itemIndex !== index));
  };

  const moveItem = (index: number, direction: -1 | 1) => {
    const items = [...playlist.items];
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const current = items[index];
    const replacement = items[target];
    if (current === undefined || replacement === undefined) return;
    items[index] = replacement;
    items[target] = current;
    savePlaylist(items);
  };

  const playbackItem =
    playback?.itemId === null
      ? undefined
      : playlist.items.find((item) => item.id === playback?.itemId);

  return (
    <Panel>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Film aria-hidden="true" className="text-cyan-300" size={19} />
          <h2 className="text-base font-semibold text-zinc-100">Signage Playlist Manager</h2>
        </div>
      </div>

      <p className="mt-2 text-xs leading-5 text-zinc-400">
        Upload JPEG, PNG, WebP, or MP4 media up to 50 MB. Set item timing and video audio, then play
        it full screen on the tablet.
      </p>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-black px-3 py-2 text-xs">
        <span
          className={
            playbackFresh && playback?.state === "playing" ? "text-emerald-300" : "text-zinc-400"
          }
        >
          Player: {playback === null ? "no acknowledgement yet" : playback.state}
          {playbackItem === undefined ? "" : ` · ${playbackItem.fileName}`}
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => savePlaylist(playlist.items, !playlist.loop)}
          className="rounded-lg border border-zinc-800 px-2 py-1 font-semibold text-zinc-200 disabled:opacity-50"
        >
          Loop playlist: {playlist.loop ? "On" : "Off"}
        </button>
      </div>

      <div className="mt-3 flex gap-2">
        <label className="flex-1 cursor-pointer rounded-2xl border border-dashed border-cyan-700 bg-cyan-950/50 px-3 py-3 text-center text-sm font-semibold text-cyan-200 hover:bg-cyan-900/50">
          {loading
            ? `Uploading${uploadProgress === null ? "..." : `: ${uploadProgress.toString()}%`}`
            : "➕ Add Image / Video to Playlist"}
          <input
            type="file"
            accept=".jpg,.jpeg,.png,.webp,.mp4,image/jpeg,image/png,image/webp,video/mp4"
            disabled={disabled || loading}
            onChange={handleFileUpload}
            className="hidden"
          />
        </label>
      </div>
      {loading && uploadProgress !== null ? (
        <div className="mt-2 flex items-center gap-2 text-xs text-cyan-200">
          <progress
            aria-label="Media upload progress"
            className="h-2 flex-1 accent-cyan-300"
            max={100}
            value={uploadProgress}
          />
          <output>{uploadProgress}%</output>
        </div>
      ) : null}

      <div className="mt-3 space-y-2">
        {playlist.items.length === 0 ? (
          <p className="py-4 text-center text-xs text-zinc-500">
            No media items in playlist. Upload an image or video above.
          </p>
        ) : (
          playlist.items.map((item, idx) => (
            <div
              key={item.id}
              className="flex items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-black p-2 text-xs"
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span className="text-base">{item.type === "video" ? "🎥" : "📷"}</span>
                <span className="truncate text-zinc-200 font-medium">
                  {item.fileName || `Item ${idx + 1}`}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1">
                  <span className="text-zinc-400">Sec:</span>
                  <input
                    type="number"
                    min={1}
                    max={3600}
                    value={item.durationSeconds}
                    disabled={disabled}
                    onChange={(event) =>
                      updateItemDuration(idx, Number.parseInt(event.target.value, 10) || 10)
                    }
                    className="w-12 rounded border border-zinc-800 bg-zinc-900 px-1 py-0.5 text-center text-zinc-100"
                  />
                </div>

                {item.type === "video" ? (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => toggleItemMute(idx)}
                    className={`rounded px-2 py-1 font-semibold ${item.muted ? "bg-zinc-800 text-zinc-400" : "bg-cyan-950 text-cyan-300 border border-cyan-800"}`}
                  >
                    {item.muted ? "🔇 Muted" : "🔊 Audio On"}
                  </button>
                ) : null}

                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => moveItem(idx, -1)}
                    disabled={disabled || idx === 0}
                    className="px-1 text-zinc-400 hover:text-white disabled:opacity-30"
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    onClick={() => moveItem(idx, 1)}
                    disabled={disabled || idx === playlist.items.length - 1}
                    className="px-1 text-zinc-400 hover:text-white disabled:opacity-30"
                  >
                    Down
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => removeItem(idx)}
                    className="px-1 text-red-400 hover:text-red-300 disabled:opacity-30"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={disabled || playlist.items.length === 0}
          onClick={() =>
            runAction(async () => {
              const result = await controllerApi.startSignage();
              await loadPlaylist();
              await loadPlayback();
              return result;
            })
          }
          className="min-h-12 rounded-2xl bg-cyan-400 px-4 text-sm font-bold text-slate-950 disabled:opacity-50"
        >
          ▶️ Start Signage Playlist
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            runAction(async () => {
              const result = await controllerApi.stopSignage();
              await loadPlaylist();
              await loadPlayback();
              return result;
            })
          }
          className="min-h-12 rounded-2xl border border-zinc-800 bg-zinc-900 px-4 text-sm font-semibold text-zinc-100 disabled:opacity-50"
        >
          ⏹️ Stop / Restore Home
        </button>
      </div>
    </Panel>
  );
}

export function DisplayPanel({
  busy,
  readOnly,
  capabilities,
  onMessage,
  onLiveText,
  onClearLiveText,
  onMedia,
  onWebpage,
  onBlack,
  onClockOnly,
  onClockColor,
  onRestore,
  controllerApi,
  runAction,
  status
}: {
  busy: boolean;
  readOnly: boolean;
  capabilities: ControllerCapabilities["display"] | undefined;
  onMessage: (message: string) => void;
  onLiveText: (message: string) => void;
  onClearLiveText: () => void;
  onMedia: (kind: "image" | "video", file: File) => void;
  onWebpage: (url: string) => void;
  onBlack: () => void;
  onClockOnly: () => void;
  onClockColor: (color: string) => void;
  onRestore: () => void;
  controllerApi: ControllerApi;
  runAction: (action: () => Promise<{ message: string }>) => void;
  status?: TabletStatus;
}) {
  const unavailable = readOnly || capabilities === undefined;
  const disabled = busy || unavailable;
  const [liveText, setLiveText] = useState("");
  const liveTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (liveTimer.current !== undefined) window.clearTimeout(liveTimer.current);
    };
  }, []);

  function updateLiveText(text: string): void {
    setLiveText(text);
    if (liveTimer.current !== undefined) window.clearTimeout(liveTimer.current);
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    liveTimer.current = window.setTimeout(() => onLiveText(trimmed), 650);
  }

  return (
    <div id="display-panel" role="tabpanel" aria-label="Display controls" className="space-y-4">
      {status ? (
        <Panel>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-300">Active Screen Mode:</span>
            {status.displayMode === "clock" ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-500/50 bg-cyan-950/70 px-3 py-1 text-xs font-bold text-cyan-200 ring-2 ring-cyan-500/30">
                <span className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse"></span> 🕒 Slender
                Clock Only
              </span>
            ) : status.displayMode === "dashboard" ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/50 bg-emerald-950/70 px-3 py-1 text-xs font-bold text-emerald-200 ring-2 ring-emerald-500/30">
                <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span> 📱 Home
                Launcher Dashboard
              </span>
            ) : status.displayMode === "black" ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs font-bold text-zinc-300 ring-2 ring-zinc-700">
                <span className="h-2 w-2 rounded-full bg-zinc-400"></span> 🌙 Pitch Black Screen
              </span>
            ) : status.displayMode === "webpage" ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-purple-500/50 bg-purple-950/70 px-3 py-1 text-xs font-bold text-purple-200 ring-2 ring-purple-500/30">
                <span className="h-2 w-2 rounded-full bg-purple-400 animate-pulse"></span> 📺
                Signage Playlist
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-black px-3 py-1 text-xs font-medium text-zinc-200 capitalize">
                {status.displayMode || "Dashboard"}
              </span>
            )}
          </div>
        </Panel>
      ) : null}
      {unavailable ? (
        <Panel>
          <p className="text-sm font-semibold text-amber-200">
            {readOnly ? "Read-only mode" : "Checking display capability"}
          </p>
          <p className="mt-1 text-sm leading-6 text-zinc-400">
            {readOnly
              ? "This tablet is connected in read-only mode."
              : "The controller is confirming which display actions this tablet supports."}
          </p>
        </Panel>
      ) : null}
      <Panel>
        <div className="flex items-center gap-2">
          <MessageSquareText aria-hidden="true" className="text-cyan-300" size={19} />
          <h2 className="text-base font-semibold text-zinc-100">Animated message</h2>
        </div>
        <form
          className="mt-3 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const message = String(new FormData(event.currentTarget).get("message") ?? "").trim();
            if (message) onMessage(message);
          }}
        >
          <textarea
            name="message"
            rows={3}
            maxLength={500}
            placeholder="Message for the tablet"
            disabled={disabled || capabilities?.message !== true}
            className="rounded-2xl border border-zinc-800 bg-black px-3 py-2 text-zinc-100"
          />
          <button
            type="submit"
            disabled={disabled || capabilities?.message !== true}
            className="min-h-12 rounded-2xl bg-cyan-300 px-4 text-sm font-bold text-slate-950 disabled:opacity-50"
          >
            Show animated message
          </button>
        </form>
      </Panel>
      <Panel>
        <div className="flex items-center gap-2">
          <MessageSquareText aria-hidden="true" className="text-cyan-300" size={19} />
          <h2 className="text-base font-semibold text-zinc-100">Live text</h2>
        </div>
        <p className="mt-2 text-xs leading-5 text-zinc-400">
          Text updates on the center of the tablet after you pause typing. It has no background and
          remains until cleared.
        </p>
        <label htmlFor="live-tablet-text" className="sr-only">
          Live tablet text
        </label>
        <textarea
          id="live-tablet-text"
          rows={3}
          maxLength={500}
          value={liveText}
          placeholder="Type a live message"
          disabled={disabled || capabilities?.liveText !== true}
          onChange={(event) => updateLiveText(event.target.value)}
          className="mt-3 w-full rounded-2xl border border-zinc-800 bg-black px-3 py-2 text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
        />
        <button
          type="button"
          disabled={disabled || capabilities?.liveText !== true}
          onClick={() => {
            if (liveTimer.current !== undefined) window.clearTimeout(liveTimer.current);
            setLiveText("");
            onClearLiveText();
          }}
          className="mt-3 min-h-12 w-full rounded-2xl border border-zinc-700 px-4 text-sm font-semibold text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:opacity-50"
        >
          Clear live text
        </button>
      </Panel>
      <Panel>
        <div className="flex items-center gap-2">
          <Image aria-hidden="true" className="text-cyan-300" size={19} />
          <h2 className="text-base font-semibold text-zinc-100">Website and media</h2>
        </div>
        <div className="mt-3 grid gap-3">
          <input
            type="file"
            accept="image/*,video/*"
            disabled={disabled || capabilities?.media !== true}
            className="block w-full rounded-2xl border border-dashed border-zinc-800 bg-black px-3 py-3 text-sm text-zinc-300"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined)
                onMedia(file.type.startsWith("video/") ? "video" : "image", file);
            }}
          />
          {capabilities?.media === false ? (
            <p className="text-xs leading-5 text-zinc-500">
              Image and video upload is not configured on this controller.
            </p>
          ) : null}
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              let url = String(new FormData(event.currentTarget).get("website") ?? "").trim();
              if (url) {
                if (!/^https?:\/\//i.test(url)) {
                  url = "https://" + url;
                }
                onWebpage(url);
              }
            }}
          >
            <input
              name="website"
              type="text"
              placeholder="https://example.com or example.com"
              required
              disabled={disabled || capabilities?.webpage !== true}
              className="min-w-0 flex-1 rounded-2xl border border-zinc-800 bg-black px-3 py-2 text-sm text-zinc-100"
            />
            <button
              type="submit"
              disabled={disabled || capabilities?.webpage !== true}
              className="min-h-12 rounded-2xl border border-zinc-700 px-3 text-sm font-semibold text-zinc-100 disabled:opacity-50"
            >
              Open
            </button>
          </form>
        </div>
      </Panel>
      <SignageManagerPanel
        disabled={disabled}
        controllerApi={controllerApi}
        runAction={runAction}
      />
      <Panel>
        <div className="flex items-center gap-2">
          <Clock aria-hidden="true" className="text-cyan-300" size={19} />
          <h2 className="text-base font-semibold text-zinc-100">Clock Theme Color</h2>
        </div>
        <div className="mt-3 flex items-center justify-around gap-2">
          {[
            { name: "Cyan", hex: "#00A2FF", bg: "bg-[#00A2FF]" },
            { name: "White", hex: "#FFFFFF", bg: "bg-white" },
            { name: "Green", hex: "#00FF66", bg: "bg-[#00FF66]" },
            { name: "Amber", hex: "#FFB000", bg: "bg-[#FFB000]" },
            { name: "Pink", hex: "#FF007F", bg: "bg-[#FF007F]" },
            { name: "Purple", hex: "#9D00FF", bg: "bg-[#9D00FF]" },
            { name: "Red", hex: "#FF3333", bg: "bg-[#FF3333]" }
          ].map((c) => (
            <button
              key={c.hex}
              type="button"
              title={c.name}
              disabled={disabled}
              onClick={() => onClockColor(c.hex)}
              className={`h-9 w-9 rounded-full ${c.bg} border-2 border-zinc-800 shadow-md transition-transform active:scale-95 disabled:opacity-50`}
            />
          ))}
        </div>
      </Panel>
      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          disabled={disabled || capabilities?.black !== true}
          onClick={onBlack}
          className={`min-h-14 rounded-2xl border text-xs font-semibold transition-all duration-150 active:scale-95 disabled:opacity-50 ${
            status?.displayMode === "black"
              ? "border-zinc-500 bg-zinc-800 text-white ring-2 ring-zinc-500/50"
              : "border-zinc-800 bg-zinc-900 text-zinc-100 hover:bg-zinc-800"
          }`}
        >
          <Moon aria-hidden="true" className="mx-auto mb-1 text-zinc-400" size={18} />
          {status?.displayMode === "black" ? "● Black Screen" : "Black Screen"}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onClockOnly}
          className={`min-h-14 rounded-2xl border text-xs font-semibold transition-all duration-150 active:scale-95 disabled:opacity-50 ${
            status?.displayMode === "clock"
              ? "border-cyan-400 bg-cyan-950 text-cyan-100 ring-2 ring-cyan-500/50"
              : "border-cyan-800 bg-cyan-950 text-cyan-200 hover:border-cyan-600"
          }`}
        >
          <Clock
            aria-hidden="true"
            className={`mx-auto mb-1 ${status?.displayMode === "clock" ? "text-cyan-200" : "text-cyan-400"}`}
            size={18}
          />
          {status?.displayMode === "clock" ? "● Clock Only" : "Clock Only"}
        </button>
        <button
          type="button"
          disabled={disabled || capabilities?.restoreDashboard !== true}
          onClick={onRestore}
          className={`min-h-14 rounded-2xl text-xs font-bold transition-all duration-150 active:scale-95 disabled:opacity-50 ${
            status?.displayMode === "dashboard"
              ? "bg-emerald-400 text-slate-950 ring-2 ring-emerald-400/50"
              : "bg-cyan-300 text-slate-950 hover:bg-cyan-200"
          }`}
        >
          <MonitorSmartphone aria-hidden="true" className="mx-auto mb-1" size={18} />
          {status?.displayMode === "dashboard" ? "● Home (Active)" : "Home Launcher"}
        </button>
      </div>
    </div>
  );
}

function OptimisticSlider({
  id,
  min,
  max,
  value,
  disabled,
  onChangeEnd
}: {
  id: string;
  min: number;
  max: number;
  value: number;
  disabled: boolean;
  onChangeEnd: (value: number) => void;
}) {
  const [localValue, setLocalValue] = useState<number>(value);
  const [isDragging, setIsDragging] = useState(false);

  return (
    <input
      id={id}
      className="mt-3 w-full accent-cyan-300"
      type="range"
      min={min}
      max={max}
      value={isDragging ? localValue : value}
      disabled={disabled}
      onChange={(e) => {
        const nextValue = Number(e.target.value);
        setLocalValue(nextValue);
        if (!isDragging) {
          onChangeEnd(nextValue);
        }
      }}
      onPointerDown={(e) => {
        setLocalValue(Number(e.currentTarget.value));
        setIsDragging(true);
      }}
      onPointerUp={(e) => {
        setIsDragging(false);
        onChangeEnd(Number(e.currentTarget.value));
      }}
      onPointerCancel={() => setIsDragging(false)}
    />
  );
}

export function DevicePanel({
  status,
  busy,
  readOnly,
  capabilities,
  serverHealth,
  restoreAvailable,
  onBrightness,
  onVolume,
  onMute,
  onOrientation,
  onScreen,
  onReboot,
  onRestartService,
  onRestore
}: {
  status: TabletStatus;
  busy: boolean;
  readOnly: boolean;
  capabilities: ControllerCapabilities["device"] | undefined;
  serverHealth: ServerHealth | undefined;
  restoreAvailable: boolean | undefined;
  onBrightness: (val: number) => void;
  onVolume: (val: number) => void;
  onMute: () => void;
  onOrientation: (orientation: ScreenOrientation) => void;
  onScreen: (on: boolean) => void;
  onReboot: () => void;
  onRestartService: (service: ServiceRestartTarget) => void;
  onRestore: () => void;
}) {
  const disabled = busy || readOnly || capabilities === undefined;
  const connectivity = status.connectivity;
  const memory = status.memory;
  const foreground = status.foregroundApp;
  const wifiSummary =
    connectivity === null
      ? "Not reported"
      : connectivity.wifiEnabled === false
        ? "Wi-Fi off"
        : connectivity.wifiConnected === false
          ? "Not connected"
          : connectivity.wifiConnected === true
            ? [
                connectivity.wifiSignalState === null
                  ? null
                  : titleCaseTelemetryState(connectivity.wifiSignalState),
                connectivity.wifiSsid,
                connectivity.internetValidated === false ? "Internet not validated" : null
              ]
                .filter((part): part is string => part !== null)
                .join(" · ") || "Connected"
            : "Not reported";
  const memorySummary =
    memory === null
      ? "Not reported"
      : `${formatBytes(memory.availableBytes)} free${
          memory.totalBytes === null ? "" : ` / ${formatBytes(memory.totalBytes)}`
        }${memory.lowMemory === true ? " · Low memory" : ""}`;
  const foregroundSummary =
    foreground === null
      ? "Not reported"
      : (foreground.label ??
        (foreground.state === "roshanos"
          ? "RoshanOS Home"
          : titleCaseTelemetryState(foreground.state)));
  const tailscaleSummary =
    status.tailscaleConnected === null
      ? "Not reported"
      : status.tailscaleConnected
        ? "Connected"
        : "Disconnected";
  const items = [
    { label: "Battery", value: unavailable(status.batteryPercent, "%"), icon: Activity },
    {
      label: "Charging",
      value: status.charging === null ? "Not reported" : status.charging ? "Yes" : "No",
      icon: Gauge
    },
    {
      label: "Storage",
      value: unavailable(status.storageFreeMb, " MB free"),
      icon: TabletSmartphone
    },
    {
      label: "Memory",
      value: memorySummary,
      icon: Gauge
    },
    {
      label: "Wi-Fi",
      value: wifiSummary,
      icon: Wifi
    },
    {
      label: "Tailscale VPN",
      value: tailscaleSummary,
      icon: ShieldCheck
    },
    {
      label: "Foreground app",
      value: foregroundSummary,
      icon: AppWindow
    },
    {
      label: "Temperature",
      value: status.batteryTemperatureC === null ? "Not reported" : `${status.batteryTemperatureC.toFixed(1)}°C`,
      icon: Activity
    },
    {
      label: "Uptime",
      value: status.uptimeSeconds === null ? "Not reported" : formatDurationSeconds(status.uptimeSeconds),
      icon: Clock
    }
  ];

  // Build service health rows from serverHealth if available
  const SERVICE_LABELS: Record<string, string> = {
    controlListener: "Controller connection",
    wifi: "Wi-Fi enforcement",
    vpnTailscale: "Tailscale VPN",
    internalMedia: "RoshanMedia (camera)",
    ipWebcamFallback: "IP Webcam fallback",
    remoteAgent: "Remote agent",
    signageService: "Signage service",
    resources: "Resource guard",
    supervisor: "System supervisor"
  };
  const serviceRows =
    serverHealth !== undefined
      ? Object.entries(serverHealth.components).map(([key, component]) => ({
          key,
          label: SERVICE_LABELS[key] ?? key,
          state: component.state,
          reason: component.degradedReason
        }))
      : [];
  return (
    <div id="device-panel" role="tabpanel" aria-label="Device controls" className="space-y-4">
      {/* Degraded reasons alert banner */}
      {serverHealth !== undefined && serverHealth.degradedReasons.length > 0 && (
        <div className="rounded-2xl border border-amber-900 bg-amber-950/60 px-4 py-3">
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-amber-300">
            <CircleAlert size={14} aria-hidden="true" /> Service Alert
          </p>
          <ul className="mt-2 space-y-1">
            {serverHealth.degradedReasons.map((reason, i) => (
              <li key={i} className="text-xs text-amber-200">{reason}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Stats tiles grid */}
      <div className="grid grid-cols-2 gap-3">
        {items.map(({ label, value, icon: Icon }) => (
          <Panel key={label} className="p-3">
            <Icon aria-hidden="true" className="text-cyan-300" size={18} />
            <p className="mt-3 text-xs text-zinc-400">{label}</p>
            <p className="mt-1 text-sm font-semibold text-zinc-100">{value}</p>
          </Panel>
        ))}
      </div>

      {/* Service health matrix */}
      {serviceRows.length > 0 && (
        <Panel>
          <div className="flex items-center gap-2">
            <ShieldCheck aria-hidden="true" className="text-cyan-300" size={19} />
            <h2 className="text-base font-semibold text-zinc-100">RoshanOS service health</h2>
          </div>
          <p className="mt-1 text-xs leading-5 text-zinc-400">
            Real-time state of every background RoshanOS service, reported by the tablet supervisor.
          </p>
          <ul className="mt-4 divide-y divide-zinc-800">
            {serviceRows.map(({ key, label, state, reason }) => (
              <li key={key} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <span className="min-w-0">
                  <span className="block text-sm text-zinc-200">{label}</span>
                  {reason !== null && (
                    <span className="block truncate text-xs text-amber-300">{reason}</span>
                  )}
                </span>
                <span
                  className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider ${serviceHealthBadge(state)}`}
                >
                  {state}
                </span>
              </li>
            ))}
          </ul>
          {serverHealth !== undefined && (
            <p className="mt-3 text-xs text-zinc-500">
              Supervisor started {formatTelemetryTime(serverHealth.supervisorStartedAtMs)} ·
              Last check {formatTelemetryTime(serverHealth.reconciledAtMs)}
            </p>
          )}
        </Panel>
      )}

      {/* Enrollment state */}
      {serverHealth !== undefined && (
        <Panel>
          <div className="flex items-center gap-2">
            <LockKeyhole aria-hidden="true" className="text-cyan-300" size={19} />
            <h2 className="text-base font-semibold text-zinc-100">Enrollment & network state</h2>
          </div>
          <dl className="mt-3 divide-y divide-zinc-800">
            <div className="flex items-center justify-between gap-3 py-2.5 first:pt-0">
              <dt className="text-sm text-zinc-400">Tailscale VPN</dt>
              <dd className={`rounded-full border px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider ${
                serverHealth.components.vpnTailscale !== undefined
                  ? serviceHealthBadge(serverHealth.components.vpnTailscale.state)
                  : "bg-zinc-800 text-zinc-400 border-zinc-700"
              }`}>
                {serverHealth.components.vpnTailscale?.state ?? "Unknown"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3 py-2.5">
              <dt className="text-sm text-zinc-400">Wi-Fi enforcement</dt>
              <dd className={`rounded-full border px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider ${
                serverHealth.components.wifi !== undefined
                  ? serviceHealthBadge(serverHealth.components.wifi.state)
                  : "bg-zinc-800 text-zinc-400 border-zinc-700"
              }`}>
                {serverHealth.components.wifi?.state ?? "Unknown"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3 py-2.5">
              <dt className="text-sm text-zinc-400">Controller link</dt>
              <dd className={`rounded-full border px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider ${
                serverHealth.components.controlListener !== undefined
                  ? serviceHealthBadge(serverHealth.components.controlListener.state)
                  : "bg-zinc-800 text-zinc-400 border-zinc-700"
              }`}>
                {serverHealth.components.controlListener?.state ?? "Unknown"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3 py-2.5 last:pb-0">
              <dt className="text-sm text-zinc-400">System healthy</dt>
              <dd className={`rounded-full border px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider ${
                serverHealth.healthy
                  ? "bg-emerald-950 text-emerald-300 border-emerald-900"
                  : "bg-rose-950 text-rose-300 border-rose-900"
              }`}>
                {serverHealth.healthy ? "Yes" : "No"}
              </dd>
            </div>
          </dl>
        </Panel>
      )}

      <Panel>
        <h2 className="text-base font-semibold text-zinc-100">Operational state</h2>
        <p className="mt-1 text-xs leading-5 text-zinc-400">
          Read-only lock, boot recovery, and installed RoshanOS details reported by the tablet.
        </p>
        <dl className="mt-4 divide-y divide-zinc-800">
          <div className="flex items-start justify-between gap-4 py-3 first:pt-0">
            <dt className="text-sm text-zinc-400">Lock state</dt>
            <dd className="text-right text-sm font-semibold text-zinc-100">
              {status.deviceLocked === null && status.keyguardLocked === null
                ? "Not reported"
                : status.deviceLocked === true
                  ? "Device locked"
                  : status.keyguardLocked === true
                    ? "Keyguard locked"
                    : "Unlocked"}
            </dd>
          </div>
          <div className="flex items-start justify-between gap-4 py-3">
            <dt className="text-sm text-zinc-400">Brightness profile</dt>
            <dd className="text-right text-sm font-semibold text-zinc-100">
              {status.brightnessMode === null
                ? `Not reported · ${formatTimeout(status.screenTimeoutMs)}`
                : `${titleCaseTelemetryState(status.brightnessMode)} · ${formatTimeout(
                    status.screenTimeoutMs
                  )}`}
            </dd>
          </div>
          <div className="flex items-start justify-between gap-4 py-3">
            <dt className="text-sm text-zinc-400">Boot recovery</dt>
            <dd className="text-right text-sm font-semibold text-zinc-100">
              {status.boot === null
                ? "Not reported"
                : `Recovery ${status.boot.recoveryState} · ${formatDurationSeconds(
                    status.boot.uptimeSeconds
                  )} uptime`}
            </dd>
          </div>
          <div className="flex items-start justify-between gap-4 py-3">
            <dt className="text-sm text-zinc-400">Last boot</dt>
            <dd className="text-right text-sm font-semibold text-zinc-100">
              {formatTelemetryTime(status.boot?.lastBootAtMs ?? null)}
            </dd>
          </div>
          <div className="flex items-start justify-between gap-4 py-3 last:pb-0">
            <dt className="text-sm text-zinc-400">Installed update</dt>
            <dd className="text-right text-sm font-semibold text-zinc-100">
              {status.update === null
                ? "Not reported"
                : status.update.versionName === null
                  ? titleCaseTelemetryState(status.update.state)
                  : `RoshanOS ${status.update.versionName}${
                      status.update.versionCode === null
                        ? ""
                        : ` (${status.update.versionCode.toString()})`
                    }`}
            </dd>
          </div>
        </dl>
      </Panel>
      <Panel>
        <p className="text-sm font-semibold text-zinc-100">Device controls</p>
        {readOnly ? (
          <p className="mt-2 text-sm text-zinc-400">
            Brightness, volume, mute, display recovery, reboot, screen, and VPN controls are
            unavailable in read-only mode.
          </p>
        ) : (
          <>
            <div className="mt-4 flex items-center justify-between">
              <label htmlFor="brightness" className="text-sm font-semibold text-zinc-200">
                Brightness
              </label>
              <output className="text-sm text-cyan-200">{status.brightness ?? "—"}/255</output>
            </div>
            <OptimisticSlider
              id="brightness"
              min={0}
              max={255}
              value={status.brightness ?? 0}
              disabled={disabled || capabilities?.brightness !== true}
              onChangeEnd={(val) => onBrightness(val)}
            />
            <div className="mt-4 flex items-center justify-between">
              <label htmlFor="device-volume" className="text-sm font-semibold text-zinc-200">
                Media volume
              </label>
              <output className="text-sm text-cyan-200">
                {status.mediaVolume ?? "—"}/{status.mediaVolumeMax ?? "—"}
              </output>
            </div>
            <OptimisticSlider
              id="device-volume"
              min={0}
              max={status.mediaVolumeMax ?? 15}
              value={status.mediaVolume ?? 0}
              disabled={disabled || capabilities?.volume !== true}
              onChangeEnd={(val) => onVolume(val)}
            />
            <button
              type="button"
              disabled={disabled || capabilities?.mute !== true}
              onClick={onMute}
              className={`mt-4 min-h-12 w-full rounded-2xl border text-sm font-semibold transition-all duration-150 active:scale-95 disabled:opacity-50 ${
                status.mediaVolume === 0
                  ? "border-amber-600 bg-amber-950/50 text-amber-200"
                  : "border-zinc-800 text-zinc-100"
              }`}
            >
              {status.mediaVolume === 0
                ? "🔇 Audio Muted — Tap to Restore"
                : "🔊 Mute Tablet Audio"}
            </button>
            <label
              htmlFor="screen-orientation"
              className="mt-4 flex items-center gap-2 text-sm font-semibold text-zinc-200"
            >
              <RotateCw aria-hidden="true" size={18} className="text-cyan-300" />
              Tablet screen orientation
            </label>
            <select
              id="screen-orientation"
              value={status.screenOrientation ?? "auto"}
              disabled={disabled || capabilities?.orientation !== true}
              onChange={(event) => onOrientation(event.target.value as ScreenOrientation)}
              className="mt-2 min-h-12 w-full rounded-2xl border border-zinc-800 bg-black px-3 text-sm text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:opacity-50"
            >
              <option value="auto">Automatic rotation</option>
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
              <option value="reverse-portrait">Portrait (upside down)</option>
              <option value="reverse-landscape">Landscape (reversed)</option>
            </select>
            <button
              type="button"
              disabled={disabled || restoreAvailable !== true}
              onClick={onRestore}
              className="mt-3 min-h-12 w-full rounded-2xl bg-zinc-100 text-sm font-bold text-slate-950 disabled:opacity-50"
            >
              Restore dashboard
            </button>
          </>
        )}
      </Panel>

      <Panel>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Tablet screen</h2>
            <p className="mt-1 text-xs text-zinc-400">
              Wake or sleep the display without changing background server operation.
            </p>
          </div>
          <span
            className={
              "rounded-full px-3 py-1 text-xs font-bold " +
              (status.screenOn === true
                ? "bg-emerald-950 text-emerald-300"
                : status.screenOn === false
                  ? "bg-zinc-800 text-zinc-300"
                  : "bg-amber-950 text-amber-200")
            }
          >
            {status.screenOn === true ? "Awake" : status.screenOn === false ? "Asleep" : "Unknown"}
          </span>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <button
            type="button"
            disabled={disabled || capabilities?.screenControl !== true}
            onClick={() => onScreen(true)}
            className="min-h-12 rounded-2xl bg-cyan-300 text-sm font-bold text-slate-950 disabled:opacity-50"
          >
            Wake screen
          </button>
          <button
            type="button"
            disabled={disabled || capabilities?.screenControl !== true}
            onClick={() => onScreen(false)}
            className="min-h-12 rounded-2xl border border-zinc-800 bg-black text-sm font-semibold text-zinc-100 disabled:opacity-50"
          >
            Sleep screen
          </button>
        </div>
      </Panel>

      <Panel>
        <h2 className="text-base font-semibold text-zinc-100">Restart a RoshanOS service</h2>
        <p className="mt-1 text-xs leading-5 text-zinc-400">
          Only the four bounded services below can be reconciled. This does not expose a command
          line or accept custom service names.
        </p>
        <div className="mt-4 grid gap-2">
          {RESTARTABLE_SERVICES.map((service) => (
            <button
              key={service.id}
              type="button"
              aria-label={`Restart ${service.label}`}
              disabled={disabled || capabilities?.serviceRestart !== true}
              onClick={() => onRestartService(service.id)}
              className="flex min-h-14 items-center justify-between gap-3 rounded-2xl border border-zinc-800 bg-black px-4 text-left disabled:opacity-50"
            >
              <span>
                <span className="block text-sm font-semibold text-zinc-100">
                  Restart {service.label}
                </span>
                <span className="mt-0.5 block text-xs text-zinc-500">{service.description}</span>
              </span>
              <RotateCw aria-hidden="true" size={17} className="shrink-0 text-cyan-300" />
            </button>
          ))}
        </div>
      </Panel>

      <Dialog.Root>
        <Dialog.Trigger asChild>
          <button
            type="button"
            disabled={disabled || capabilities?.reboot !== true}
            className="min-h-12 w-full rounded-2xl border border-rose-900 bg-rose-950/40 text-sm font-semibold text-rose-200 disabled:opacity-50"
          >
            Reboot tablet
          </button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/80" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl">
            <Dialog.Title className="flex items-center gap-2 text-lg font-bold text-zinc-100">
              <CircleAlert aria-hidden="true" className="text-amber-300" size={22} />
              Reboot RoshanOS?
            </Dialog.Title>
            <Dialog.Description className="mt-3 text-sm leading-6 text-zinc-300">
              The tablet will briefly go offline. RoshanCore and its supervised services should
              recover automatically after Android starts. Use this only when you can tolerate the
              interruption.
            </Dialog.Description>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="min-h-12 rounded-2xl border border-zinc-800 text-sm font-semibold text-zinc-100"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <Dialog.Close asChild>
                <button
                  type="button"
                  disabled={disabled || capabilities?.reboot !== true}
                  onClick={onReboot}
                  className="min-h-12 rounded-2xl bg-rose-500 text-sm font-bold text-white disabled:opacity-50"
                >
                  Confirm reboot
                </button>
              </Dialog.Close>
            </div>
            <Dialog.Close
              aria-label="Close dialog"
              className="absolute right-4 top-4 rounded-lg p-1 text-zinc-400"
            >
              <X aria-hidden="true" size={18} />
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

export function AdminPanel({
  status,
  apiVersion,
  disabled,
  capabilities,
  serverHealth,
  apps,
  controllerApi,
  runAction,
  onTouchLock,
  onOrientation
}: {
  status: TabletStatus;
  apiVersion: string;
  disabled: boolean;
  capabilities: ControllerCapabilities["device"] | undefined;
  serverHealth: ServerHealth | undefined;
  apps: ApprovedApp[];
  controllerApi: ControllerApi;
  runAction: (action: () => Promise<{ message: string }>) => Promise<void>;
  onTouchLock: (enabled: boolean) => void;
  onOrientation: (orientation: ScreenOrientation) => void;
}) {
  const [remoteStatus, setRemoteStatus] = useState<RemoteControlStatus | undefined>();
  const [remoteAudit, setRemoteAudit] = useState<RemoteAuditEvent[]>([]);
  const [remoteError, setRemoteError] = useState<string | undefined>();
  const [screenshotUrl, setScreenshotUrl] = useState<string | undefined>();
  const [screenshotBusy, setScreenshotBusy] = useState(false);
  const [liveScreenActive, setLiveScreenActive] = useState(false);
  const [liveScreenPaused, setLiveScreenPaused] = useState(false);
  const screenshotRequestActiveRef = useRef(false);
  const screenshotAbortRef = useRef<AbortController | undefined>(undefined);
  const [diagnostics, setDiagnostics] = useState<DiagnosticSnapshot | undefined>();
  const [diagnosticsError, setDiagnosticsError] = useState<string | undefined>();
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [technicalApps, setTechnicalApps] = useState<{ packageName: string; label: string }[] | undefined>();
  const [dpcStatus, setDpcStatus] = useState<DpcStatus | undefined>();
  const [dpcError, setDpcError] = useState<string | undefined>();

  const loadRemoteState = useCallback(async () => {
    try {
      const [nextStatus, nextAudit] = await Promise.all([
        controllerApi.remoteStatus(),
        controllerApi.remoteAudit()
      ]);
      setRemoteStatus(nextStatus);
      setRemoteAudit(nextAudit);
      setRemoteError(undefined);
    } catch (error) {
      setRemoteError(
        error instanceof Error ? error.message : "RoshanRemoteAgent status is unavailable."
      );
    }
  }, [controllerApi]);

  const loadDpcState = useCallback(async () => {
    try {
      setDpcStatus(await controllerApi.getDpcStatus());
      setDpcError(undefined);
    } catch (error) {
      setDpcError(error instanceof Error ? error.message : "Device Owner status is unavailable.");
    }
  }, [controllerApi]);

  const loadDiagnostics = useCallback(async () => {
    setDiagnosticsBusy(true);
    try {
      setDiagnostics(await controllerApi.tabletDiagnostics());
      setDiagnosticsError(undefined);
    } catch (error) {
      setDiagnosticsError(
        error instanceof Error ? error.message : "The RoshanOS diagnostic journal is unavailable."
      );
    } finally {
      setDiagnosticsBusy(false);
    }
  }, [controllerApi]);

  const loadTechnicalApps = useCallback(async () => {
    try {
      setTechnicalApps(await controllerApi.listTechnicalApps());
    } catch {
      setTechnicalApps([]);
    }
  }, [controllerApi]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadRemoteState(), 0);
    return () => window.clearTimeout(timer);
  }, [loadRemoteState]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadDpcState(), 0);
    const interval = window.setInterval(() => void loadDpcState(), 30_000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [loadDpcState]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadDiagnostics();
      void loadTechnicalApps();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadDiagnostics, loadTechnicalApps]);

  useEffect(() => {
    return () => {
      if (screenshotUrl !== undefined) URL.revokeObjectURL(screenshotUrl);
    };
  }, [screenshotUrl]);

  const captureRemoteScreenshot = useCallback(
    async (refreshAudit = true): Promise<boolean> => {
      if (screenshotRequestActiveRef.current) return false;
      const requestController = new AbortController();
      screenshotRequestActiveRef.current = true;
      screenshotAbortRef.current = requestController;
      setScreenshotBusy(true);
      try {
        const blob = await controllerApi.remoteScreenshot(requestController.signal);
        if (requestController.signal.aborted) return false;
        const nextUrl = URL.createObjectURL(blob);
        setScreenshotUrl(nextUrl);
        setRemoteError(undefined);
        if (refreshAudit) {
          setRemoteAudit(await controllerApi.remoteAudit());
        }
        return true;
      } catch (error) {
        if (
          requestController.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          return false;
        }
        setRemoteError(
          error instanceof Error ? error.message : "The tablet screenshot could not be captured."
        );
        return false;
      } finally {
        if (screenshotAbortRef.current === requestController) {
          screenshotAbortRef.current = undefined;
          screenshotRequestActiveRef.current = false;
          setScreenshotBusy(false);
        }
      }
    },
    [controllerApi]
  );

  const stopLiveScreen = useCallback(() => {
    setLiveScreenActive(false);
    setLiveScreenPaused(false);
    screenshotAbortRef.current?.abort();
  }, []);

  const liveScreenAvailable =
    !disabled && capabilities?.remoteControl === true && remoteStatus?.enabled === true;

  useEffect(() => {
    if (!liveScreenActive || !liveScreenAvailable) {
      screenshotAbortRef.current?.abort();
      return;
    }

    let stopped = false;
    let timer: number | undefined;
    const tabletLimit = Math.max(
      1,
      Math.min(CONTROLLER_SCREENSHOTS_PER_MINUTE, remoteStatus.maxScreenshotsPerMinute)
    );
    const intervalMs = Math.max(LIVE_SCREEN_MIN_INTERVAL_MS, Math.ceil(60_000 / tabletLimit));

    const clearTimer = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    };
    const schedule = (delayMs: number) => {
      clearTimer();
      timer = window.setTimeout(() => void capture(), delayMs);
    };
    const capture = async () => {
      if (stopped) return;
      if (document.visibilityState !== "visible") {
        setLiveScreenPaused(true);
        return;
      }
      setLiveScreenPaused(false);
      await captureRemoteScreenshot(false);
      if (!stopped && document.visibilityState === "visible") {
        schedule(intervalMs);
      }
    };
    const onVisibilityChange = () => {
      clearTimer();
      if (document.visibilityState !== "visible") {
        setLiveScreenPaused(true);
        screenshotAbortRef.current?.abort();
        return;
      }
      setLiveScreenPaused(false);
      schedule(0);
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule(0);
    return () => {
      stopped = true;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      screenshotAbortRef.current?.abort();
    };
  }, [
    captureRemoteScreenshot,
    liveScreenActive,
    liveScreenAvailable,
    remoteStatus?.maxScreenshotsPerMinute
  ]);

  useEffect(() => {
    return () => screenshotAbortRef.current?.abort();
  }, []);

  function remoteAction(action: () => Promise<{ message: string }>): void {
    runAction(async () => {
      const result = await action();
      await loadRemoteState();
      return result;
    });
  }

  function maintenanceAction(input: DpcMaintenanceAction): void {
    runAction(async () => {
      const result = await controllerApi.setMaintenanceMode(input);
      await loadDpcState();
      return result;
    });
  }

  function clearDiagnosticJournal(): void {
    runAction(async () => {
      setDiagnosticsBusy(true);
      try {
        const result = await controllerApi.clearTabletDiagnostics();
        await loadDiagnostics();
        return {
          message: `Cleared ${result.removedEntries.toString()} diagnostic ${
            result.removedEntries === 1 ? "entry" : "entries"
          }.`
        };
      } finally {
        setDiagnosticsBusy(false);
      }
    });
  }

  const items = [
    {
      label: "Wi-Fi",
      value:
        status.wifiConnected === null
          ? "Not reported"
          : status.wifiConnected
            ? "Connected"
            : "Offline",
      icon: Wifi
    },
    {
      label: "Tailscale",
      value:
        status.tailscaleConnected === null
          ? "Not reported"
          : status.tailscaleConnected
            ? "Connected"
            : "Offline",
      icon: ShieldCheck
    },
    { label: "IP Webcam", value: status.ipWebcamHealthy ? "Healthy" : "Offline", icon: Camera }
  ];

  return (
    <div id="admin-panel" role="tabpanel" aria-label="Admin Diagnostics" className="space-y-4">
      <Panel>
        <h2 className="text-base font-semibold text-zinc-100">Admin Diagnostics</h2>
        <p className="mt-2 text-sm text-zinc-400">
          This page contains technical service statuses and is intended for administrators.
        </p>
      </Panel>

      <Panel>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <LockKeyhole aria-hidden="true" className="mt-0.5 text-cyan-300" size={20} />
            <div>
              <h2 className="text-base font-semibold text-zinc-100">
                Protected owner maintenance
              </h2>
              <p className="mt-1 text-xs leading-5 text-zinc-400">
                Device Owner protections remain enforced during normal use. A confirmed maintenance
                window lasts at most 15 minutes and closes automatically.
              </p>
            </div>
          </div>
          <span
            className={
              "shrink-0 rounded-full px-3 py-1 text-xs font-bold " +
              (dpcStatus?.maintenance?.active === true
                ? "bg-amber-950 text-amber-200"
                : "bg-emerald-950 text-emerald-300")
            }
          >
            {dpcStatus === undefined
              ? "Checking"
              : dpcStatus.maintenance?.active === true
                ? "Maintenance"
                : "Protected"}
          </span>
        </div>

        {dpcError !== undefined ? (
          <p className="mt-3 rounded-xl border border-rose-900 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
            {dpcError}
          </p>
        ) : null}

        <div className="mt-4 rounded-2xl border border-zinc-800 bg-black/70 p-3 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="text-zinc-400">Device Owner</span>
            <span className={dpcStatus?.deviceOwner ? "text-emerald-300" : "text-amber-200"}>
              {dpcStatus === undefined
                ? "Checking"
                : dpcStatus.deviceOwner
                  ? "Active"
                  : "Not active"}
            </span>
          </div>
          {dpcStatus?.maintenance?.active === true ? (
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-zinc-400">Automatic protection restore</span>
              <span className="text-amber-200">
                in {Math.max(1, Math.ceil(dpcStatus.maintenance.remainingSeconds / 60))} min
              </span>
            </div>
          ) : null}
        </div>

        <p className="mt-3 rounded-xl border border-amber-900/80 bg-amber-950/40 px-3 py-2 text-xs leading-5 text-amber-100">
          Warning: maintenance temporarily relaxes package-management and kiosk restrictions. Keep
          the tablet physically supervised and exit as soon as the owner work is complete.
        </p>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <Dialog.Root>
            <Dialog.Trigger asChild>
              <button
                type="button"
                disabled={
                  disabled ||
                  capabilities?.maintenance !== true ||
                  dpcStatus?.deviceOwner !== true ||
                  dpcStatus.maintenance?.active === true
                }
                className="min-h-12 rounded-2xl bg-amber-300 px-3 text-sm font-bold text-slate-950 disabled:opacity-50"
              >
                Enter for 15 minutes
              </button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-40 bg-black/80" />
              <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-amber-800 bg-zinc-900 p-5 shadow-2xl">
                <Dialog.Title className="flex items-center gap-2 text-lg font-bold text-zinc-100">
                  <CircleAlert aria-hidden="true" className="text-amber-300" size={22} />
                  Temporarily relax protections?
                </Dialog.Title>
                <Dialog.Description className="mt-3 text-sm leading-6 text-zinc-300">
                  For the next 15 minutes, protected owner maintenance may expose Android settings
                  and package controls that normal users cannot access. The window automatically
                  expires, but you should still exit it immediately when finished.
                </Dialog.Description>
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      className="min-h-12 rounded-2xl border border-zinc-800 text-sm font-semibold text-zinc-100"
                    >
                      Cancel
                    </button>
                  </Dialog.Close>
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      disabled={disabled || capabilities?.maintenance !== true}
                      onClick={() => maintenanceAction({ action: "enter", durationMinutes: 15 })}
                      className="min-h-12 rounded-2xl bg-amber-300 px-3 text-sm font-bold text-slate-950 disabled:opacity-50"
                    >
                      Confirm 15-minute maintenance
                    </button>
                  </Dialog.Close>
                </div>
                <Dialog.Close
                  aria-label="Close maintenance confirmation"
                  className="absolute right-4 top-4 rounded-lg p-1 text-zinc-400"
                >
                  <X aria-hidden="true" size={18} />
                </Dialog.Close>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
          <button
            type="button"
            disabled={
              disabled ||
              capabilities?.maintenance !== true ||
              dpcStatus?.maintenance?.active !== true
            }
            onClick={() => maintenanceAction({ action: "exit" })}
            className="min-h-12 rounded-2xl border border-emerald-800 bg-emerald-950/40 px-3 text-sm font-semibold text-emerald-200 disabled:opacity-50"
          >
            Exit maintenance now
          </button>
        </div>

        <div className="mt-5 border-t border-zinc-800 pt-4">
          <h3 className="text-sm font-semibold text-zinc-100">Owner PIN recovery</h3>
          <p className="mt-1 text-xs leading-5 text-zinc-400">
            Clear failed-attempt and cooldown counters after verifying that the tablet owner is
            present. This action never reads, accepts, sets, or changes the owner PIN.
          </p>
          <Dialog.Root>
            <Dialog.Trigger asChild>
              <button
                type="button"
                disabled={disabled || capabilities?.adminPinRecovery !== true}
                className="mt-3 min-h-11 w-full rounded-xl border border-rose-900 bg-rose-950/40 px-3 text-sm font-semibold text-rose-200 disabled:opacity-50"
              >
                Reset owner PIN lockout
              </button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-40 bg-black/80" />
              <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-rose-900 bg-zinc-900 p-5 shadow-2xl">
                <Dialog.Title className="flex items-center gap-2 text-lg font-bold text-zinc-100">
                  <CircleAlert aria-hidden="true" className="text-rose-300" size={22} />
                  Clear owner PIN lockout?
                </Dialog.Title>
                <Dialog.Description className="mt-3 text-sm leading-6 text-zinc-300">
                  Continue only after confirming the legitimate owner. This clears failed-attempt,
                  cooldown, and recovery-lock counters. The configured PIN remains unchanged and is
                  never sent to this controller.
                </Dialog.Description>
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      className="min-h-12 rounded-2xl border border-zinc-800 text-sm font-semibold text-zinc-100"
                    >
                      Cancel
                    </button>
                  </Dialog.Close>
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      disabled={disabled || capabilities?.adminPinRecovery !== true}
                      onClick={() => runAction(() => controllerApi.resetAdminPinRateLimit())}
                      className="min-h-12 rounded-2xl bg-rose-500 px-3 text-sm font-bold text-white disabled:opacity-50"
                    >
                      Confirm lockout reset
                    </button>
                  </Dialog.Close>
                </div>
                <Dialog.Close
                  aria-label="Close owner PIN recovery confirmation"
                  className="absolute right-4 top-4 rounded-lg p-1 text-zinc-400"
                >
                  <X aria-hidden="true" size={18} />
                </Dialog.Close>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </div>
      </Panel>

      <TailscaleEnrollmentPanel
        controllerApi={controllerApi}
        disabled={disabled}
        runAction={runAction}
      />

      <SignedUpdatePanel controllerApi={controllerApi} disabled={disabled} runAction={runAction} />

      <div className="grid grid-cols-2 gap-3">
        {items.map(({ label, value, icon: Icon }) => (
          <Panel key={label} className="p-3">
            <Icon aria-hidden="true" className="text-cyan-300" size={18} />
            <p className="mt-3 text-xs text-zinc-400">{label}</p>
            <p className="mt-1 text-sm font-semibold text-zinc-100">{value}</p>
          </Panel>
        ))}
      </div>

      <Panel>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">RoshanCore server health</h2>
            <p className="mt-1 text-xs text-zinc-400">
              Authenticated component-level state reported by the tablet supervisor.
            </p>
          </div>
          <span
            className={
              "rounded-full px-3 py-1 text-xs font-bold " +
              (serverHealth?.healthy
                ? "bg-emerald-950 text-emerald-300"
                : "bg-amber-950 text-amber-200")
            }
          >
            {serverHealth === undefined
              ? "Checking"
              : serverHealth.healthy
                ? "Healthy"
                : "Degraded"}
          </span>
        </div>
        {serverHealth !== undefined ? (
          <>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {Object.entries(serverHealth.components).map(([name, component]) => (
                <div key={name} className="rounded-2xl border border-zinc-800 bg-black/70 p-3">
                  <p className="truncate text-xs text-zinc-400">
                    {name.replace(/([A-Z])/g, " $1").trim()}
                  </p>
                  <p
                    className={
                      "mt-1 text-sm font-semibold capitalize " +
                      (component.state === "healthy" || component.state === "standby"
                        ? "text-emerald-300"
                        : component.state === "starting"
                          ? "text-cyan-300"
                          : "text-amber-200")
                    }
                  >
                    {component.state}
                  </p>
                  {component.degradedReason !== null ? (
                    <p className="mt-1 line-clamp-3 text-[11px] leading-4 text-zinc-500">
                      {component.degradedReason}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
            {serverHealth.degradedReasons.length > 0 ? (
              <ul className="mt-3 space-y-1 text-xs leading-5 text-amber-200">
                {serverHealth.degradedReasons.map((reason) => (
                  <li key={reason}>• {reason}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="mt-4 text-sm text-zinc-500">Waiting for the tablet health probe.</p>
        )}
      </Panel>

      <Panel>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">RoshanOS diagnostic journal</h2>
            <p className="mt-1 text-xs leading-5 text-zinc-400">
              Reboot-persistent, bounded service events from the tablet. Entries contain only
              allowlisted machine-readable fields; credentials, owner PINs, SSIDs, request bodies,
              and URLs are excluded on the tablet.
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-zinc-800 px-3 py-1 text-xs font-bold text-zinc-300">
            {diagnostics === undefined
              ? "Waiting"
              : `${diagnostics.entryCount.toString()} ${
                  diagnostics.entryCount === 1 ? "entry" : "entries"
                }`}
          </span>
        </div>

        {diagnosticsError !== undefined ? (
          <p className="mt-3 rounded-xl border border-rose-900 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
            {diagnosticsError}
          </p>
        ) : null}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            disabled={disabled || diagnosticsBusy}
            onClick={() => void loadDiagnostics()}
            className="min-h-10 flex-1 rounded-xl border border-zinc-800 px-3 text-sm font-semibold text-zinc-100 disabled:opacity-50"
          >
            {diagnosticsBusy ? "Loading…" : "Refresh journal"}
          </button>
          <Dialog.Root>
            <Dialog.Trigger asChild>
              <button
                type="button"
                disabled={
                  disabled ||
                  diagnosticsBusy ||
                  diagnostics === undefined ||
                  diagnostics.entryCount === 0
                }
                className="min-h-10 flex-1 rounded-xl border border-rose-900 bg-rose-950/40 px-3 text-sm font-semibold text-rose-200 disabled:opacity-50"
              >
                Clear journal
              </button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-40 bg-black/80" />
              <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-rose-900 bg-zinc-900 p-5 shadow-2xl">
                <Dialog.Title className="text-lg font-bold text-zinc-100">
                  Clear tablet diagnostics?
                </Dialog.Title>
                <Dialog.Description className="mt-3 text-sm leading-6 text-zinc-300">
                  This permanently removes the current bounded event journal from the tablet. New
                  service events will continue to be recorded.
                </Dialog.Description>
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      className="min-h-11 rounded-xl border border-zinc-800 text-sm font-semibold text-zinc-100"
                    >
                      Cancel
                    </button>
                  </Dialog.Close>
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      disabled={disabled || diagnosticsBusy}
                      onClick={clearDiagnosticJournal}
                      className="min-h-11 rounded-xl bg-rose-500 px-3 text-sm font-bold text-white disabled:opacity-50"
                    >
                      Confirm clear
                    </button>
                  </Dialog.Close>
                </div>
                <Dialog.Close
                  aria-label="Close diagnostics confirmation"
                  className="absolute right-4 top-4 rounded-lg p-1 text-zinc-400"
                >
                  <X aria-hidden="true" size={18} />
                </Dialog.Close>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </div>

        {diagnostics !== undefined && diagnostics.entryCount === 0 ? (
          <p className="mt-4 rounded-xl bg-black px-3 py-3 text-xs text-zinc-500">
            No diagnostic events are currently stored.
          </p>
        ) : null}
        {diagnostics !== undefined && diagnostics.events.length > 0 ? (
          <ol
            aria-label="Tablet diagnostic events"
            className="mt-4 max-h-80 space-y-2 overflow-auto pr-1 text-xs"
          >
            {diagnostics.events
              .slice(-50)
              .reverse()
              .map((entry) => (
                <li
                  key={entry.sequence}
                  className="rounded-xl border border-zinc-800 bg-black/80 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span
                      className={
                        "font-semibold uppercase tracking-wide " +
                        (entry.level === "error"
                          ? "text-rose-300"
                          : entry.level === "warn"
                            ? "text-amber-200"
                            : "text-cyan-300")
                      }
                    >
                      {entry.level}
                    </span>
                    <time
                      className="text-[11px] text-zinc-500"
                      dateTime={new Date(entry.timestampMs).toISOString()}
                    >
                      {new Date(entry.timestampMs).toLocaleString()}
                    </time>
                  </div>
                  <p className="mt-1 break-all font-mono text-zinc-200">
                    {entry.component}.{entry.event}
                  </p>
                  {Object.keys(entry.fields).length > 0 ? (
                    <p className="mt-1 break-all font-mono text-[11px] leading-4 text-zinc-500">
                      {Object.entries(entry.fields)
                        .map(([key, value]) => `${key}=${value}`)
                        .join(" · ")}
                    </p>
                  ) : null}
                </li>
              ))}
          </ol>
        ) : null}
        {diagnostics !== undefined && diagnostics.events.length > 50 ? (
          <p className="mt-2 text-[11px] text-zinc-500">
            Showing the newest 50 of {diagnostics.entryCount.toString()} entries.
          </p>
        ) : null}
      </Panel>

      <Panel>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Technical applications</h2>
            <p className="mt-1 text-xs leading-5 text-zinc-400">
              Hidden device-owner and system packages on the tablet.
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-zinc-800 px-3 py-1 text-xs font-bold text-zinc-300">
            {technicalApps === undefined
              ? "Checking"
              : `${technicalApps.length.toString()} installed`}
          </span>
        </div>
        {technicalApps !== undefined && technicalApps.length > 0 ? (
          <ul className="mt-4 grid gap-2 text-xs">
            {technicalApps.map((app) => (
              <li
                key={app.packageName}
                className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-black/70 px-3 py-2"
              >
                <div className="truncate font-semibold text-zinc-200">{app.label}</div>
                <div className="truncate font-mono text-[11px] text-zinc-500">
                  {app.packageName}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>

      <Panel>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">RoshanRemoteAgent</h2>
            <p className="mt-1 text-xs leading-5 text-zinc-400">
              Disabled by default. Only bounded typed actions are available; there is no shell
              console.
            </p>
          </div>
          <span
            className={
              "rounded-full px-3 py-1 text-xs font-bold " +
              (remoteStatus?.enabled
                ? "bg-emerald-950 text-emerald-300"
                : "bg-zinc-800 text-zinc-300")
            }
          >
            {remoteStatus?.enabled ? "Enabled" : "Disabled"}
          </span>
        </div>

        {remoteError !== undefined ? (
          <p className="mt-3 rounded-xl border border-rose-900 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
            {remoteError}
          </p>
        ) : null}

        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={disabled || capabilities?.remoteControl !== true}
            onClick={() => remoteAction(() => controllerApi.setRemoteEnabled(true))}
            className="min-h-11 rounded-xl bg-cyan-300 px-3 text-sm font-bold text-slate-950 disabled:opacity-50"
          >
            Enable remote
          </button>
          <button
            type="button"
            disabled={disabled || capabilities?.remoteControl !== true}
            onClick={() => {
              stopLiveScreen();
              remoteAction(() => controllerApi.setRemoteEnabled(false));
            }}
            className="min-h-11 rounded-xl border border-zinc-800 px-3 text-sm font-semibold text-zinc-100 disabled:opacity-50"
          >
            Disable remote
          </button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!liveScreenAvailable || screenshotBusy || liveScreenActive}
            onClick={() => void captureRemoteScreenshot()}
            className="min-h-11 rounded-xl border border-cyan-800 bg-cyan-950/50 px-3 text-sm font-semibold text-cyan-100 disabled:opacity-50"
          >
            {screenshotBusy && !liveScreenActive ? "Capturing…" : "Capture once"}
          </button>
          <button
            type="button"
            aria-pressed={liveScreenActive}
            disabled={!liveScreenActive && (!liveScreenAvailable || screenshotBusy)}
            onClick={() => {
              if (liveScreenActive) {
                stopLiveScreen();
              } else {
                setLiveScreenActive(true);
              }
            }}
            className={
              "min-h-11 rounded-xl px-3 text-sm font-bold disabled:opacity-50 " +
              (liveScreenActive
                ? "border border-rose-800 bg-rose-950/50 text-rose-100"
                : "bg-cyan-300 text-slate-950")
            }
          >
            {liveScreenActive ? "Stop live screen" : "Start live screen"}
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-4 text-zinc-500">
          Live screen is owner opt-in and refreshes at most 20 times per minute. It pauses while
          this page is hidden and never starts a second capture before the first finishes.
        </p>
        <p
          role="status"
          aria-live="polite"
          className={
            "mt-2 text-xs " +
            (liveScreenActive && liveScreenAvailable
              ? "text-emerald-300"
              : liveScreenActive
                ? "text-amber-200"
                : "text-zinc-500")
          }
        >
          {liveScreenActive
            ? !liveScreenAvailable
              ? "Live screen capture is unavailable and paused."
              : liveScreenPaused
                ? "Live screen paused while this page is hidden."
                : screenshotBusy
                  ? "Live screen active · refreshing"
                  : "Live screen active · waiting for next refresh"
            : "Live screen stopped."}
        </p>
        {screenshotUrl !== undefined ? (
          <img
            src={screenshotUrl}
            alt="Latest authenticated screenshot from the tablet"
            className="mt-3 max-h-96 w-full rounded-2xl border border-zinc-800 bg-black object-contain"
          />
        ) : null}

        <div className="mt-4 grid gap-3">
          <form
            className="grid grid-cols-[1fr_1fr_auto] gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              remoteAction(() =>
                controllerApi.remoteTap(
                  Number(values.get("remote-x")),
                  Number(values.get("remote-y"))
                )
              );
            }}
          >
            <label className="grid gap-1 text-xs text-zinc-400">
              Tap X
              <input
                name="remote-x"
                type="number"
                required
                min={0}
                max={(remoteStatus?.screenWidth ?? 1) - 1}
                disabled={disabled || remoteStatus?.enabled !== true}
                className="min-h-10 rounded-xl border border-zinc-800 bg-black px-2 text-zinc-100"
              />
            </label>
            <label className="grid gap-1 text-xs text-zinc-400">
              Tap Y
              <input
                name="remote-y"
                type="number"
                required
                min={0}
                max={(remoteStatus?.screenHeight ?? 1) - 1}
                disabled={disabled || remoteStatus?.enabled !== true}
                className="min-h-10 rounded-xl border border-zinc-800 bg-black px-2 text-zinc-100"
              />
            </label>
            <button
              type="submit"
              disabled={disabled || remoteStatus?.enabled !== true}
              className="mt-5 min-h-10 rounded-xl border border-zinc-800 px-3 text-sm font-semibold disabled:opacity-50"
            >
              Tap
            </button>
          </form>

          <form
            className="grid grid-cols-2 gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              remoteAction(() =>
                controllerApi.remoteSwipe({
                  startX: Number(values.get("swipe-start-x")),
                  startY: Number(values.get("swipe-start-y")),
                  endX: Number(values.get("swipe-end-x")),
                  endY: Number(values.get("swipe-end-y")),
                  durationMs: Number(values.get("swipe-duration"))
                })
              );
            }}
          >
            {[
              ["swipe-start-x", "Start X", (remoteStatus?.screenWidth ?? 1) - 1],
              ["swipe-start-y", "Start Y", (remoteStatus?.screenHeight ?? 1) - 1],
              ["swipe-end-x", "End X", (remoteStatus?.screenWidth ?? 1) - 1],
              ["swipe-end-y", "End Y", (remoteStatus?.screenHeight ?? 1) - 1]
            ].map(([name, label, max]) => (
              <label key={String(name)} className="grid gap-1 text-xs text-zinc-400">
                {label}
                <input
                  name={String(name)}
                  type="number"
                  required
                  min={0}
                  max={Number(max)}
                  disabled={disabled || remoteStatus?.enabled !== true}
                  className="min-h-10 rounded-xl border border-zinc-800 bg-black px-2 text-zinc-100"
                />
              </label>
            ))}
            <label className="grid gap-1 text-xs text-zinc-400">
              Duration ms
              <input
                name="swipe-duration"
                type="number"
                required
                min={50}
                max={2000}
                defaultValue={300}
                disabled={disabled || remoteStatus?.enabled !== true}
                className="min-h-10 rounded-xl border border-zinc-800 bg-black px-2 text-zinc-100"
              />
            </label>
            <button
              type="submit"
              disabled={disabled || remoteStatus?.enabled !== true}
              className="mt-5 min-h-10 rounded-xl border border-zinc-800 px-3 text-sm font-semibold disabled:opacity-50"
            >
              Swipe
            </button>
          </form>

          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const key = String(new FormData(event.currentTarget).get("remote-key")) as RemoteKey;
              remoteAction(() => controllerApi.remoteKey(key));
            }}
          >
            <label className="sr-only" htmlFor="remote-key">
              Remote key
            </label>
            <select
              id="remote-key"
              name="remote-key"
              required
              disabled={disabled || remoteStatus?.enabled !== true}
              className="min-h-11 min-w-0 flex-1 rounded-xl border border-zinc-800 bg-black px-2 text-sm"
            >
              {(remoteStatus?.allowedKeys ?? []).map((key) => (
                <option key={key} value={key}>
                  {key.replaceAll("_", " ")}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={disabled || remoteStatus?.enabled !== true}
              className="min-h-11 rounded-xl border border-zinc-800 px-3 text-sm font-semibold disabled:opacity-50"
            >
              Send key
            </button>
          </form>

          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const text = String(new FormData(event.currentTarget).get("remote-text") ?? "");
              remoteAction(() => controllerApi.remoteText(text));
              event.currentTarget.reset();
            }}
          >
            <label className="sr-only" htmlFor="remote-text">
              Bounded remote text
            </label>
            <input
              id="remote-text"
              name="remote-text"
              required
              minLength={1}
              maxLength={120}
              pattern="[A-Za-z0-9 .,!?\@_+\-]+"
              placeholder="Safe text (max 120)"
              disabled={disabled || remoteStatus?.enabled !== true}
              className="min-h-11 min-w-0 flex-1 rounded-xl border border-zinc-800 bg-black px-3 text-sm"
            />
            <button
              type="submit"
              disabled={disabled || remoteStatus?.enabled !== true}
              className="min-h-11 rounded-xl border border-zinc-800 px-3 text-sm font-semibold disabled:opacity-50"
            >
              Type
            </button>
          </form>

          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const packageName = String(
                new FormData(event.currentTarget).get("close-package") ?? ""
              );
              remoteAction(() => controllerApi.closeApprovedApp(packageName));
            }}
          >
            <label className="sr-only" htmlFor="close-package">
              Approved application to close
            </label>
            <select
              id="close-package"
              name="close-package"
              required
              disabled={disabled || remoteStatus?.enabled !== true}
              className="min-h-11 min-w-0 flex-1 rounded-xl border border-zinc-800 bg-black px-2 text-sm"
            >
              <option value="">Approved app to close</option>
              {apps
                .filter(
                  (app) =>
                    app.packageName !== undefined &&
                    (app.status === undefined || app.status === "approved")
                )
                .map((app) => (
                  <option key={app.packageName} value={app.packageName}>
                    {app.label}
                  </option>
                ))}
            </select>
            <button
              type="submit"
              disabled={disabled || remoteStatus?.enabled !== true}
              className="min-h-11 rounded-xl border border-zinc-800 px-3 text-sm font-semibold disabled:opacity-50"
            >
              Close
            </button>
          </form>
        </div>

        <div className="mt-4 border-t border-zinc-800 pt-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
              Recent typed-action audit
            </p>
            <button
              type="button"
              onClick={() => void loadRemoteState()}
              className="text-xs text-cyan-300 underline"
            >
              Refresh
            </button>
          </div>
          {remoteAudit.length === 0 ? (
            <p className="mt-2 text-xs text-zinc-500">
              No remote actions in this process session.
            </p>
          ) : (
            <ul className="mt-2 max-h-40 space-y-1 overflow-auto text-xs">
              {remoteAudit
                .slice(-12)
                .reverse()
                .map((event, index) => (
                  <li
                    key={`${event.timestamp}-${event.action}-${index}`}
                    className="flex items-center justify-between gap-3 rounded-lg bg-black px-2 py-1.5"
                  >
                    <span className="truncate text-zinc-300">{event.action}</span>
                    <span className={event.success ? "text-emerald-300" : "text-rose-300"}>
                      {event.success ? "ok" : "rejected"}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </div>
      </Panel>

      <Panel>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-100">Touch Lock</h2>
          {status.touchLock ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/50 bg-red-950/70 px-3 py-1 text-xs font-bold text-red-200 ring-2 ring-red-500/30">
              <span className="h-2 w-2 rounded-full bg-red-400 animate-pulse"></span> 🔒 Screen
              Locked
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-600/50 bg-emerald-950/50 px-3 py-1 text-xs font-bold text-emerald-300">
              🔓 Screen Unlocked
            </span>
          )}
        </div>
        <p className="mt-2 text-sm text-zinc-400">
          Enabling Touch Lock prevents the physical screen from being used, until unlocked or
          rebooted.
        </p>
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            disabled={disabled || !capabilities?.touchLock}
            onClick={() => onTouchLock(true)}
            className={`flex-1 min-h-12 rounded-2xl border text-sm font-semibold transition-all duration-150 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:opacity-50 ${
              status.touchLock
                ? "border-red-500/50 bg-red-950/70 text-red-200 ring-2 ring-red-500/30"
                : "border-zinc-800 bg-black text-zinc-100 hover:border-red-700 hover:text-red-200"
            }`}
          >
            🔒 Lock Touch
          </button>
          <button
            type="button"
            disabled={disabled || !capabilities?.touchLock}
            onClick={() => onTouchLock(false)}
            className={`flex-1 min-h-12 rounded-2xl border text-sm font-semibold transition-all duration-150 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:opacity-50 ${
              !status.touchLock
                ? "border-emerald-600/50 bg-emerald-950/50 text-emerald-200"
                : "border-zinc-800 bg-black text-zinc-100 hover:border-emerald-700 hover:text-emerald-200"
            }`}
          >
            🔓 Unlock Touch
          </button>
        </div>
      </Panel>

      <Panel>
        <h2 className="text-base font-semibold text-zinc-100">Orientation</h2>
        <p className="mt-2 text-sm text-zinc-400">
          Force the tablet into a specific rotation. Current:{" "}
          {status.screenOrientation ?? "Unknown"}.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          {(["auto", "landscape", "portrait", "reverse-landscape"] as ScreenOrientation[]).map(
            (orientation) => (
              <button
                key={orientation}
                type="button"
                disabled={disabled || !capabilities?.orientation}
                onClick={() => onOrientation(orientation)}
                className="flex-1 min-w-24 min-h-12 rounded-2xl border border-zinc-800 bg-black text-sm font-semibold text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:opacity-50"
              >
                {orientation.charAt(0).toUpperCase() + orientation.slice(1).replace("-", " ")}
              </button>
            )
          )}
        </div>
      </Panel>

      <div className="flex items-center justify-between text-xs text-zinc-500 mt-8 mb-24 px-4 text-center">
        <span>Controller API: {apiVersion}</span>
        <button
          onClick={() => {
            if ("serviceWorker" in navigator) {
              navigator.serviceWorker.getRegistrations().then((regs) => {
                regs.forEach((reg) => reg.unregister());
                caches.keys().then((keys) => {
                  Promise.all(keys.map((k) => caches.delete(k))).then(() => {
                    window.location.reload();
                  });
                });
              });
            } else {
              window.location.reload();
            }
          }}
          className="underline hover:text-zinc-300"
        >
          Force Reload
        </button>
      </div>
    </div>
  );
}

export function AppsPanel({
  apps,
  disabled,
  onLaunchApp,
  onApproveApp,
  onRevokeApp
}: {
  apps: ApprovedApp[];
  disabled: boolean;
  onLaunchApp: (appId: string) => void;
  onApproveApp: (packageName: string) => void;
  onRevokeApp: (packageName: string) => void;
}) {
  const visibleApps = apps.filter((app) => app.status !== "technical");
  const approvedApps = visibleApps.filter(
    (app) => app.status === undefined || app.status === "approved"
  );
  const discoveredApps = visibleApps.filter((app) => app.status === "discovered");

  return (
    <div id="apps-panel" role="tabpanel" aria-label="Apps" className="space-y-4">
      <Panel>
        <div className="flex items-center gap-2">
          <AppWindow aria-hidden="true" className="text-cyan-300" size={19} />
          <h2 className="text-base font-semibold text-zinc-100">Approved applications</h2>
        </div>
        <p className="mt-2 text-xs leading-5 text-zinc-400">
          Only approved everyday apps can be opened. Technical RoshanOS packages never appear in
          this list.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          {approvedApps.map((app) => (
            <div key={app.id} className="rounded-2xl border border-zinc-800 bg-black p-3">
              <p className="truncate text-sm font-semibold text-zinc-100">{app.label}</p>
              <div className="mt-3 grid gap-2">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onLaunchApp(app.id)}
                  className="min-h-11 rounded-xl bg-cyan-300 px-3 text-sm font-bold text-slate-950 disabled:opacity-50"
                >
                  Open {app.label}
                </button>
                {app.packageName !== undefined ? (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onRevokeApp(app.packageName!)}
                    className="min-h-10 rounded-xl border border-rose-900 px-3 text-xs font-semibold text-rose-200 disabled:opacity-50"
                  >
                    Revoke {app.label}
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        {approvedApps.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">No approved launchable apps were found.</p>
        ) : null}
      </Panel>

      <Panel>
        <div className="flex items-center gap-2">
          <LayoutGrid aria-hidden="true" className="text-cyan-300" size={19} />
          <h2 className="text-base font-semibold text-zinc-100">Discovered applications</h2>
        </div>
        <p className="mt-2 text-xs leading-5 text-zinc-400">
          Approve an installed non-technical app before it can appear on RoshanOS Home or be opened
          remotely.
        </p>
        <div className="mt-4 grid gap-3">
          {discoveredApps.map((app) => (
            <div
              key={app.id}
              className="flex min-h-14 items-center justify-between gap-3 rounded-2xl border border-zinc-800 bg-black px-4"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-zinc-100">
                  {app.label}
                </span>
                <span className="block truncate text-[11px] text-zinc-500">
                  {app.packageName ?? "Package identifier unavailable"}
                </span>
              </span>
              <button
                type="button"
                disabled={disabled || app.packageName === undefined}
                onClick={() => {
                  if (app.packageName !== undefined) onApproveApp(app.packageName);
                }}
                className="min-h-10 shrink-0 rounded-xl border border-cyan-700 bg-cyan-950/50 px-3 text-xs font-bold text-cyan-100 disabled:opacity-50"
              >
                Approve {app.label}
              </button>
            </div>
          ))}
        </div>
        {discoveredApps.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">
            No additional non-technical applications were discovered.
          </p>
        ) : null}
      </Panel>
    </div>
  );
}

export function MusicPanel({
  disabled,
  onMediaControl,
  mediaVolume
}: {
  disabled: boolean;
  onMediaControl: (action: "play-pause" | "next" | "previous") => void;
  mediaVolume?: number | null;
}) {
  const [isPlaying, setIsPlaying] = useState(false);

  const handlePlayPause = () => {
    setIsPlaying((prev) => !prev);
    onMediaControl("play-pause");
  };

  const handleNext = () => {
    setIsPlaying(true);
    onMediaControl("next");
  };

  const handlePrevious = () => {
    setIsPlaying(true);
    onMediaControl("previous");
  };

  const isMuted = mediaVolume === 0;

  return (
    <div id="music-panel" role="tabpanel" aria-label="Music" className="space-y-4">
      <Panel>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Music aria-hidden="true" className="text-cyan-300" size={19} />
            <h2 className="text-base font-semibold text-zinc-100">Media Controls</h2>
          </div>
          {isPlaying && !isMuted ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-500/50 bg-cyan-950/70 px-3 py-1 text-xs font-bold text-cyan-200 ring-2 ring-cyan-500/30">
              <span className="flex items-end gap-0.5 h-3">
                <span
                  className="w-0.5 bg-cyan-400 rounded-full animate-[music-bar_0.8s_ease-in-out_infinite]"
                  style={{ height: "40%" }}
                ></span>
                <span
                  className="w-0.5 bg-cyan-400 rounded-full animate-[music-bar_0.8s_ease-in-out_0.2s_infinite]"
                  style={{ height: "80%" }}
                ></span>
                <span
                  className="w-0.5 bg-cyan-400 rounded-full animate-[music-bar_0.8s_ease-in-out_0.4s_infinite]"
                  style={{ height: "60%" }}
                ></span>
                <span
                  className="w-0.5 bg-cyan-400 rounded-full animate-[music-bar_0.8s_ease-in-out_0.1s_infinite]"
                  style={{ height: "100%" }}
                ></span>
              </span>
              🎵 Playing
            </span>
          ) : isMuted ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-600/50 bg-amber-950/50 px-3 py-1 text-xs font-bold text-amber-300">
              🔇 Audio Muted
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs font-medium text-zinc-400">
              ⏸️ Paused
            </span>
          )}
        </div>
        <p className="mt-2 text-xs leading-5 text-zinc-400">
          Control music or video playing on the tablet.
        </p>
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            disabled={disabled}
            onClick={handlePrevious}
            className="flex-1 min-h-16 rounded-2xl border border-zinc-800 bg-black text-sm font-semibold text-zinc-100 transition-all duration-150 active:scale-95 hover:border-zinc-700 hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:opacity-50"
          >
            ⏮️ Prev
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={handlePlayPause}
            className={`flex-2 min-w-0 flex-grow-[2] min-h-16 rounded-2xl border text-sm font-bold transition-all duration-150 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:opacity-50 ${
              isPlaying
                ? "border-cyan-500/50 bg-cyan-950/70 text-cyan-100 ring-2 ring-cyan-500/30"
                : "border-zinc-800 bg-black text-zinc-100 hover:border-cyan-700 hover:bg-zinc-900"
            }`}
          >
            {isPlaying ? "⏸️ Pause" : "▶️ Play"}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={handleNext}
            className="flex-1 min-h-16 rounded-2xl border border-zinc-800 bg-black text-sm font-semibold text-zinc-100 transition-all duration-150 active:scale-95 hover:border-zinc-700 hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:opacity-50"
          >
            ⏭️ Next
          </button>
        </div>
      </Panel>
    </div>
  );
}

export function LocationPanel({
  disabled,
  locationData,
  onSetMode,
  onFindSound,
  onStopSound
}: {
  disabled: boolean;
  locationData: LocationData | undefined;
  onSetMode: (mode: string) => void;
  onFindSound: (durationSeconds: number) => void;
  onStopSound: () => void;
}) {
  const mode = locationData?.mode ?? "OFF";
  const hasFix = locationData?.hasFix === true;
  const lat = locationData?.latitude;
  const lng = locationData?.longitude;
  const acc = locationData?.accuracy;

  return (
    <div id="location-panel" role="tabpanel" aria-label="Location" className="space-y-4">
      <Panel>
        <div className="flex items-center gap-2">
          <MapPin aria-hidden="true" className="text-cyan-300" size={19} />
          <h2 className="text-base font-semibold text-zinc-100">Location & Find Device</h2>
        </div>
        <p className="mt-2 text-xs leading-5 text-zinc-400">
          Administrator-managed location tracking and remote device locator sound.
        </p>

        <div className="mt-4">
          <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Tracking Mode
          </label>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {(["OFF", "ON_DEMAND", "PERIODIC", "LOST_DEVICE"] as const).map((m) => (
              <button
                key={m}
                type="button"
                disabled={disabled}
                onClick={() => onSetMode(m)}
                className={
                  "min-h-12 rounded-xl border px-3 text-xs font-bold transition disabled:opacity-50 " +
                  (mode === m
                    ? "border-cyan-400 bg-cyan-400/20 text-cyan-200"
                    : "border-zinc-800 bg-black text-zinc-300 hover:border-zinc-800")
                }
              >
                {m.replace("_", " ")}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-zinc-800 bg-black p-4 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-400">Fix Status</span>
            <span className={hasFix ? "font-bold text-emerald-400" : "text-amber-400"}>
              {hasFix ? "Position Fix Active" : "Waiting for GPS Fix"}
            </span>
          </div>
          {hasFix ? (
            <>
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-400">Coordinates</span>
                <span className="font-mono text-cyan-300">
                  {lat?.toFixed(5)}, {lng?.toFixed(5)}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-400">Accuracy</span>
                <span className="text-zinc-200">{acc ? `±${acc.toFixed(1)}m` : "N/A"}</span>
              </div>
            </>
          ) : null}
        </div>

        {hasFix && lat && lng ? (
          <div className="mt-4 overflow-hidden rounded-2xl border border-zinc-800">
            <iframe
              title="Device Location Map"
              width="100%"
              height="200"
              frameBorder="0"
              scrolling="no"
              src={`https://www.openstreetmap.org/export/embed.html?bbox=${lng - 0.005},${lat - 0.005},${lng + 0.005},${lat + 0.005}&layer=mapnik&marker=${lat},${lng}`}
            />
          </div>
        ) : null}
      </Panel>

      <Panel>
        <div className="flex items-center gap-2">
          <Volume2 aria-hidden="true" className="text-cyan-300" size={19} />
          <h2 className="text-base font-semibold text-zinc-100">Find Device Sound</h2>
        </div>
        <p className="mt-2 text-xs leading-5 text-zinc-400">
          Play an audible alarm tone on the tablet to locate it.
        </p>
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onFindSound(15)}
            className="flex-1 min-h-14 rounded-2xl bg-cyan-300 font-bold text-slate-950 hover:bg-cyan-200 disabled:opacity-50"
          >
            Play Sound (15s)
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={onStopSound}
            className="min-h-14 rounded-2xl border border-zinc-800 bg-black px-4 text-sm font-semibold text-zinc-200 hover:border-zinc-700 disabled:opacity-50"
          >
            Stop Sound
          </button>
        </div>
      </Panel>
    </div>
  );
}

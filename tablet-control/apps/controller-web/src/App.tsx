import { useEffect, useRef, useState } from "react";
import type {
  ApprovedApp,
  CameraStatus,
  ControllerCapabilities,
  ServerHealth,
  TabletStatus
} from "@tablet-control/shared-types";
import { controllerApi, ControllerApiError, type LocationData, type SessionData } from "./api";
import {
  BottomTabs,
  DevicePanel,
  DisplayPanel,
  LivePanel,
  NoticeBar,
  StatusHeader,
  TalkPanel,
  AdminPanel,
  AppsPanel,
  MusicPanel,
  LocationPanel,
  type Notice,
  type TabId
} from "./components";
import type { AudioState, VideoState } from "./stream-states.js";
import { PollingCoordinator } from "./pollingCoordinator.js";

const fallbackStatus: TabletStatus = {
  mode: "mock",
  online: false,
  batteryPercent: null,
  charging: null,
  batteryTemperatureC: null,
  mediaVolume: null,
  mediaVolumeMax: null,
  brightness: null,
  brightnessMode: null,
  screenTimeoutMs: null,
  screenOrientation: null,
  screenOn: null,
  keyguardLocked: null,
  deviceLocked: null,
  wifiConnected: null,
  tailscaleConnected: null,
  connectivity: null,
  memory: null,
  foregroundApp: null,
  boot: null,
  update: null,
  transport: "mock",
  readOnlyLatencyMs: null,
  ipWebcamHealthy: false,
  fullyKioskHealthy: null,
  companionHealthy: null,
  storageFreeMb: null,
  uptimeSeconds: null
};

const fallbackCamera: CameraStatus = {
  mode: "mock",
  healthy: false,
  activeCamera: null,
  orientation: null,
  listeningEnabled: false,
  zoom: null,
  quality: null,
  resolution: null,
  fps: null,
  focusMode: null,
  hasTorch: false,
  transport: "mock",
  lastStatusLatencyMs: null
};

function errorMessage(error: unknown): string {
  if (error instanceof ControllerApiError) {
    return error.message;
  }

  return "The local controller did not respond.";
}

export function App() {
  const [session, setSession] = useState<SessionData | undefined>();
  const [loadingSession, setLoadingSession] = useState(true);
  const [status, setStatus] = useState<TabletStatus>(fallbackStatus);
  const [camera, setCamera] = useState<CameraStatus>(fallbackCamera);
  const [capabilities, setCapabilities] = useState<ControllerCapabilities | undefined>();
  const [activeTab, setActiveTab] = useState<TabId>(
    () => (localStorage.getItem("tc-tab") as TabId) ?? "live"
  );
  const [notice, setNotice] = useState<Notice | undefined>();
  const [videoState, setVideoState] = useState<VideoState>("idle");
  const [audioState, setAudioState] = useState<AudioState>("idle");
  const [busy, setBusy] = useState(false);
  const [transmitting, setTransmitting] = useState(false);
  const [apiVersion, setApiVersion] = useState<string>("unknown");
  const [apps, setApps] = useState<ApprovedApp[]>([]);
  const [locationData, setLocationData] = useState<LocationData>();
  const [serverHealth, setServerHealth] = useState<ServerHealth | undefined>();
  const readOnly = session?.mode === "real-readonly" || status.mode === "real-readonly";
  const realStreams = session?.mode !== undefined && session.mode !== "mock";

  const talkWsRef = useRef<WebSocket | null>(null);
  const talkStreamRef = useRef<MediaStream | null>(null);
  const talkCtxRef = useRef<AudioContext | null>(null);
  const talkProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const talkGainRef = useRef<GainNode | null>(null);
  const talkAttemptRef = useRef(0);
  const pollingCoordinatorRef = useRef<PollingCoordinator | null>(null);
  const initialTabRef = useRef(activeTab);

  useEffect(() => {
    return () => {
      cleanupTalk();
      pollingCoordinatorRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const existingSession = await controllerApi.session();
        setSession(existingSession);

        pollingCoordinatorRef.current?.stop();
        pollingCoordinatorRef.current = new PollingCoordinator(controllerApi, {
          onStatus: setStatus,
          onCamera: setCamera,
          onCapabilities: setCapabilities,
          onVersion: (v) => setApiVersion(v.apiBuild),
          onApps: setApps,
          onLocation: setLocationData,
          onHealth: setServerHealth,
          onError: (error) => {
            if (error instanceof ControllerApiError && error.code === "RATE_LIMITED") {
              setNotice({
                tone: "info",
                message: "Request limit reached. Polling will slow down automatically."
              });
            }
          }
        });
        pollingCoordinatorRef.current.setTab(initialTabRef.current);
        pollingCoordinatorRef.current.start();
      } catch {
        setSession(undefined);
      } finally {
        setLoadingSession(false);
      }
    })();
  }, []);

  async function refresh(): Promise<void> {
    await pollingCoordinatorRef.current?.refreshOnce();
  }

  async function runAction(action: () => Promise<{ message: string }>): Promise<void> {
    if (readOnly) {
      setNotice({
        tone: "info",
        message:
          "This tablet is connected in read-only mode; the requested control remains unavailable."
      });
      return;
    }

    setBusy(true);
    try {
      const result = await action();
      await refresh();
      setNotice({ tone: "success", message: result.message });
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function runCameraAction(action: () => Promise<{ message: string }>): Promise<void> {
    setBusy(true);
    try {
      const result = await action();
      await refresh();
      setNotice({ tone: "success", message: result.message });
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function runAppMutation(action: () => Promise<{ message: string }>): Promise<void> {
    await runAction(async () => {
      const result = await action();
      setApps(await controllerApi.listApps());
      return result;
    });
  }

  async function signIn(username: string, password: string): Promise<void> {
    setBusy(true);
    try {
      const nextSession = await controllerApi.login(username, password);
      setSession(nextSession);

      pollingCoordinatorRef.current?.stop();
      pollingCoordinatorRef.current = new PollingCoordinator(controllerApi, {
        onStatus: setStatus,
        onCamera: setCamera,
        onCapabilities: setCapabilities,
        onVersion: (v) => setApiVersion(v.apiBuild),
        onApps: setApps,
        onLocation: setLocationData,
        onHealth: setServerHealth,
        onError: (error) => {
          if (error instanceof ControllerApiError && error.code === "RATE_LIMITED") {
            setNotice({
              tone: "info",
              message: "Request limit reached. Polling will slow down automatically."
            });
          }
        }
      });
      pollingCoordinatorRef.current.setTab(activeTab);
      pollingCoordinatorRef.current.start();

      setNotice({
        tone: "info",
        message:
          nextSession.mode === "real-readonly"
            ? "Signed in. Camera controls are active. Display and device controls require RoshanCore."
            : nextSession.mode === "companion"
              ? "Signed in. Live camera, tablet display, and device controls are connected."
              : "Signed in. No tablet command was sent."
      });
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  function handleTabChange(tab: TabId): void {
    setActiveTab(tab);
    pollingCoordinatorRef.current?.setTab(tab);
    if (tab !== "live") {
      setVideoState("idle");
      setAudioState("idle");
    }
    try {
      localStorage.setItem("tc-tab", tab);
    } catch {
      // storage unavailable — ignore
    }
  }

  async function signOut(): Promise<void> {
    setBusy(true);
    try {
      await controllerApi.logout();
      pollingCoordinatorRef.current?.stop();
      pollingCoordinatorRef.current = null;
      setSession(undefined);
      setNotice({ tone: "info", message: "Signed out of the local controller." });
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  function cleanupTalk(): void {
    talkAttemptRef.current += 1;
    talkProcessorRef.current?.disconnect();
    talkProcessorRef.current = null;
    talkGainRef.current?.disconnect();
    talkGainRef.current = null;
    void talkCtxRef.current?.close();
    talkCtxRef.current = null;
    talkStreamRef.current?.getTracks().forEach((t) => t.stop());
    talkStreamRef.current = null;
    const ws = talkWsRef.current;
    talkWsRef.current = null;
    if (ws !== null)
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    setTransmitting(false);
  }

  function startTalk(): void {
    if (
      readOnly ||
      capabilities?.pushToTalk !== true ||
      transmitting ||
      busy ||
      talkWsRef.current !== null
    )
      return;

    if (session?.mode === "mock") {
      setTransmitting(true);
      return;
    }

    const attempt = talkAttemptRef.current + 1;
    talkAttemptRef.current = attempt;
    const mediaPromise = navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true
      }
    });
    const ctx = new AudioContext({ sampleRate: 16000 });
    talkCtxRef.current = ctx;
    void ctx.resume();

    void mediaPromise
      .then((stream) => {
        if (talkAttemptRef.current !== attempt) {
          stream.getTracks().forEach((track) => track.stop());
        } else {
          talkStreamRef.current = stream;
        }
      })
      .catch(() => {
        if (talkAttemptRef.current === attempt) {
          setNotice({ tone: "error", message: "Microphone access denied." });
          cleanupTalk();
        }
      });

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/api/v1/talk`);
    talkWsRef.current = ws;

    ws.onopen = () => {
      ws.send('{"type":"talk-start"}');
    };

    ws.onerror = () => {
      cleanupTalk();
      setNotice({ tone: "error", message: "Push-to-talk connection failed." });
    };

    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      const msg = JSON.parse(e.data as string) as { type: string };

      if (msg.type === "talking") {
        if (talkAttemptRef.current !== attempt) return;
        setTransmitting(true);
        void (async () => {
          try {
            const stream = await mediaPromise;
            if (talkAttemptRef.current !== attempt) {
              stream.getTracks().forEach((track) => track.stop());
              return;
            }
            talkStreamRef.current = stream;
            await ctx.resume();
            const source = ctx.createMediaStreamSource(stream);
            const processor = ctx.createScriptProcessor(1024, 1, 1);
            const silentGain = ctx.createGain();
            silentGain.gain.value = 0;
            talkProcessorRef.current = processor;
            talkGainRef.current = silentGain;
            processor.onaudioprocess = (ae) => {
              if (ws.readyState !== WebSocket.OPEN) return;
              const f32 = ae.inputBuffer.getChannelData(0);
              const outputLength = f32.length;
              const i16 = new Int16Array(outputLength);
              for (let i = 0; i < outputLength; i++) {
                i16[i] = Math.max(-32768, Math.min(32767, (f32[i] * 32767) | 0));
              }
              ws.send(i16.buffer);
            };
            source.connect(processor);
            processor.connect(silentGain);
            silentGain.connect(ctx.destination);
          } catch {
            if (talkAttemptRef.current !== attempt) return;
            setNotice({ tone: "error", message: "Microphone access denied." });
            if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"talk-stop"}');
            cleanupTalk();
          }
        })();
      }

      if (msg.type === "idle") cleanupTalk();
    };

    ws.onclose = () => {
      cleanupTalk();
    };
  }

  function stopTalk(): void {
    if (session?.mode === "mock") {
      setTransmitting(false);
      return;
    }

    const ws = talkWsRef.current;
    if (ws !== null && ws.readyState === WebSocket.OPEN) {
      ws.send('{"type":"talk-stop"}');
    }
    cleanupTalk();
  }

  if (loadingSession) {
    return (
      <main className="grid min-h-screen place-items-center bg-black px-6 text-center text-slate-300">
        <p>Loading local controller…</p>
      </main>
    );
  }

  if (session === undefined) {
    return <LoginScreen busy={busy} notice={notice} onSubmit={signIn} />;
  }

  const onlineLabel = status.online
    ? readOnly
      ? "Camera stream available"
      : "Tablet online"
    : readOnly
      ? "Camera stream unavailable"
      : "Tablet offline";

  return (
    <main className="min-h-screen bg-black text-slate-100">
      <StatusHeader status={status} videoState={videoState} audioState={audioState} />
      <div className="mx-auto max-w-xl space-y-4 px-4 pb-28 pt-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-slate-400" aria-live="polite">
            {onlineLabel}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void signOut()}
            className="min-h-11 rounded-xl border border-zinc-800 px-3 text-sm font-semibold text-slate-200 disabled:opacity-50"
          >
            Sign out
          </button>
        </div>
        <NoticeBar notice={notice} />
        {activeTab === "live" ? (
          <LivePanel
            camera={camera}
            busy={busy}
            streamAvailable={realStreams}
            {...(realStreams
              ? { onVideoStateChange: setVideoState, onAudioStateChange: setAudioState }
              : {})}
            onSelectCamera={async (selectedCamera) => {
              // 1. Detach stream and cleanup talk
              setVideoState("idle");
              cleanupTalk();

              await runCameraAction(async () => {
                const result = await controllerApi.selectCamera(selectedCamera);

                // Fetch new state to confirm
                const newCameraState = await controllerApi.cameraStatus();
                if (newCameraState.activeCamera !== selectedCamera) {
                  throw new Error("Failed to switch camera.");
                }

                return result;
              });
            }}
            onOrientation={(orientation) =>
              void runCameraAction(() => controllerApi.setCameraOrientation(orientation))
            }
            onZoom={(zoom) => void runCameraAction(() => controllerApi.setZoom(zoom))}
            onQuality={(quality) => void runCameraAction(() => controllerApi.setQuality(quality))}
            onFps={(fps) => void runCameraAction(() => controllerApi.setFps(fps))}
            onResolution={(resolution) =>
              void runCameraAction(() => controllerApi.setResolution(resolution))
            }
            onFocus={(mode) => void runCameraAction(() => controllerApi.setFocus(mode))}
            onAutofocus={() => void runCameraAction(() => controllerApi.triggerAutofocus())}
          />
        ) : null}
        {activeTab === "talk" ? (
          <TalkPanel
            transmitting={transmitting}
            volume={status.mediaVolume}
            busy={busy}
            readOnly={readOnly}
            pushToTalkAvailable={capabilities?.pushToTalk}
            volumeAvailable={capabilities?.device.volume}
            onTalkStart={() => startTalk()}
            onTalkStop={() => stopTalk()}
            onVolume={(volume) => void runAction(() => controllerApi.setVolume(volume))}
          />
        ) : null}
        {activeTab === "display" ? (
          <DisplayPanel
            busy={busy}
            readOnly={readOnly}
            capabilities={capabilities?.display}
            onMessage={(message) =>
              void runAction(() =>
                controllerApi.showMessage({
                  text: message,
                  textSize: "large",
                  background: "dark",
                  durationSeconds: 30,
                  restoreDashboard: true
                })
              )
            }
            onLiveText={(text) => void runAction(() => controllerApi.showLiveText(text))}
            onClearLiveText={() => void runAction(() => controllerApi.clearLiveText())}
            onMedia={(kind, file) =>
              void runAction(() => controllerApi.showMedia(kind, file, 30, true))
            }
            onWebpage={(url) =>
              void runAction(() =>
                controllerApi.showWebpage({ url, durationSeconds: 30, restoreDashboard: true })
              )
            }
            onBlack={() => void runAction(() => controllerApi.showBlack())}
            onClockOnly={() => void runAction(() => controllerApi.showClockOnly())}
            onClockColor={(color) => void runAction(() => controllerApi.setClockColor(color))}
            onRestore={() => void runAction(() => controllerApi.restoreDashboard())}
            controllerApi={controllerApi}
            runAction={runAction}
            status={status}
          />
        ) : null}
        {activeTab === "device" ? (
          <DevicePanel
            status={status}
            busy={busy}
            readOnly={readOnly}
            capabilities={capabilities?.device}
            serverHealth={serverHealth}
            restoreAvailable={capabilities?.display.restoreDashboard}
            onBrightness={(brightness) =>
              void runAction(() => controllerApi.setBrightness(brightness))
            }
            onVolume={(volume) => void runAction(() => controllerApi.setVolume(volume))}
            onMute={() => void runAction(() => controllerApi.setMuted(status.mediaVolume !== 0))}
            onOrientation={(orientation) =>
              void runAction(() => controllerApi.setScreenOrientation(orientation))
            }
            onScreen={(on) => void runAction(() => controllerApi.setScreenOn(on))}
            onReboot={() => void runAction(() => controllerApi.rebootDevice())}
            onRestartService={(service) =>
              void runAction(() => controllerApi.restartService(service))
            }
            onRestore={() => void runAction(() => controllerApi.restoreDashboard())}
          />
        ) : null}

        {activeTab === "apps" ? (
          <AppsPanel
            apps={apps}
            disabled={busy || readOnly}
            onLaunchApp={(appId) => void runAction(() => controllerApi.launchApp(appId))}
            onApproveApp={(packageName) =>
              void runAppMutation(() => controllerApi.approveApp(packageName))
            }
            onRevokeApp={(packageName) =>
              void runAppMutation(() => controllerApi.revokeApp(packageName))
            }
          />
        ) : null}

        {activeTab === "music" ? (
          <MusicPanel
            disabled={busy || readOnly}
            onMediaControl={(action) => void runAction(() => controllerApi.controlMedia(action))}
            mediaVolume={status?.mediaVolume}
          />
        ) : null}

        {activeTab === "location" ? (
          <LocationPanel
            disabled={busy || readOnly}
            locationData={locationData}
            onSetMode={(mode) => void runAction(() => controllerApi.setLocationMode(mode))}
            onFindSound={(duration) => void runAction(() => controllerApi.findSound(duration))}
            onStopSound={() => void runAction(() => controllerApi.stopFindSound())}
          />
        ) : null}

        {activeTab === "admin" ? (
          <AdminPanel
            status={status}
            apiVersion={apiVersion}
            disabled={busy || readOnly}
            capabilities={capabilities?.device}
            serverHealth={serverHealth}
            apps={apps}
            controllerApi={controllerApi}
            runAction={runAction}
            onTouchLock={(on) => void runAction(() => controllerApi.setTouchLock(on))}
            onOrientation={(orientation) =>
              void runAction(() => controllerApi.setScreenOrientation(orientation))
            }
          />
        ) : null}
      </div>

      <BottomTabs activeTab={activeTab} onChange={handleTabChange} />
    </main>
  );
}

function LoginScreen({
  busy,
  notice,
  onSubmit
}: {
  busy: boolean;
  notice: Notice | undefined;
  onSubmit: (username: string, password: string) => Promise<void>;
}) {
  return (
    <main className="grid min-h-screen bg-black px-4 py-8 text-slate-100">
      <section className="m-auto w-full max-w-sm rounded-[2rem] border border-zinc-800 bg-zinc-950/80 p-6 shadow-2xl">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-300 text-slate-950">
          <span className="text-sm font-black">ROS</span>
        </div>
        <p className="mt-6 text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
          Local controller authentication
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">RoshanOS Controller</h1>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          Authentication is local to this controller. Credentials are required before any tablet
          action is sent.
        </p>
        <form
          className="mt-6 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void onSubmit(String(form.get("username") ?? ""), String(form.get("password") ?? ""));
          }}
        >
          <label className="grid gap-1 text-sm font-medium text-slate-300">
            Username
            <input
              name="username"
              required
              autoComplete="username"
              className="min-h-12 rounded-2xl border border-zinc-800 bg-black px-3 text-slate-100"
            />
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-300">
            Controller password
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="min-h-12 rounded-2xl border border-zinc-800 bg-black px-3 text-slate-100"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="min-h-12 rounded-2xl bg-cyan-300 px-4 text-sm font-bold text-slate-950 disabled:opacity-50"
          >
            {busy ? "Signing in..." : "Sign in"}
            {/*
            {busy ? "Signing in…" : "Sign in to mock controller"}
            */}
          </button>
        </form>
        <p className="mt-4 text-xs leading-5 text-slate-500">
          Your controller account is required before any tablet action is sent.
        </p>
        <div className="mt-4">
          <NoticeBar notice={notice} />
        </div>
      </section>
    </main>
  );
}

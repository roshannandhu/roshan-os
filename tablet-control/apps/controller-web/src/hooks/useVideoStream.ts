import { useCallback, useEffect, useRef, useState } from "react";
import type { VideoState } from "../stream-states.js";

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const STABILITY_RESET_MS = 10_000;

export function useVideoStream(active: boolean): {
  src: string | undefined;
  state: VideoState;
  onLoad: () => void;
  onError: () => void;
  retry: () => void;
} {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<VideoState>("idle");
  const attempt = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stableTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latestActive = useRef(active);
  // Keep ref in sync with prop; done in an effect to satisfy react-hooks/refs.
  useEffect(() => {
    latestActive.current = active;
  }, [active]);

  const clearAll = useCallback(() => {
    clearTimeout(retryTimer.current);
    clearTimeout(stableTimer.current);
  }, []);

  const bump = useCallback(() => {
    clearAll();
    setState("connecting");
    setRevision((n) => n + 1);
  }, [clearAll]);

  const onLoad = useCallback(() => {
    clearTimeout(stableTimer.current);
    setState("connected");
    stableTimer.current = setTimeout(() => {
      attempt.current = 0;
    }, STABILITY_RESET_MS);
  }, []);

  const onError = useCallback(() => {
    clearAll();
    if (attempt.current >= RETRY_DELAYS_MS.length) {
      setState("exhausted");
      return;
    }
    const delay = RETRY_DELAYS_MS[attempt.current]!;
    attempt.current += 1;
    setState("reconnecting");
    retryTimer.current = setTimeout(() => {
      if (latestActive.current && !document.hidden) bump();
    }, delay);
  }, [clearAll, bump]);

  const retry = useCallback(() => {
    attempt.current = 0;
    bump();
  }, [bump]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        clearAll();
        setState("hidden");
      } else if (latestActive.current) {
        retry();
      }
    };
    const onResume = () => {
      if (!document.hidden && latestActive.current) retry();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onResume);
    window.addEventListener("pageshow", onResume);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onResume);
      window.removeEventListener("pageshow", onResume);
    };
  }, [clearAll, retry]);

  useEffect(() => {
    if (active && !document.hidden) {
      // ponytail: setState via bump() in effect is intentional — reactive stream start/stop.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      bump();
    } else {
      clearAll();
      setState("idle");
    }
    return clearAll;
  }, [active, bump, clearAll]);

  const src =
    state !== "idle" && state !== "exhausted" && state !== "hidden"
      ? `/api/v1/camera/stream?attempt=${revision}`
      : undefined;

  return { src, state, onLoad, onError, retry };
}

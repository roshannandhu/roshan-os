import { Network, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TailscaleEnrollmentStatus } from "@tablet-control/shared-types";
import type { ControllerApi } from "./api.js";

const panelClass =
  "rounded-3xl border border-zinc-800 bg-zinc-950/80 p-4 shadow-[0_12px_40px_rgba(0,0,0,0.22)]";
const ENROLLMENT_POLL_MS = 3_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Tailscale enrollment is unavailable.";
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function stateLabel(state: TailscaleEnrollmentStatus["state"]): string {
  switch (state) {
    case "never_requested":
      return "Not enrolled";
    case "enrolling":
      return "Enrolling";
    case "succeeded":
      return "Connected";
    case "failed":
      return "Failed";
  }
}

function stateTone(state: TailscaleEnrollmentStatus["state"]): string {
  if (state === "succeeded") return "bg-emerald-950 text-emerald-300";
  if (state === "failed") return "bg-rose-950 text-rose-200";
  if (state === "enrolling") return "bg-cyan-950 text-cyan-200";
  return "bg-zinc-800 text-zinc-400";
}

export function TailscaleEnrollmentPanel({
  controllerApi,
  disabled,
  runAction
}: {
  controllerApi: ControllerApi;
  disabled: boolean;
  runAction: (action: () => Promise<{ message: string }>) => Promise<void>;
}) {
  const [status, setStatus] = useState<TailscaleEnrollmentStatus | undefined>();
  const [statusError, setStatusError] = useState<string | undefined>();
  const [operationError, setOperationError] = useState<string | undefined>();
  const [timeoutSeconds, setTimeoutSeconds] = useState(120);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(false);
  const statusRequestActiveRef = useRef(false);
  const authKeyInputRef = useRef<HTMLInputElement>(null);

  const refreshStatus = useCallback(
    async (quiet = false): Promise<void> => {
      if (statusRequestActiveRef.current) return;
      statusRequestActiveRef.current = true;
      if (!quiet && mountedRef.current) setStatusError(undefined);
      try {
        const nextStatus = await controllerApi.getTailscaleEnrollmentStatus();
        if (!mountedRef.current) return;
        setStatus(nextStatus);
        setStatusError(undefined);
      } catch (error) {
        if (mountedRef.current) setStatusError(errorMessage(error));
      } finally {
        statusRequestActiveRef.current = false;
      }
    },
    [controllerApi]
  );

  useEffect(() => {
    mountedRef.current = true;
    const initialTimer = window.setTimeout(() => void refreshStatus(), 0);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshStatus(true);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      mountedRef.current = false;
      window.clearTimeout(initialTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshStatus]);

  useEffect(() => {
    if (status?.state !== "enrolling") return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshStatus(true);
    }, ENROLLMENT_POLL_MS);
    return () => window.clearInterval(interval);
  }, [refreshStatus, status?.state]);

  function submitEnrollment(): void {
    const input = authKeyInputRef.current;
    const authKey = input?.value ?? "";
    setBusy(true);
    setOperationError(undefined);
    void runAction(async () => {
      try {
        const enrollmentPromise = controllerApi.enrollTailscale(authKey, timeoutSeconds);
        if (input !== null) input.value = "";
        const result = await enrollmentPromise;
        setStatus(result.enrollment);
        setStatusError(undefined);
        return {
          message: `Tailscale enrollment accepted by the tablet (${result.code}).`
        };
      } catch (error) {
        setOperationError(errorMessage(error));
        throw error;
      } finally {
        if (input !== null) input.value = "";
        setBusy(false);
      }
    });
  }

  const enrollmentInProgress = status?.state === "enrolling";
  const enrollmentUnsupported =
    status !== undefined &&
    (!status.deviceOwner ||
      !status.tailscaleInstalled ||
      !status.tailscaleEnabled ||
      !status.supportedPolicies.authKey);

  return (
    <section className={panelClass} aria-labelledby="tailscale-enrollment-heading">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Network aria-hidden="true" className="mt-0.5 text-cyan-300" size={20} />
          <div>
            <h2
              id="tailscale-enrollment-heading"
              className="text-base font-semibold text-zinc-100"
            >
              Private-network enrollment
            </h2>
            <p className="mt-1 text-xs leading-5 text-zinc-400">
              Send a one-off Tailscale auth key directly to RoshanCore through the protected owner
              session.
            </p>
          </div>
        </div>
        <span
          role="status"
          aria-live="polite"
          className={
            "shrink-0 rounded-full px-3 py-1 text-xs font-bold " +
            (status === undefined ? "bg-zinc-800 text-zinc-300" : stateTone(status.state))
          }
        >
          {status === undefined ? "Checking" : stateLabel(status.state)}
        </span>
      </div>

      <p className="mt-3 rounded-xl border border-rose-900/80 bg-rose-950/40 px-3 py-2 text-xs leading-5 text-rose-100">
        <strong>⚠ Recovery action.</strong> Only use this if the tablet reports
        TAILSCALE_IDENTITY_MISSING after a factory reset. Normal reboots do NOT
        require a new auth key.
      </p>

      {statusError !== undefined ? (
        <p
          role="alert"
          className="mt-3 rounded-xl border border-rose-900 bg-rose-950/60 px-3 py-2 text-xs text-rose-200"
        >
          {statusError}
        </p>
      ) : null}
      {operationError !== undefined ? (
        <p
          role="alert"
          className="mt-3 rounded-xl border border-rose-900 bg-rose-950/60 px-3 py-2 text-xs text-rose-200"
        >
          {operationError}
        </p>
      ) : null}

      <div className="mt-3 rounded-xl border border-amber-900/80 bg-amber-950/40 px-3 py-2 text-xs leading-5 text-amber-100">
        <strong>Recovery only.</strong> During normal operation, the tablet reuses its existing
        Tailscale identity automatically. This panel is only needed if the tablet has been
        factory-reset or its Tailscale identity is genuinely missing.
      </div>

      {status !== undefined ? (
        <div className="mt-4 rounded-2xl border border-zinc-800 bg-black/70 p-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-zinc-100">Enrollment proof</h3>
            <button
              type="button"
              disabled={busy}
              onClick={() => void refreshStatus()}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-zinc-800 px-3 text-xs font-semibold text-zinc-200 disabled:opacity-50"
            >
              <RefreshCw aria-hidden="true" size={14} />
              Refresh
            </button>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-xl bg-zinc-900 p-2.5">
              <dt className="text-zinc-500">Result code</dt>
              <dd className="mt-1 break-all font-mono text-[11px] text-zinc-200">{status.code}</dd>
            </div>
            <div className="rounded-xl bg-zinc-900 p-2.5">
              <dt className="text-zinc-500">Finished</dt>
              <dd className="mt-1 font-semibold text-zinc-200">
                {formatTime(status.finishedAtMs)}
              </dd>
            </div>
            <div className="rounded-xl bg-zinc-900 p-2.5">
              <dt className="text-zinc-500">Tailscale package</dt>
              <dd className="mt-1 font-semibold text-zinc-200">
                {status.tailscaleInstalled
                  ? status.tailscaleEnabled
                    ? (status.tailscaleVersion ?? "Installed")
                    : "Disabled"
                  : "Not installed"}
              </dd>
            </div>
            <div className="rounded-xl bg-zinc-900 p-2.5">
              <dt className="text-zinc-500">Credential proof</dt>
              <dd
                className={
                  "mt-1 font-semibold " +
                  (status.credentialConsumptionProven ? "text-emerald-300" : "text-amber-200")
                }
              >
                {status.credentialConsumptionProven ? "Confirmed" : "Waiting"}
              </dd>
            </div>
          </dl>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div className="flex items-center gap-2 rounded-xl bg-zinc-900 p-2.5">
              <ShieldCheck
                aria-hidden="true"
                size={16}
                className={status.alwaysOnVpnConfigured ? "text-emerald-300" : "text-amber-200"}
              />
              <span className="text-zinc-300">
                Always-on VPN {status.alwaysOnVpnConfigured ? "ready" : "not ready"}
              </span>
            </div>
            <div className="flex items-center gap-2 rounded-xl bg-zinc-900 p-2.5">
              <ShieldCheck
                aria-hidden="true"
                size={16}
                className={status.tailnetAddressDetected ? "text-emerald-300" : "text-amber-200"}
              />
              <span className="text-zinc-300">
                Tailnet address {status.tailnetAddressDetected ? "detected" : "not detected"}
              </span>
            </div>
          </div>
          {status.transientAuthKeyPresent ? (
            <p className="mt-3 rounded-xl border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-100">
              A transient key is currently applied on the tablet and will be scrubbed after proof,
              timeout, failure, or process restart.
            </p>
          ) : status.transientAuthKeyPresent === null ? (
            <p className="mt-3 rounded-xl border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-100">
              RoshanCore cannot safely read the managed-restriction state, so key removal is not
              confirmed. Treat enrollment as incomplete and inspect the tablet status.
            </p>
          ) : null}
        </div>
      ) : null}

      <form
        className="mt-4 grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submitEnrollment();
        }}
      >
        <label className="grid gap-1 text-xs font-semibold text-zinc-300">
          One-off Tailscale auth key
          <input
            ref={authKeyInputRef}
            aria-label="One-off Tailscale auth key"
            type="password"
            name="tailscale-one-off-auth-key"
            autoComplete="off"
            spellCheck={false}
            minLength={32}
            maxLength={256}
            pattern="tskey-auth-[A-Za-z0-9_-]+"
            required
            disabled={disabled || busy || enrollmentInProgress}
            className="min-h-11 rounded-xl border border-zinc-800 bg-black px-3 text-sm text-zinc-100 disabled:opacity-50"
          />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-zinc-300">
          Proof timeout (seconds)
          <input
            aria-label="Tailscale enrollment timeout"
            type="number"
            min={30}
            max={300}
            step={1}
            required
            value={timeoutSeconds}
            disabled={disabled || busy || enrollmentInProgress}
            onChange={(event) => setTimeoutSeconds(Number(event.currentTarget.value))}
            className="min-h-11 rounded-xl border border-zinc-800 bg-black px-3 text-sm text-zinc-100 disabled:opacity-50"
          />
        </label>
        <button
          type="submit"
          disabled={
            disabled ||
            busy ||
            enrollmentInProgress ||
            enrollmentUnsupported ||
            !Number.isInteger(timeoutSeconds) ||
            timeoutSeconds < 30 ||
            timeoutSeconds > 300
          }
          className="min-h-12 rounded-xl bg-cyan-300 px-4 text-sm font-bold text-slate-950 hover:bg-cyan-200 disabled:opacity-50"
        >
          {busy ? "Submitting securely\u2026" : "Recovery: re-enroll Tailscale"}
        </button>
        {enrollmentUnsupported ? (
          <p className="text-[11px] leading-4 text-amber-200">
            Enrollment requires Device Owner, an enabled Tailscale package, and managed AuthKey
            policy support.
          </p>
        ) : null}
      </form>
    </section>
  );
}

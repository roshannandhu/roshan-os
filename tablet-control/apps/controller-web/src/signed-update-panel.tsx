import * as Dialog from "@radix-ui/react-dialog";
import {
  CircleAlert,
  PackageCheck,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Upload,
  X
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { UPDATE_MAX_APK_BYTES } from "@tablet-control/shared-types";
import type {
  ControllerUpdateArtifact,
  SignedUpdateState,
  SignedUpdateStatus
} from "@tablet-control/shared-types";
import type { ControllerApi } from "./api.js";

const panelClass =
  "rounded-3xl border border-zinc-800 bg-zinc-950/80 p-4 shadow-[0_12px_40px_rgba(0,0,0,0.22)]";
const UPDATE_STATUS_POLL_MS = 5_000;

const UPDATE_STATE_LABELS: Record<SignedUpdateState, string> = {
  idle: "Idle",
  downloading: "Downloading",
  verifying: "Verifying",
  staging: "Staging",
  committing: "Committing",
  applied: "Applied",
  failed: "Failed",
  rollback_committing: "Rolling back",
  rolled_back: "Rolled back"
};

function formatBytes(value: number): string {
  if (value < 1024) return `${value.toString()} B`;
  const units = ["KiB", "MiB", "GiB"];
  let amount = value / 1024;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatVersion(name: string | null, code: number | null): string {
  if (name === null && code === null) return "Not reported";
  if (name === null) return `code ${code?.toString() ?? "unknown"}`;
  if (code === null) return name;
  return `${name} (code ${code.toString()})`;
}

function formatTime(value: number | null): string {
  if (value === null) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatCreatedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(timestamp));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The RoshanOS update service is unavailable.";
}

function updateStateTone(state: SignedUpdateState): string {
  if (state === "failed") return "bg-rose-950 text-rose-200";
  if (state === "applied" || state === "rolled_back") {
    return "bg-emerald-950 text-emerald-300";
  }
  if (
    state === "downloading" ||
    state === "verifying" ||
    state === "staging" ||
    state === "committing" ||
    state === "rollback_committing"
  ) {
    return "bg-cyan-950 text-cyan-200";
  }
  return "bg-zinc-800 text-zinc-400";
}

export function SignedUpdatePanel({
  controllerApi,
  disabled,
  runAction
}: {
  controllerApi: ControllerApi;
  disabled: boolean;
  runAction: (action: () => Promise<{ message: string }>) => Promise<void>;
}) {
  const [status, setStatus] = useState<SignedUpdateStatus | undefined>();
  const [statusError, setStatusError] = useState<string | undefined>();
  const [statusLoading, setStatusLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | undefined>();
  const [artifact, setArtifact] = useState<ControllerUpdateArtifact | undefined>();
  const [uploadProgress, setUploadProgress] = useState(0);
  const [operation, setOperation] = useState<"upload" | "install" | "rollback" | undefined>();
  const [operationError, setOperationError] = useState<string | undefined>();
  const statusRequestActiveRef = useRef(false);
  const mountedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refreshStatus = useCallback(
    async (quiet = false): Promise<void> => {
      if (statusRequestActiveRef.current) return;
      statusRequestActiveRef.current = true;
      if (!quiet && mountedRef.current) setStatusLoading(true);
      try {
        const nextStatus = await controllerApi.getSignedUpdateStatus();
        if (!mountedRef.current) return;
        setStatus(nextStatus);
        setStatusError(undefined);
      } catch (error) {
        if (mountedRef.current) setStatusError(errorMessage(error));
      } finally {
        statusRequestActiveRef.current = false;
        if (mountedRef.current) setStatusLoading(false);
      }
    },
    [controllerApi]
  );

  useEffect(() => {
    mountedRef.current = true;
    const initialTimer = window.setTimeout(() => void refreshStatus(), 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshStatus(true);
    }, UPDATE_STATUS_POLL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshStatus(true);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      mountedRef.current = false;
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshStatus]);

  const selectedFileValid =
    selectedFile !== undefined &&
    selectedFile.size > 0 &&
    selectedFile.size <= UPDATE_MAX_APK_BYTES &&
    selectedFile.name.toLowerCase().endsWith(".apk");
  const operationBusy = operation !== undefined;
  const expectedBytes = status?.progress.expectedBytes ?? null;
  const progressPercent =
    status !== undefined && expectedBytes !== null && expectedBytes > 0
      ? Math.min(100, Math.round((status.progress.downloadedBytes / expectedBytes) * 100))
      : undefined;

  function uploadSelectedFile(): void {
    if (!selectedFileValid || selectedFile === undefined) return;
    const file = selectedFile;
    setOperation("upload");
    setUploadProgress(0);
    setOperationError(undefined);
    void runAction(async () => {
      try {
        const nextArtifact = await controllerApi.uploadUpdateArtifact(file, setUploadProgress);
        setArtifact(nextArtifact);
        setSelectedFile(undefined);
        if (fileInputRef.current !== null) fileInputRef.current.value = "";
        return {
          message: `${nextArtifact.fileName} is stored and ready for signed installation.`
        };
      } catch (error) {
        setOperationError(errorMessage(error));
        throw error;
      } finally {
        setOperation(undefined);
      }
    });
  }

  function installArtifact(): void {
    if (artifact === undefined) return;
    const selectedArtifact = artifact;
    setOperation("install");
    setOperationError(undefined);
    void runAction(async () => {
      try {
        const result = await controllerApi.installUpdateArtifact(selectedArtifact.id);
        setStatus(result.requestResult.update);
        setStatusError(undefined);
        return {
          message: `Signed update accepted by the tablet (${result.requestResult.code}).`
        };
      } catch (error) {
        setOperationError(errorMessage(error));
        throw error;
      } finally {
        setOperation(undefined);
      }
    });
  }

  function rollbackUpdate(): void {
    setOperation("rollback");
    setOperationError(undefined);
    void runAction(async () => {
      try {
        const result = await controllerApi.rollbackSignedUpdate();
        setStatus(result.update);
        setStatusError(undefined);
        return { message: `Rollback accepted by the tablet (${result.code}).` };
      } catch (error) {
        setOperationError(errorMessage(error));
        throw error;
      } finally {
        setOperation(undefined);
      }
    });
  }

  return (
    <section className={panelClass} aria-labelledby="signed-update-heading">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <PackageCheck aria-hidden="true" className="mt-0.5 text-cyan-300" size={20} />
          <div>
            <h2 id="signed-update-heading" className="text-base font-semibold text-zinc-100">
              Signed RoshanOS updates
            </h2>
            <p className="mt-1 text-xs leading-5 text-zinc-400">
              Upload an APK to this controller, then explicitly ask the tablet to download, verify,
              and install it over the private network.
            </p>
          </div>
        </div>
        <span
          role="status"
          aria-live="polite"
          className={
            "shrink-0 rounded-full px-3 py-1 text-xs font-bold " +
            (status === undefined ? "bg-zinc-800 text-zinc-300" : updateStateTone(status.state))
          }
        >
          {status === undefined ? "Checking" : UPDATE_STATE_LABELS[status.state]}
        </span>
      </div>

      <p className="mt-3 rounded-xl border border-amber-900/80 bg-amber-950/40 px-3 py-2 text-xs leading-5 text-amber-100">
        The tablet accepts only a compatible APK signed by its trusted RoshanOS application key. It
        verifies the exact SHA-256 hash before staging. Do not disconnect power while an update is
        committing.
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

      <div className="mt-4 rounded-2xl border border-zinc-800 bg-black/70 p-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-zinc-100">Tablet update status</h3>
          <button
            type="button"
            disabled={statusLoading || operationBusy}
            onClick={() => void refreshStatus()}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-zinc-800 px-3 text-xs font-semibold text-zinc-200 disabled:opacity-50"
          >
            <RefreshCw aria-hidden="true" size={14} />
            {statusLoading ? "Checking\u2026" : "Refresh"}
          </button>
        </div>

        {status === undefined ? (
          <p className="mt-3 text-xs text-zinc-500">Waiting for signed-update status.</p>
        ) : (
          <>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-xl bg-zinc-900 p-2.5">
                <dt className="text-zinc-500">Installed version</dt>
                <dd className="mt-1 break-words font-semibold text-zinc-200">
                  {formatVersion(status.currentVersionName, status.currentVersionCode)}
                </dd>
              </div>
              <div className="rounded-xl bg-zinc-900 p-2.5">
                <dt className="text-zinc-500">Target version</dt>
                <dd className="mt-1 break-words font-semibold text-zinc-200">
                  {formatVersion(status.targetVersionName, status.targetVersionCode)}
                </dd>
              </div>
              <div className="rounded-xl bg-zinc-900 p-2.5">
                <dt className="text-zinc-500">Controller origin</dt>
                <dd
                  className={
                    "mt-1 break-all font-semibold " +
                    (status.controllerOrigin.state === "ready"
                      ? "text-emerald-300"
                      : "text-amber-200")
                  }
                >
                  {status.controllerOrigin.state === "ready"
                    ? (status.controllerOrigin.host ?? "Ready")
                    : status.controllerOrigin.state}
                </dd>
              </div>
              <div className="rounded-xl bg-zinc-900 p-2.5">
                <dt className="text-zinc-500">Last applied</dt>
                <dd className="mt-1 font-semibold text-zinc-200">
                  {formatTime(status.lastAppliedAtMs)}
                </dd>
              </div>
            </dl>

            <div className="mt-3 rounded-xl bg-zinc-900 p-2.5 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="text-zinc-500">Transfer progress</span>
                <span className="font-semibold text-zinc-200">
                  {expectedBytes === null
                    ? `${formatBytes(status.progress.downloadedBytes)} received`
                    : `${formatBytes(status.progress.downloadedBytes)} / ${formatBytes(
                        expectedBytes
                      )}`}
                </span>
              </div>
              {progressPercent !== undefined ? (
                <progress
                  aria-label="Tablet update download progress"
                  className="mt-2 h-2 w-full accent-cyan-300"
                  max={100}
                  value={progressPercent}
                />
              ) : null}
            </div>

            {status.errorCode !== null ? (
              <p className="mt-3 rounded-xl border border-rose-900 bg-rose-950/50 px-3 py-2 font-mono text-xs text-rose-200">
                Tablet error: {status.errorCode}
              </p>
            ) : null}

            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div className="flex items-center gap-2 rounded-xl bg-zinc-900 p-2.5">
                <ShieldCheck
                  aria-hidden="true"
                  size={16}
                  className={
                    status.installCapability.deviceOwner ? "text-emerald-300" : "text-amber-200"
                  }
                />
                <span className="text-zinc-300">
                  Device Owner {status.installCapability.deviceOwner ? "active" : "required"}
                </span>
              </div>
              <div className="flex items-center gap-2 rounded-xl bg-zinc-900 p-2.5">
                <ShieldCheck
                  aria-hidden="true"
                  size={16}
                  className={
                    status.installCapability.silentSelfUpdateCapable
                      ? "text-emerald-300"
                      : "text-amber-200"
                  }
                />
                <span className="text-zinc-300">
                  Silent install{" "}
                  {status.installCapability.silentSelfUpdateCapable ? "ready" : "unavailable"}
                </span>
              </div>
            </div>
          </>
        )}
      </div>

      <form
        className="mt-4 grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          uploadSelectedFile();
        }}
      >
        <label className="grid gap-1 text-xs font-semibold text-zinc-300">
          RoshanOS APK
          <input
            ref={fileInputRef}
            aria-label="RoshanOS update APK"
            type="file"
            accept=".apk,application/vnd.android.package-archive,application/octet-stream"
            disabled={disabled || operationBusy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              setSelectedFile(file);
              setArtifact(undefined);
              setUploadProgress(0);
              setOperationError(
                file === undefined ||
                  (file.size > 0 &&
                    file.size <= UPDATE_MAX_APK_BYTES &&
                    file.name.toLowerCase().endsWith(".apk"))
                  ? undefined
                  : "Select a non-empty .apk file no larger than 128 MiB."
              );
            }}
            className="min-h-11 rounded-xl border border-zinc-800 bg-black px-3 py-2 text-sm text-zinc-200 file:mr-3 file:rounded-lg file:border-0 file:bg-cyan-300 file:px-3 file:py-1.5 file:font-semibold file:text-slate-950 disabled:opacity-50"
          />
        </label>
        {selectedFile !== undefined ? (
          <p className="text-xs text-zinc-400">
            {selectedFile.name} · {formatBytes(selectedFile.size)}
          </p>
        ) : null}
        {operation === "upload" ? (
          <div role="status" aria-live="polite" className="text-xs text-cyan-200">
            Uploading to controller · {uploadProgress.toString()}%
            <progress
              aria-label="APK upload progress"
              className="mt-1.5 h-2 w-full accent-cyan-300"
              max={100}
              value={uploadProgress}
            />
          </div>
        ) : null}
        <button
          type="submit"
          disabled={disabled || operationBusy || !selectedFileValid}
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-cyan-300 px-4 text-sm font-bold text-slate-950 hover:bg-cyan-200 disabled:opacity-50"
        >
          <Upload aria-hidden="true" size={17} />
          {operation === "upload" ? "Uploading\u2026" : "Upload APK securely"}
        </button>
      </form>

      {artifact !== undefined ? (
        <div className="mt-4 rounded-2xl border border-emerald-900 bg-emerald-950/30 p-3">
          <h3 className="text-sm font-semibold text-emerald-200">Stored update artifact</h3>
          <dl className="mt-2 space-y-2 text-xs">
            <div className="flex justify-between gap-3">
              <dt className="text-zinc-500">Artifact ID</dt>
              <dd className="break-all text-right font-mono text-[11px] text-zinc-300">
                {artifact.id}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-zinc-500">File</dt>
              <dd className="break-all text-right text-zinc-200">{artifact.fileName}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-zinc-500">Size</dt>
              <dd className="text-zinc-200">{formatBytes(artifact.sizeBytes)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-zinc-500">Stored</dt>
              <dd className="text-right text-zinc-200">{formatCreatedAt(artifact.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">SHA-256</dt>
              <dd className="mt-1 break-all font-mono text-[11px] leading-4 text-zinc-300">
                {artifact.sha256}
              </dd>
            </div>
          </dl>
          <button
            type="button"
            disabled={
              disabled ||
              operationBusy ||
              status?.installCapability.silentSelfUpdateCapable !== true
            }
            onClick={installArtifact}
            className="mt-3 min-h-12 w-full rounded-xl bg-emerald-400 px-4 text-sm font-bold text-slate-950 disabled:opacity-50"
          >
            {operation === "install" ? "Requesting installation\u2026" : "Install uploaded update"}
          </button>
          {status?.installCapability.silentSelfUpdateCapable !== true ? (
            <p className="mt-2 text-[11px] leading-4 text-amber-200">
              Installation stays disabled until the tablet reports Device Owner and silent
              self-update permission ready.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 border-t border-zinc-800 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">Rollback</h3>
            <p className="mt-1 text-xs leading-5 text-zinc-400">
              Android retains app data for this update. Automatic boot-failure rollback is not
              guaranteed.
            </p>
          </div>
          <span
            className={
              "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold " +
              (status?.rollback.available === true
                ? "bg-amber-950 text-amber-200"
                : "bg-zinc-800 text-zinc-400")
            }
          >
            {status?.rollback.available === true ? "Available" : "Unavailable"}
          </span>
        </div>
        {status !== undefined ? (
          <p className="mt-2 text-xs text-zinc-500">
            Last rollback: {formatTime(status.lastRollbackAtMs)}
            {status.rollback.reasonCode === null ? "" : ` · ${status.rollback.reasonCode}`}
          </p>
        ) : null}

        <Dialog.Root>
          <Dialog.Trigger asChild>
            <button
              type="button"
              disabled={disabled || operationBusy || status?.rollback.available !== true}
              className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-rose-900 bg-rose-950/40 px-3 text-sm font-semibold text-rose-200 disabled:opacity-50"
            >
              <RotateCcw aria-hidden="true" size={16} />
              Roll back last update
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-black/80" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-rose-900 bg-zinc-900 p-5 shadow-2xl">
              <Dialog.Title className="flex items-center gap-2 text-lg font-bold text-zinc-100">
                <CircleAlert aria-hidden="true" className="text-rose-300" size={22} />
                Roll back the last RoshanOS update?
              </Dialog.Title>
              <Dialog.Description className="mt-3 text-sm leading-6 text-zinc-300">
                This asks Android to restore the available previous RoshanOS application version
                while retaining app data. The tablet may restart RoshanOS services as the rollback
                commits.
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
                    disabled={disabled || operationBusy || status?.rollback.available !== true}
                    onClick={rollbackUpdate}
                    className="min-h-12 rounded-2xl bg-rose-500 px-3 text-sm font-bold text-white disabled:opacity-50"
                  >
                    Confirm rollback
                  </button>
                </Dialog.Close>
              </div>
              <Dialog.Close
                aria-label="Close rollback confirmation"
                className="absolute right-4 top-4 rounded-lg p-1 text-zinc-400"
              >
                <X aria-hidden="true" size={18} />
              </Dialog.Close>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
    </section>
  );
}

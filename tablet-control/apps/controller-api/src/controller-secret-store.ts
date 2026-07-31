import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_HELPER_OUTPUT_BYTES = 16 * 1024;
const HELPER_TIMEOUT_MS = 15_000;

export interface CompanionSecretPersistence {
  setCompanionSecret(secret: string): Promise<void>;
}

interface HelperReadResponse {
  ok: true;
  value: string;
}

function helperPath(): string {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  return resolve(sourceDirectory, "../../../scripts/controller-secret-store.ps1");
}

function powershellPath(): string {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (windowsRoot === undefined || windowsRoot.length === 0) {
    return "powershell.exe";
  }
  return resolve(windowsRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
}

/**
 * Deliberately allowlists non-secret environment values. In particular, the
 * companion credential and the controller's other protected values are never
 * inherited by the PowerShell helper.
 */
function helperEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function helperArguments(): string[] {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    helperPath()
  ];
}

function isStorableCompanionSecret(value: unknown): value is string {
  const hasControlCharacter =
    typeof value === "string" &&
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    });
  return (
    typeof value === "string" && value.length >= 16 && value.length <= 1024 && !hasControlCharacter
  );
}

/**
 * Reads the current-user DPAPI value into controller memory through a private
 * stdout pipe. The value is never placed in process.env.
 */
export function readDpapiCompanionSecretSync(): string {
  if (process.platform !== "win32") {
    throw new Error("The protected companion credential requires Windows DPAPI.");
  }

  const result = spawnSync(powershellPath(), helperArguments(), {
    input: JSON.stringify({ operation: "read" }),
    encoding: "utf8",
    windowsHide: true,
    env: helperEnvironment(),
    maxBuffer: MAX_HELPER_OUTPUT_BYTES,
    timeout: HELPER_TIMEOUT_MS
  });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error("The protected companion credential could not be loaded.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("The protected companion credential helper returned invalid data.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("ok" in parsed) ||
    parsed.ok !== true ||
    !("value" in parsed) ||
    !isStorableCompanionSecret(parsed.value)
  ) {
    throw new Error("The protected companion credential helper returned invalid data.");
  }
  return (parsed as HelperReadResponse).value;
}

/**
 * Atomically updates only TABLET_COMPANION_SECRET in the current-user DPAPI
 * JSON store. The plaintext crosses the process boundary exclusively on stdin.
 */
export class PowerShellDpapiCompanionSecretPersistence implements CompanionSecretPersistence {
  public async setCompanionSecret(secret: string): Promise<void> {
    if (!isStorableCompanionSecret(secret)) {
      throw new Error("Refusing to persist an invalid companion credential.");
    }
    if (process.platform !== "win32") {
      throw new Error("The protected companion credential requires Windows DPAPI.");
    }

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(powershellPath(), helperArguments(), {
        windowsHide: true,
        env: helperEnvironment(),
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error("Protected credential update timed out."));
      }, HELPER_TIMEOUT_MS);

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Never include helper output in an error. It must remain impossible
        // for a future helper regression to place a credential in a log.
        if (error === undefined) resolvePromise();
        else rejectPromise(error);
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > MAX_HELPER_OUTPUT_BYTES) {
          child.kill();
          finish(new Error("Protected credential helper output was too large."));
          return;
        }
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_HELPER_OUTPUT_BYTES) {
          child.kill();
          finish(new Error("Protected credential helper error output was too large."));
        }
      });
      child.once("error", () => {
        finish(new Error("Protected credential helper could not start."));
      });
      child.once("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(new Error("Protected credential update failed."));
          return;
        }
        try {
          const response = JSON.parse(stdout) as { ok?: unknown };
          if (response.ok !== true) {
            finish(new Error("Protected credential helper returned invalid data."));
            return;
          }
        } catch {
          finish(new Error("Protected credential helper returned invalid data."));
          return;
        }
        finish();
      });

      child.stdin.once("error", () => {
        finish(new Error("Protected credential helper input failed."));
      });
      child.stdin.end(JSON.stringify({ operation: "set", value: secret }));
    });
  }
}

export function generateCompanionSecret(): string {
  // 48 random bytes = 384 bits, comfortably above the 256-bit requirement.
  return randomBytes(48).toString("base64url");
}

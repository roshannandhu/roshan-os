import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { URL } from "node:url";

const username = process.env.TABLET_IP_WEBCAM_USERNAME || "";
const password = process.env.TABLET_IP_WEBCAM_PASSWORD || "";
const configuredBaseUrl = process.env.TABLET_IP_WEBCAM_BASE_URL;
if (!configuredBaseUrl || !username || !password) {
  throw new Error(
    "Set TABLET_IP_WEBCAM_BASE_URL, TABLET_IP_WEBCAM_USERNAME, and TABLET_IP_WEBCAM_PASSWORD in the current process environment."
  );
}
if (
  username.includes(":") ||
  /[\r\n]/u.test(username) ||
  /[\r\n]/u.test(password) ||
  username.length > 256 ||
  password.length > 512
) {
  throw new Error("IP Webcam diagnostic credentials are malformed.");
}
const parsedBaseUrl = new URL(configuredBaseUrl);
if (
  !["http:", "https:"].includes(parsedBaseUrl.protocol) ||
  parsedBaseUrl.username ||
  parsedBaseUrl.password ||
  parsedBaseUrl.pathname !== "/" ||
  parsedBaseUrl.search ||
  parsedBaseUrl.hash
) {
  throw new Error("TABLET_IP_WEBCAM_BASE_URL must be a credential-free HTTP(S) origin.");
}
const baseUrl = parsedBaseUrl.origin;
const authHeader = "Basic " + Buffer.from(username + ":" + password).toString("base64");

const adbPath = process.env.ADB_PATH?.trim() || "adb";

function getProcessInfo() {
  try {
    const out = execFileSync(adbPath, ["shell", "ps -A | grep com.pas.webcam"], {
      encoding: "utf8"
    });
    const lines = out.trim().split("\n");
    if (lines.length > 0 && lines[0].includes("com.pas.webcam")) {
      const parts = lines[0].trim().split(/\s+/);
      return { pid: parts[1], processName: parts[parts.length - 1] };
    }
  } catch (e) {
    return { pid: null, error: e.message };
  }
  return { pid: null };
}

async function fetchStatus() {
  try {
    const res = await fetch(`${baseUrl}/status.json`, {
      headers: { Authorization: authHeader },
      redirect: "error",
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) return { ok: false, status: res.status };
    const json = await res.json();
    return { ok: true, status: res.status, json };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function fetchSnapshot() {
  const t0 = Date.now();
  try {
    const res = await fetch(`${baseUrl}/shot.jpg`, {
      headers: { Authorization: authHeader },
      redirect: "error",
      signal: AbortSignal.timeout(4000)
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) return { ok: false, status: res.status, latencyMs };
    const contentType = res.headers.get("content-type");
    const buf = Buffer.from(await res.arrayBuffer());

    // Check JPEG Magic Bytes 0xFF 0xD8 ... 0xFF 0xD9
    const isJpeg =
      buf.length >= 4 &&
      buf[0] === 0xff &&
      buf[1] === 0xd8 &&
      buf[buf.length - 2] === 0xff &&
      buf[buf.length - 1] === 0xd9;
    const hash = crypto.createHash("sha256").update(buf).digest("hex");

    return {
      ok: true,
      status: res.status,
      contentType,
      sizeBytes: buf.length,
      isJpeg,
      hash,
      latencyMs,
      timestamp: Date.now()
    };
  } catch (e) {
    return { ok: false, error: e.message, latencyMs: Date.now() - t0 };
  }
}

async function runDiagnostic(durationSeconds = 15) {
  console.log(`=== STARTING CAMERA DIAGNOSTIC (${durationSeconds}s) ===`);
  console.log(`Base URL: ${baseUrl}`);
  const proc = getProcessInfo();
  console.log(`Process Info: PID=${proc.pid || "DEAD"}`);

  const status = await fetchStatus();
  console.log(
    `Status API:`,
    status.ok
      ? `200 OK (ffc=${status.json?.curvals?.ffc}, video_size=${status.json?.curvals?.video_size})`
      : `FAILED (${status.error || status.status})`
  );

  let prevHash = null;
  let totalFrames = 0;
  let freshFrames = 0;
  let frozenFrames = 0;
  let failedFrames = 0;
  let totalLatency = 0;

  const startTime = Date.now();
  while (Date.now() - startTime < durationSeconds * 1000) {
    const snap = await fetchSnapshot();
    totalFrames++;
    if (!snap.ok) {
      failedFrames++;
      console.log(
        `[Frame ${totalFrames}] FAILED: ${snap.error || snap.status} (${snap.latencyMs}ms)`
      );
    } else if (!snap.isJpeg) {
      failedFrames++;
      console.log(`[Frame ${totalFrames}] INVALID JPEG MAGIC BYTES (size=${snap.sizeBytes})`);
    } else {
      totalLatency += snap.latencyMs;
      if (snap.hash === prevHash) {
        frozenFrames++;
        console.log(
          `[Frame ${totalFrames}] FROZEN (Hash=${snap.hash.substring(0, 8)}, Latency=${snap.latencyMs}ms)`
        );
      } else {
        freshFrames++;
        console.log(
          `[Frame ${totalFrames}] FRESH  (Hash=${snap.hash.substring(0, 8)}, Size=${snap.sizeBytes}B, Latency=${snap.latencyMs}ms)`
        );
      }
      prevHash = snap.hash;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const avgLatency =
    freshFrames + frozenFrames > 0 ? (totalLatency / (freshFrames + frozenFrames)).toFixed(1) : 0;
  console.log(`\n=== DIAGNOSTIC SUMMARY ===`);
  console.log(`Total Frames Attempted: ${totalFrames}`);
  console.log(`Fresh Changing Frames:  ${freshFrames}`);
  console.log(`Frozen Duplicate Frames: ${frozenFrames}`);
  console.log(`Failed / Error Frames:   ${failedFrames}`);
  console.log(`Average Latency:        ${avgLatency}ms`);
  console.log(
    `Frame Freshness Rate:   ${totalFrames > 0 ? ((freshFrames / totalFrames) * 100).toFixed(1) : 0}%`
  );

  return { totalFrames, freshFrames, frozenFrames, failedFrames, avgLatency };
}

const requestedDuration = Number.parseInt(process.argv[2] || "15", 10);
if (!Number.isInteger(requestedDuration) || requestedDuration < 1 || requestedDuration > 300) {
  throw new Error("Diagnostic duration must be a whole number from 1 to 300 seconds.");
}
await runDiagnostic(requestedDuration);

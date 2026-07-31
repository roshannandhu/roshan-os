import { describe, expect, it } from "vitest";
import {
  classifyRawHttpOutcome,
  classifyHttpOutcome,
  currentHelperTreatsHttpAsLive,
  mayAttemptRestart,
  parseHttpProbeResult,
  validateProvisioningInput
} from "./health-model.js";

describe("Phase 4A.1 health-check model", () => {
  it("reproduces the installed helper's HTTP 200/401 liveness rule", () => {
    expect(currentHelperTreatsHttpAsLive(200)).toBe(true);
    expect(currentHelperTreatsHttpAsLive(401)).toBe(true);
    expect(currentHelperTreatsHttpAsLive(500)).toBe(false);
  });

  it("preserves unauthenticated HTTP 200 health", () => {
    expect(
      classifyHttpOutcome({
        authMode: "disabled",
        credentialConfig: "missing",
        curlExit: 0,
        statusCode: 200
      })
    ).toEqual({ state: "healthy", livenessHealthy: true });
  });

  it("regresses the exact Android-shell failure shape with a literal delimiter parser", () => {
    expect(parseHttpProbeResult("200|1234")).toEqual({
      kind: "valid",
      statusCode: 200,
      byteCount: "1234"
    });
  });

  it.each([
    ["200|0", { kind: "valid", statusCode: 200, byteCount: "0" }],
    ["200|1234", { kind: "valid", statusCode: 200, byteCount: "1234" }],
    ["401|0", { kind: "valid", statusCode: 401, byteCount: "0" }],
    ["401|123", { kind: "valid", statusCode: 401, byteCount: "123" }],
    ["500|123", { kind: "valid", statusCode: 500, byteCount: "123" }],
    ["200|1234\n", { kind: "valid", statusCode: 200, byteCount: "1234" }],
    ["200|1234\r\n", { kind: "valid", statusCode: 200, byteCount: "1234" }],
    ["", { kind: "empty-response" }],
    ["200123", { kind: "invalid-probe" }],
    ["200|123|456", { kind: "invalid-probe" }],
    ["twohundred|123", { kind: "invalid-probe" }],
    ["200|bytes", { kind: "invalid-probe" }],
    ["200|123$()", { kind: "invalid-probe" }]
  ])("validates probe fixture %j", (raw, expected) => {
    expect(parseHttpProbeResult(raw)).toEqual(expected);
  });

  it("keeps malformed, empty, and curl-failed probes unhealthy", () => {
    const base = { authMode: "disabled" as const, credentialConfig: "missing" as const };
    expect(classifyRawHttpOutcome({ ...base, curlExit: 0, rawProbe: "" })).toEqual({
      state: "empty-response",
      livenessHealthy: false
    });
    expect(classifyRawHttpOutcome({ ...base, curlExit: 0, rawProbe: "200|1|2" })).toEqual({
      state: "invalid-probe",
      livenessHealthy: false
    });
    expect(classifyRawHttpOutcome({ ...base, curlExit: 28, rawProbe: "000|0" })).toEqual({
      state: "partial-or-timeout",
      livenessHealthy: false
    });
  });

  it("distinguishes a response-completion timeout from a timeout before HTTP status", () => {
    const base = { authMode: "disabled" as const, credentialConfig: "missing" as const };
    expect(classifyRawHttpOutcome({ ...base, curlExit: 28, rawProbe: "200|289" })).toEqual({
      state: "response-completion-timeout",
      livenessHealthy: false
    });
    expect(classifyRawHttpOutcome({ ...base, curlExit: 7, rawProbe: "" })).toEqual({
      state: "partial-or-timeout",
      livenessHealthy: false
    });
  });

  it("classifies 401 as a non-restart authentication state", () => {
    expect(
      classifyHttpOutcome({
        authMode: "enabled",
        credentialConfig: "ready",
        curlExit: 0,
        statusCode: 401
      })
    ).toEqual({ state: "auth-invalid", livenessHealthy: true });
  });

  it("accepts an authenticated HTTP 200", () => {
    expect(
      classifyHttpOutcome({
        authMode: "enabled",
        credentialConfig: "ready",
        curlExit: 0,
        statusCode: 200
      })
    ).toEqual({ state: "healthy", livenessHealthy: true });
  });

  it("keeps missing or malformed credential configuration out of restart loops", () => {
    for (const credentialConfig of ["missing", "malformed"] as const) {
      expect(
        classifyHttpOutcome({ authMode: "enabled", credentialConfig, curlExit: 0, statusCode: 401 })
      ).toEqual({ state: "auth-config-missing-or-invalid", livenessHealthy: true });
    }
  });

  it("classifies timeout and partial response as unhealthy", () => {
    expect(
      classifyHttpOutcome({
        authMode: "disabled",
        credentialConfig: "missing",
        curlExit: 28,
        statusCode: 200
      })
    ).toEqual({ state: "partial-or-timeout", livenessHealthy: false });
  });

  it("only permits a bounded restart for a true liveness failure", () => {
    expect(
      mayAttemptRestart({
        listenerAvailable: false,
        livenessHealthy: false,
        attemptsInWindow: 2,
        maximumAttempts: 3
      })
    ).toBe(true);
    expect(
      mayAttemptRestart({
        listenerAvailable: true,
        livenessHealthy: false,
        attemptsInWindow: 0,
        maximumAttempts: 3
      })
    ).toBe(true);
    expect(
      mayAttemptRestart({
        listenerAvailable: false,
        livenessHealthy: true,
        attemptsInWindow: 0,
        maximumAttempts: 3
      })
    ).toBe(false);
    expect(
      mayAttemptRestart({
        listenerAvailable: false,
        livenessHealthy: false,
        attemptsInWindow: 3,
        maximumAttempts: 3
      })
    ).toBe(false);
  });

  it("rejects unsafe provisioning values before a curl config could be written", () => {
    expect(validateProvisioningInput("TabletAdmin1", "A12345678901234567890123")).toBe(true);
    expect(validateProvisioningInput("bad-name", "A12345678901234567890123")).toBe(false);
    expect(validateProvisioningInput("TabletAdmin1", "short")).toBe(false);
    for (const unsafePassword of [
      "A12345678901234567890$%^",
      "A12345678901234567890,abc",
      "A12345678901234567890()",
      "A12345678901234567890 xx",
      'A12345678901234567890"xx'
    ]) {
      expect(validateProvisioningInput("TabletAdmin1", unsafePassword)).toBe(false);
    }
  });
});

export type AuthMode = "disabled" | "enabled" | "invalid";

export type HttpOutcome = {
  authMode: AuthMode;
  credentialConfig: "ready" | "missing" | "malformed";
  curlExit: number;
  statusCode: number;
};

export type HealthState =
  | "healthy"
  | "auth-required-while-disabled"
  | "auth-invalid"
  | "auth-config-missing-or-invalid"
  | "partial-or-timeout"
  | "response-completion-timeout"
  | "empty-response"
  | "invalid-probe"
  | "http-unhealthy";

export type ProbeParseResult =
  | { kind: "valid"; statusCode: number; byteCount: string }
  | { kind: "empty-response" }
  | { kind: "invalid-probe" };

/**
 * Mirrors the repaired helper's POSIX-safe validation of curl's exact
 * `HTTP_CODE|BYTE_COUNT` output. One trailing LF, CR, or CRLF is accepted.
 */
export function parseHttpProbeResult(raw: string): ProbeParseResult {
  if (raw === "") {
    return { kind: "empty-response" };
  }

  const match = /^([0-9]{3})\|([0-9]+)(?:\r\n|\n|\r)?$/.exec(raw);
  if (!match) {
    return { kind: "invalid-probe" };
  }

  return { kind: "valid", statusCode: Number(match[1]), byteCount: match[2] };
}

export function classifyRawHttpOutcome(
  input: Omit<HttpOutcome, "statusCode"> & { rawProbe: string }
): {
  state: HealthState;
  livenessHealthy: boolean;
} {
  const parsed = parseHttpProbeResult(input.rawProbe);
  if (input.curlExit !== 0) {
    if (parsed.kind === "valid" && parsed.statusCode >= 100 && parsed.statusCode <= 599) {
      return { state: "response-completion-timeout", livenessHealthy: false };
    }
    return { state: "partial-or-timeout", livenessHealthy: false };
  }

  if (parsed.kind !== "valid") {
    return { state: parsed.kind, livenessHealthy: false };
  }

  return classifyHttpOutcome({ ...input, statusCode: parsed.statusCode });
}

/** Mirrors the installed helper's current `200|401` liveness behavior. */
export function currentHelperTreatsHttpAsLive(statusCode: number): boolean {
  return statusCode === 200 || statusCode === 401;
}

export function classifyHttpOutcome(outcome: HttpOutcome): {
  state: HealthState;
  livenessHealthy: boolean;
} {
  if (outcome.curlExit !== 0) {
    return { state: "partial-or-timeout", livenessHealthy: false };
  }

  if (outcome.statusCode === 200) {
    return {
      state:
        outcome.authMode === "enabled" && outcome.credentialConfig !== "ready"
          ? "auth-config-missing-or-invalid"
          : "healthy",
      livenessHealthy: true
    };
  }

  if (outcome.statusCode === 401) {
    if (outcome.authMode === "enabled") {
      return {
        state:
          outcome.credentialConfig === "ready" ? "auth-invalid" : "auth-config-missing-or-invalid",
        livenessHealthy: true
      };
    }

    return { state: "auth-required-while-disabled", livenessHealthy: true };
  }

  return { state: "http-unhealthy", livenessHealthy: false };
}

export function validateProvisioningInput(username: string, password: string): boolean {
  return (
    /^[A-Za-z0-9]+$/.test(username) && /^[A-Za-z0-9]+$/.test(password) && password.length >= 24
  );
}

export function mayAttemptRestart(input: {
  listenerAvailable: boolean;
  livenessHealthy: boolean;
  attemptsInWindow: number;
  maximumAttempts: number;
}): boolean {
  return !input.livenessHealthy && input.attemptsInWindow < input.maximumAttempts;
}

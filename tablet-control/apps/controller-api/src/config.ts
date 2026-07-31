export type AdapterMode = "mock" | "real-readonly" | "companion";

export interface FullyKioskConfig {
  baseUrl: string;
  adminPassword: string; // never logged or serialized to the client
  requestTimeoutMs: number;
}

export interface CompanionConfig {
  baseUrl: string;
  secret: string; // never logged or serialized to the client
  requestTimeoutMs: number;
  transport?: Exclude<Transport, "mock">;
}
export type Transport = "mock" | "trusted-lan" | "tailscale";
export type ControllerExposureMode = "localhost" | "lan-validation";

export interface IpWebcamCredentials {
  username: string;
  password: string; // never logged or serialized to the client
}

export interface IpWebcamReadOnlyConfig {
  baseUrl: URL;
  transport: Exclude<Transport, "mock">;
  requestTimeoutMs: number;
  maxReconnectAttempts: number;
  credentials?: IpWebcamCredentials;
}

export interface AppConfig {
  environment: "development" | "test" | "production";
  bindHost: string;
  port: number;
  exposureMode: ControllerExposureMode;
  allowedClientIps: string[];
  serveWeb: boolean;
  sessionCookieName: string;
  sessionSecret: string;
  sessionTtlMs: number;
  adminUsername: string;
  mockAdminPassword: string;
  allowedOrigin: string;
  controllerPublicOrigin: string | undefined;
  adapterMode: AdapterMode;
  ipWebcam: IpWebcamReadOnlyConfig | undefined;
  fully: FullyKioskConfig | undefined;
  companion: CompanionConfig | undefined;
}

export type AppConfigOverrides = Partial<AppConfig>;

export interface RuntimeSecretOverrides {
  companionSecret?: string;
}

const defaultConfig: AppConfig = {
  environment: "development",
  bindHost: "127.0.0.1",
  port: 3000,
  exposureMode: "localhost",
  allowedClientIps: [],
  serveWeb: false,
  sessionCookieName: "tablet_control_session",
  sessionSecret: "phase-1-placeholder-session-secret-not-for-deployment",
  sessionTtlMs: 1000 * 60 * 60 * 8,
  adminUsername: "admin",
  mockAdminPassword: "phase-1-local-only",
  allowedOrigin: "http://127.0.0.1:5173",
  controllerPublicOrigin: undefined,
  adapterMode: "mock",
  ipWebcam: undefined,
  fully: undefined,
  companion: undefined
};

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined || value.length === 0) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error("Read-only adapter numeric configuration is invalid.");
  }

  return parsed;
}

function parseEnvironmentMode(value: string | undefined): AdapterMode {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      "TABLET_ADAPTER_MODE is missing. It must be explicitly set to mock, real-readonly, or companion."
    );
  }

  if (value === "mock" || value === "real-readonly" || value === "companion") {
    return value;
  }

  throw new Error("TABLET_ADAPTER_MODE must be mock, real-readonly, or companion.");
}

function parseRuntimeEnvironment(value: string | undefined): AppConfig["environment"] {
  if (value === undefined || value.length === 0) {
    return "development";
  }

  if (value === "development" || value === "test" || value === "production") {
    return value;
  }

  throw new Error("NODE_ENV must be development, test, or production.");
}

function parseIpv4(value: string | undefined, variableName: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(variableName + " is required.");
  }

  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    throw new Error(variableName + " must be an IPv4 address.");
  }

  return value;
}

function parseIpv4List(value: string | undefined, variableName: string): string[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }

  const ips = value
    .split(",")
    .map((ip) => ip.trim())
    .filter((ip) => ip.length > 0);
  if (ips.length === 0) {
    return [];
  }

  for (const ip of ips) {
    parseIpv4(ip, variableName);
  }

  return ips;
}

export function isPrivateIpv4(value: string): boolean {
  const [first, second] = value.split(".").map(Number);
  return (
    first === 10 ||
    (first === 100 && second !== undefined && second >= 64 && second <= 127) ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isLoopbackHost(value: string): boolean {
  return value === "127.0.0.1" || value === "localhost";
}

function isLoopbackBaseUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
  } catch {
    return false;
  }
}

function parseServiceBaseUrl(value: string, varName: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${varName} must be a valid HTTP URL.`);
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) {
    throw new Error(`${varName} must be credential-free HTTP or HTTPS.`);
  }
  return value.replace(/\/$/, "");
}

function parseBindHost(value: string | undefined): string {
  if (value === undefined || value.length === 0 || value === "127.0.0.1") {
    return "127.0.0.1";
  }

  if (value === "localhost") {
    return value;
  }

  return parseIpv4(value, "CONTROLLER_BIND_HOST");
}

function parseExposureMode(value: string | undefined): ControllerExposureMode {
  if (value === undefined || value.length === 0 || value === "localhost") {
    return "localhost";
  }

  if (value === "lan-validation") {
    return value;
  }

  throw new Error("CONTROLLER_EXPOSURE_MODE must be localhost or lan-validation.");
}

function parseBoolean(value: string | undefined, fallback: boolean, variableName: string): boolean {
  if (value === undefined || value.length === 0) {
    return fallback;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(variableName + " must be true or false.");
}

function parseTransport(value: string | undefined): Exclude<Transport, "mock"> {
  if (value === undefined || value.length === 0 || value === "trusted-lan") {
    return "trusted-lan";
  }

  if (value === "tailscale") {
    return value;
  }

  throw new Error("TABLET_TRANSPORT must be trusted-lan or tailscale.");
}

export function parseControllerPublicOrigin(value: string): string {
  const hasControlOrWhitespace = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x20 || codePoint === 0x7f;
  });
  if (
    value.length === 0 ||
    value.length > 2_048 ||
    value !== value.trim() ||
    hasControlOrWhitespace
  ) {
    throw new Error("CONTROLLER_PUBLIC_ORIGIN must be a canonical HTTPS Tailscale ts.net origin.");
  }
  const rawOrigin = /^https:\/\/([A-Za-z0-9.-]+)(?::443)?\/?$/u.exec(value);
  if (rawOrigin === null) {
    throw new Error("CONTROLLER_PUBLIC_ORIGIN must be a canonical HTTPS Tailscale ts.net origin.");
  }

  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("CONTROLLER_PUBLIC_ORIGIN must be a canonical HTTPS Tailscale ts.net origin.");
  }

  const hostname = origin.hostname.toLowerCase();
  const labels = hostname.split(".");
  const validDnsName =
    hostname.length <= 253 &&
    hostname !== "ts.net" &&
    hostname.endsWith(".ts.net") &&
    labels.every(
      (label) =>
        label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
    );

  if (
    origin.protocol !== "https:" ||
    origin.username.length !== 0 ||
    origin.password.length !== 0 ||
    (origin.port.length !== 0 && origin.port !== "443") ||
    origin.pathname !== "/" ||
    origin.search.length !== 0 ||
    origin.hash.length !== 0 ||
    hostname !== rawOrigin[1]?.toLowerCase() ||
    !validDnsName
  ) {
    throw new Error("CONTROLLER_PUBLIC_ORIGIN must be a canonical HTTPS Tailscale ts.net origin.");
  }

  return `https://${hostname}`;
}

function parseIpWebcamCredentials(
  username: string | undefined,
  password: string | undefined
): IpWebcamCredentials | undefined {
  const hasUsername = username !== undefined && username.trim().length > 0;
  const hasPassword = password !== undefined && password.trim().length > 0;
  if (!hasUsername || !hasPassword) {
    throw new Error(
      "TABLET_IP_WEBCAM_USERNAME and TABLET_IP_WEBCAM_PASSWORD must be provided for real adapter modes."
    );
  }
  return { username, password };
}

function parseRequiredServiceConfig(
  baseUrlValue: string | undefined,
  secretValue: string | undefined,
  baseUrlVariable: string,
  secretVariable: string
): { baseUrl: string; secret: string } | undefined {
  const hasBaseUrl = baseUrlValue !== undefined && baseUrlValue.trim().length > 0;
  const hasSecret = secretValue !== undefined && secretValue.trim().length > 0;
  if (!hasBaseUrl && !hasSecret) {
    return undefined;
  }
  if (!hasBaseUrl || !hasSecret) {
    throw new Error(
      `${baseUrlVariable} and ${secretVariable} must both be provided for real adapter modes.`
    );
  }

  return {
    baseUrl: parseServiceBaseUrl(baseUrlValue, baseUrlVariable),
    secret: secretValue
  };
}

function createReadOnlyConfig(
  baseUrlValue: string | undefined,
  transport: Exclude<Transport, "mock">,
  requestTimeoutMs: number,
  maxReconnectAttempts: number,
  credentials: IpWebcamCredentials | undefined
): IpWebcamReadOnlyConfig {
  if (baseUrlValue === undefined || baseUrlValue.length === 0) {
    throw new Error("TABLET_IP_WEBCAM_BASE_URL is required in real-readonly mode.");
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlValue);
  } catch {
    throw new Error("TABLET_IP_WEBCAM_BASE_URL must be a valid HTTP URL.");
  }

  if (
    (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") ||
    baseUrl.username ||
    baseUrl.password
  ) {
    throw new Error("TABLET_IP_WEBCAM_BASE_URL must be credential-free HTTP or HTTPS.");
  }

  return {
    baseUrl,
    transport,
    requestTimeoutMs,
    maxReconnectAttempts,
    ...(credentials !== undefined ? { credentials } : {})
  };
}

export function createConfig(
  overrides: AppConfigOverrides = {},
  runtimeSecrets: RuntimeSecretOverrides = {}
): AppConfig {
  const environment = overrides.environment ?? parseRuntimeEnvironment(process.env.NODE_ENV);
  const adapterMode =
    overrides.adapterMode ??
    (environment === "test" && process.env.TABLET_ADAPTER_MODE === undefined
      ? "mock"
      : parseEnvironmentMode(process.env.TABLET_ADAPTER_MODE));
  const requestTimeoutMs = parseBoundedInteger(
    process.env.TABLET_REQUEST_TIMEOUT_MS,
    5_000,
    500,
    10_000
  );
  const maxReconnectAttempts = parseBoundedInteger(
    process.env.TABLET_STREAM_MAX_RECONNECT_ATTEMPTS,
    3,
    0,
    3
  );
  const transport = parseTransport(process.env.TABLET_TRANSPORT);
  const bindHost = overrides.bindHost ?? parseBindHost(process.env.CONTROLLER_BIND_HOST);
  const exposureMode =
    overrides.exposureMode ?? parseExposureMode(process.env.CONTROLLER_EXPOSURE_MODE);
  const allowedClientIps =
    overrides.allowedClientIps ??
    parseIpv4List(process.env.CONTROLLER_ALLOWED_CLIENT_IP, "CONTROLLER_ALLOWED_CLIENT_IP");
  const serveWeb =
    overrides.serveWeb ??
    parseBoolean(process.env.CONTROLLER_SERVE_WEB, false, "CONTROLLER_SERVE_WEB");
  const adminPassword =
    overrides.mockAdminPassword ??
    process.env.CONTROLLER_ADMIN_PASSWORD ??
    defaultConfig.mockAdminPassword;
  const sessionSecret =
    overrides.sessionSecret ??
    process.env.CONTROLLER_SESSION_SECRET ??
    process.env.SESSION_SECRET ??
    defaultConfig.sessionSecret;
  const controllerPublicOriginValue =
    overrides.controllerPublicOrigin ?? process.env.CONTROLLER_PUBLIC_ORIGIN;
  const controllerPublicOrigin =
    controllerPublicOriginValue === undefined
      ? undefined
      : parseControllerPublicOrigin(controllerPublicOriginValue);

  const config: AppConfig = {
    ...defaultConfig,
    ...overrides,
    environment,
    bindHost,
    port: overrides.port ?? parseBoundedInteger(process.env.CONTROLLER_PORT, 3000, 1024, 65535),
    exposureMode,
    allowedClientIps,
    serveWeb,
    controllerPublicOrigin,
    mockAdminPassword: adminPassword,
    sessionSecret,
    adminUsername:
      overrides.adminUsername ??
      process.env.CONTROLLER_ADMIN_USERNAME ??
      defaultConfig.adminUsername,
    adapterMode,
    ipWebcam: undefined
  };

  if (exposureMode === "localhost") {
    if (!isLoopbackHost(bindHost) && bindHost !== "0.0.0.0") {
      throw new Error("CONTROLLER_BIND_HOST must remain loopback or 0.0.0.0.");
    }
  } else {
    if (!isPrivateIpv4(bindHost) && bindHost !== "0.0.0.0") {
      throw new Error(
        "lan-validation mode requires a private IPv4 CONTROLLER_BIND_HOST or 0.0.0.0."
      );
    }
    for (const ip of allowedClientIps) {
      if (!isPrivateIpv4(ip)) {
        throw new Error("CONTROLLER_ALLOWED_CLIENT_IP must contain only private IPv4 addresses.");
      }
    }

    if (adminPassword.length < 20) {
      throw new Error(
        "lan-validation mode requires a temporary controller password of at least 20 characters."
      );
    }

    if (sessionSecret.length < 32) {
      throw new Error("lan-validation mode requires a session secret of at least 32 characters.");
    }

    if (!serveWeb || (adapterMode !== "real-readonly" && adapterMode !== "companion")) {
      throw new Error(
        "lan-validation mode requires CONTROLLER_SERVE_WEB=true and real-readonly or companion mode."
      );
    }
  }

  if (adapterMode === "real-readonly") {
    const configuredIpWebcam = overrides.ipWebcam;
    if (configuredIpWebcam !== undefined) {
      config.ipWebcam = configuredIpWebcam;
    } else {
      const baseUrl = process.env.TABLET_IP_WEBCAM_BASE_URL;
      if (baseUrl === undefined || baseUrl.length === 0) {
        throw new Error("TABLET_IP_WEBCAM_BASE_URL is required in real-readonly mode.");
      }
      const credentials = parseIpWebcamCredentials(
        process.env.TABLET_IP_WEBCAM_USERNAME,
        process.env.TABLET_IP_WEBCAM_PASSWORD
      );
      config.ipWebcam = createReadOnlyConfig(
        baseUrl,
        transport,
        requestTimeoutMs,
        maxReconnectAttempts,
        credentials
      );
    }
  } else if (adapterMode === "companion") {
    const configuredIpWebcam = overrides.ipWebcam;
    if (configuredIpWebcam !== undefined) {
      config.ipWebcam = configuredIpWebcam;
    } else {
      const baseUrl = process.env.TABLET_IP_WEBCAM_BASE_URL;
      const username = process.env.TABLET_IP_WEBCAM_USERNAME;
      const password = process.env.TABLET_IP_WEBCAM_PASSWORD;
      const anyFallbackSetting = [baseUrl, username, password].some(
        (setting) => setting !== undefined && setting.trim().length > 0
      );
      if (anyFallbackSetting) {
        if (baseUrl === undefined || baseUrl.trim().length === 0) {
          throw new Error(
            "TABLET_IP_WEBCAM_BASE_URL is required when the optional IP Webcam fallback is configured."
          );
        }
        config.ipWebcam = createReadOnlyConfig(
          baseUrl,
          transport,
          requestTimeoutMs,
          maxReconnectAttempts,
          parseIpWebcamCredentials(username, password)
        );
      }
    }
  }

  if (overrides.fully !== undefined) {
    config.fully = overrides.fully;
  } else {
    const fullyConfig = parseRequiredServiceConfig(
      process.env.TABLET_FULLY_BASE_URL,
      process.env.TABLET_FULLY_ADMIN_PASSWORD,
      "TABLET_FULLY_BASE_URL",
      "TABLET_FULLY_ADMIN_PASSWORD"
    );
    if (fullyConfig !== undefined) {
      config.fully = {
        baseUrl: fullyConfig.baseUrl,
        adminPassword: fullyConfig.secret,
        requestTimeoutMs
      };
    }
  }

  if (overrides.companion !== undefined) {
    config.companion = overrides.companion;
  } else {
    // Re-entrant config builds (e.g. createApp() re-resolving an already-built
    // AppConfig as overrides) must not re-read TABLET_COMPANION_SECRET from
    // process.env: the DPAPI-loaded secret is deleted from the environment
    // after its first read in server.ts, so this branch would otherwise throw
    // on the second pass even though a valid companion config was provided.
    const companionConfig = parseRequiredServiceConfig(
      process.env.TABLET_COMPANION_BASE_URL,
      runtimeSecrets.companionSecret ?? process.env.TABLET_COMPANION_SECRET,
      "TABLET_COMPANION_BASE_URL",
      "TABLET_COMPANION_SECRET"
    );
    if (companionConfig !== undefined) {
      config.companion = {
        baseUrl: companionConfig.baseUrl,
        secret: companionConfig.secret,
        requestTimeoutMs,
        transport
      };
    }
  }

  if (exposureMode === "lan-validation") {
    if (config.companion !== undefined && isLoopbackBaseUrl(config.companion.baseUrl)) {
      throw new Error(
        "lan-validation mode: TABLET_COMPANION_BASE_URL must not be a loopback address."
      );
    }
    if (config.fully !== undefined && isLoopbackBaseUrl(config.fully.baseUrl)) {
      throw new Error("lan-validation mode: TABLET_FULLY_BASE_URL must not be a loopback address.");
    }
  }

  if (environment === "production") {
    if (adapterMode !== "companion") {
      throw new Error(
        "Production requires TABLET_ADAPTER_MODE=companion; mock and real-readonly are development-only."
      );
    }
    if (!serveWeb) {
      throw new Error("Production requires CONTROLLER_SERVE_WEB=true.");
    }
    if (config.companion === undefined) {
      throw new Error("Production requires TABLET_COMPANION_BASE_URL and TABLET_COMPANION_SECRET.");
    }
    if (config.controllerPublicOrigin === undefined) {
      throw new Error(
        "Production requires CONTROLLER_PUBLIC_ORIGIN as a strict HTTPS Tailscale ts.net origin."
      );
    }
    if (adminPassword.length < 20 || sessionSecret.length < 32) {
      throw new Error(
        "Production requires strong CONTROLLER_ADMIN_PASSWORD and CONTROLLER_SESSION_SECRET values."
      );
    }
  }

  return config;
}

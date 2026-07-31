import type { TabletAdapters } from "@tablet-control/integration-contracts";
import {
  AdminPinRateLimitResetSchema,
  AppPackageMutationSchema,
  AppLaunchSchema,
  CameraFocusSchema,
  CameraFpsSchema,
  CameraOrientationInputSchema,
  CameraQualitySchema,
  CameraResolutionSchema,
  CameraSelectSchema,
  type CameraStatus,
  CameraTorchSchema,
  CameraZoomSchema,
  ControllerUpdateArtifactSchema,
  ControllerCapabilitiesSchema,
  DeviceBrightnessSchema,
  DeviceMediaSchema,
  DeviceOrientationSchema,
  DeviceRebootSchema,
  DeviceScreenSchema,
  DeviceTouchLockSchema,
  DeviceVolumeSchema,
  DpcMaintenanceActionSchema,
  HealthSchema,
  LoginSchema,
  LiveTextDisplaySchema,
  MEDIA_MAX_FILE_BYTES,
  MediaDisplaySchema,
  MediaIdSchema,
  MediaUploadSchema,
  type MediaMimeType,
  MessageDisplaySchema,
  RemoteCloseAppSchema,
  RemoteEnabledSchema,
  RemoteKeyInputSchema,
  RemoteSwipeSchema,
  RemoteTapSchema,
  RemoteTextSchema,
  type ServerComponentHealth,
  ServerHealthSchema,
  type ServerHealth,
  SignageCompletionSchema,
  SignagePlaybackAckSchema,
  SignagePlaylistUpdateSchema,
  ServiceRestartBodySchema,
  ServiceRestartTargetSchema,
  SignedUpdateRollbackInputSchema,
  TabletStatusSchema,
  TailscaleEnrollmentRequestSchema,
  UpdateArtifactIdSchema,
  type MediaItem,
  type SignageItem,
  type SignagePlaylistUpdate,
  type TabletStatus,
  WebpageDisplaySchema,
  success
} from "@tablet-control/shared-types";
import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z, type ZodType } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getRequestSession, requireCsrf, requireSession, safeEquals } from "./auth.js";
import type { SessionStore } from "./auth.js";
import type { AppConfig } from "./config.js";
import { ApiProblem } from "./errors.js";
import type { TalkCoordinator } from "./talk.js";
import { MediaLibrary, MediaStorageError } from "./media-library.js";
import {
  renderSignagePlayer,
  SIGNAGE_PLAYBACK_CAPABILITY_TTL_SECONDS,
  SIGNAGE_PLAYBACK_COOKIE_NAME,
  SIGNAGE_PLAYBACK_COOKIE_PATH,
  SIGNAGE_PLAYER_CACHE_CONTROL,
  SignagePlaybackCapability,
  signagePlayerEtag,
  SignagePlaybackStore,
  SignagePlaylistStore
} from "./signage.js";
import { validateExternalUrl } from "./ssrf-guard.js";
import { UpdateArtifactStorageError, type UpdateArtifactStore } from "./update-artifact-store.js";

export interface RouteServices {
  config: AppConfig;
  sessions: SessionStore;
  adapters: TabletAdapters;
  talk: TalkCoordinator;
  storageDirectory: string;
  updateArtifactStore: UpdateArtifactStore;
}

function getControllerBaseUrl(request: FastifyRequest, config: AppConfig): string {
  const hostHeader = request.headers.host;
  const forwardedProto = request.headers["x-forwarded-proto"];
  const forwardedValue = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const requestedProto = forwardedValue?.split(",")[0]?.trim();
  const proto =
    requestedProto === "http" || requestedProto === "https"
      ? requestedProto
      : request.protocol === "https"
        ? "https"
        : "http";
  if (hostHeader !== undefined) {
    try {
      const candidate = new URL(`${proto}://${hostHeader}`);
      if (
        candidate.username.length === 0 &&
        candidate.password.length === 0 &&
        candidate.pathname === "/" &&
        candidate.search.length === 0 &&
        candidate.hash.length === 0
      ) {
        return candidate.origin;
      }
    } catch {
      // Fall back to the configured listener when the Host header is malformed.
    }
  }
  return `http://${config.bindHost}:${config.port}`;
}

function requestUsesHttps(request: FastifyRequest): boolean {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const forwardedValue = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return forwardedValue?.split(",")[0]?.trim() === "https" || request.protocol === "https";
}

function issueSignagePlaybackCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  capabilities: SignagePlaybackCapability
): void {
  const userAgent = request.headers["user-agent"];
  const normalizedUserAgent = Array.isArray(userAgent) ? userAgent[0] : userAgent;
  reply.setCookie(
    SIGNAGE_PLAYBACK_COOKIE_NAME,
    capabilities.issue(request.ip, normalizedUserAgent),
    {
      httpOnly: true,
      sameSite: "strict",
      secure: requestUsesHttps(request),
      path: SIGNAGE_PLAYBACK_COOKIE_PATH,
      maxAge: SIGNAGE_PLAYBACK_CAPABILITY_TTL_SECONDS
    }
  );
}

function requireSignagePlaybackCapability(
  request: FastifyRequest,
  capabilities: SignagePlaybackCapability
): void {
  const userAgent = request.headers["user-agent"];
  const normalizedUserAgent = Array.isArray(userAgent) ? userAgent[0] : userAgent;
  if (
    !capabilities.validate(
      request.cookies[SIGNAGE_PLAYBACK_COOKIE_NAME],
      request.ip,
      normalizedUserAgent
    )
  ) {
    throw new ApiProblem(
      401,
      "UNAUTHENTICATED",
      "A valid signage player capability is required.",
      false
    );
  }
}

function parseBody<T>(schema: ZodType<T>, request: FastifyRequest): T {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    throw new ApiProblem(400, "VALIDATION_ERROR", "Request body is invalid.", false);
  }

  return parsed.data;
}

const MiniAlbumCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    itemIds: z.array(MediaIdSchema).max(100).default([]),
    durationPerItemSeconds: z.number().int().min(1).max(3600).default(10)
  })
  .strict();

const MiniAlbumUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    itemIds: z.array(MediaIdSchema).max(100).optional(),
    durationPerItemSeconds: z.number().int().min(1).max(3600).optional(),
    loop: z.boolean().optional(),
    shuffle: z.boolean().optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one album field is required.");

function authorizeMutation(request: FastifyRequest, services: RouteServices): void {
  const session = requireSession(request, services.config, services.sessions);
  requireCsrf(request, session);

  if (services.config.adapterMode === "real-readonly") {
    actionRequiresApproval();
  }
}

async function requireVerifiedExternalUrl(url: string): Promise<string> {
  const validation = await validateExternalUrl(url.trim());
  if (!validation.valid || validation.url === undefined) {
    throw new ApiProblem(
      400,
      "FORBIDDEN",
      validation.error ?? "The external webpage URL is not permitted.",
      false
    );
  }
  return validation.url.toString();
}

// Camera controls are verified and allowed regardless of adapter mode.
function authorizeCameraControl(request: FastifyRequest, services: RouteServices): void {
  const session = requireSession(request, services.config, services.sessions);
  requireCsrf(request, session);
}

function mediaStorageProblem(error: unknown): never {
  if (!(error instanceof MediaStorageError)) {
    throw error;
  }
  if (error.kind === "file-too-large") {
    throw new ApiProblem(413, "VALIDATION_ERROR", error.message, false);
  }
  if (error.kind === "library-full" || error.kind === "item-limit") {
    throw new ApiProblem(409, "CONFLICT", error.message, true);
  }
  throw new ApiProblem(400, "VALIDATION_ERROR", error.message, false);
}

interface StreamedMultipartFile {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
}

function multipartUploadProblem(error: unknown): never {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code === "FST_REQ_FILE_TOO_LARGE" || code === "FST_FILES_LIMIT") {
    throw new ApiProblem(
      413,
      "VALIDATION_ERROR",
      "The media file exceeds the 50 MB upload limit.",
      false
    );
  }
  if (
    code === "FST_FIELDS_LIMIT" ||
    code === "FST_PARTS_LIMIT" ||
    code === "FST_INVALID_MULTIPART_CONTENT_TYPE"
  ) {
    throw new ApiProblem(400, "VALIDATION_ERROR", "The multipart upload is invalid.", false);
  }
  throw error;
}

async function storeMultipartMedia(
  request: FastifyRequest,
  mediaLibrary: MediaLibrary
): Promise<MediaItem> {
  if (!request.isMultipart()) {
    throw new ApiProblem(
      415,
      "VALIDATION_ERROR",
      "Media uploads must use multipart/form-data.",
      false
    );
  }

  const fields = new Map<string, string>();
  let uploaded: StreamedMultipartFile | undefined;
  let temporaryPath: string | undefined;

  try {
    try {
      const parts = request.parts({
        limits: {
          fieldNameSize: 32,
          fieldSize: 256,
          fields: 2,
          files: 1,
          parts: 3,
          fileSize: MEDIA_MAX_FILE_BYTES
        }
      });

      for await (const part of parts) {
        if (part.type === "field") {
          if (
            (part.fieldname !== "title" && part.fieldname !== "durationSeconds") ||
            typeof part.value !== "string" ||
            fields.has(part.fieldname)
          ) {
            throw new ApiProblem(
              400,
              "VALIDATION_ERROR",
              "The multipart upload metadata is invalid.",
              false
            );
          }
          fields.set(part.fieldname, part.value);
          continue;
        }

        if (part.fieldname !== "file" || uploaded !== undefined || temporaryPath !== undefined) {
          throw new ApiProblem(
            400,
            "VALIDATION_ERROR",
            "Exactly one media file is required.",
            false
          );
        }

        temporaryPath = mediaLibrary.createTemporaryUploadPath();
        const hash = createHash("sha256");
        let sizeBytes = 0;
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            sizeBytes += chunk.length;
            if (sizeBytes > MEDIA_MAX_FILE_BYTES) {
              callback(
                Object.assign(new Error("The media file exceeds the upload limit."), {
                  code: "FST_REQ_FILE_TOO_LARGE"
                })
              );
              return;
            }
            hash.update(chunk);
            callback(null, chunk);
          }
        });

        await pipeline(
          part.file,
          meter,
          createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 })
        );
        if (part.file.truncated || sizeBytes <= 0) {
          throw Object.assign(new Error("The media file exceeds the upload limit."), {
            code: part.file.truncated ? "FST_REQ_FILE_TOO_LARGE" : "FST_INVALID_MULTIPART"
          });
        }
        uploaded = {
          fileName: part.filename,
          mimeType: part.mimetype,
          sizeBytes,
          checksum: hash.digest("hex")
        };
      }
    } catch (error) {
      multipartUploadProblem(error);
    }

    if (uploaded === undefined || temporaryPath === undefined) {
      throw new ApiProblem(400, "VALIDATION_ERROR", "Exactly one media file is required.", false);
    }

    const durationText = fields.get("durationSeconds") ?? "10";
    if (!/^[1-9][0-9]{0,3}$/u.test(durationText)) {
      throw new ApiProblem(
        400,
        "VALIDATION_ERROR",
        "Media duration must be a whole number from 1 to 3600.",
        false
      );
    }

    const parsed = MediaUploadSchema.safeParse({
      fileName: uploaded.fileName,
      mimeType: uploaded.mimeType,
      sizeBytes: uploaded.sizeBytes,
      durationSeconds: Number(durationText),
      ...(fields.has("title") ? { title: fields.get("title") } : {})
    });
    if (!parsed.success) {
      throw new ApiProblem(400, "VALIDATION_ERROR", "Media upload metadata is invalid.", false);
    }

    const input = parsed.data;
    try {
      return mediaLibrary.commitTemporaryUpload(
        {
          fileName: input.fileName,
          ...(input.title !== undefined ? { title: input.title } : {}),
          mimeType: input.mimeType as MediaMimeType,
          sizeBytes: input.sizeBytes,
          durationSeconds: input.durationSeconds
        },
        temporaryPath,
        uploaded.checksum
      );
    } catch (error) {
      return mediaStorageProblem(error);
    }
  } finally {
    if (temporaryPath !== undefined && existsSync(temporaryPath)) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Startup cleanup can remove an abandoned private upload after an I/O failure.
      }
    }
  }
}

interface StreamedUpdateArtifact {
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

function updateUploadProblem(error: unknown, maxFileBytes: number): never {
  if (error instanceof UpdateArtifactStorageError) {
    throw new ApiProblem(
      error.kind === "file-too-large" ? 413 : 400,
      "VALIDATION_ERROR",
      error.message,
      false
    );
  }
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code === "FST_REQ_FILE_TOO_LARGE" || code === "FST_FILES_LIMIT") {
    throw new ApiProblem(
      413,
      "VALIDATION_ERROR",
      `The APK exceeds the ${Math.floor(maxFileBytes / (1024 * 1024)).toString()} MiB upload limit.`,
      false
    );
  }
  if (
    code === "FST_FIELDS_LIMIT" ||
    code === "FST_PARTS_LIMIT" ||
    code === "FST_INVALID_MULTIPART_CONTENT_TYPE" ||
    code === "FST_INVALID_MULTIPART"
  ) {
    throw new ApiProblem(
      400,
      "VALIDATION_ERROR",
      "The signed-update multipart upload is invalid.",
      false
    );
  }
  throw error;
}

async function storeMultipartUpdate(request: FastifyRequest, artifacts: UpdateArtifactStore) {
  if (!request.isMultipart()) {
    throw new ApiProblem(
      415,
      "VALIDATION_ERROR",
      "Signed-update APK uploads must use multipart/form-data.",
      false
    );
  }

  let uploaded: StreamedUpdateArtifact | undefined;
  let temporaryPath: string | undefined;
  try {
    try {
      const parts = request.parts({
        limits: {
          fieldNameSize: 16,
          fieldSize: 1,
          fields: 0,
          files: 1,
          parts: 1,
          fileSize: artifacts.maxFileBytes
        }
      });

      for await (const part of parts) {
        if (
          part.type !== "file" ||
          part.fieldname !== "file" ||
          uploaded !== undefined ||
          temporaryPath !== undefined
        ) {
          throw new ApiProblem(
            400,
            "VALIDATION_ERROR",
            "Exactly one APK file part named file is required.",
            false
          );
        }

        const mimeType = part.mimetype.toLowerCase();
        if (
          mimeType !== "application/vnd.android.package-archive" &&
          mimeType !== "application/octet-stream"
        ) {
          throw new ApiProblem(
            415,
            "VALIDATION_ERROR",
            "The update file must use the Android APK or octet-stream media type.",
            false
          );
        }
        const fileName = artifacts.normalizeApkFileName(part.filename);
        temporaryPath = artifacts.createTemporaryUploadPath();
        const hash = createHash("sha256");
        let sizeBytes = 0;
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            sizeBytes += chunk.length;
            if (sizeBytes > artifacts.maxFileBytes) {
              callback(
                Object.assign(new Error("The APK exceeds the signed-update limit."), {
                  code: "FST_REQ_FILE_TOO_LARGE"
                })
              );
              return;
            }
            hash.update(chunk);
            callback(null, chunk);
          }
        });

        await pipeline(
          part.file,
          meter,
          createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 })
        );
        if (part.file.truncated || sizeBytes <= 0) {
          throw Object.assign(new Error("The APK upload is empty or truncated."), {
            code: part.file.truncated ? "FST_REQ_FILE_TOO_LARGE" : "FST_INVALID_MULTIPART"
          });
        }
        uploaded = {
          fileName,
          sizeBytes,
          sha256: hash.digest("hex")
        };
      }
    } catch (error) {
      updateUploadProblem(error, artifacts.maxFileBytes);
    }

    if (uploaded === undefined || temporaryPath === undefined) {
      throw new ApiProblem(400, "VALIDATION_ERROR", "Exactly one APK file is required.", false);
    }
    try {
      return ControllerUpdateArtifactSchema.parse(
        artifacts.finalizeTemporaryUpload({
          temporaryPath,
          fileName: uploaded.fileName,
          sizeBytes: uploaded.sizeBytes,
          sha256: uploaded.sha256
        })
      );
    } catch (error) {
      return updateUploadProblem(error, artifacts.maxFileBytes);
    }
  } finally {
    if (temporaryPath !== undefined) {
      try {
        artifacts.removeTemporaryUpload(temporaryPath);
      } catch {
        // A private abandoned staging file can be cleaned during maintenance.
      }
    }
  }
}

function hasValidArtifactBearer(request: FastifyRequest, secret: string): boolean {
  const header = request.headers.authorization;
  const supplied =
    typeof header === "string" && header.length <= 4_096 ? header : "invalid authorization";
  const suppliedDigest = createHash("sha256").update(supplied, "utf8").digest();
  const expectedDigest = createHash("sha256").update(`Bearer ${secret}`, "utf8").digest();
  return (
    typeof header === "string" &&
    header.length <= 4_096 &&
    timingSafeEqual(suppliedDigest, expectedDigest)
  );
}

function requireSignedUpdateMode(services: RouteServices): void {
  if (services.config.adapterMode === "real-readonly") {
    throw new ApiProblem(
      501,
      "UNSUPPORTED",
      "Signed RoshanCore updates require Companion mode.",
      false
    );
  }
}

type ParsedByteRange =
  { kind: "full" } | { kind: "partial"; start: number; end: number } | { kind: "unsatisfiable" };

export function parseByteRange(value: string | undefined, size: number): ParsedByteRange {
  if (value === undefined) {
    return { kind: "full" };
  }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (match === null) {
    return { kind: "unsatisfiable" };
  }
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText.length === 0 && endText.length === 0) {
    return { kind: "unsatisfiable" };
  }

  if (startText.length === 0) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { kind: "unsatisfiable" };
    }
    return {
      kind: "partial",
      start: Math.max(0, size - suffixLength),
      end: size - 1
    };
  }

  const start = Number(startText);
  const requestedEnd = endText.length === 0 ? size - 1 : Number(endText);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return { kind: "unsatisfiable" };
  }
  return {
    kind: "partial",
    start,
    end: Math.min(requestedEnd, size - 1)
  };
}

function canonicalizePlaylistUpdate(
  update: SignagePlaylistUpdate,
  mediaLibrary: MediaLibrary
): SignagePlaylistUpdate {
  if (update.items === undefined) {
    return update;
  }

  const items: SignageItem[] = update.items.map((candidate) => {
    const media = mediaLibrary.getItem(candidate.id);
    if (media === undefined) {
      throw new ApiProblem(
        400,
        "VALIDATION_ERROR",
        "Every playlist entry must reference uploaded media.",
        false
      );
    }
    if (
      candidate.type !== media.type ||
      candidate.url !== media.url ||
      candidate.fileName !== media.fileName ||
      candidate.checksum !== media.checksum
    ) {
      throw new ApiProblem(
        400,
        "VALIDATION_ERROR",
        "Playlist media metadata must match the uploaded item.",
        false
      );
    }
    return {
      id: media.id,
      type: media.type,
      url: media.url,
      fileName: media.fileName,
      checksum: media.checksum,
      durationSeconds: candidate.durationSeconds,
      muted: candidate.muted
    };
  });

  return {
    ...(update.enabled !== undefined ? { enabled: update.enabled } : {}),
    ...(update.loop !== undefined ? { loop: update.loop } : {}),
    items
  };
}

function actionRequiresApproval(): never {
  throw new ApiProblem(
    409,
    "ACTION_REQUIRES_APPROVAL",
    "This action is intentionally disabled outside the approved root recovery phase.",
    false
  );
}

function healthPayload(services: RouteServices) {
  const activeMode =
    services.config.adapterMode === "real-readonly" || services.config.adapterMode === "companion";

  return HealthSchema.parse({
    mode: services.config.adapterMode,
    controller: "healthy",
    adapters: {
      ipWebcam: activeMode
        ? services.config.ipWebcam === undefined
          ? "not-configured"
          : "configured"
        : "mock",
      fullyKiosk: activeMode
        ? services.config.adapterMode === "companion" && services.config.companion !== undefined
          ? "configured"
          : "not-configured"
        : "mock",
      companion: activeMode
        ? services.config.companion !== undefined
          ? "configured"
          : "not-configured"
        : "mock"
    }
  });
}

async function tabletHealthPayload(services: RouteServices): Promise<ServerHealth> {
  if (services.config.adapterMode !== "real-readonly") {
    return services.adapters.companion.getServerHealth();
  }

  const now = Date.now();
  let fallbackHealthy = false;
  let fallbackReason: string | null = null;
  try {
    fallbackHealthy = (await services.adapters.ipWebcam.getStatus()).healthy;
    if (!fallbackHealthy) fallbackReason = "IP Webcam reported unhealthy.";
  } catch {
    fallbackReason = "IP Webcam is unreachable.";
  }
  const component = (
    state: ServerComponentHealth["state"],
    degradedReason: string | null,
    details: Record<string, unknown> = {}
  ): ServerComponentHealth => ({
    state,
    checkedAtMs: now,
    lastHealthyAtMs: state === "healthy" || state === "standby" ? now : 0,
    degradedReason,
    details
  });
  const unavailable = (name: string) =>
    component("unavailable", `${name} requires RoshanCore Companion mode.`);
  return ServerHealthSchema.parse({
    healthy: fallbackHealthy,
    supervisorStartedAtMs: 0,
    reconciledAtMs: now,
    reconciliationReason: "real_readonly_probe",
    degradedReasons: fallbackReason === null ? [] : [`ipWebcamFallback: ${fallbackReason}`],
    components: {
      controlListener: unavailable("Control listener health"),
      wifi: unavailable("Wi-Fi health"),
      vpnTailscale: unavailable("Tailscale health"),
      internalMedia: unavailable("Internal media health"),
      ipWebcamFallback: component(fallbackHealthy ? "healthy" : "degraded", fallbackReason, {
        configured: true
      }),
      remoteAgent: unavailable("RoshanRemoteAgent"),
      signageService: unavailable("RoshanOS signage health"),
      supervisor: unavailable("Server supervisor")
    }
  });
}

function requireRemoteMode(services: RouteServices): void {
  if (services.config.adapterMode === "real-readonly") {
    throw new ApiProblem(501, "UNSUPPORTED", "RoshanRemoteAgent requires Companion mode.", false);
  }
}

function requireDiagnosticsMode(services: RouteServices): void {
  if (services.config.adapterMode === "real-readonly") {
    throw new ApiProblem(
      501,
      "UNSUPPORTED",
      "The RoshanOS diagnostic journal requires Companion mode.",
      false
    );
  }
}

async function capabilitiesPayload(services: RouteServices) {
  if (services.config.adapterMode === "mock") {
    return ControllerCapabilitiesSchema.parse({
      mode: "mock",
      camera: {
        stream: false,
        select: false,
        zoom: false,
        focus: false,
        fps: false,
        resolution: false,
        quality: false,
        snapshot: false,
        orientation: false,
        torch: false
      },
      listeningAudio: false,
      pushToTalk: false,
      display: {
        message: false,
        liveText: false,
        webpage: false,
        black: false,
        media: false,
        restoreDashboard: false
      },
      device: {
        telemetry: false,
        brightness: false,
        volume: false,
        mute: false,
        orientation: false,
        appLauncher: true,
        appManagement: true,
        screenControl: true,
        touchLock: false,
        remoteControl: true,
        reboot: true,
        serviceRestart: true,
        maintenance: true,
        adminPinRecovery: true
      }
    });
  }

  const realTablet = services.config.adapterMode === "companion";
  let camera = { zoom: false, focus: false, fps: false, resolution: false, quality: false };
  try {
    const status = await services.adapters.ipWebcam.getStatus();
    camera = {
      zoom: status.zoom !== null,
      focus: status.focusMode !== null,
      fps: status.fps !== null,
      resolution: status.resolution !== null,
      quality: status.quality !== null
    };
  } catch {
    // An offline camera must not cause a false claim that controls are available.
  }

  return ControllerCapabilitiesSchema.parse({
    mode: services.config.adapterMode,
    camera: {
      stream: true,
      select: realTablet,
      ...camera,
      snapshot: true,
      orientation: services.config.ipWebcam !== undefined,
      torch: false
    },
    listeningAudio: true,
    pushToTalk: realTablet,
    display: {
      message: realTablet,
      liveText: realTablet,
      webpage: realTablet,
      black: realTablet,
      media: realTablet,
      restoreDashboard: realTablet
    },
    device: {
      telemetry: realTablet,
      brightness: realTablet,
      volume: realTablet,
      mute: realTablet,
      orientation: realTablet,
      appLauncher: realTablet,
      appManagement: realTablet,
      screenControl: realTablet,
      touchLock: realTablet,
      remoteControl: realTablet,
      reboot: realTablet,
      serviceRestart: realTablet,
      maintenance: realTablet,
      adminPinRecovery: realTablet
    }
  });
}

async function* relayStream(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return;
      }

      yield chunk.value;
    }
  } finally {
    await reader.cancel();
  }
}

async function tabletStatusPayload(services: RouteServices) {
  if (services.config.adapterMode === "mock") {
    return services.adapters.companion.getStatus();
  }

  let camera: Pick<CameraStatus, "healthy" | "transport" | "lastStatusLatencyMs"> = {
    healthy: false,
    transport: "trusted-lan",
    lastStatusLatencyMs: null
  };
  try {
    if (services.config.adapterMode === "companion" && services.config.companion !== undefined) {
      camera = await services.adapters.companion.getCameraStatus();
    } else {
      camera = await services.adapters.ipWebcam.getStatus();
    }
  } catch {
    camera = {
      healthy: false,
      transport: services.config.ipWebcam?.transport ?? "trusted-lan",
      lastStatusLatencyMs: null
    };
  }

  let companionData: Partial<TabletStatus> = {};
  let companionHealthy: boolean | null = services.config.companion !== undefined ? false : null;

  if (services.config.adapterMode === "companion" && services.config.companion !== undefined) {
    try {
      companionData = await services.adapters.companion.getStatus();
      companionHealthy = true;
    } catch {
      companionHealthy = false;
    }
  }

  return TabletStatusSchema.parse({
    mode: services.config.adapterMode,
    online: camera.healthy || companionData.online || false,
    batteryPercent: companionData.batteryPercent ?? null,
    charging: companionData.charging ?? null,
    batteryTemperatureC: companionData.batteryTemperatureC ?? null,
    mediaVolume: companionData.mediaVolume ?? null,
    mediaVolumeMax: companionData.mediaVolumeMax ?? null,
    brightness: companionData.brightness ?? null,
    brightnessMode: companionData.brightnessMode ?? null,
    screenTimeoutMs: companionData.screenTimeoutMs ?? null,
    screenOrientation: companionData.screenOrientation ?? null,
    screenOn: companionData.screenOn ?? null,
    keyguardLocked: companionData.keyguardLocked ?? null,
    deviceLocked: companionData.deviceLocked ?? null,
    displayMode: companionData.displayMode ?? null,
    touchLock: companionData.touchLock ?? null,
    wifiConnected: companionData.wifiConnected ?? null,
    tailscaleConnected:
      companionData.tailscaleConnected ??
      (camera.transport === "tailscale" ? camera.healthy : null),
    connectivity: companionData.connectivity ?? null,
    memory: companionData.memory ?? null,
    foregroundApp: companionData.foregroundApp ?? null,
    boot: companionData.boot ?? null,
    update: companionData.update ?? null,
    transport: camera.transport,
    readOnlyLatencyMs: camera.lastStatusLatencyMs,
    ipWebcamHealthy: camera.healthy,
    fullyKioskHealthy: services.config.adapterMode === "companion" ? companionHealthy : null,
    companionHealthy,
    storageFreeMb: companionData.storageFreeMb ?? null,
    uptimeSeconds: companionData.uptimeSeconds ?? null
  });
}

export async function registerRoutes(app: FastifyInstance, services: RouteServices): Promise<void> {
  const mediaLibrary = new MediaLibrary(path.join(services.storageDirectory, "media"));
  const signageStore = new SignagePlaylistStore(
    path.join(services.storageDirectory, "signage-playlist.json")
  );
  const playbackStore = new SignagePlaybackStore(
    path.join(services.storageDirectory, "signage-playback.json")
  );
  const playbackCapabilities = new SignagePlaybackCapability();

  // Public black page — no auth, loaded by Fully's WebView for showBlack()
  app.get("/black", async (_request, reply) => {
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .send('<html><body style="margin:0;background:#000"></body></html>');
  });

  // Public ambient clock page — loaded by Kiosk when default/idle
  app.get("/clock", async (_request, reply) => {
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Ambient Clock</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@700;800&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: #000000;
      color: #00A2FF;
      font-family: 'Big Shoulders Display', 'sans-serif-condensed', sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      overflow: hidden;
      user-select: none;
    }
    .clock-box {
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .time {
      font-size: 30vw;
      line-height: 0.88;
      letter-spacing: 0.01em;
    }
    .date {
      font-size: 5.5vw;
      letter-spacing: 0.08em;
      margin-top: 1rem;
      text-transform: uppercase;
    }
    @media (orientation: landscape) {
      .time { font-size: 42vh; }
      .date { font-size: 8vh; margin-top: 0.5rem; }
    }
  </style>
</head>
<body>
  <div class="clock-box">
    <div id="time" class="time">10:08</div>
    <div id="date" class="date">SATURDAY, MAY 24</div>
  </div>
  <script>
    function update() {
      const now = new Date();
      const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\\s?[AP]M/i, '');
      const dateParts = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      document.getElementById('time').textContent = timeStr;
      document.getElementById('date').textContent = dateParts.toUpperCase();
    }
    setInterval(update, 1000);
    update();
  </script>
</body>
</html>`);
  });

  app.get(
    "/api/v1/health",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async () => {
      return success(await healthPayload(services));
    }
  );

  app.get(
    "/api/v1/version",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async () => {
      let commit = process.env.CONTROLLER_GIT_COMMIT;
      if (!commit) {
        try {
          const { execSync } = await import("node:child_process");
          commit = execSync("git rev-parse --short HEAD", { cwd: process.cwd() }).toString().trim();
        } catch {
          commit = "e362bd0";
        }
      }
      return success({
        environment: services.config.environment,
        adapterMode: services.config.adapterMode,
        mock: services.config.adapterMode === "mock",
        gitCommit: commit,
        apiBuild: "0.1.0",
        webBuild: "0.1.0",
        serviceWorker: services.config.serveWeb ? "enabled" : "disabled",
        buildTimestamp: process.env.CONTROLLER_BUILD_TIMESTAMP ?? new Date().toISOString(),
        companionVersion: services.config.companion !== undefined ? "1.0.0" : undefined,
        cameraAgentVersion: services.config.ipWebcam !== undefined ? "1.0.0" : undefined,
        kioskVersion: "1.0.0"
      });
    }
  );

  app.get(
    "/api/v1/capabilities",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request) => {
      requireSession(request, services.config, services.sessions);
      return success(await capabilitiesPayload(services));
    }
  );

  app.post(
    "/api/v1/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = parseBody(LoginSchema, request);
      const validUsername = safeEquals(input.username, services.config.adminUsername);
      const validPassword = safeEquals(input.password, services.config.mockAdminPassword);

      if (!validUsername || !validPassword) {
        throw new ApiProblem(
          401,
          "UNAUTHENTICATED",
          "Invalid local controller credentials.",
          false
        );
      }

      const session = services.sessions.create(input.username, services.config.sessionTtlMs);
      reply.setCookie(services.config.sessionCookieName, session.id, {
        signed: true,
        httpOnly: true,
        sameSite: "strict",
        secure: services.config.environment === "production",
        path: "/",
        maxAge: Math.floor(services.config.sessionTtlMs / 1000)
      });

      return success({
        username: session.username,
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt,
        mode: services.config.adapterMode
      });
    }
  );

  app.get(
    "/api/v1/auth/session",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const session = requireSession(request, services.config, services.sessions);
      return success({
        username: session.username,
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt,
        mode: services.config.adapterMode
      });
    }
  );

  app.post(
    "/api/v1/auth/logout",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const session = requireSession(request, services.config, services.sessions);
      requireCsrf(request, session);
      services.sessions.delete(session.id);
      reply.clearCookie(services.config.sessionCookieName, { path: "/" });
      return success({ loggedOut: true });
    }
  );

  app.post(
    "/api/v1/update/artifacts",
    {
      bodyLimit: services.updateArtifactStore.maxFileBytes + 65_536,
      onRequest: async (request) => authorizeMutation(request, services),
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } }
    },
    async (request) => {
      return success(await storeMultipartUpdate(request, services.updateArtifactStore));
    }
  );

  app.get(
    "/api/v1/update/artifacts/:id/apk",
    {
      exposeHeadRoute: false,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
    },
    async (request, reply) => {
      if ((request.raw.url ?? "").includes("?")) {
        throw new ApiProblem(
          400,
          "VALIDATION_ERROR",
          "Signed-update artifact URLs must not contain a query string.",
          false
        );
      }

      const companionSecret = services.config.companion?.secret;
      if (companionSecret === undefined || !hasValidArtifactBearer(request, companionSecret)) {
        throw new ApiProblem(
          401,
          "UNAUTHENTICATED",
          "A valid Companion bearer credential is required.",
          false
        );
      }

      const rawId = (request.params as { id?: string }).id;
      const parsedId = UpdateArtifactIdSchema.safeParse(rawId);
      const artifactFile = parsedId.success
        ? services.updateArtifactStore.getArtifactFile(parsedId.data)
        : undefined;
      if (artifactFile === undefined) {
        throw new ApiProblem(404, "VALIDATION_ERROR", "Update artifact not found.", false);
      }

      return reply
        .status(200)
        .header("content-type", "application/vnd.android.package-archive")
        .header("content-length", artifactFile.artifact.sizeBytes.toString())
        .header("cache-control", "no-store")
        .header("pragma", "no-cache")
        .header("x-content-type-options", "nosniff")
        .header("content-disposition", `attachment; filename="${artifactFile.artifact.id}.apk"`)
        .send(createReadStream(artifactFile.filePath, { flags: "r" }));
    }
  );

  app.get(
    "/api/v1/update/status",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request) => {
      requireSession(request, services.config, services.sessions);
      requireSignedUpdateMode(services);
      return success(await services.adapters.companion.getUpdateStatus());
    }
  );

  app.post(
    "/api/v1/update/artifacts/:id/install",
    {
      bodyLimit: 1_024,
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } }
    },
    async (request) => {
      authorizeMutation(request, services);
      if (services.config.adapterMode !== "companion" || services.config.companion === undefined) {
        throw new ApiProblem(
          501,
          "NOT_CONFIGURED",
          "A configured Companion adapter is required for signed updates.",
          false
        );
      }
      const controllerOrigin = services.config.controllerPublicOrigin;
      if (controllerOrigin === undefined) {
        throw new ApiProblem(
          409,
          "NOT_CONFIGURED",
          "CONTROLLER_PUBLIC_ORIGIN is not configured.",
          false
        );
      }

      const rawId = (request.params as { id?: string }).id;
      const parsedId = UpdateArtifactIdSchema.safeParse(rawId);
      const artifact = parsedId.success
        ? services.updateArtifactStore.getArtifact(parsedId.data)
        : undefined;
      if (artifact === undefined) {
        throw new ApiProblem(404, "VALIDATION_ERROR", "Update artifact not found.", false);
      }

      const updateUrl = new URL(
        `/api/v1/update/artifacts/${encodeURIComponent(artifact.id)}/apk`,
        controllerOrigin
      ).toString();
      const originResult =
        await services.adapters.companion.configureUpdateControllerOrigin(controllerOrigin);
      const requestResult = await services.adapters.companion.requestUpdate(
        updateUrl,
        artifact.sha256
      );
      return success({
        artifact,
        controllerOrigin,
        originResult,
        requestResult
      });
    }
  );

  app.post(
    "/api/v1/update/rollback",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request) => {
      authorizeMutation(request, services);
      requireSignedUpdateMode(services);
      parseBody(SignedUpdateRollbackInputSchema, request);
      return success(await services.adapters.companion.requestUpdateRollback());
    }
  );

  app.get(
    "/api/v1/tailscale/enrollment/status",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request) => {
      requireSession(request, services.config, services.sessions);
      requireSignedUpdateMode(services);
      return success(await services.adapters.companion.getTailscaleEnrollmentStatus());
    }
  );

  app.post(
    "/api/v1/tailscale/enrollment",
    {
      bodyLimit: 1_024,
      config: { rateLimit: { max: 3, timeWindow: "15 minutes" } }
    },
    async (request) => {
      authorizeMutation(request, services);
      requireSignedUpdateMode(services);
      const input = parseBody(TailscaleEnrollmentRequestSchema, request);
      return success(
        await services.adapters.companion.enrollTailscale(input.authKey, input.timeoutSeconds)
      );
    }
  );

  app.get(
    "/api/v1/tablet/status",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request) => {
      requireSession(request, services.config, services.sessions);
      return success(await tabletStatusPayload(services));
    }
  );

  app.get(
    "/api/v1/tablet/health",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request) => {
      requireSession(request, services.config, services.sessions);
      return success(await tabletHealthPayload(services));
    }
  );

  app.get(
    "/api/v1/tablet/diagnostics",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      requireSession(request, services.config, services.sessions);
      requireDiagnosticsMode(services);
      reply.header("cache-control", "no-store, private");
      return success(await services.adapters.companion.getDiagnostics());
    }
  );

  app.post(
    "/api/v1/tablet/diagnostics/clear",
    { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } },
    async (request, reply) => {
      authorizeMutation(request, services);
      requireDiagnosticsMode(services);
      reply.header("cache-control", "no-store, private");
      return success(await services.adapters.companion.clearDiagnostics());
    }
  );

  app.get(
    "/api/v1/remote/status",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request) => {
      requireSession(request, services.config, services.sessions);
      requireRemoteMode(services);
      return success(await services.adapters.companion.getRemoteStatus());
    }
  );

  app.post(
    "/api/v1/remote/enabled",
    { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      requireRemoteMode(services);
      const input = parseBody(RemoteEnabledSchema, request);
      return success(await services.adapters.companion.setRemoteEnabled(input.enabled));
    }
  );

  app.post(
    "/api/v1/remote/screenshot",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      authorizeMutation(request, services);
      requireRemoteMode(services);
      const bytes = await services.adapters.companion.getRemoteScreenshot();
      return reply
        .header("cache-control", "no-store, private")
        .header("content-security-policy", "default-src 'none'")
        .type("image/png")
        .send(Buffer.from(bytes));
    }
  );

  app.post(
    "/api/v1/remote/tap",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      requireRemoteMode(services);
      const input = parseBody(RemoteTapSchema, request);
      return success(await services.adapters.companion.remoteTap(input.x, input.y));
    }
  );

  app.post(
    "/api/v1/remote/swipe",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      requireRemoteMode(services);
      const input = parseBody(RemoteSwipeSchema, request);
      return success(
        await services.adapters.companion.remoteSwipe(
          input.startX,
          input.startY,
          input.endX,
          input.endY,
          input.durationMs
        )
      );
    }
  );

  app.post(
    "/api/v1/remote/key",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      requireRemoteMode(services);
      const input = parseBody(RemoteKeyInputSchema, request);
      return success(await services.adapters.companion.remoteKey(input.key));
    }
  );

  app.post(
    "/api/v1/remote/text",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      requireRemoteMode(services);
      const input = parseBody(RemoteTextSchema, request);
      return success(await services.adapters.companion.remoteText(input.text));
    }
  );

  app.post(
    "/api/v1/remote/close-app",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      requireRemoteMode(services);
      const input = parseBody(RemoteCloseAppSchema, request);
      const approved = await services.adapters.companion.listApps();
      if (
        !approved.some(
          (app) =>
            app.packageName === input.packageName &&
            (app.status === undefined || app.status === "approved")
        )
      ) {
        throw new ApiProblem(
          403,
          "FORBIDDEN",
          "Only a currently approved application can be closed.",
          false
        );
      }
      return success(await services.adapters.companion.closeApprovedApp(input.packageName));
    }
  );

  app.get(
    "/api/v1/remote/audit",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      requireSession(request, services.config, services.sessions);
      requireRemoteMode(services);
      return success(await services.adapters.companion.getRemoteAudit());
    }
  );

  app.get(
    "/api/v1/camera/status",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request) => {
      requireSession(request, services.config, services.sessions);
      if (services.config.adapterMode === "companion" && services.config.companion !== undefined) {
        return success(await services.adapters.companion.getCameraStatus());
      }
      return success(await services.adapters.ipWebcam.getStatus());
    }
  );

  app.get("/api/v1/camera/stream", async (request, reply) => {
    requireSession(request, services.config, services.sessions);
    if (services.config.adapterMode !== "mock") {
      const stream =
        services.config.adapterMode === "companion" && services.config.companion !== undefined
          ? await services.adapters.companion.openCameraStream("video")
          : await services.adapters.ipWebcam.openReadOnlyStream("video");
      request.raw.once("close", () => stream.cancel());
      reply
        .header("cache-control", "no-store")
        .header("content-type", stream.diagnostics.contentType ?? "application/octet-stream")
        .header("x-controller-stream-mode", services.config.adapterMode)
        .header("x-controller-stream-latency-ms", String(stream.diagnostics.connectionLatencyMs));
      return reply.send(Readable.from(relayStream(stream.body)));
    }

    return success({
      mode: "mock",
      streamUrl: null,
      message: "Phase 1 does not open a real camera stream."
    });
  });

  app.get("/api/v1/camera/audio", async (request, reply) => {
    requireSession(request, services.config, services.sessions);
    if (services.config.adapterMode !== "mock") {
      const stream =
        services.config.adapterMode === "companion" && services.config.companion !== undefined
          ? await services.adapters.companion.openCameraStream("audio")
          : await services.adapters.ipWebcam.openReadOnlyStream("audio");
      request.raw.once("close", () => stream.cancel());
      reply
        .header("cache-control", "no-store")
        .header("content-type", stream.diagnostics.contentType ?? "application/octet-stream")
        .header("x-controller-stream-mode", services.config.adapterMode)
        .header("x-controller-stream-latency-ms", String(stream.diagnostics.connectionLatencyMs));
      return reply.send(Readable.from(relayStream(stream.body)));
    }

    return success({
      mode: "mock",
      streamUrl: null,
      message: "Phase 1 does not open a real listening-audio stream."
    });
  });

  app.get("/api/v1/camera/snapshot", async (request, reply) => {
    requireSession(request, services.config, services.sessions);
    const jpeg =
      services.config.adapterMode === "companion" && services.config.companion !== undefined
        ? await services.adapters.companion.getCameraSnapshot()
        : await services.adapters.ipWebcam.getSnapshot();
    return reply
      .header("cache-control", "no-store")
      .header("content-type", "image/jpeg")
      .send(Buffer.from(jpeg));
  });

  app.post(
    "/api/v1/camera/select",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeCameraControl(request, services);
      const input = parseBody(CameraSelectSchema, request);
      if (services.config.adapterMode === "companion" && services.config.companion !== undefined) {
        return success(await services.adapters.companion.selectCamera(input.camera));
      }
      return success(await services.adapters.ipWebcam.selectCamera(input.camera));
    }
  );

  app.post("/api/v1/camera/torch", async (request) => {
    authorizeCameraControl(request, services);
    parseBody(CameraTorchSchema, request);
    const status = await services.adapters.ipWebcam.getStatus();
    if (!status.hasTorch) {
      throw new ApiProblem(
        422,
        "UNSUPPORTED",
        "Torch is unavailable because the documented tablet cameras have no flash hardware.",
        false
      );
    }

    return success(await services.adapters.ipWebcam.setTorch(true));
  });

  app.post(
    "/api/v1/camera/orientation",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeCameraControl(request, services);
      const input = parseBody(CameraOrientationInputSchema, request);
      return success(await services.adapters.ipWebcam.setOrientation(input.orientation));
    }
  );

  app.post(
    "/api/v1/camera/zoom",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeCameraControl(request, services);
      const input = parseBody(CameraZoomSchema, request);
      return success(await services.adapters.ipWebcam.setZoom(input.zoom));
    }
  );

  app.post(
    "/api/v1/camera/focus",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeCameraControl(request, services);
      const input = parseBody(CameraFocusSchema, request);
      return success(await services.adapters.ipWebcam.setFocus(input.mode));
    }
  );

  app.post(
    "/api/v1/camera/autofocus",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeCameraControl(request, services);
      return success(await services.adapters.ipWebcam.triggerAutofocus());
    }
  );

  app.post(
    "/api/v1/camera/fps",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeCameraControl(request, services);
      const input = parseBody(CameraFpsSchema, request);
      return success(await services.adapters.ipWebcam.setFps(input.fps));
    }
  );

  app.post(
    "/api/v1/camera/resolution",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeCameraControl(request, services);
      const input = parseBody(CameraResolutionSchema, request);
      return success(await services.adapters.ipWebcam.setResolution(input.resolution));
    }
  );

  app.post(
    "/api/v1/camera/quality",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeCameraControl(request, services);
      const input = parseBody(CameraQualitySchema, request);
      return success(await services.adapters.ipWebcam.setQuality(input.quality));
    }
  );

  app.post("/api/v1/camera/restart", async (request) => {
    authorizeMutation(request, services);
    actionRequiresApproval();
  });

  app.post(
    "/api/v1/display/message",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      const input = parseBody(MessageDisplaySchema, request);
      return success(
        await services.adapters.fullyKiosk.showMessage(input.text, input.durationSeconds)
      );
    }
  );

  app.post(
    "/api/v1/display/live-text",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      const input = parseBody(LiveTextDisplaySchema, request);
      return success(await services.adapters.fullyKiosk.showLiveText(input.text));
    }
  );

  app.post("/api/v1/display/live-text/clear", async (request) => {
    authorizeMutation(request, services);
    return success(await services.adapters.fullyKiosk.clearLiveText());
  });

  const rejectLegacyBase64Display = async (request: FastifyRequest) => {
    authorizeMutation(request, services);
    throw new ApiProblem(
      410,
      "UNSUPPORTED",
      "JSON/base64 display uploads were removed. Upload multipart media to /api/v1/media/items, then use /api/v1/display/media.",
      false
    );
  };

  app.post(
    "/api/v1/display/image",
    {
      bodyLimit: 8 * 1024,
      config: { rateLimit: { max: 6, timeWindow: "1 minute" } }
    },
    rejectLegacyBase64Display
  );

  app.post(
    "/api/v1/display/video",
    {
      bodyLimit: 8 * 1024,
      config: { rateLimit: { max: 6, timeWindow: "1 minute" } }
    },
    rejectLegacyBase64Display
  );

  app.post(
    "/api/v1/display/media",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      const input = parseBody(MediaDisplaySchema, request);
      const item = mediaLibrary.getItem(input.mediaId);
      if (item === undefined) {
        throw new ApiProblem(
          400,
          "VALIDATION_ERROR",
          "The selected multipart-uploaded media item does not exist.",
          false
        );
      }

      if (services.config.adapterMode === "companion") {
        const baseUrl = getControllerBaseUrl(request, services.config);
        const mediaUrl = new URL(item.url, baseUrl).toString();
        return success(await services.adapters.companion.showWebpage(mediaUrl));
      }

      return success(await services.adapters.fullyKiosk.showMedia(item.type, item.fileName));
    }
  );

  app.post(
    "/api/v1/display/webpage",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      const input = parseBody(WebpageDisplaySchema, request);
      const targetUrl = await requireVerifiedExternalUrl(input.url);

      if (services.config.adapterMode === "companion") {
        return success(await services.adapters.companion.showWebpage(targetUrl));
      }
      return success(await services.adapters.fullyKiosk.showWebpage(targetUrl));
    }
  );

  app.post("/api/v1/display/dashboard-start-url", async (request) => {
    authorizeMutation(request, services);
    const input = parseBody(WebpageDisplaySchema, request);
    const targetUrl = await requireVerifiedExternalUrl(input.url);
    return success(await services.adapters.fullyKiosk.setDashboardStartUrl(targetUrl));
  });

  app.post(
    "/api/v1/display/black",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      return success(await services.adapters.fullyKiosk.showBlack());
    }
  );

  app.post(
    "/api/v1/display/restore",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      if (services.config.adapterMode === "companion") {
        return success(await services.adapters.companion.restoreDashboard());
      }
      return success(await services.adapters.fullyKiosk.restoreDashboard());
    }
  );

  app.post(
    "/api/v1/display/clock",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      if (services.config.adapterMode === "companion") {
        return success(await services.adapters.companion.showClockOnly());
      }
      return success(await services.adapters.fullyKiosk.restoreDashboard());
    }
  );

  app.post(
    "/api/v1/display/clock-color",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      const body = request.body as { color?: string };
      const color = body?.color ?? "#00A2FF";
      if (services.config.adapterMode === "companion") {
        return success(await services.adapters.companion.setClockColor(color));
      }
      return success({ simulated: true, message: "Clock color set to " + color });
    }
  );

  app.get("/signage-player.html", async (request, reply) => {
    const html = renderSignagePlayer();
    const etag = signagePlayerEtag(html);
    issueSignagePlaybackCookie(request, reply, playbackCapabilities);
    reply
      .header("cache-control", SIGNAGE_PLAYER_CACHE_CONTROL)
      .header("etag", etag)
      .header(
        "content-security-policy",
        "default-src 'none'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
      )
      .header("referrer-policy", "no-referrer")
      .header("x-content-type-options", "nosniff");
    if (request.headers["if-none-match"] === etag) {
      return reply.code(304).send();
    }
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get(
    "/media/:id",
    { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const rawId = (request.params as { id?: string }).id;
      const parsedId = MediaIdSchema.safeParse(rawId);
      if (!parsedId.success) {
        throw new ApiProblem(404, "VALIDATION_ERROR", "Media item not found.", false);
      }

      const stored = mediaLibrary.getFile(parsedId.data);
      if (stored === undefined) {
        throw new ApiProblem(404, "VALIDATION_ERROR", "Media item not found.", false);
      }

      const ifNoneMatch = request.headers["if-none-match"];
      const ifRange = request.headers["if-range"];
      const requestedRange =
        ifRange !== undefined && ifRange !== stored.etag ? undefined : request.headers.range;
      const range = parseByteRange(requestedRange, stored.item.sizeBytes);
      reply
        .header("accept-ranges", "bytes")
        .header("cache-control", "public, max-age=31536000, immutable")
        .header("cross-origin-resource-policy", "same-origin")
        .header("etag", stored.etag)
        .header("x-content-type-options", "nosniff")
        .type(stored.item.mimeType);

      if (range.kind === "full" && ifNoneMatch === stored.etag) {
        return reply.code(304).send();
      }
      if (range.kind === "unsatisfiable") {
        return reply
          .code(416)
          .header("content-range", `bytes */${stored.item.sizeBytes.toString()}`)
          .send();
      }

      const start = range.kind === "partial" ? range.start : 0;
      const end = range.kind === "partial" ? range.end : stored.item.sizeBytes - 1;
      const contentLength = end - start + 1;
      if (range.kind === "partial") {
        reply
          .code(206)
          .header(
            "content-range",
            `bytes ${start.toString()}-${end.toString()}/${stored.item.sizeBytes.toString()}`
          );
      }
      reply.header("content-length", contentLength.toString());
      return reply.send(createReadStream(stored.filePath, { start, end }));
    }
  );

  app.get("/api/v1/signage/playlist", async (request, reply) => {
    issueSignagePlaybackCookie(request, reply, playbackCapabilities);
    reply.header("cache-control", "no-store");
    return success(signageStore.get());
  });

  app.post(
    "/api/v1/signage/playlist",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      const input = parseBody(SignagePlaylistUpdateSchema, request);
      return success(signageStore.set(canonicalizePlaylistUpdate(input, mediaLibrary)));
    }
  );

  app.get(
    "/api/v1/signage/playback",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request, reply) => {
      requireSession(request, services.config, services.sessions);
      reply.header("cache-control", "no-store");
      return success(playbackStore.get());
    }
  );

  app.post(
    "/api/v1/signage/playback",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request) => {
      requireSignagePlaybackCapability(request, playbackCapabilities);
      const input = parseBody(SignagePlaybackAckSchema, request);
      const playlist = signageStore.get();
      if (
        input.playlistRevision !== playlist.revision ||
        (input.itemId !== null && !playlist.items.some((item) => item.id === input.itemId))
      ) {
        throw new ApiProblem(
          409,
          "CONFLICT",
          "Playback acknowledgement does not match the active playlist revision.",
          true
        );
      }
      return success(playbackStore.record(input));
    }
  );

  app.post(
    "/api/v1/signage/completion",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      requireSignagePlaybackCapability(request, playbackCapabilities);
      const input = parseBody(SignageCompletionSchema, request);
      const current = signageStore.get();
      const priorPlayback = playbackStore.get();
      if (
        !current.enabled &&
        !current.loop &&
        current.revision === input.playlistRevision + 1 &&
        current.items.at(-1)?.id === input.itemId &&
        priorPlayback?.playerId === input.playerId &&
        priorPlayback.playlistRevision === current.revision &&
        priorPlayback.state === "stopped"
      ) {
        return success({
          playlist: current,
          playback: priorPlayback,
          restoreResult: {
            simulated: true,
            message: "This non-loop completion was already applied."
          }
        });
      }
      if (
        !current.enabled ||
        current.loop ||
        input.playlistRevision !== current.revision ||
        current.items.at(-1)?.id !== input.itemId
      ) {
        throw new ApiProblem(
          409,
          "CONFLICT",
          "Completion does not match the final item of the active non-loop playlist.",
          true
        );
      }

      const restoreResult =
        services.config.adapterMode === "companion"
          ? await services.adapters.companion.restoreDashboard()
          : { simulated: true, message: "Non-loop signage completed and Home was restored." };
      const playlist = signageStore.set({ enabled: false });
      const playback = playbackStore.record({
        playerId: input.playerId,
        playlistRevision: playlist.revision,
        itemId: null,
        state: "stopped",
        positionSeconds: 0
      });
      return success({ playlist, playback, restoreResult });
    }
  );

  app.post(
    "/api/v1/signage/start",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      const current = signageStore.get();
      if (current.items.length === 0) {
        throw new ApiProblem(
          409,
          "CONFLICT",
          "Add at least one media item before starting signage.",
          false
        );
      }
      const playlist = signageStore.set({ enabled: true });
      playbackStore.record({
        playerId: "controller",
        playlistRevision: playlist.revision,
        itemId: playlist.items[0]?.id ?? null,
        state: "loading",
        positionSeconds: 0
      });
      const playerUrl = new URL(
        "/signage-player.html",
        getControllerBaseUrl(request, services.config)
      ).toString();
      if (services.config.adapterMode === "companion") {
        return success(await services.adapters.companion.showWebpage(playerUrl));
      }
      return success({ simulated: true, message: "Signage started." });
    }
  );

  app.post(
    "/api/v1/signage/stop",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      const playlist = signageStore.set({ enabled: false });
      playbackStore.record({
        playerId: "controller",
        playlistRevision: playlist.revision,
        itemId: null,
        state: "stopped",
        positionSeconds: 0
      });
      if (services.config.adapterMode === "companion") {
        return success(await services.adapters.companion.restoreDashboard());
      }
      return success({ simulated: true, message: "Signage stopped and Home restored." });
    }
  );

  app.get(
    "/api/v1/media/items",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request) => {
      requireSession(request, services.config, services.sessions);
      return success(mediaLibrary.getItems());
    }
  );

  app.post(
    "/api/v1/media/items",
    {
      bodyLimit: MEDIA_MAX_FILE_BYTES + 32_768,
      onRequest: async (request) => authorizeMutation(request, services),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
    },
    async (request) => {
      return success(await storeMultipartMedia(request, mediaLibrary));
    }
  );

  app.delete("/api/v1/media/items/:id", async (request) => {
    authorizeMutation(request, services);
    const rawId = (request.params as { id?: string }).id;
    const parsedId = MediaIdSchema.safeParse(rawId);
    if (!parsedId.success || !mediaLibrary.deleteMedia(parsedId.data)) {
      throw new ApiProblem(404, "VALIDATION_ERROR", "Media item not found.", false);
    }
    const playlist = signageStore.get();
    if (playlist.items.some((item) => item.id === parsedId.data)) {
      signageStore.set({
        items: playlist.items.filter((item) => item.id !== parsedId.data)
      });
    }
    return success({ deleted: true });
  });

  app.get(
    "/api/v1/media/albums",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request) => {
      requireSession(request, services.config, services.sessions);
      return success(mediaLibrary.getAlbums());
    }
  );

  app.post("/api/v1/media/albums", async (request) => {
    authorizeMutation(request, services);
    const body = parseBody(MiniAlbumCreateSchema, request);
    const album = mediaLibrary.createAlbum(body.title, body.itemIds, body.durationPerItemSeconds);
    return success(album);
  });

  app.put("/api/v1/media/albums/:id", async (request) => {
    authorizeMutation(request, services);
    const { id } = request.params as { id: string };
    const input = parseBody(MiniAlbumUpdateSchema, request);
    const album = mediaLibrary.updateAlbum(id, {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.itemIds !== undefined ? { itemIds: input.itemIds } : {}),
      ...(input.durationPerItemSeconds !== undefined
        ? { durationPerItemSeconds: input.durationPerItemSeconds }
        : {}),
      ...(input.loop !== undefined ? { loop: input.loop } : {}),
      ...(input.shuffle !== undefined ? { shuffle: input.shuffle } : {})
    });
    if (!album) throw new ApiProblem(400, "VALIDATION_ERROR", "Album not found.", false);
    return success(album);
  });

  app.delete("/api/v1/media/albums/:id", async (request) => {
    authorizeMutation(request, services);
    const { id } = request.params as { id: string };
    const ok = mediaLibrary.deleteAlbum(id);
    if (!ok) throw new ApiProblem(400, "VALIDATION_ERROR", "Album not found.", false);
    return success({ deleted: true });
  });

  app.post(
    "/api/v1/media/url",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      const { url } = (request.body as { url?: unknown }) ?? {};
      if (typeof url !== "string") {
        throw new ApiProblem(400, "VALIDATION_ERROR", "A webpage URL is required.", false);
      }
      const targetUrl = await requireVerifiedExternalUrl(url);
      return success(await services.adapters.fullyKiosk.showWebpage(targetUrl));
    }
  );

  app.get(
    "/api/v1/location",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request) => {
      requireSession(request, services.config, services.sessions);
      const adapter = services.adapters.fullyKiosk;
      if (adapter.getLocation !== undefined) {
        return success(await adapter.getLocation());
      }
      return success({ mode: "OFF", hasFix: false, gpsEnabled: false, networkEnabled: false });
    }
  );

  app.post(
    "/api/v1/location/mode",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      const { mode } = request.body as { mode: string };
      const adapter = services.adapters.fullyKiosk;
      if (adapter.setLocationMode !== undefined) {
        return success(await adapter.setLocationMode(mode));
      }
      throw new ApiProblem(
        501,
        "UNSUPPORTED",
        "Location tracking not supported in current mode.",
        false
      );
    }
  );

  app.post(
    "/api/v1/device/find/sound",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      const { durationSeconds } = (request.body as { durationSeconds?: number }) ?? {};
      if (services.config.adapterMode === "companion") {
        return success(await services.adapters.companion.findSound(durationSeconds ?? 15));
      }
      const adapter = services.adapters.fullyKiosk;
      if (adapter.findSound !== undefined) {
        return success(await adapter.findSound(durationSeconds ?? 15));
      }
      throw new ApiProblem(
        501,
        "UNSUPPORTED",
        "Find device sound not supported in current mode.",
        false
      );
    }
  );

  app.post(
    "/api/v1/device/find/sound/stop",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      if (services.config.adapterMode === "companion") {
        return success(await services.adapters.companion.stopFindSound());
      }
      const adapter = services.adapters.fullyKiosk;
      if (adapter.stopFindSound !== undefined) {
        return success(await adapter.stopFindSound());
      }
      throw new ApiProblem(
        501,
        "UNSUPPORTED",
        "Find device sound not supported in current mode.",
        false
      );
    }
  );

  app.get(
    "/api/v1/dpc/status",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request) => {
      requireSession(request, services.config, services.sessions);
      if (services.config.adapterMode === "real-readonly") {
        return success({
          deviceOwner: false,
          maintenance: {
            active: false,
            expiresAt: 0,
            remainingSeconds: 0
          }
        });
      }
      return success(await services.adapters.fullyKiosk.getDpcStatus());
    }
  );

  app.post(
    "/api/v1/dpc/maintenance",
    { config: { rateLimit: { max: 4, timeWindow: "15 minutes" } } },
    async (request) => {
      authorizeMutation(request, services);
      const input = parseBody(DpcMaintenanceActionSchema, request);
      return success(await services.adapters.fullyKiosk.setMaintenanceMode(input));
    }
  );

  app.post(
    "/api/v1/admin/pin/rate-limit/reset",
    { config: { rateLimit: { max: 2, timeWindow: "15 minutes" } } },
    async (request) => {
      authorizeMutation(request, services);
      parseBody(AdminPinRateLimitResetSchema, request);
      return success(await services.adapters.companion.resetAdminPinRateLimit());
    }
  );

  app.post(
    "/api/v1/device/brightness",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      const input = parseBody(DeviceBrightnessSchema, request);
      return success(await services.adapters.companion.setBrightness(input.brightness));
    }
  );

  app.post(
    "/api/v1/device/volume",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      const input = parseBody(DeviceVolumeSchema, request);
      return success(await services.adapters.companion.setVolume(input.volume));
    }
  );

  app.post(
    "/api/v1/device/mute",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      const input = parseBody(CameraTorchSchema, request);
      return success(await services.adapters.companion.setMuted(input.enabled));
    }
  );

  app.post(
    "/api/v1/device/orientation",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      const input = parseBody(DeviceOrientationSchema, request);
      return success(await services.adapters.companion.setScreenOrientation(input.orientation));
    }
  );

  app.get(
    "/api/v1/device/apps",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request) => {
      requireSession(request, services.config, services.sessions);
      if (services.config.adapterMode === "real-readonly") return success([]);
      const apps = await services.adapters.companion.listApps();
      return success(apps.filter((app) => app.status !== "technical"));
    }
  );

  app.get(
    "/api/v1/device/apps/technical",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      if (services.config.adapterMode === "real-readonly") return success([]);
      return success(await services.adapters.companion.listTechnicalApps());
    }
  );

  app.post(
    "/api/v1/device/apps/launch",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      const input = parseBody(AppLaunchSchema, request);
      const apps = await services.adapters.companion.listApps();
      if (
        !apps.some(
          (app) => app.id === input.appId && (app.status === undefined || app.status === "approved")
        )
      ) {
        throw new ApiProblem(
          403,
          "FORBIDDEN",
          "Only a currently approved application can be opened.",
          false
        );
      }
      return success(await services.adapters.companion.launchApp(input.appId));
    }
  );

  app.post(
    "/api/v1/device/apps/approve",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      const input = parseBody(AppPackageMutationSchema, request);
      const apps = await services.adapters.companion.listApps();
      if (
        !apps.some((app) => app.packageName === input.packageName && app.status === "discovered")
      ) {
        throw new ApiProblem(
          400,
          "VALIDATION_ERROR",
          "Only a discovered non-technical application can be approved.",
          false
        );
      }
      return success(await services.adapters.companion.approveApp(input.packageName));
    }
  );

  app.post(
    "/api/v1/device/apps/revoke",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      const input = parseBody(AppPackageMutationSchema, request);
      const apps = await services.adapters.companion.listApps();
      if (
        !apps.some(
          (app) =>
            app.packageName === input.packageName &&
            (app.status === undefined || app.status === "approved")
        )
      ) {
        throw new ApiProblem(
          400,
          "VALIDATION_ERROR",
          "Only a currently approved non-technical application can be revoked.",
          false
        );
      }
      return success(await services.adapters.companion.revokeApp(input.packageName));
    }
  );

  app.post(
    "/api/v1/device/media",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      const input = parseBody(DeviceMediaSchema, request);
      return success(await services.adapters.companion.controlMedia(input.action));
    }
  );

  app.post(
    "/api/v1/device/screen",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      const input = parseBody(DeviceScreenSchema, request);
      return success(await services.adapters.companion.setScreenOn(input.on));
    }
  );

  app.post(
    "/api/v1/device/touch_lock",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      authorizeMutation(request, services);
      if (services.config.adapterMode !== "companion") {
        throw new ApiProblem(400, "UNSUPPORTED", "Touch lock requires the companion app.", true);
      }
      const input = parseBody(DeviceTouchLockSchema, request);
      return success(await services.adapters.companion.setTouchLock(input.on));
    }
  );

  app.post(
    "/api/v1/device/reboot",
    { config: { rateLimit: { max: 1, timeWindow: "10 minutes" } } },
    async (request) => {
      authorizeMutation(request, services);
      parseBody(DeviceRebootSchema, request);
      return success(await services.adapters.companion.rebootDevice());
    }
  );

  app.post(
    "/api/v1/services/:service/restart",
    { config: { rateLimit: { max: 4, timeWindow: "10 minutes" } } },
    async (request) => {
      authorizeMutation(request, services);
      parseBody(ServiceRestartBodySchema, request);
      const parsed = ServiceRestartTargetSchema.safeParse(
        (request.params as { service?: unknown }).service
      );
      if (!parsed.success) {
        throw new ApiProblem(
          400,
          "VALIDATION_ERROR",
          "Supported services are core, media, vpn, and remote.",
          false
        );
      }
      return success(await services.adapters.companion.restartService(parsed.data));
    }
  );

  app.get("/api/v1/talk", { websocket: true }, (socket, request) => {
    const session = getRequestSession(request, services.config, services.sessions);
    if (
      session === undefined ||
      services.config.companion === undefined ||
      !isAllowedTalkOrigin({
        origin: request.headers.origin,
        requestHost: request.headers.host,
        forwardedHost: request.headers["x-forwarded-host"],
        requestProtocol: request.protocol,
        forwardedProtocol: request.headers["x-forwarded-proto"],
        configuredOrigin: services.config.allowedOrigin,
        isTest: services.config.environment === "test"
      })
    ) {
      socket.close(4401, "Authentication required.");
      return;
    }

    socket.on("message", async (rawMessage: Buffer, isBinary: boolean) => {
      try {
        if (isBinary) {
          if (!services.talk.isActiveFor(session.id)) {
            socket.close(4400, "Talk has not started.");
            return;
          }
          await services.adapters.companion.sendAudioFrame(rawMessage);
          return;
        }

        const message = rawMessage.toString();
        if (message === '{"type":"talk-start"}') {
          services.talk.start(session.id);
          await services.adapters.companion.beginTalk();
          socket.send('{"type":"talking"}');
          return;
        }

        if (message === '{"type":"talk-stop"}') {
          services.talk.stop(session.id);
          await services.adapters.companion.endTalk();
          socket.send('{"type":"idle"}');
          return;
        }

        socket.close(4400, "Unsupported talk message.");
      } catch (err) {
        request.log.error("Talk socket message error: " + err);
      }
    });

    socket.on("close", async () => {
      try {
        if (services.talk.stop(session.id)) {
          await services.adapters.companion.endTalk();
        }
      } catch (err) {
        request.log.error("Talk socket close error: " + err);
      }
    });
  });
  // Tailscale automatic enrollment
  const activeEnrollments = new Map<string, {
    code: string;
    approved: boolean;
    authKey?: string;
    resolve?: (key: string) => void;
    reject?: (error: Error) => void;
  }>();

  app.post("/api/public/enroll/wait", async (request, reply) => {
    const { code } = request.body as { code: string };
    if (!code || typeof code !== "string") {
      return { ok: false, error: "Missing code" };
    }

    let state = activeEnrollments.get(code);
    if (!state) {
      state = { code, approved: false };
      activeEnrollments.set(code, state);
    }

    if (state.approved && state.authKey) {
      activeEnrollments.delete(code);
      return { ok: true, authKey: state.authKey };
    }

    try {
      const authKey = await new Promise<string>((resolve, reject) => {
        state!.resolve = resolve;
        state!.reject = reject;
        setTimeout(() => reject(new Error("TIMEOUT")), 5 * 60 * 1000);
      });
      activeEnrollments.delete(code);
      return { ok: true, authKey };
    } catch (e) {
      const err = e as Error;
      activeEnrollments.delete(code);
      if (err.message === "TIMEOUT") {
        return reply.status(408).send({ ok: false, error: "Timeout waiting for approval" });
      }
      return reply.status(500).send({ ok: false, error: err.message });
    }
  });

  app.post("/api/v1/enroll/approve", async (_request, reply) => {
    return reply.status(410).send({
      ok: false,
      error: {
        code: "GONE",
        message: "Enrollment code approval has been removed. Use ADB provisioning with -TailscaleAuthKey instead."
      }
    });
  });
}

export function isAllowedTalkOrigin(input: {
  origin: string | undefined;
  requestHost: string | undefined;
  forwardedHost: string | string[] | undefined;
  requestProtocol: string;
  forwardedProtocol: string | string[] | undefined;
  configuredOrigin: string;
  isTest: boolean;
}): boolean {
  if (input.origin === undefined) return input.isTest;

  try {
    const supplied = new URL(input.origin);
    if (supplied.protocol !== "http:" && supplied.protocol !== "https:") return false;
    if (supplied.origin === new URL(input.configuredOrigin).origin) return true;

    const forwardedHost = Array.isArray(input.forwardedHost)
      ? input.forwardedHost[0]
      : input.forwardedHost;
    const forwardedProtocol = Array.isArray(input.forwardedProtocol)
      ? input.forwardedProtocol[0]
      : input.forwardedProtocol;
    const host = (forwardedHost ?? input.requestHost)?.split(",")[0]?.trim();
    const protocol = (forwardedProtocol ?? input.requestProtocol).split(",")[0]?.trim();
    if (host === undefined || host.length === 0 || (protocol !== "http" && protocol !== "https")) {
      return false;
    }
    return supplied.origin === `${protocol}://${host}`;
  } catch {
    return false;
  }
}

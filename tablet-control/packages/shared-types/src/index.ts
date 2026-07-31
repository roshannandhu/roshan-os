import { z } from "zod";

export const ErrorCodeSchema = z.enum([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "CSRF_REJECTED",
  "TABLET_OFFLINE",
  "CAMERA_OFFLINE",
  "TIMEOUT",
  "MALFORMED_RESPONSE",
  "STREAM_FAILURE",
  "UNSUPPORTED",
  "NOT_CONFIGURED",
  "VALIDATION_ERROR",
  "ACTION_REQUIRES_APPROVAL",
  "CONFLICT",
  "RATE_LIMITED",
  "INTERNAL_ERROR"
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const AdapterModeSchema = z.enum(["mock", "real-readonly", "companion"]);
export type AdapterMode = z.infer<typeof AdapterModeSchema>;

export const TransportSchema = z.enum(["mock", "trusted-lan", "tailscale"]);
export type Transport = z.infer<typeof TransportSchema>;

export interface ApiError {
  code: ErrorCode;
  message: string;
  recoverable: boolean;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: ApiError;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

const TelemetryTimestampSchema = z.number().int().min(0).max(8_640_000_000_000_000);
const TelemetryBytesSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const TabletConnectivitySchema = z
  .object({
    wifiEnabled: z.boolean().nullable(),
    wifiConnected: z.boolean().nullable(),
    wifiSsid: z.string().min(1).max(64).nullable(),
    wifiRssiDbm: z.number().int().min(-126).max(0).nullable(),
    wifiSignalLevel: z.number().int().min(0).max(4).nullable(),
    wifiSignalState: z.enum(["weak", "fair", "good", "excellent"]).nullable(),
    internetCapable: z.boolean().nullable(),
    internetValidated: z.boolean().nullable()
  })
  .strict();
export type TabletConnectivity = z.infer<typeof TabletConnectivitySchema>;

export const TabletMemorySchema = z
  .object({
    availableBytes: TelemetryBytesSchema.nullable(),
    totalBytes: TelemetryBytesSchema.nullable(),
    lowMemory: z.boolean().nullable(),
    lowMemoryThresholdBytes: TelemetryBytesSchema.nullable()
  })
  .strict();
export type TabletMemory = z.infer<typeof TabletMemorySchema>;

export const TabletForegroundAppSchema = z
  .object({
    state: z.enum(["unknown", "roshanos", "approved", "technical", "unapproved"]),
    packageName: z
      .string()
      .min(3)
      .max(255)
      .regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u)
      .nullable(),
    label: z.string().min(1).max(120).nullable()
  })
  .strict();
export type TabletForegroundApp = z.infer<typeof TabletForegroundAppSchema>;

export const TabletBootSchema = z
  .object({
    lastBootAtMs: TelemetryTimestampSchema.nullable(),
    uptimeSeconds: z.number().int().nonnegative(),
    recoveryState: z.enum(["unknown", "recovering", "succeeded", "degraded"]),
    recoveryVerifiedAtMs: TelemetryTimestampSchema.nullable()
  })
  .strict();
export type TabletBoot = z.infer<typeof TabletBootSchema>;

export const TabletUpdateSchema = z
  .object({
    state: z.enum(["installed", "unknown"]),
    versionName: z.string().min(1).max(120).nullable(),
    versionCode: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    firstInstalledAtMs: TelemetryTimestampSchema.nullable(),
    lastAppliedAtMs: TelemetryTimestampSchema.nullable(),
    pendingSystemUpdateState: z.literal("unknown")
  })
  .strict();
export type TabletUpdate = z.infer<typeof TabletUpdateSchema>;

export const UPDATE_MAX_APK_BYTES = 128 * 1024 * 1024;

export const UpdateArtifactIdSchema = z.string().regex(/^update_[0-9]{13}_[a-f0-9]{16}$/u);

export const UpdateSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const ControllerUpdateArtifactSchema = z
  .object({
    id: UpdateArtifactIdSchema,
    fileName: z.string().min(5).max(240),
    sizeBytes: z.number().int().positive().max(UPDATE_MAX_APK_BYTES),
    sha256: UpdateSha256Schema,
    createdAt: z.string().datetime()
  })
  .strict();
export type ControllerUpdateArtifact = z.infer<typeof ControllerUpdateArtifactSchema>;

const SignedUpdateVersionCodeSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();
const SignedUpdateVersionNameSchema = z.string().min(1).max(120).nullable();
const SignedUpdateTimestampSchema = TelemetryTimestampSchema.nullable();

export const SignedUpdateStateSchema = z.enum([
  "idle",
  "downloading",
  "verifying",
  "staging",
  "committing",
  "applied",
  "failed",
  "rollback_committing",
  "rolled_back"
]);
export type SignedUpdateState = z.infer<typeof SignedUpdateStateSchema>;

export const SignedUpdateStatusSchema = z
  .object({
    state: SignedUpdateStateSchema,
    currentVersionCode: SignedUpdateVersionCodeSchema,
    currentVersionName: SignedUpdateVersionNameSchema,
    baseVersionCode: SignedUpdateVersionCodeSchema,
    baseVersionName: SignedUpdateVersionNameSchema,
    targetVersionCode: SignedUpdateVersionCodeSchema,
    targetVersionName: SignedUpdateVersionNameSchema,
    startedAtMs: SignedUpdateTimestampSchema,
    updatedAtMs: SignedUpdateTimestampSchema,
    lastAppliedAtMs: SignedUpdateTimestampSchema,
    lastRollbackAtMs: SignedUpdateTimestampSchema,
    lastRolledBackFromVersionCode: SignedUpdateVersionCodeSchema,
    errorCode: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[A-Z0-9_]+$/u)
      .nullable(),
    progress: z
      .object({
        downloadedBytes: TelemetryBytesSchema,
        expectedBytes: TelemetryBytesSchema.nullable()
      })
      .strict(),
    controllerOrigin: z
      .object({
        configured: z.boolean(),
        state: z.enum(["unconfigured", "ready", "corrupt"]),
        host: z.string().min(1).max(253).nullable()
      })
      .strict(),
    installCapability: z
      .object({
        deviceOwner: z.boolean(),
        selfUpdatePermissionGranted: z.boolean(),
        silentSelfUpdateCapable: z.boolean(),
        installerUiAllowed: z.literal(false)
      })
      .strict(),
    rollback: z
      .object({
        platformApiPresent: z.boolean(),
        permissionGranted: z.boolean(),
        supported: z.boolean(),
        available: z.boolean(),
        rollbackId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
        versionRolledBackFrom: SignedUpdateVersionCodeSchema,
        versionRolledBackTo: SignedUpdateVersionCodeSchema,
        reasonCode: z
          .string()
          .min(1)
          .max(120)
          .regex(/^[A-Z0-9_]+$/u)
          .nullable(),
        requestedForLastUpdate: z.boolean(),
        dataPolicy: z.literal("retain"),
        bootFailureAutoRollbackGuaranteed: z.literal(false)
      })
      .strict()
  })
  .strict();
export type SignedUpdateStatus = z.infer<typeof SignedUpdateStatusSchema>;

export const SignedUpdateActionResultSchema = z
  .object({
    accepted: z.literal(true),
    code: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[A-Z0-9_]+$/u),
    update: SignedUpdateStatusSchema
  })
  .strict();
export type SignedUpdateActionResult = z.infer<typeof SignedUpdateActionResultSchema>;

export const SignedUpdateRollbackInputSchema = z.object({ confirm: z.literal(true) }).strict();

export const TailscaleEnrollmentRequestSchema = z
  .object({
    authKey: z
      .string()
      .min(32)
      .max(256)
      .regex(/^tskey-auth-[A-Za-z0-9_-]+$/u),
    timeoutSeconds: z.number().int().min(30).max(300)
  })
  .strict();
export type TailscaleEnrollmentRequest = z.infer<typeof TailscaleEnrollmentRequestSchema>;

export const TailscaleEnrollmentStatusSchema = z
  .object({
    state: z.enum(["never_requested", "enrolling", "succeeded", "failed"]),
    code: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Z0-9_]+$/u),
    startedAtMs: TelemetryTimestampSchema,
    finishedAtMs: TelemetryTimestampSchema,
    deadlineAtMs: TelemetryTimestampSchema,
    timeoutSeconds: z.number().int().min(0).max(300),
    deviceOwner: z.boolean(),
    tailscaleInstalled: z.boolean(),
    tailscaleEnabled: z.boolean(),
    tailscaleVersion: z.string().min(1).max(120).nullable(),
    alwaysOnVpnConfigured: z.boolean(),
    vpnTransportDetected: z.boolean(),
    vpnValidated: z.boolean(),
    tailnetAddressDetected: z.boolean(),
    credentialConsumptionProven: z.boolean(),
    transientAuthKeyPresent: z.boolean().nullable(),
    supportedPolicies: z
      .object({
        authKey: z.boolean(),
        forceEnabled: z.boolean(),
        onboardingFlow: z.boolean()
      })
      .strict(),
    appliedNonSecretPolicy: z
      .object({
        alwaysOnVpnPackage: z.boolean(),
        forceEnabled: z.boolean(),
        onboardingHidden: z.boolean()
      })
      .strict()
  })
  .strict();
export type TailscaleEnrollmentStatus = z.infer<typeof TailscaleEnrollmentStatusSchema>;

export const TailscaleEnrollmentActionResultSchema = z
  .object({
    accepted: z.literal(true),
    code: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Z0-9_]+$/u),
    enrollment: TailscaleEnrollmentStatusSchema
  })
  .strict();
export type TailscaleEnrollmentActionResult = z.infer<typeof TailscaleEnrollmentActionResultSchema>;

export const TabletStatusSchema = z
  .object({
    mode: AdapterModeSchema,
    online: z.boolean(),
    batteryPercent: z.number().int().min(0).max(100).nullable(),
    charging: z.boolean().nullable(),
    batteryTemperatureC: z.number().min(-20).max(100).nullable(),
    mediaVolume: z.number().int().min(0).nullable(),
    mediaVolumeMax: z.number().int().positive().nullable(),
    brightness: z.number().int().min(0).max(255).nullable(),
    brightnessMode: z.enum(["manual", "automatic"]).nullable(),
    screenTimeoutMs: z.number().int().positive().max(2_147_483_647).nullable(),
    screenOrientation: z
      .enum(["auto", "portrait", "landscape", "reverse-portrait", "reverse-landscape"])
      .nullable(),
    screenOn: z.boolean().nullable(),
    keyguardLocked: z.boolean().nullable(),
    deviceLocked: z.boolean().nullable(),
    displayMode: z.string().nullable().optional(),
    touchLock: z.boolean().nullable().optional(),
    wifiConnected: z.boolean().nullable(),
    tailscaleConnected: z.boolean().nullable(),
    connectivity: TabletConnectivitySchema.nullable(),
    memory: TabletMemorySchema.nullable(),
    foregroundApp: TabletForegroundAppSchema.nullable(),
    boot: TabletBootSchema.nullable(),
    update: TabletUpdateSchema.nullable(),
    transport: TransportSchema,
    readOnlyLatencyMs: z.number().int().nonnegative().nullable(),
    ipWebcamHealthy: z.boolean(),
    fullyKioskHealthy: z.boolean().nullable(),
    companionHealthy: z.boolean().nullable(),
    storageFreeMb: z.number().int().nonnegative().nullable(),
    uptimeSeconds: z.number().int().nonnegative().nullable()
  })
  .strict();

export type TabletStatus = z.infer<typeof TabletStatusSchema>;

export const CameraNameSchema = z.enum(["front", "rear"]);
export type CameraName = z.infer<typeof CameraNameSchema>;

export const CameraOrientationSchema = z.enum([
  "landscape",
  "portrait",
  "upsidedown",
  "upsidedown_portrait"
]);
export type CameraOrientation = z.infer<typeof CameraOrientationSchema>;

export const ScreenOrientationSchema = z.enum([
  "auto",
  "portrait",
  "landscape",
  "reverse-portrait",
  "reverse-landscape"
]);
export type ScreenOrientation = z.infer<typeof ScreenOrientationSchema>;

export const ApprovedAppIdSchema = z.enum([
  "spotify",
  "vlc",
  "weather",
  "calendar",
  "pdf-reader",
  "localsend",
  "todo-agenda",
  "photo-frame",
  "broccoli"
]);
export type ApprovedAppId = z.infer<typeof ApprovedAppIdSchema>;

export const ApprovedAppSchema = z.object({
  id: z.string(),
  label: z.string().trim().min(1).max(120),
  packageName: z
    .string()
    .min(3)
    .max(255)
    .regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u)
    .optional(),
  status: z.enum(["approved", "discovered", "technical"]).optional()
});
export type ApprovedApp = z.infer<typeof ApprovedAppSchema>;

export const AppLaunchSchema = z.object({
  appId: z.string().trim().min(1).max(120)
});

export const DeviceMediaSchema = z.object({
  action: z.enum(["play-pause", "next", "previous"])
});

export const CameraStatusSchema = z.object({
  mode: AdapterModeSchema,
  healthy: z.boolean(),
  activeCamera: CameraNameSchema.nullable(),
  orientation: CameraOrientationSchema.nullable(),
  listeningEnabled: z.boolean().nullable(),
  zoom: z.number().min(1).max(4).nullable(),
  quality: z.number().int().min(1).max(100).nullable(),
  resolution: z.string().nullable(),
  fps: z.number().int().positive().nullable(),
  focusMode: z.enum(["off", "auto", "macro", "continuous-video", "continuous-picture"]).nullable(),
  hasTorch: z.boolean(),
  transport: TransportSchema,
  lastStatusLatencyMs: z.number().int().nonnegative().nullable()
});

export type CameraStatus = z.infer<typeof CameraStatusSchema>;

export const StreamKindSchema = z.enum(["video", "audio"]);
export type StreamKind = z.infer<typeof StreamKindSchema>;

export const StreamDiagnosticsSchema = z.object({
  mode: AdapterModeSchema,
  kind: StreamKindSchema,
  contentType: z.string().nullable(),
  connectionLatencyMs: z.number().int().nonnegative(),
  transport: TransportSchema,
  maxReconnectAttempts: z.number().int().nonnegative(),
  readOnly: z.literal(true)
});

export type StreamDiagnostics = z.infer<typeof StreamDiagnosticsSchema>;

export const DisplayModeSchema = z.enum([
  "dashboard",
  "message",
  "image",
  "video",
  "webpage",
  "black"
]);
export type DisplayMode = z.infer<typeof DisplayModeSchema>;

export const HealthSchema = z.object({
  mode: AdapterModeSchema,
  controller: z.literal("healthy"),
  adapters: z.object({
    ipWebcam: z.enum(["configured", "healthy", "offline", "mock", "not-configured"]),
    fullyKiosk: z.enum(["configured", "mock", "not-configured"]),
    companion: z.enum(["configured", "mock", "not-configured"])
  })
});

export type ControllerHealth = z.infer<typeof HealthSchema>;

export const ServerComponentStateSchema = z.enum([
  "starting",
  "healthy",
  "standby",
  "disabled",
  "degraded",
  "unavailable",
  "stopped"
]);
export type ServerComponentState = z.infer<typeof ServerComponentStateSchema>;

export const ServerComponentHealthSchema = z
  .object({
    state: ServerComponentStateSchema,
    checkedAtMs: z.number().int().nonnegative(),
    lastHealthyAtMs: z.number().int().nonnegative(),
    degradedReason: z.string().max(500).nullable(),
    details: z.record(z.unknown())
  })
  .strict();
export type ServerComponentHealth = z.infer<typeof ServerComponentHealthSchema>;

export const ServerHealthSchema = z
  .object({
    healthy: z.boolean(),
    homeReady: z.boolean().optional(),
    supervisorStartedAtMs: z.number().int().nonnegative(),
    reconciledAtMs: z.number().int().nonnegative(),
    reconciliationReason: z.string().min(1).max(120),
    degradedReasons: z.array(z.string().min(1).max(500)).max(32),
    components: z
      .object({
        controlListener: ServerComponentHealthSchema,
        wifi: ServerComponentHealthSchema,
        vpnTailscale: ServerComponentHealthSchema,
        internalMedia: ServerComponentHealthSchema,
        ipWebcamFallback: ServerComponentHealthSchema,
        remoteAgent: ServerComponentHealthSchema,
        signageService: ServerComponentHealthSchema,
        resources: ServerComponentHealthSchema.optional(),
        supervisor: ServerComponentHealthSchema
      })
      .catchall(ServerComponentHealthSchema)
  })
  .strict();
export type ServerHealth = z.infer<typeof ServerHealthSchema>;

export const DiagnosticLevelSchema = z.enum(["info", "warn", "error"]);
export type DiagnosticLevel = z.infer<typeof DiagnosticLevelSchema>;

const DiagnosticFieldKeySchema = z.enum([
  "circuit_open",
  "degraded_count",
  "duration_minutes",
  "enabled",
  "error_class",
  "generation",
  "healthy",
  "previous_state",
  "reason",
  "result",
  "retry_attempt",
  "service",
  "source",
  "state",
  "trigger"
]);

export const DiagnosticEventSchema = z
  .object({
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    timestampMs: z.number().int().min(0).max(8_640_000_000_000_000),
    level: DiagnosticLevelSchema,
    component: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9_.-]+$/u),
    event: z
      .string()
      .min(1)
      .max(48)
      .regex(/^[a-z0-9_.-]+$/u),
    fields: z.record(
      DiagnosticFieldKeySchema,
      z
        .string()
        .min(1)
        .max(96)
        .regex(/^[A-Za-z0-9_.:-]+$/u)
    )
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value.fields).length > 8) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A diagnostic event cannot contain more than eight fields.",
        path: ["fields"]
      });
    }
  });
export type DiagnosticEvent = z.infer<typeof DiagnosticEventSchema>;

export const DiagnosticSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAtMs: z.number().int().min(0).max(8_640_000_000_000_000),
    entryCount: z.number().int().min(0).max(256),
    oldestSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    newestSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    limits: z
      .object({
        maxEntries: z.literal(256),
        maxFileBytes: z.literal(128 * 1024),
        maxFieldsPerEntry: z.literal(8),
        maxFieldValueChars: z.literal(96)
      })
      .strict(),
    events: z.array(DiagnosticEventSchema).max(256)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.entryCount !== value.events.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Diagnostic entryCount does not match the event list.",
        path: ["entryCount"]
      });
    }
    const expectedOldest = value.events[0]?.sequence ?? null;
    const expectedNewest = value.events.at(-1)?.sequence ?? null;
    if (value.oldestSequence !== expectedOldest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Diagnostic oldestSequence does not match the event list.",
        path: ["oldestSequence"]
      });
    }
    if (value.newestSequence !== expectedNewest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Diagnostic newestSequence does not match the event list.",
        path: ["newestSequence"]
      });
    }
    for (let index = 1; index < value.events.length; index++) {
      if (value.events[index]!.sequence <= value.events[index - 1]!.sequence) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Diagnostic events must be ordered by increasing sequence.",
          path: ["events", index, "sequence"]
        });
      }
    }
  });
export type DiagnosticSnapshot = z.infer<typeof DiagnosticSnapshotSchema>;

export const DiagnosticClearResultSchema = z
  .object({
    cleared: z.literal(true),
    removedEntries: z.number().int().min(0).max(256),
    remainingEntries: z.literal(0)
  })
  .strict();
export type DiagnosticClearResult = z.infer<typeof DiagnosticClearResultSchema>;

export const RemoteKeySchema = z.enum([
  "BACK",
  "HOME",
  "RECENTS",
  "ENTER",
  "DPAD_UP",
  "DPAD_DOWN",
  "DPAD_LEFT",
  "DPAD_RIGHT",
  "MEDIA_PLAY_PAUSE",
  "MEDIA_NEXT",
  "MEDIA_PREVIOUS",
  "VOLUME_UP",
  "VOLUME_DOWN"
]);
export type RemoteKey = z.infer<typeof RemoteKeySchema>;

export const RemoteControlStatusSchema = z
  .object({
    enabled: z.boolean(),
    allowedKeys: z.array(RemoteKeySchema),
    screenWidth: z.number().int().positive().max(10_000),
    screenHeight: z.number().int().positive().max(10_000),
    maxActionsPerMinute: z.number().int().positive().max(1_000),
    maxScreenshotsPerMinute: z.number().int().positive().max(120)
  })
  .strict();
export type RemoteControlStatus = z.infer<typeof RemoteControlStatusSchema>;

export const CompanionStatusPayloadSchema = z
  .object({
    mode: z.literal("companion"),
    online: z.literal(true),
    batteryPercent: z.number().int().min(0).max(100).nullable(),
    charging: z.boolean().nullable(),
    batteryTemperatureC: z.number().min(-20).max(100).nullable(),
    brightness: z.number().int().min(0).max(255).nullable(),
    brightnessMode: z.enum(["manual", "automatic"]).nullable(),
    screenTimeoutMs: z.number().int().positive().max(2_147_483_647).nullable(),
    screenOrientation: ScreenOrientationSchema.nullable(),
    screenOn: z.boolean().nullable(),
    keyguardLocked: z.boolean().nullable(),
    deviceLocked: z.boolean().nullable(),
    displayMode: z.string().min(1).max(40),
    touchLock: z.boolean(),
    mediaVolume: z.number().int().min(0).nullable(),
    mediaVolumeMax: z.number().int().positive().nullable(),
    storageFreeMb: z.number().int().nonnegative().nullable(),
    uptimeSeconds: z.number().int().nonnegative(),
    connectivity: TabletConnectivitySchema,
    memory: TabletMemorySchema,
    foregroundApp: TabletForegroundAppSchema,
    boot: TabletBootSchema,
    update: TabletUpdateSchema,
    enrolled: z.boolean(),
    credentialState: z.enum(["unenrolled", "ready", "legacy_ready", "credential_corrupt"]),
    credentialVersion: z.number().int().nonnegative(),
    pinState: z.enum(["PIN_NOT_CONFIGURED", "READY", "COOLDOWN", "LOCKED_RECOVERY_REQUIRED"]),
    pairingActive: z.boolean(),
    remoteControl: RemoteControlStatusSchema,
    serverHealth: z.union([
      ServerHealthSchema,
      z
        .object({
          healthy: z.literal(false),
          state: z.literal("starting")
        })
        .strict()
    ])
  })
  .strict();
export type CompanionStatusPayload = z.infer<typeof CompanionStatusPayloadSchema>;

export const RemoteAuditEventSchema = z
  .object({
    timestamp: z.number().int().nonnegative(),
    action: z.string().min(1).max(80),
    success: z.boolean()
  })
  .strict();
export type RemoteAuditEvent = z.infer<typeof RemoteAuditEventSchema>;

export const RemoteEnabledSchema = z.object({ enabled: z.boolean() }).strict();

const RemoteCoordinateSchema = z.number().int().min(0).max(9_999);

export const RemoteTapSchema = z
  .object({
    x: RemoteCoordinateSchema,
    y: RemoteCoordinateSchema
  })
  .strict();

export const RemoteSwipeSchema = z
  .object({
    startX: RemoteCoordinateSchema,
    startY: RemoteCoordinateSchema,
    endX: RemoteCoordinateSchema,
    endY: RemoteCoordinateSchema,
    durationMs: z.number().int().min(50).max(2_000)
  })
  .strict();

export const RemoteKeyInputSchema = z.object({ key: RemoteKeySchema }).strict();

export const RemoteTextSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9 .,!?@_+-]+$/u)
  })
  .strict();

export const AndroidPackageNameSchema = z
  .string()
  .min(3)
  .max(255)
  .regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u);

export const RemoteCloseAppSchema = z
  .object({
    packageName: AndroidPackageNameSchema
  })
  .strict();

export const AppPackageMutationSchema = z
  .object({
    packageName: AndroidPackageNameSchema
  })
  .strict();

export const DeviceScreenSchema = z
  .object({
    on: z.boolean()
  })
  .strict();

export const DeviceRebootSchema = z
  .object({
    confirm: z.literal(true)
  })
  .strict();

export const ServiceRestartTargetSchema = z.enum(["core", "media", "vpn", "remote"]);
export type ServiceRestartTarget = z.infer<typeof ServiceRestartTargetSchema>;
export const ServiceRestartBodySchema = z.object({}).strict();

export const DpcMaintenanceStatusSchema = z
  .object({
    active: z.boolean(),
    expiresAt: z.number().int().nonnegative(),
    remainingSeconds: z.number().int().nonnegative()
  })
  .strict();
export type DpcMaintenanceStatus = z.infer<typeof DpcMaintenanceStatusSchema>;

export const DpcStatusSchema = z
  .object({
    deviceOwner: z.boolean(),
    restrictions: z.record(z.boolean()).optional(),
    statusBarDisabled: z.boolean().optional(),
    maintenance: DpcMaintenanceStatusSchema.optional(),
    lockTaskPackagesCount: z.number().int().nonnegative().optional()
  })
  .strict();
export type DpcStatus = z.infer<typeof DpcStatusSchema>;

export const DpcMaintenanceActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("enter"),
      durationMinutes: z.literal(15)
    })
    .strict(),
  z
    .object({
      action: z.literal("exit")
    })
    .strict()
]);
export type DpcMaintenanceAction = z.infer<typeof DpcMaintenanceActionSchema>;

export const AdminPinRateLimitResetSchema = z.undefined();

export const ControllerCapabilitiesSchema = z.object({
  mode: AdapterModeSchema,
  camera: z.object({
    stream: z.boolean(),
    select: z.boolean(),
    zoom: z.boolean(),
    focus: z.boolean(),
    fps: z.boolean(),
    resolution: z.boolean(),
    quality: z.boolean(),
    snapshot: z.boolean(),
    orientation: z.boolean(),
    torch: z.literal(false)
  }),
  listeningAudio: z.boolean(),
  pushToTalk: z.boolean(),
  display: z.object({
    message: z.boolean(),
    liveText: z.boolean(),
    webpage: z.boolean(),
    black: z.boolean(),
    media: z.boolean(),
    restoreDashboard: z.boolean()
  }),
  device: z.object({
    telemetry: z.boolean(),
    brightness: z.boolean(),
    volume: z.boolean(),
    mute: z.boolean(),
    orientation: z.boolean(),
    appLauncher: z.boolean(),
    appManagement: z.boolean().optional(),
    screenControl: z.boolean(),
    touchLock: z.boolean(),
    remoteControl: z.boolean().optional(),
    reboot: z.boolean().optional(),
    serviceRestart: z.boolean().optional(),
    maintenance: z.boolean().optional(),
    adminPinRecovery: z.boolean().optional()
  })
});

export type ControllerCapabilities = z.infer<typeof ControllerCapabilitiesSchema>;

export const LoginSchema = z.object({
  username: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(256)
});

export type LoginInput = z.infer<typeof LoginSchema>;

/**
 * The tablet displays 128 random bits as 32 hexadecimal characters. Spaces
 * and hyphens are presentation-only and are removed before the value leaves
 * the authenticated controller endpoint.
 */
export const EnrollmentPairingNonceSchema = z
  .string()
  .trim()
  .min(32)
  .max(64)
  .transform((value) => value.replace(/[\s-]/g, "").toLowerCase())
  .refine((value) => /^[0-9a-f]{32}$/.test(value), {
    message: "Pairing code must contain exactly 32 hexadecimal characters."
  });

export const EnrollmentPairRequestSchema = z
  .object({
    nonce: EnrollmentPairingNonceSchema
  })
  .strict();

export type EnrollmentPairRequest = z.infer<typeof EnrollmentPairRequestSchema>;

export const EnrollmentPairResultSchema = z
  .object({
    paired: z.literal(true),
    credentialStored: z.literal(true),
    message: z.string().min(1).max(200)
  })
  .strict();

export type EnrollmentPairResult = z.infer<typeof EnrollmentPairResultSchema>;

export const CameraSelectSchema = z.object({
  camera: CameraNameSchema
});

export const CameraOrientationInputSchema = z.object({
  orientation: CameraOrientationSchema
});

export const DeviceTouchLockSchema = z.object({
  on: z.boolean()
});

export const CameraTorchSchema = z.object({
  enabled: z.boolean()
});

export const CameraZoomSchema = z.object({
  zoom: z.number().min(1).max(4)
});

export const CameraFocusSchema = z.object({
  mode: z.enum(["off", "auto", "macro", "continuous-video", "continuous-picture"])
});

export const CameraFpsSchema = z.object({
  fps: z.union([z.literal(10), z.literal(15), z.literal(30)])
});

export const CameraResolutionSchema = z.object({
  resolution: z.string().min(3).max(20)
});

export const CameraQualitySchema = z.object({
  quality: z.number().int().min(1).max(100)
});

export const DeviceBrightnessSchema = z.object({
  brightness: z.number().int().min(0).max(255)
});

export const DeviceVolumeSchema = z.object({
  volume: z.number().int().min(0).max(15)
});

export const DeviceOrientationSchema = z.object({
  orientation: ScreenOrientationSchema
});

export const MessageDisplaySchema = z.object({
  text: z.string().trim().min(1).max(500),
  textSize: z.enum(["small", "medium", "large"]),
  background: z.enum(["dark", "light", "accent"]),
  durationSeconds: z.number().int().min(0).max(3600),
  restoreDashboard: z.boolean()
});

export const LiveTextDisplaySchema = z.object({
  text: z.string().trim().min(1).max(500)
});

export const WebpageDisplaySchema = z.object({
  url: z.string().url().max(2048),
  durationSeconds: z.number().int().min(0).max(3600),
  restoreDashboard: z.boolean()
});

export const MEDIA_MAX_FILE_BYTES = 50_000_000;
export const MEDIA_MAX_TOTAL_BYTES = 250_000_000;
export const MEDIA_MAX_ITEMS = 100;

export const MediaMimeTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp", "video/mp4"]);
export type MediaMimeType = z.infer<typeof MediaMimeTypeSchema>;

export const MediaTypeSchema = z.enum(["image", "video"]);
export type MediaType = z.infer<typeof MediaTypeSchema>;

export const MediaIdSchema = z
  .string()
  .regex(/^media_[0-9]{13}_[a-f0-9]{8}$/u, "Media ID is invalid.");
export type MediaId = z.infer<typeof MediaIdSchema>;

export const MediaDisplaySchema = z
  .object({
    mediaId: MediaIdSchema,
    durationSeconds: z.number().int().min(0).max(3600),
    restoreDashboard: z.boolean()
  })
  .strict();

const SafeMediaFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !value.includes("/") &&
      !value.includes("\\") &&
      !value.includes("\0"),
    "Media file name is invalid."
  );

export const MediaUploadSchema = z
  .object({
    fileName: SafeMediaFileNameSchema,
    title: z.string().trim().min(1).max(120).optional(),
    mimeType: MediaMimeTypeSchema,
    sizeBytes: z.number().int().positive().max(MEDIA_MAX_FILE_BYTES),
    durationSeconds: z.number().int().min(1).max(3600).default(10)
  })
  .strict();
export type MediaUpload = z.infer<typeof MediaUploadSchema>;

export const MediaItemSchema = z
  .object({
    id: MediaIdSchema,
    title: z.string().trim().min(1).max(120),
    type: MediaTypeSchema,
    fileName: SafeMediaFileNameSchema,
    mimeType: MediaMimeTypeSchema,
    sizeBytes: z.number().int().positive().max(MEDIA_MAX_FILE_BYTES),
    durationSeconds: z.number().int().min(1).max(3600),
    url: z.string().regex(/^\/media\/media_[0-9]{13}_[a-f0-9]{8}$/u),
    createdAt: z.number().int().nonnegative(),
    checksum: z.string().regex(/^[a-f0-9]{64}$/u)
  })
  .strict();
export type MediaItem = z.infer<typeof MediaItemSchema>;

export const SignageItemSchema = z
  .object({
    id: MediaIdSchema,
    type: MediaTypeSchema,
    url: z.string().regex(/^\/media\/media_[0-9]{13}_[a-f0-9]{8}$/u),
    fileName: SafeMediaFileNameSchema,
    checksum: z.string().regex(/^[a-f0-9]{64}$/u),
    durationSeconds: z.number().int().min(1).max(3600),
    muted: z.boolean()
  })
  .strict();
export type SignageItem = z.infer<typeof SignageItemSchema>;

const SignageItemsSchema = z
  .array(SignageItemSchema)
  .max(MEDIA_MAX_ITEMS)
  .superRefine((items, context) => {
    const ids = new Set<string>();
    items.forEach((item, index) => {
      if (ids.has(item.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Playlist items must be unique.",
          path: [index, "id"]
        });
      }
      ids.add(item.id);
    });
  });

export const SignagePlaylistSchema = z
  .object({
    enabled: z.boolean(),
    loop: z.boolean(),
    items: SignageItemsSchema,
    revision: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strict();
export type SignagePlaylist = z.infer<typeof SignagePlaylistSchema>;

export const SignagePlaylistUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    loop: z.boolean().optional(),
    items: SignageItemsSchema.optional()
  })
  .strict()
  .refine(
    (value) => value.enabled !== undefined || value.loop !== undefined || value.items !== undefined,
    "At least one playlist field is required."
  );
export type SignagePlaylistUpdate = z.infer<typeof SignagePlaylistUpdateSchema>;

export const SignagePlaybackStatusSchema = z.enum([
  "idle",
  "loading",
  "playing",
  "ended",
  "error",
  "stopped"
]);
export type SignagePlaybackStatus = z.infer<typeof SignagePlaybackStatusSchema>;

export const SignagePlaybackAckSchema = z
  .object({
    playerId: z.string().trim().min(1).max(80),
    playlistRevision: z.number().int().nonnegative(),
    itemId: MediaIdSchema.nullable(),
    state: SignagePlaybackStatusSchema,
    positionSeconds: z.number().finite().min(0).max(86_400),
    errorCode: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9_.:-]+$/u)
      .nullable()
      .optional()
  })
  .strict();
export type SignagePlaybackAck = z.infer<typeof SignagePlaybackAckSchema>;

export const SignageCompletionSchema = z
  .object({
    playerId: z.string().trim().min(1).max(80),
    playlistRevision: z.number().int().nonnegative(),
    itemId: MediaIdSchema
  })
  .strict();
export type SignageCompletion = z.infer<typeof SignageCompletionSchema>;

export const SignagePlaybackStateSchema = SignagePlaybackAckSchema.extend({
  receivedAt: z.number().int().nonnegative()
});
export type SignagePlaybackState = z.infer<typeof SignagePlaybackStateSchema>;

export const TalkMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("talk-start") }),
  z.object({ type: z.literal("talk-stop") })
]);

export type TalkMessage = z.infer<typeof TalkMessageSchema>;

export function success<T>(data: T): ApiSuccess<T> {
  return { ok: true, data };
}

export function failure(code: ErrorCode, message: string, recoverable: boolean): ApiFailure {
  return { ok: false, error: { code, message, recoverable } };
}

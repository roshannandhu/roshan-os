import {
  ControllerUpdateArtifactSchema,
  UPDATE_MAX_APK_BYTES,
  UpdateArtifactIdSchema,
  UpdateSha256Schema,
  type ControllerUpdateArtifact
} from "@tablet-control/shared-types";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

interface StoredUpdateArtifact extends ControllerUpdateArtifact {
  storedFileName: string;
}

export type UpdateArtifactStorageErrorKind = "invalid-data" | "file-too-large";

export class UpdateArtifactStorageError extends Error {
  public constructor(
    public readonly kind: UpdateArtifactStorageErrorKind,
    message: string
  ) {
    super(message);
    this.name = "UpdateArtifactStorageError";
  }
}

export interface UpdateArtifactStoreOptions {
  maxFileBytes?: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneArtifact(artifact: ControllerUpdateArtifact): ControllerUpdateArtifact {
  return { ...artifact };
}

function fsyncBestEffort(descriptor: number): void {
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform === "win32" &&
      (code === "EPERM" || code === "EINVAL" || code === "ENOTSUP")
    ) {
      return;
    }
    throw error;
  }
}

export class UpdateArtifactStore {
  private readonly baseDirectory: string;
  private readonly filesDirectory: string;
  private readonly uploadsDirectory: string;
  private readonly catalogFile: string;
  public readonly maxFileBytes: number;

  public constructor(baseDirectory?: string, options: UpdateArtifactStoreOptions = {}) {
    this.baseDirectory = path.resolve(
      baseDirectory ?? path.join(process.cwd(), ".local", "updates")
    );
    this.filesDirectory = path.join(this.baseDirectory, "files");
    this.uploadsDirectory = path.join(this.baseDirectory, "uploads");
    this.catalogFile = path.join(this.baseDirectory, "catalog.json");
    this.maxFileBytes = options.maxFileBytes ?? UPDATE_MAX_APK_BYTES;

    if (
      !Number.isSafeInteger(this.maxFileBytes) ||
      this.maxFileBytes <= 0 ||
      this.maxFileBytes > UPDATE_MAX_APK_BYTES
    ) {
      throw new Error("Signed-update artifact size limit is invalid.");
    }

    fs.mkdirSync(this.filesDirectory, { recursive: true });
    fs.mkdirSync(this.uploadsDirectory, { recursive: true });
    if (!fs.existsSync(this.catalogFile)) {
      this.writeCatalog([]);
    }
  }

  public createTemporaryUploadPath(): string {
    return path.join(
      this.uploadsDirectory,
      `${process.pid.toString()}-${Date.now().toString()}-${crypto
        .randomBytes(12)
        .toString("hex")}.upload`
    );
  }

  private isManagedTemporaryPath(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    const relative = path.relative(this.uploadsDirectory, resolved);
    return (
      relative.length > 0 &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative) &&
      path.extname(resolved) === ".upload"
    );
  }

  public removeTemporaryUpload(filePath: string): void {
    if (!this.isManagedTemporaryPath(filePath)) {
      return;
    }
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  public normalizeApkFileName(fileName: string): string {
    const hasControlCharacter = [...fileName].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    });
    if (
      fileName.length < 5 ||
      fileName.length > 240 ||
      fileName !== path.basename(fileName) ||
      hasControlCharacter ||
      path.extname(fileName).toLowerCase() !== ".apk"
    ) {
      throw new UpdateArtifactStorageError(
        "invalid-data",
        "The signed-update upload must use a safe .apk file name."
      );
    }
    return fileName;
  }

  private writeCatalog(artifacts: StoredUpdateArtifact[]): void {
    const temporaryPath = `${this.catalogFile}.${process.pid.toString()}.${crypto
      .randomBytes(8)
      .toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(artifacts, null, 2), {
        encoding: "utf8",
        mode: 0o600
      });
      const descriptor = fs.openSync(temporaryPath, "r");
      try {
        fsyncBestEffort(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporaryPath, this.catalogFile);
    } finally {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The atomic destination is already authoritative; abandoned private
        // temporary metadata can be removed by controller maintenance.
      }
    }
  }

  private normalizeStoredArtifact(value: unknown): StoredUpdateArtifact | undefined {
    if (!isPlainRecord(value) || typeof value.storedFileName !== "string") {
      return undefined;
    }
    const parsed = ControllerUpdateArtifactSchema.safeParse({
      id: value.id,
      fileName: value.fileName,
      sizeBytes: value.sizeBytes,
      sha256: value.sha256,
      createdAt: value.createdAt
    });
    if (!parsed.success || value.storedFileName !== `${parsed.data.id}.apk`) {
      return undefined;
    }
    const filePath = path.resolve(this.filesDirectory, value.storedFileName);
    const relative = path.relative(this.filesDirectory, filePath);
    if (
      relative.length === 0 ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return undefined;
    }
    try {
      const stat = fs.lstatSync(filePath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !== parsed.data.sizeBytes ||
        stat.size > this.maxFileBytes
      ) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    return {
      ...parsed.data,
      storedFileName: value.storedFileName
    };
  }

  private readCatalog(): StoredUpdateArtifact[] {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.catalogFile, "utf8"));
      if (!Array.isArray(value)) {
        return [];
      }
      return value
        .map((artifact) => this.normalizeStoredArtifact(artifact))
        .filter((artifact): artifact is StoredUpdateArtifact => artifact !== undefined);
    } catch {
      return [];
    }
  }

  public finalizeTemporaryUpload(input: {
    temporaryPath: string;
    fileName: string;
    sizeBytes: number;
    sha256: string;
  }): ControllerUpdateArtifact {
    if (!this.isManagedTemporaryPath(input.temporaryPath)) {
      throw new UpdateArtifactStorageError("invalid-data", "Upload staging path is invalid.");
    }
    const fileName = this.normalizeApkFileName(input.fileName);
    if (!UpdateSha256Schema.safeParse(input.sha256).success) {
      throw new UpdateArtifactStorageError("invalid-data", "APK SHA-256 is invalid.");
    }
    if (
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes <= 0 ||
      input.sizeBytes > this.maxFileBytes
    ) {
      throw new UpdateArtifactStorageError(
        input.sizeBytes > this.maxFileBytes ? "file-too-large" : "invalid-data",
        "APK size is outside the signed-update limit."
      );
    }

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(input.temporaryPath);
    } catch {
      throw new UpdateArtifactStorageError("invalid-data", "Staged APK is missing.");
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== input.sizeBytes) {
      throw new UpdateArtifactStorageError("invalid-data", "Staged APK size is inconsistent.");
    }

    const header = Buffer.alloc(4);
    const descriptor = fs.openSync(input.temporaryPath, "r");
    try {
      const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
      fsyncBestEffort(descriptor);
      if (
        bytesRead !== header.length ||
        header[0] !== 0x50 ||
        header[1] !== 0x4b ||
        header[2] !== 0x03 ||
        header[3] !== 0x04
      ) {
        throw new UpdateArtifactStorageError(
          "invalid-data",
          "The uploaded file does not have an APK/ZIP signature."
        );
      }
    } finally {
      fs.closeSync(descriptor);
    }

    const id = `update_${Date.now().toString()}_${crypto.randomBytes(8).toString("hex")}`;
    if (!UpdateArtifactIdSchema.safeParse(id).success) {
      throw new UpdateArtifactStorageError("invalid-data", "Generated artifact ID is invalid.");
    }
    const storedFileName = `${id}.apk`;
    const destinationPath = path.join(this.filesDirectory, storedFileName);
    const artifact = ControllerUpdateArtifactSchema.parse({
      id,
      fileName,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      createdAt: new Date().toISOString()
    });

    fs.renameSync(input.temporaryPath, destinationPath);
    try {
      this.writeCatalog([...this.readCatalog(), { ...artifact, storedFileName }]);
    } catch (error) {
      try {
        fs.unlinkSync(destinationPath);
      } catch {
        // Preserve the original catalog failure.
      }
      throw error;
    }

    return cloneArtifact(artifact);
  }

  public getArtifact(id: string): ControllerUpdateArtifact | undefined {
    if (!UpdateArtifactIdSchema.safeParse(id).success) {
      return undefined;
    }
    const record = this.readCatalog().find((candidate) => candidate.id === id);
    return record === undefined ? undefined : cloneArtifact(record);
  }

  public getArtifactFile(
    id: string
  ): { artifact: ControllerUpdateArtifact; filePath: string } | undefined {
    if (!UpdateArtifactIdSchema.safeParse(id).success) {
      return undefined;
    }
    const record = this.readCatalog().find((candidate) => candidate.id === id);
    if (record === undefined) {
      return undefined;
    }
    return {
      artifact: cloneArtifact(record),
      filePath: path.join(this.filesDirectory, record.storedFileName)
    };
  }
}

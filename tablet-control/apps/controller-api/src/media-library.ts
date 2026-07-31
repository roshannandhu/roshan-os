import {
  MEDIA_MAX_FILE_BYTES,
  MEDIA_MAX_ITEMS,
  MEDIA_MAX_TOTAL_BYTES,
  MediaItemSchema,
  MediaMimeTypeSchema,
  type MediaItem,
  type MediaMimeType,
  type MediaUpload
} from "@tablet-control/shared-types";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type MediaStorageErrorKind =
  "invalid-data" | "file-too-large" | "library-full" | "item-limit";

export class MediaStorageError extends Error {
  public constructor(
    public readonly kind: MediaStorageErrorKind,
    message: string
  ) {
    super(message);
    this.name = "MediaStorageError";
  }
}

interface CatalogItem extends MediaItem {
  storedFileName: string;
}

export interface MiniAlbum {
  id: string;
  title: string;
  itemIds: string[];
  durationPerItemSeconds: number;
  loop: boolean;
  shuffle: boolean;
  offlineAvailable: boolean;
  createdAt: number;
}

export interface MediaLibraryOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxItems?: number;
}

const EXTENSIONS_BY_MIME: Readonly<Record<MediaMimeType, readonly string[]>> = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "video/mp4": [".mp4"]
};

const STORED_EXTENSION_BY_MIME: Readonly<Record<MediaMimeType, string>> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "video/mp4": ".mp4"
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeStoredFileName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 180 &&
    value === path.basename(value) &&
    value !== "." &&
    value !== ".." &&
    !value.includes("\0")
  );
}

function cloneItem(item: MediaItem): MediaItem {
  return { ...item };
}

function toPublicItem(item: CatalogItem): MediaItem {
  return {
    id: item.id,
    title: item.title,
    type: item.type,
    fileName: item.fileName,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    durationSeconds: item.durationSeconds,
    url: item.url,
    createdAt: item.createdAt,
    checksum: item.checksum
  };
}

export class MediaLibrary {
  private readonly mediaDir: string;
  private readonly filesDir: string;
  private readonly uploadsDir: string;
  private readonly catalogFile: string;
  private readonly albumsFile: string;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxItems: number;

  public constructor(baseDir?: string, options: MediaLibraryOptions = {}) {
    this.mediaDir = path.resolve(baseDir ?? path.join(process.cwd(), ".local", "media"));
    this.filesDir = path.join(this.mediaDir, "files");
    this.uploadsDir = path.join(this.mediaDir, "uploads");
    this.catalogFile = path.join(this.mediaDir, "catalog.json");
    this.albumsFile = path.join(this.mediaDir, "albums.json");
    this.maxFileBytes = options.maxFileBytes ?? MEDIA_MAX_FILE_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? MEDIA_MAX_TOTAL_BYTES;
    this.maxItems = options.maxItems ?? MEDIA_MAX_ITEMS;

    fs.mkdirSync(this.filesDir, { recursive: true });
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    this.ensureFiles();
  }

  private ensureFiles(): void {
    if (!fs.existsSync(this.catalogFile)) {
      this.writeJsonAtomically(this.catalogFile, []);
    }
    if (!fs.existsSync(this.albumsFile)) {
      this.writeJsonAtomically(this.albumsFile, []);
    }
  }

  private writeJsonAtomically(filePath: string, value: unknown): void {
    const temporaryPath = `${filePath}.${process.pid.toString()}.${crypto
      .randomBytes(4)
      .toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), {
        encoding: "utf8",
        mode: 0o600
      });
      fs.renameSync(temporaryPath, filePath);
    } finally {
      if (fs.existsSync(temporaryPath)) {
        fs.unlinkSync(temporaryPath);
      }
    }
  }

  private resolveStoredPath(storedFileName: string): string | undefined {
    if (!isSafeStoredFileName(storedFileName)) {
      return undefined;
    }

    const preferred = path.resolve(this.filesDir, storedFileName);
    const preferredRelative = path.relative(this.filesDir, preferred);
    if (
      preferredRelative.length > 0 &&
      !preferredRelative.startsWith(`..${path.sep}`) &&
      preferredRelative !== ".." &&
      !path.isAbsolute(preferredRelative) &&
      fs.existsSync(preferred)
    ) {
      return preferred;
    }

    // Read-only compatibility for files written by the original media implementation.
    const legacy = path.resolve(this.mediaDir, storedFileName);
    const legacyRelative = path.relative(this.mediaDir, legacy);
    if (
      legacyRelative.length > 0 &&
      !legacyRelative.startsWith(`..${path.sep}`) &&
      legacyRelative !== ".." &&
      !path.isAbsolute(legacyRelative) &&
      fs.existsSync(legacy)
    ) {
      return legacy;
    }

    return undefined;
  }

  private normalizeCatalogItem(value: unknown): CatalogItem | undefined {
    if (!isPlainRecord(value) || typeof value.id !== "string") {
      return undefined;
    }

    let storedFileName =
      typeof value.storedFileName === "string" ? value.storedFileName : undefined;
    let displayFileName = typeof value.fileName === "string" ? value.fileName : undefined;

    if (
      storedFileName === undefined &&
      displayFileName !== undefined &&
      displayFileName.startsWith(`${value.id}_`)
    ) {
      storedFileName = displayFileName;
      displayFileName = displayFileName.slice(value.id.length + 1);
    }

    if (
      storedFileName === undefined ||
      displayFileName === undefined ||
      !isSafeStoredFileName(storedFileName)
    ) {
      return undefined;
    }

    const storedPath = this.resolveStoredPath(storedFileName);
    if (storedPath === undefined) {
      return undefined;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(storedPath);
    } catch {
      return undefined;
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > this.maxFileBytes) {
      return undefined;
    }

    const publicCandidate = {
      id: value.id,
      title: value.title,
      type: value.type,
      fileName: displayFileName,
      mimeType: value.mimeType,
      sizeBytes: stat.size,
      durationSeconds: value.durationSeconds,
      url: `/media/${value.id}`,
      createdAt: value.createdAt,
      checksum: value.checksum
    };
    const parsed = MediaItemSchema.safeParse(publicCandidate);
    if (!parsed.success) {
      return undefined;
    }

    return {
      ...parsed.data,
      storedFileName
    };
  }

  private getCatalog(): CatalogItem[] {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.catalogFile, "utf8"));
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .map((item) => this.normalizeCatalogItem(item))
        .filter((item): item is CatalogItem => item !== undefined);
    } catch {
      return [];
    }
  }

  private saveCatalog(items: CatalogItem[]): void {
    this.writeJsonAtomically(this.catalogFile, items);
  }

  public getItems(): MediaItem[] {
    return this.getCatalog().map((item) => cloneItem(toPublicItem(item)));
  }

  public getItem(id: string): MediaItem | undefined {
    const record = this.getCatalog().find((item) => item.id === id);
    if (record === undefined) {
      return undefined;
    }
    return cloneItem(toPublicItem(record));
  }

  public getFile(id: string): { item: MediaItem; filePath: string; etag: string } | undefined {
    const record = this.getCatalog().find((item) => item.id === id);
    if (record === undefined) {
      return undefined;
    }

    const filePath = this.resolveStoredPath(record.storedFileName);
    if (filePath === undefined) {
      return undefined;
    }
    return {
      item: cloneItem(toPublicItem(record)),
      filePath,
      etag: `"${record.checksum}"`
    };
  }

  public getAlbums(): MiniAlbum[] {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.albumsFile, "utf8"));
      return Array.isArray(parsed) ? (parsed as MiniAlbum[]) : [];
    } catch {
      return [];
    }
  }

  private saveAlbums(albums: MiniAlbum[]): void {
    this.writeJsonAtomically(this.albumsFile, albums);
  }

  private currentStorageBytes(): number {
    let total = 0;
    const directories = [this.filesDir, this.mediaDir];
    for (const directory of directories) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.endsWith(".json") || entry.name.endsWith(".tmp")) {
          continue;
        }
        try {
          total += fs.statSync(path.join(directory, entry.name)).size;
        } catch {
          // A concurrently removed file does not consume quota anymore.
        }
      }
    }
    return total;
  }

  public createTemporaryUploadPath(): string {
    return path.join(
      this.uploadsDir,
      `${process.pid.toString()}-${Date.now().toString()}-${crypto
        .randomBytes(12)
        .toString("hex")}.upload`
    );
  }

  private isManagedTemporaryUpload(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    const relative = path.relative(this.uploadsDir, resolved);
    return (
      relative.length > 0 &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative) &&
      path.extname(resolved) === ".upload"
    );
  }

  private static validateFileSignatureFromPath(
    mimeType: MediaMimeType,
    filePath: string,
    sizeBytes: number
  ): boolean {
    const headerLength = Math.min(sizeBytes, 32);
    const header = Buffer.alloc(headerLength);
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(filePath, "r");
      const bytesRead = fs.readSync(descriptor, header, 0, headerLength, 0);
      if (bytesRead !== headerLength) {
        return false;
      }
    } catch {
      return false;
    } finally {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
      }
    }

    if (mimeType === "image/webp") {
      return (
        header.length >= 12 &&
        header.toString("ascii", 0, 4) === "RIFF" &&
        header.toString("ascii", 8, 12) === "WEBP" &&
        header.readUInt32LE(4) + 8 <= sizeBytes
      );
    }
    if (mimeType === "video/mp4") {
      if (header.length < 12 || header.toString("ascii", 4, 8) !== "ftyp") {
        return false;
      }
      const firstBoxSize = header.readUInt32BE(0);
      return firstBoxSize >= 12 && firstBoxSize <= sizeBytes;
    }
    return MediaLibrary.validateFileSignature(mimeType, header);
  }

  public commitTemporaryUpload(
    upload: MediaUpload,
    temporaryPath: string,
    checksum: string
  ): MediaItem {
    if (!this.isManagedTemporaryUpload(temporaryPath)) {
      throw new MediaStorageError("invalid-data", "The temporary upload path is invalid.");
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(temporaryPath);
    } catch {
      throw new MediaStorageError("invalid-data", "The temporary media upload is missing.");
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size !== upload.sizeBytes) {
      throw new MediaStorageError(
        "invalid-data",
        "The declared media size does not match the uploaded content."
      );
    }
    if (stat.size > this.maxFileBytes) {
      throw new MediaStorageError("file-too-large", "The media file exceeds the upload limit.");
    }
    if (!/^[a-f0-9]{64}$/u.test(checksum)) {
      throw new MediaStorageError("invalid-data", "The media checksum is invalid.");
    }
    if (!MediaLibrary.fileExtensionMatches(upload.fileName, upload.mimeType)) {
      throw new MediaStorageError(
        "invalid-data",
        "The file extension does not match the declared media type."
      );
    }
    if (
      !MediaLibrary.validateFileSignatureFromPath(upload.mimeType, temporaryPath, upload.sizeBytes)
    ) {
      throw new MediaStorageError(
        "invalid-data",
        "The file signature does not match the declared media type."
      );
    }

    const items = this.getCatalog();
    if (items.length >= this.maxItems) {
      throw new MediaStorageError("item-limit", "The media library item limit has been reached.");
    }
    if (this.currentStorageBytes() + stat.size > this.maxTotalBytes) {
      throw new MediaStorageError(
        "library-full",
        "The media library storage limit has been reached."
      );
    }

    const id = `media_${Date.now().toString()}_${crypto.randomBytes(4).toString("hex")}`;
    const storedFileName = `${id}${STORED_EXTENSION_BY_MIME[upload.mimeType]}`;
    const filePath = path.join(this.filesDir, storedFileName);
    const item: CatalogItem = {
      id,
      title: upload.title ?? upload.fileName,
      type: upload.mimeType === "video/mp4" ? "video" : "image",
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      sizeBytes: stat.size,
      durationSeconds: upload.durationSeconds,
      url: `/media/${id}`,
      createdAt: Date.now(),
      checksum,
      storedFileName
    };

    fs.renameSync(temporaryPath, filePath);
    try {
      items.push(item);
      this.saveCatalog(items);
    } catch (error) {
      try {
        fs.renameSync(filePath, temporaryPath);
      } catch {
        // Keep the original catalog error if rollback itself fails.
      }
      throw error;
    }

    return cloneItem(toPublicItem(item));
  }

  public addMedia(upload: MediaUpload, dataBuffer: Buffer): MediaItem {
    if (dataBuffer.length <= 0 || dataBuffer.length !== upload.sizeBytes) {
      throw new MediaStorageError(
        "invalid-data",
        "The declared media size does not match the uploaded content."
      );
    }
    if (dataBuffer.length > this.maxFileBytes) {
      throw new MediaStorageError("file-too-large", "The media file exceeds the upload limit.");
    }
    if (!MediaLibrary.fileExtensionMatches(upload.fileName, upload.mimeType)) {
      throw new MediaStorageError(
        "invalid-data",
        "The file extension does not match the declared media type."
      );
    }
    if (!MediaLibrary.validateFileSignature(upload.mimeType, dataBuffer)) {
      throw new MediaStorageError(
        "invalid-data",
        "The file signature does not match the declared media type."
      );
    }

    const items = this.getCatalog();
    if (items.length >= this.maxItems) {
      throw new MediaStorageError("item-limit", "The media library item limit has been reached.");
    }
    if (this.currentStorageBytes() + dataBuffer.length > this.maxTotalBytes) {
      throw new MediaStorageError(
        "library-full",
        "The media library storage limit has been reached."
      );
    }

    const id = `media_${Date.now().toString()}_${crypto.randomBytes(4).toString("hex")}`;
    const storedFileName = `${id}${STORED_EXTENSION_BY_MIME[upload.mimeType]}`;
    const filePath = path.join(this.filesDir, storedFileName);
    const checksum = crypto.createHash("sha256").update(dataBuffer).digest("hex");
    const item: CatalogItem = {
      id,
      title: upload.title ?? upload.fileName,
      type: upload.mimeType === "video/mp4" ? "video" : "image",
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      sizeBytes: dataBuffer.length,
      durationSeconds: upload.durationSeconds,
      url: `/media/${id}`,
      createdAt: Date.now(),
      checksum,
      storedFileName
    };

    fs.writeFileSync(filePath, dataBuffer, { flag: "wx", mode: 0o600 });
    try {
      items.push(item);
      this.saveCatalog(items);
    } catch (error) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Keep the original catalog error.
      }
      throw error;
    }

    return cloneItem(toPublicItem(item));
  }

  public deleteMedia(id: string): boolean {
    const items = this.getCatalog();
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) {
      return false;
    }

    const item = items[index];
    if (item === undefined) {
      return false;
    }
    const filePath = this.resolveStoredPath(item.storedFileName);
    if (filePath !== undefined) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        return false;
      }
    }

    items.splice(index, 1);
    this.saveCatalog(items);

    const albums = this.getAlbums();
    for (const album of albums) {
      album.itemIds = album.itemIds.filter((itemId) => itemId !== id);
    }
    this.saveAlbums(albums);
    return true;
  }

  public createAlbum(
    title: string,
    itemIds: string[] = [],
    durationPerItemSeconds = 10
  ): MiniAlbum {
    const id = `album_${Date.now().toString()}_${crypto.randomBytes(3).toString("hex")}`;
    const album: MiniAlbum = {
      id,
      title,
      itemIds,
      durationPerItemSeconds,
      loop: true,
      shuffle: false,
      offlineAvailable: true,
      createdAt: Date.now()
    };

    const albums = this.getAlbums();
    albums.push(album);
    this.saveAlbums(albums);
    return album;
  }

  public updateAlbum(
    id: string,
    updates: Partial<Omit<MiniAlbum, "id" | "createdAt">>
  ): MiniAlbum | null {
    const albums = this.getAlbums();
    const album = albums.find((candidate) => candidate.id === id);
    if (album === undefined) {
      return null;
    }

    Object.assign(album, updates);
    this.saveAlbums(albums);
    return album;
  }

  public deleteAlbum(id: string): boolean {
    const albums = this.getAlbums();
    const index = albums.findIndex((album) => album.id === id);
    if (index === -1) {
      return false;
    }
    albums.splice(index, 1);
    this.saveAlbums(albums);
    return true;
  }

  public static fileExtensionMatches(fileName: string, mimeType: MediaMimeType): boolean {
    const parsedMime = MediaMimeTypeSchema.safeParse(mimeType);
    if (!parsedMime.success) {
      return false;
    }
    const extension = path.extname(fileName).toLowerCase();
    return EXTENSIONS_BY_MIME[parsedMime.data].includes(extension);
  }

  public static validateFileSignature(mimeType: MediaMimeType, buffer: Buffer): boolean {
    if (mimeType === "image/png") {
      return (
        buffer.length >= 8 &&
        buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      );
    }
    if (mimeType === "image/jpeg") {
      return buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    }
    if (mimeType === "image/webp") {
      return (
        buffer.length >= 12 &&
        buffer.toString("ascii", 0, 4) === "RIFF" &&
        buffer.toString("ascii", 8, 12) === "WEBP" &&
        buffer.readUInt32LE(4) + 8 <= buffer.length
      );
    }
    if (mimeType === "video/mp4") {
      if (buffer.length < 12 || buffer.toString("ascii", 4, 8) !== "ftyp") {
        return false;
      }
      const firstBoxSize = buffer.readUInt32BE(0);
      return firstBoxSize >= 12 && firstBoxSize <= buffer.length;
    }
    return false;
  }
}

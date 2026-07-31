import {
  SignagePlaybackAckSchema,
  SignagePlaybackStateSchema,
  SignagePlaylistSchema,
  type SignagePlaybackAck,
  type SignagePlaybackState,
  type SignagePlaylist,
  type SignagePlaylistUpdate
} from "@tablet-control/shared-types";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const SIGNAGE_PLAYBACK_COOKIE_NAME = "roshanos_signage_player";
export const SIGNAGE_PLAYBACK_COOKIE_PATH = "/api/v1/signage";
export const SIGNAGE_PLAYBACK_CAPABILITY_TTL_SECONDS = 15 * 60;

function normalizeCapabilitySource(value: string): string {
  return value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
}

function capabilityUserAgent(value: string | undefined): string {
  return (value ?? "").slice(0, 512);
}

export class SignagePlaybackCapability {
  private readonly signingKey = crypto.randomBytes(32);

  public issue(sourceIp: string, userAgent: string | undefined, now = Date.now()): string {
    const issuedAt = Math.floor(now / 1000);
    const expiresAt = issuedAt + SIGNAGE_PLAYBACK_CAPABILITY_TTL_SECONDS;
    const nonce = crypto.randomBytes(24).toString("base64url");
    const payload = ["v1", issuedAt.toString(36), expiresAt.toString(36), nonce].join(".");
    const signature = this.sign(payload, sourceIp, userAgent);
    return `${payload}.${signature}`;
  }

  public validate(
    token: string | undefined,
    sourceIp: string,
    userAgent: string | undefined,
    now = Date.now()
  ): boolean {
    if (token === undefined || token.length < 80 || token.length > 256) {
      return false;
    }
    const parts = token.split(".");
    if (parts.length !== 5 || parts[0] !== "v1") {
      return false;
    }
    const issuedAt = Number.parseInt(parts[1] ?? "", 36);
    const expiresAt = Number.parseInt(parts[2] ?? "", 36);
    const nonce = parts[3] ?? "";
    const suppliedSignature = parts[4] ?? "";
    const nowSeconds = Math.floor(now / 1000);
    if (
      !Number.isSafeInteger(issuedAt) ||
      !Number.isSafeInteger(expiresAt) ||
      issuedAt > nowSeconds + 30 ||
      expiresAt <= nowSeconds ||
      expiresAt - issuedAt !== SIGNAGE_PLAYBACK_CAPABILITY_TTL_SECONDS ||
      !/^[A-Za-z0-9_-]{32}$/u.test(nonce) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(suppliedSignature)
    ) {
      return false;
    }

    const payload = parts.slice(0, 4).join(".");
    const expectedSignature = this.sign(payload, sourceIp, userAgent);
    const supplied = Buffer.from(suppliedSignature, "utf8");
    const expected = Buffer.from(expectedSignature, "utf8");
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  }

  private sign(payload: string, sourceIp: string, userAgent: string | undefined): string {
    return crypto
      .createHmac("sha256", this.signingKey)
      .update(payload, "utf8")
      .update("\0", "utf8")
      .update(normalizeCapabilitySource(sourceIp), "utf8")
      .update("\0", "utf8")
      .update(capabilityUserAgent(userAgent), "utf8")
      .digest("base64url");
  }
}

function clonePlaylist(playlist: SignagePlaylist): SignagePlaylist {
  return {
    ...playlist,
    items: playlist.items.map((item) => ({ ...item }))
  };
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
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

export class SignagePlaylistStore {
  private data: SignagePlaylist = {
    enabled: false,
    loop: true,
    items: [],
    revision: 0,
    updatedAt: 0
  };

  public constructor(private readonly filePath: string) {
    this.load();
  }

  private load(): void {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const validated = SignagePlaylistSchema.safeParse(parsed);
      if (validated.success) {
        this.data = validated.data;
      }
    } catch {
      // A missing or corrupt state file starts from a safe, disabled playlist.
    }
  }

  private save(): void {
    writeJsonAtomically(this.filePath, this.data);
  }

  public get(): SignagePlaylist {
    return clonePlaylist(this.data);
  }

  public set(update: SignagePlaylistUpdate): SignagePlaylist {
    const next = SignagePlaylistSchema.parse({
      enabled: update.enabled ?? this.data.enabled,
      loop: update.loop ?? this.data.loop,
      items: update.items ?? this.data.items,
      revision: this.data.revision,
      updatedAt: this.data.updatedAt
    });
    const changed =
      next.enabled !== this.data.enabled ||
      next.loop !== this.data.loop ||
      JSON.stringify(next.items) !== JSON.stringify(this.data.items);
    if (!changed) {
      return this.get();
    }

    this.data = {
      ...next,
      revision: this.data.revision + 1,
      updatedAt: Date.now()
    };
    this.save();
    return this.get();
  }
}

export class SignagePlaybackStore {
  private latest: SignagePlaybackState | null = null;

  public constructor(private readonly filePath: string) {
    this.load();
  }

  private load(): void {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const validated = SignagePlaybackStateSchema.safeParse(parsed);
      if (validated.success) {
        this.latest = validated.data;
      }
    } catch {
      // Playback acknowledgement is optional until a player reports.
    }
  }

  public get(): SignagePlaybackState | null {
    return this.latest === null ? null : { ...this.latest };
  }

  public record(input: SignagePlaybackAck): SignagePlaybackState {
    const ack = SignagePlaybackAckSchema.parse(input);
    const state = SignagePlaybackStateSchema.parse({
      ...ack,
      receivedAt: Date.now()
    });
    this.latest = state;
    writeJsonAtomically(this.filePath, state);
    return { ...state };
  }
}

export const SIGNAGE_PLAYER_CACHE_CONTROL =
  "public, max-age=300, stale-while-revalidate=86400, stale-if-error=604800";

export function signagePlayerEtag(html: string): string {
  return `"${crypto.createHash("sha256").update(html, "utf8").digest("hex")}"`;
}

export function renderSignagePlayer(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>RoshanOS Signage</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body, #stage { width: 100%; height: 100%; overflow: hidden; background: #000; }
    #stage { display: flex; align-items: center; justify-content: center; }
    img, video { width: 100%; height: 100%; object-fit: contain; background: #000; border: 0; outline: 0; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <main id="stage" aria-label="Signage playback">
    <img id="image" alt="" hidden>
    <video id="video" playsinline webkit-playsinline preload="auto" disablepictureinpicture hidden></video>
  </main>
  <script>
    (function () {
      "use strict";

      var stage = document.getElementById("stage");
      var image = document.getElementById("image");
      var video = document.getElementById("video");
      var playlist = { enabled: false, loop: true, items: [], revision: 0 };
      var currentIndex = 0;
      var generation = 0;
      var advanceTimer = null;
      var recoveryTimer = null;
      var completionRetryTimer = null;
      var completionInFlight = null;
      var pendingCompletion = null;
      var retryCount = 0;
      var recovering = false;
      var lastPosition = 0;
      var lastProgressAt = 0;
      var itemDeadline = 0;
      var stopped = true;
      var activeObjectUrl = null;
      var activeCacheName = null;
      var cacheVerified = false;
      var activationInFlight = null;
      var lastPlaylistFailure = "";
      var lastPlaylistFailureAt = 0;
      var PLAYLIST_STORAGE_KEY = "roshanos.signage.playlist.v2";
      var LEGACY_PLAYLIST_STORAGE_KEY = "roshanos.signage.playlist.v1";
      var MEDIA_CACHE_PREFIX = "roshanos-signage-media-v2-r";
      var LEGACY_MEDIA_CACHE_NAME = "roshanos-signage-media-v1";
      var MAX_STORED_PLAYLIST_BYTES = 128 * 1024;
      var MAX_CACHE_ITEMS = 100;
      var MAX_CACHE_BYTES = 192 * 1024 * 1024;
      var MAX_MEDIA_BYTES = 50 * 1000 * 1000;
      var playerId =
        window.crypto && typeof window.crypto.randomUUID === "function"
          ? window.crypto.randomUUID()
          : "player-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);

      function clearTimers() {
        if (advanceTimer !== null) window.clearTimeout(advanceTimer);
        if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
        advanceTimer = null;
        recoveryTimer = null;
      }

      function revokeActiveObjectUrl() {
        if (activeObjectUrl !== null) {
          URL.revokeObjectURL(activeObjectUrl);
          activeObjectUrl = null;
        }
      }

      function markFailure(code) {
        var safe = errorCode({ name: code }, "PlayerFailure");
        stage.dataset.error = safe;
        if (window.console && typeof window.console.warn === "function") {
          window.console.warn("[RoshanOS Signage] " + safe);
        }
        var now = Date.now();
        if (safe !== lastPlaylistFailure || now - lastPlaylistFailureAt >= 30000) {
          lastPlaylistFailure = safe;
          lastPlaylistFailureAt = now;
          var item = playlist.items[currentIndex] || null;
          report("error", item, safe);
        }
      }

      function clearFailure() {
        delete stage.dataset.error;
        lastPlaylistFailure = "";
        lastPlaylistFailureAt = 0;
      }

      function errorCode(error, fallback) {
        var raw =
          error && typeof error.name === "string" && error.name.length > 0
            ? error.name
            : fallback;
        return String(raw).replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 80) || fallback;
      }

      function playerError(code) {
        var error = new Error(code);
        error.name = code;
        return error;
      }

      function report(state, item, error) {
        var payload = {
          playerId: playerId,
          playlistRevision: Number(playlist.revision) || 0,
          itemId: item && typeof item.id === "string" ? item.id : null,
          state: state,
          positionSeconds:
            item && item.type === "video" && Number.isFinite(video.currentTime)
              ? Math.max(0, video.currentTime)
              : 0
        };
        if (error) payload.errorCode = error;
        fetch("/api/v1/signage/playback", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          keepalive: true,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        }).catch(function () {});
      }

      function scheduleCompletionRetry() {
        if (pendingCompletion === null || completionRetryTimer !== null) return;
        completionRetryTimer = window.setTimeout(function () {
          completionRetryTimer = null;
          sendPendingCompletion();
        }, 5000);
      }

      function sendPendingCompletion() {
        if (pendingCompletion === null || completionInFlight !== null) return;
        var requested = pendingCompletion;
        completionInFlight = fetch("/api/v1/signage/completion", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          keepalive: true,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(requested)
        })
          .then(async function (response) {
            if (response.status === 409) {
              pendingCompletion = null;
              delete stage.dataset.completionError;
              await fetchPlaylist();
              return;
            }
            if (!response.ok) {
              if (response.status === 401) await fetchPlaylist();
              throw playerError("CompletionHTTP" + response.status.toString());
            }
            if (
              pendingCompletion !== null &&
              pendingCompletion.playlistRevision === requested.playlistRevision &&
              pendingCompletion.itemId === requested.itemId
            ) {
              pendingCompletion = null;
            }
            if (completionRetryTimer !== null) {
              window.clearTimeout(completionRetryTimer);
              completionRetryTimer = null;
            }
            delete stage.dataset.completionError;
            await fetchPlaylist();
          })
          .catch(function (error) {
            stage.dataset.completionError = errorCode(error, "CompletionFailed");
            scheduleCompletionRetry();
          })
          .finally(function () {
            completionInFlight = null;
          });
      }

      function completeNonLoopPlaylist(token, item) {
        if (token !== generation) return;
        var completion = {
          playerId: playerId,
          playlistRevision: Number(playlist.revision) || 0,
          itemId: item.id
        };
        stopPlayback(false);
        pendingCompletion = completion;
        sendPendingCompletion();
      }

      function resetElements() {
        image.onload = null;
        image.onerror = null;
        image.hidden = true;
        image.removeAttribute("src");
        video.onloadedmetadata = null;
        video.onplaying = null;
        video.onended = null;
        video.onerror = null;
        video.onstalled = null;
        video.onwaiting = null;
        video.ontimeupdate = null;
        video.pause();
        video.hidden = true;
        video.removeAttribute("src");
        video.load();
        revokeActiveObjectUrl();
      }

      function stopPlayback(shouldReport) {
        generation += 1;
        clearTimers();
        resetElements();
        if (!stopped && shouldReport) report("stopped", null, null);
        stopped = true;
      }

      function scheduleAdvance(token, item) {
        if (token !== generation) return;
        if (advanceTimer !== null) window.clearTimeout(advanceTimer);
        var remaining = Math.max(250, itemDeadline - Date.now());
        advanceTimer = window.setTimeout(function () {
          finishItem(token, item);
        }, remaining);
      }

      function finishItem(token, item) {
        if (token !== generation) return;
        report("ended", item, null);
        clearTimers();
        if (currentIndex + 1 < playlist.items.length) {
          currentIndex += 1;
          playCurrent();
          return;
        }
        if (playlist.loop && playlist.items.length > 0) {
          currentIndex = 0;
          playCurrent();
          return;
        }
        completeNonLoopPlaylist(token, item);
      }

      async function sha256Hex(buffer) {
        if (
          !window.crypto ||
          !window.crypto.subtle ||
          typeof window.crypto.subtle.digest !== "function"
        ) {
          throw playerError("MediaIntegrityUnavailable");
        }
        var digest = await window.crypto.subtle.digest("SHA-256", buffer);
        return Array.from(new Uint8Array(digest))
          .map(function (byte) { return byte.toString(16).padStart(2, "0"); })
          .join("");
      }

      async function verifyMediaResponse(response, item, errorPrefix) {
        var length = Number(response.headers.get("content-length"));
        if (
          !response.ok ||
          response.status !== 200 ||
          !mediaResponseMatchesItem(response, item) ||
          !Number.isInteger(length) ||
          length <= 0 ||
          length > MAX_MEDIA_BYTES
        ) {
          if (response.body) response.body.cancel().catch(function () {});
          throw playerError(errorPrefix + "Invalid");
        }
        var body = await response.arrayBuffer();
        if (body.byteLength !== length || body.byteLength > MAX_MEDIA_BYTES) {
          throw playerError(errorPrefix + "BodyInvalid");
        }
        var checksum = await sha256Hex(body);
        if (checksum !== item.checksum) {
          throw playerError(errorPrefix + "ChecksumMismatch");
        }
        var blob = new Blob([body], {
          type: response.headers.get("content-type") || "application/octet-stream"
        });
        return { blob: blob, length: length };
      }

      async function verifiedNetworkSource(item) {
        var response = await fetch(item.url, {
          credentials: "same-origin",
          cache: "no-store"
        });
        var verified = await verifyMediaResponse(response, item, "NetworkMedia");
        var objectUrl = URL.createObjectURL(verified.blob);
        return { url: objectUrl, objectUrl: objectUrl, cached: false };
      }

      async function resolveMediaSource(item) {
        if (!window.URL || typeof URL.createObjectURL !== "function") {
          throw playerError("ObjectUrlUnavailable");
        }
        if (
          !cacheVerified ||
          activeCacheName === null ||
          !("caches" in window)
        ) {
          return verifiedNetworkSource(item);
        }
        try {
          var cache = await caches.open(activeCacheName);
          var cached = await cache.match(item.url);
          if (!cached) throw playerError("CachedMediaMissing");
          var verified = await verifyMediaResponse(cached, item, "CachedMedia");
          var objectUrl = URL.createObjectURL(verified.blob);
          return { url: objectUrl, objectUrl: objectUrl, cached: true };
        } catch (error) {
          invalidateActiveCache(errorCode(error, "CacheReadFailed"));
          return verifiedNetworkSource(item);
        }
      }

      async function assignMediaSource(element, token, item) {
        var source = await resolveMediaSource(item);
        if (token !== generation) {
          if (source.objectUrl !== null) URL.revokeObjectURL(source.objectUrl);
          return false;
        }
        revokeActiveObjectUrl();
        activeObjectUrl = source.objectUrl;
        stage.dataset.mediaSource = source.cached ? "cache" : "network";
        element.src = source.url;
        return true;
      }

      function invalidateActiveCache(reason) {
        if (!("caches" in window)) return;
        var invalidCacheName = activeCacheName;
        cacheVerified = false;
        activeCacheName = null;
        try {
          window.localStorage.removeItem(PLAYLIST_STORAGE_KEY);
        } catch (_error) {
          // The in-memory state is still marked unverified.
        }
        stage.dataset.cacheError = reason;
        if (invalidCacheName === null) return;
        caches.delete(invalidCacheName)
          .catch(function () {});
      }

      function invalidateCachedMedia() {
        if (stage.dataset.mediaSource !== "cache") return;
        invalidateActiveCache("CachedPlaybackFailed");
      }

      async function loadVideoSource(token, item) {
        try {
          var assigned = await assignMediaSource(video, token, item);
          if (!assigned) return;
          video.load();
          attemptVideoPlay(token, item);
        } catch (error) {
          recoverVideo(token, item, errorCode(error, "VideoSourceInvalid"));
        }
      }

      async function loadImageSource(token, item) {
        try {
          var assigned = await assignMediaSource(image, token, item);
          if (!assigned) return;
        } catch (error) {
          recoverImage(token, item, errorCode(error, "ImageSourceInvalid"));
        }
      }

      function mediaResponseMatchesItem(response, item) {
        var contentType = (response.headers.get("content-type") || "").toLowerCase();
        return item.type === "video"
          ? contentType.indexOf("video/mp4") === 0
          : contentType.indexOf("image/") === 0;
      }

      function cacheNameForPlaylist(nextPlaylist) {
        var suffix =
          window.crypto && typeof window.crypto.randomUUID === "function"
            ? window.crypto.randomUUID()
            : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
        return MEDIA_CACHE_PREFIX + nextPlaylist.revision.toString() + "-" + suffix;
      }

      function safeCacheName(value) {
        return (
          typeof value === "string" &&
          value.indexOf(MEDIA_CACHE_PREFIX) === 0 &&
          value.length <= 160 &&
          /^[A-Za-z0-9_-]+$/.test(value)
        );
      }

      async function validateCachedPlaylist(cacheName, nextPlaylist, verifyBodies) {
        function invalid(reason) {
          stage.dataset.cacheValidationError = reason;
          return null;
        }
        if (
          !("caches" in window) ||
          !safeCacheName(cacheName) ||
          !nextPlaylist.enabled ||
          nextPlaylist.items.length > MAX_CACHE_ITEMS
        ) {
          return invalid("CachedPlaylistMetadataInvalid");
        }

        var cache = await caches.open(cacheName);
        var desiredLookup = {};
        nextPlaylist.items.forEach(function (item) {
          desiredLookup[new URL(item.url, window.location.origin).href] = true;
        });
        var existingRequests = await cache.keys();
        if (existingRequests.length !== nextPlaylist.items.length) {
          return invalid("CachedPlaylistItemCountMismatch");
        }
        for (var requestIndex = 0; requestIndex < existingRequests.length; requestIndex += 1) {
          if (!desiredLookup[existingRequests[requestIndex].url]) {
            return invalid("CachedPlaylistUnexpectedItem");
          }
        }

        var totalBytes = 0;
        for (var index = 0; index < nextPlaylist.items.length; index += 1) {
          var item = nextPlaylist.items[index];
          var cached = await cache.match(item.url);
          if (!cached || cached.status !== 200 || !mediaResponseMatchesItem(cached, item)) {
            return invalid("CachedPlaylistMediaInvalid");
          }
          var length = Number(cached.headers.get("content-length"));
          if (
            !Number.isInteger(length) ||
            length <= 0 ||
            length > MAX_MEDIA_BYTES ||
            totalBytes + length > MAX_CACHE_BYTES
          ) {
            return invalid("CachedPlaylistLengthInvalid");
          }
          if (verifyBodies) {
            try {
              var verifiedBody = await verifyMediaResponse(
                cached.clone(),
                item,
                "CachedMedia"
              );
              if (verifiedBody.length !== length) {
                return invalid("CachedPlaylistBodyLengthMismatch");
              }
            } catch (error) {
              return invalid(
                errorCode(
                  {
                    name:
                      error && typeof error.message === "string"
                        ? error.message
                        : errorCode(error, "CachedPlaylistIntegrityInvalid")
                  },
                  "CachedPlaylistIntegrityInvalid"
                )
              );
            }
          }
          totalBytes += length;
        }
        delete stage.dataset.cacheValidationError;
        return {
          cacheName: cacheName,
          itemCount: nextPlaylist.items.length,
          totalBytes: totalBytes
        };
      }

      async function stageCompletePlaylist(nextPlaylist) {
        if (!nextPlaylist.enabled) {
          return { cacheName: null, itemCount: 0, totalBytes: 0 };
        }
        if (!("caches" in window)) throw playerError("CacheUnavailable");
        if (nextPlaylist.items.length > MAX_CACHE_ITEMS) {
          throw playerError("PlaylistCacheItemLimit");
        }

        var cacheName = cacheNameForPlaylist(nextPlaylist);
        var cache = await caches.open(cacheName);
        var totalBytes = 0;
        try {
          for (var index = 0; index < nextPlaylist.items.length; index += 1) {
            var item = nextPlaylist.items[index];
            var response = await fetch(item.url, {
              credentials: "same-origin",
              cache: "no-store"
            });
            var length = Number(response.headers.get("content-length"));
            if (
              !response.ok ||
              response.status !== 200 ||
              !mediaResponseMatchesItem(response, item) ||
              !Number.isInteger(length) ||
              length <= 0 ||
              length > MAX_MEDIA_BYTES
            ) {
              if (response.body) response.body.cancel().catch(function () {});
              throw playerError("MediaPrefetchInvalid");
            }
            if (totalBytes + length > MAX_CACHE_BYTES) {
              if (response.body) response.body.cancel().catch(function () {});
              throw playerError("PlaylistCacheByteLimit");
            }
            var verifiedDownload = await verifyMediaResponse(
              response.clone(),
              item,
              "DownloadedMedia"
            );
            if (verifiedDownload.length !== length) {
              throw playerError("DownloadedMediaLengthMismatch");
            }
            await cache.put(item.url, response);
            totalBytes += length;
          }

          var verified = await validateCachedPlaylist(cacheName, nextPlaylist, true);
          if (
            verified === null ||
            verified.itemCount !== nextPlaylist.items.length ||
            verified.totalBytes !== totalBytes
          ) {
            throw playerError("PlaylistCacheVerificationFailed");
          }
          return verified;
        } catch (error) {
          await caches.delete(cacheName);
          throw error;
        }
      }

      async function pruneInactiveCaches(keepName) {
        if (!("caches" in window)) return;
        var names = await caches.keys();
        for (var index = 0; index < names.length; index += 1) {
          var name = names[index];
          if (
            (name.indexOf(MEDIA_CACHE_PREFIX) === 0 && name !== keepName) ||
            name === LEGACY_MEDIA_CACHE_NAME
          ) {
            await caches.delete(name);
          }
        }
      }

      function updateCacheStatus(cacheInfo) {
        stage.dataset.cachedItems = cacheInfo.itemCount.toString();
        stage.dataset.cachedBytes = cacheInfo.totalBytes.toString();
        if (cacheInfo.cacheName === null) {
          delete stage.dataset.activeCache;
        } else {
          stage.dataset.activeCache = cacheInfo.cacheName;
        }
      }

      function recoverVideo(token, item, reason) {
        if (token !== generation || recovering) return;
        recovering = true;
        retryCount += 1;
        lastPosition = Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : lastPosition;
        report("error", item, reason);
        if (retryCount > 3 || Date.now() >= itemDeadline) {
          recovering = false;
          finishItem(token, item);
          return;
        }

        if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
        video.pause();
        video.removeAttribute("src");
        video.load();
        recoveryTimer = window.setTimeout(function () {
          if (token !== generation) return;
          recovering = false;
          loadVideoSource(token, item);
        }, Math.min(2000, 300 * retryCount));
      }

      function attemptVideoPlay(token, item) {
        if (token !== generation) return;
        var playPromise = video.play();
        if (playPromise && typeof playPromise.catch === "function") {
          playPromise.catch(function (error) {
            recoverVideo(token, item, errorCode(error, "PlayRejected"));
          });
        }
      }

      function playVideo(token, item) {
        image.hidden = true;
        video.hidden = false;
        video.muted = item.muted;
        video.loop = false;
        video.onloadedmetadata = function () {
          if (token !== generation) return;
          if (lastPosition > 0 && Number.isFinite(video.duration)) {
            video.currentTime = Math.min(lastPosition, Math.max(0, video.duration - 0.25));
          }
          attemptVideoPlay(token, item);
        };
        video.onplaying = function () {
          if (token !== generation) return;
          recovering = false;
          lastProgressAt = Date.now();
          report("playing", item, null);
          scheduleAdvance(token, item);
        };
        video.ontimeupdate = function () {
          if (token !== generation) return;
          if (video.currentTime > lastPosition) {
            lastPosition = video.currentTime;
            lastProgressAt = Date.now();
          }
        };
        video.onended = function () {
          finishItem(token, item);
        };
        video.onerror = function () {
          invalidateCachedMedia(item);
          recoverVideo(token, item, "MediaError");
        };
        function scheduleStallRecovery() {
          if (token !== generation || recovering) return;
          if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
          recoveryTimer = window.setTimeout(function () {
            if (token === generation && Date.now() - lastProgressAt >= 2000) {
              recoverVideo(token, item, "PlaybackStalled");
            }
          }, 2200);
        }
        video.onstalled = scheduleStallRecovery;
        video.onwaiting = scheduleStallRecovery;
        loadVideoSource(token, item);
      }

      function recoverImage(token, item, reason) {
        if (token !== generation) return;
        retryCount += 1;
        report("error", item, reason);
        if (retryCount > 2) {
          finishItem(token, item);
          return;
        }
        window.setTimeout(function () {
          if (token === generation) loadImageSource(token, item);
        }, 500 * retryCount);
      }

      function playImage(token, item) {
        video.pause();
        video.hidden = true;
        image.hidden = false;
        image.onload = function () {
          if (token !== generation) return;
          report("playing", item, null);
          scheduleAdvance(token, item);
        };
        image.onerror = function () {
          if (token !== generation) return;
          invalidateCachedMedia(item);
          recoverImage(token, item, "ImageLoadError");
        };
        loadImageSource(token, item);
      }

      function playCurrent() {
        clearTimers();
        resetElements();
        if (!playlist.enabled || !Array.isArray(playlist.items) || playlist.items.length === 0) {
          stopPlayback(true);
          return;
        }
        if (currentIndex >= playlist.items.length) currentIndex = 0;

        generation += 1;
        var token = generation;
        var item = playlist.items[currentIndex];
        retryCount = 0;
        recovering = false;
        lastPosition = 0;
        lastProgressAt = Date.now();
        itemDeadline = Date.now() + Math.max(1, Number(item.durationSeconds) || 10) * 1000;
        stopped = false;
        report("loading", item, null);
        if (item.type === "video") playVideo(token, item);
        else playImage(token, item);
      }

      function validPlaylistItem(item) {
        return (
          item &&
          typeof item.id === "string" &&
          /^media_[0-9]{13}_[a-f0-9]{8}$/.test(item.id) &&
          (item.type === "image" || item.type === "video") &&
          typeof item.url === "string" &&
          /^\\/media\\/media_[0-9]{13}_[a-f0-9]{8}$/.test(item.url) &&
          typeof item.fileName === "string" &&
          item.fileName.length > 0 &&
          item.fileName.length <= 120 &&
          item.fileName.trim() === item.fileName &&
          item.fileName !== "." &&
          item.fileName !== ".." &&
          item.fileName.indexOf("/") === -1 &&
          item.fileName.indexOf("\\\\") === -1 &&
          item.fileName.indexOf("\\0") === -1 &&
          typeof item.checksum === "string" &&
          /^[a-f0-9]{64}$/.test(item.checksum) &&
          Number.isInteger(item.durationSeconds) &&
          item.durationSeconds >= 1 &&
          item.durationSeconds <= 3600 &&
          typeof item.muted === "boolean"
        );
      }

      function validPlaylist(value) {
        return (
          value &&
          typeof value.enabled === "boolean" &&
          typeof value.loop === "boolean" &&
          Number.isInteger(value.revision) &&
          value.revision >= 0 &&
          Number.isInteger(value.updatedAt) &&
          value.updatedAt >= 0 &&
          Array.isArray(value.items) &&
          value.items.length <= 100 &&
          value.items.every(validPlaylistItem) &&
          new Set(value.items.map(function (item) { return item.id; })).size === value.items.length
        );
      }

      function playlistsEqual(left, right) {
        return (
          left.revision === right.revision &&
          left.enabled === right.enabled &&
          left.loop === right.loop &&
          JSON.stringify(left.items) === JSON.stringify(right.items)
        );
      }

      function persistVerifiedPlaylist(value, cacheInfo) {
        var serialized = JSON.stringify({
          version: 2,
          savedAt: Date.now(),
          playlist: value,
          cacheName: cacheInfo.cacheName,
          itemCount: cacheInfo.itemCount,
          totalBytes: cacheInfo.totalBytes
        });
        if (serialized.length > MAX_STORED_PLAYLIST_BYTES) {
          throw playerError("PlaylistStorageLimit");
        }
        window.localStorage.setItem(PLAYLIST_STORAGE_KEY, serialized);
        try {
          window.localStorage.removeItem(LEGACY_PLAYLIST_STORAGE_KEY);
        } catch (_error) {
          // The v2 record was committed; stale legacy cleanup is best effort.
        }
        delete stage.dataset.storageError;
      }

      function readStoredPlaylist() {
        try {
          var serialized = window.localStorage.getItem(PLAYLIST_STORAGE_KEY);
          if (!serialized) return null;
          if (serialized.length > MAX_STORED_PLAYLIST_BYTES) {
            window.localStorage.removeItem(PLAYLIST_STORAGE_KEY);
            markFailure("StoredPlaylistTooLarge");
            return null;
          }
          var stored = JSON.parse(serialized);
          if (
            !stored ||
            stored.version !== 2 ||
            !Number.isInteger(stored.savedAt) ||
            !validPlaylist(stored.playlist) ||
            (stored.cacheName !== null && !safeCacheName(stored.cacheName)) ||
            !Number.isInteger(stored.itemCount) ||
            stored.itemCount < 0 ||
            stored.itemCount > MAX_CACHE_ITEMS ||
            !Number.isInteger(stored.totalBytes) ||
            stored.totalBytes < 0 ||
            stored.totalBytes > MAX_CACHE_BYTES
          ) {
            window.localStorage.removeItem(PLAYLIST_STORAGE_KEY);
            markFailure("StoredPlaylistInvalid");
            return null;
          }
          return stored;
        } catch (error) {
          markFailure(errorCode(error, "StoredPlaylistReadFailed"));
          return null;
        }
      }

      async function restoreVerifiedPlaylist() {
        var stored = readStoredPlaylist();
        if (stored === null) return;

        var verified;
        if (stored.playlist.enabled) {
          verified = await validateCachedPlaylist(stored.cacheName, stored.playlist, true);
          if (
            verified === null ||
            verified.itemCount !== stored.itemCount ||
            verified.totalBytes !== stored.totalBytes
          ) {
            window.localStorage.removeItem(PLAYLIST_STORAGE_KEY);
            if (safeCacheName(stored.cacheName) && "caches" in window) {
              await caches.delete(stored.cacheName);
            }
            markFailure("StoredPlaylistCacheInvalid");
            return;
          }
        } else {
          if (stored.cacheName !== null || stored.itemCount !== 0 || stored.totalBytes !== 0) {
            window.localStorage.removeItem(PLAYLIST_STORAGE_KEY);
            markFailure("StoredPlaylistCacheInvalid");
            return;
          }
          verified = { cacheName: null, itemCount: 0, totalBytes: 0 };
        }

        playlist = stored.playlist;
        activeCacheName = verified.cacheName;
        cacheVerified = true;
        currentIndex = 0;
        updateCacheStatus(verified);
        stage.dataset.playlistSource = "storage";
        if (playlist.enabled) playCurrent();
        else stopPlayback(false);
        try {
          await pruneInactiveCaches(activeCacheName);
        } catch (_error) {
          // Cache cleanup does not invalidate the verified active generation.
        }
      }

      async function activatePlaylist(next, cacheInfo) {
        var previousId =
          playlist.items[currentIndex] && typeof playlist.items[currentIndex].id === "string"
            ? playlist.items[currentIndex].id
            : null;
        try {
          persistVerifiedPlaylist(next, cacheInfo);
        } catch (error) {
          stage.dataset.storageError = errorCode(error, "PlaylistPersistFailed");
          if (cacheInfo.cacheName !== null && "caches" in window) {
            await caches.delete(cacheInfo.cacheName);
          }
          throw error;
        }

        playlist = next;
        activeCacheName = cacheInfo.cacheName;
        cacheVerified = true;
        var retainedIndex = previousId
          ? playlist.items.findIndex(function (item) { return item.id === previousId; })
          : -1;
        currentIndex = retainedIndex >= 0 ? retainedIndex : 0;
        updateCacheStatus(cacheInfo);
        stage.dataset.playlistSource = "network";
        clearFailure();
        if (playlist.enabled) playCurrent();
        else stopPlayback(true);
        pruneInactiveCaches(activeCacheName).catch(function (error) {
          stage.dataset.cacheCleanupError = errorCode(error, "CacheCleanupFailed");
        });
      }

      async function applyNetworkPlaylist(next) {
        if (playlistsEqual(next, playlist) && cacheVerified) {
          stage.dataset.playlistSource = "network";
          clearFailure();
          return;
        }
        if (activationInFlight !== null) return;

        activationInFlight = (async function () {
          var staged = await stageCompletePlaylist(next);
          await activatePlaylist(next, staged);
        })();
        try {
          await activationInFlight;
        } finally {
          activationInFlight = null;
        }
      }

      async function fetchPlaylist() {
        try {
          var response = await fetch("/api/v1/signage/playlist", {
            credentials: "same-origin",
            cache: "no-store"
          });
          if (!response.ok) {
            markFailure("PlaylistHTTP" + response.status.toString());
            return;
          }
          var envelope = await response.json();
          if (!envelope || envelope.ok !== true || !validPlaylist(envelope.data)) {
            markFailure("PlaylistResponseInvalid");
            return;
          }
          var next = envelope.data;
          await applyNetworkPlaylist(next);
        } catch (error) {
          markFailure(
            window.navigator && window.navigator.onLine === false
              ? "PlaylistOffline"
              : errorCode(error, "PlaylistFetchFailed")
          );
        }
      }

      var initialized = false;
      function requestPlaylistRefresh() {
        if (initialized) {
          sendPendingCompletion();
          fetchPlaylist();
        }
      }

      window.addEventListener("online", requestPlaylistRefresh);
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) requestPlaylistRefresh();
      });
      window.addEventListener("pagehide", function () {
        report("stopped", null, null);
        resetElements();
      });

      (async function initialize() {
        await restoreVerifiedPlaylist();
        initialized = true;
        await fetchPlaylist();
      })().catch(function (error) {
        initialized = true;
        markFailure(errorCode(error, "PlayerInitializationFailed"));
      });
      window.setInterval(requestPlaylistRefresh, 5000);
    })();
  </script>
</body>
</html>`;
}

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { renderSignagePlayer } from "./signage.js";

class MemoryCache {
  public readonly entries = new Map<string, Response>();

  private key(input: RequestInfo | URL): string {
    if (typeof input === "string") return new URL(input, window.location.origin).href;
    if (input instanceof URL) return input.href;
    return input.url;
  }

  public async match(input: RequestInfo | URL): Promise<Response | undefined> {
    return this.entries.get(this.key(input))?.clone();
  }

  public async put(input: RequestInfo | URL, response: Response): Promise<void> {
    this.entries.set(this.key(input), response.clone());
    await response.arrayBuffer();
  }

  public async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

class MemoryCacheStorage {
  public readonly stores = new Map<string, MemoryCache>();

  public async open(name: string): Promise<MemoryCache> {
    let cache = this.stores.get(name);
    if (cache === undefined) {
      cache = new MemoryCache();
      this.stores.set(name, cache);
    }
    return cache;
  }

  public async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }

  public async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }
}

afterEach(() => {
  window.localStorage.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("signage player cache transaction", () => {
  it("keeps the prior verified playlist when a downloaded item fails SHA-256 verification", async () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => "7f65a0cb-11b8-4d9e-a122-85b7610a82c1",
      subtle: {
        digest: async (_algorithm: AlgorithmIdentifier, data: BufferSource) =>
          Uint8Array.from(
            createHash("sha256")
              .update(Buffer.from(data as ArrayBuffer))
              .digest()
          ).buffer
      }
    } as unknown as Crypto);
    expect(window.crypto.subtle).toBeDefined();
    const caches = new MemoryCacheStorage();
    Object.defineProperty(window, "caches", {
      configurable: true,
      value: caches
    });
    Object.defineProperty(window.URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:verified-old-media")
    });
    Object.defineProperty(window.URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(window, "setInterval").mockImplementation(
      (() => 1) as unknown as typeof window.setInterval
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const oldBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const oldItem = {
      id: "media_1722222222222_a1b2c3d4",
      type: "image",
      url: "/media/media_1722222222222_a1b2c3d4",
      fileName: "verified.png",
      checksum: createHash("sha256").update(oldBytes).digest("hex"),
      durationSeconds: 10,
      muted: true
    };
    const oldPlaylist = {
      enabled: true,
      loop: true,
      items: [oldItem],
      revision: 1,
      updatedAt: 1722222222222
    };
    const oldCacheName = "roshanos-signage-media-v2-r1-verified";
    const oldCache = await caches.open(oldCacheName);
    await oldCache.put(
      oldItem.url,
      new Response(oldBytes, {
        status: 200,
        headers: {
          "content-length": oldBytes.byteLength.toString(),
          "content-type": "image/png"
        }
      })
    );
    const cachedBeforePlayer = await oldCache.match(oldItem.url);
    const cachedBeforePlayerBytes = await cachedBeforePlayer?.arrayBuffer();
    expect(
      createHash("sha256")
        .update(Buffer.from(cachedBeforePlayerBytes ?? new ArrayBuffer(0)))
        .digest("hex")
    ).toBe(oldItem.checksum);
    const browserDigest = await window.crypto.subtle.digest(
      "SHA-256",
      cachedBeforePlayerBytes ?? new ArrayBuffer(0)
    );
    expect(Buffer.from(browserDigest).toString("hex")).toBe(oldItem.checksum);
    const persisted = JSON.stringify({
      version: 2,
      savedAt: 1722222222222,
      playlist: oldPlaylist,
      cacheName: oldCacheName,
      itemCount: 1,
      totalBytes: oldBytes.byteLength
    });
    window.localStorage.setItem("roshanos.signage.playlist.v2", persisted);

    const nextItem = {
      ...oldItem,
      id: "media_1722222222223_b1c2d3e4",
      url: "/media/media_1722222222223_b1c2d3e4",
      fileName: "unavailable.png"
    };
    const nextPlaylist = {
      ...oldPlaylist,
      items: [nextItem],
      revision: 2,
      updatedAt: 1722222222223
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/v1/signage/playlist") {
          return new Response(JSON.stringify({ ok: true, data: nextPlaylist }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        if (url === nextItem.url) {
          const corruptBytes = new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9
          ]);
          return new Response(corruptBytes, {
            status: 200,
            headers: {
              "content-length": corruptBytes.byteLength.toString(),
              "content-type": "image/png"
            }
          });
        }
        if (url === "/api/v1/signage/playback" && init?.method === "POST") {
          return new Response(JSON.stringify({ ok: true, data: {} }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      })
    );

    const html = renderSignagePlayer();
    const script = html.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
    document.body.innerHTML =
      '<main id="stage"><img id="image" hidden><video id="video" hidden></video></main>';
    expect(script).toBeDefined();
    Function(script ?? "")();

    await vi.waitFor(() => {
      expect(document.getElementById("stage")?.dataset.error).toBe(
        "DownloadedMediaChecksumMismatch"
      );
    });
    expect(
      window.localStorage.getItem("roshanos.signage.playlist.v2"),
      JSON.stringify({
        dataset: document.getElementById("stage")?.dataset,
        warnings: warnSpy.mock.calls
      })
    ).toBe(persisted);
    expect(document.getElementById("stage")?.dataset.playlistSource).toBe("storage");
    expect(document.getElementById("image")?.getAttribute("src")).toBe("blob:verified-old-media");
    expect(await caches.keys()).toEqual([oldCacheName]);
  });

  it("calls the protected completion capability after the final non-loop item", async () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => "3d6429c5-42f8-46d5-a7e3-93c3f7f1fe91",
      subtle: {
        digest: async (_algorithm: AlgorithmIdentifier, data: BufferSource) =>
          Uint8Array.from(
            createHash("sha256")
              .update(Buffer.from(data as ArrayBuffer))
              .digest()
          ).buffer
      }
    } as unknown as Crypto);
    const caches = new MemoryCacheStorage();
    Object.defineProperty(window, "caches", {
      configurable: true,
      value: caches
    });
    Object.defineProperty(window.URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:verified-final-media")
    });
    Object.defineProperty(window.URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(window, "setInterval").mockImplementation(
      (() => 1) as unknown as typeof window.setInterval
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 3, 2, 1]);
    const item = {
      id: "media_1722222222224_c1d2e3f4",
      type: "image",
      url: "/media/media_1722222222224_c1d2e3f4",
      fileName: "final.png",
      checksum: createHash("sha256").update(bytes).digest("hex"),
      durationSeconds: 1,
      muted: true
    };
    const playlist = {
      enabled: true,
      loop: false,
      items: [item],
      revision: 7,
      updatedAt: 1722222222224
    };
    const completions: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/v1/signage/playlist") {
          return new Response(JSON.stringify({ ok: true, data: playlist }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        if (url === item.url) {
          return new Response(bytes, {
            status: 200,
            headers: {
              "content-length": bytes.byteLength.toString(),
              "content-type": "image/png"
            }
          });
        }
        if (url === "/api/v1/signage/playback" && init?.method === "POST") {
          return Response.json({ ok: true, data: {} });
        }
        if (url === "/api/v1/signage/completion" && init?.method === "POST") {
          completions.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return Response.json({ ok: true, data: {} });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      })
    );

    const html = renderSignagePlayer();
    const script = html.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
    document.body.innerHTML =
      '<main id="stage"><img id="image" hidden><video id="video" hidden></video></main>';
    Function(script ?? "")();

    await vi.waitFor(() => {
      expect(document.getElementById("image")?.getAttribute("src")).toBe(
        "blob:verified-final-media"
      );
    });
    document.getElementById("image")?.dispatchEvent(new Event("load"));

    await vi.waitFor(
      () => {
        expect(completions).toEqual([
          {
            playerId: "3d6429c5-42f8-46d5-a7e3-93c3f7f1fe91",
            playlistRevision: 7,
            itemId: item.id
          }
        ]);
      },
      { timeout: 2500 }
    );
    expect((document.getElementById("image") as HTMLImageElement | null)?.hidden).toBe(true);
  });
});

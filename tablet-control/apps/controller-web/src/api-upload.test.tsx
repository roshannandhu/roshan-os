import { afterEach, describe, expect, it, vi } from "vitest";
import { ControllerApi } from "./api";

const uploadedItem = {
  id: "media_1722222222222_a1b2c3d4",
  title: "welcome.png",
  type: "image" as const,
  fileName: "welcome.png",
  mimeType: "image/png" as const,
  sizeBytes: 12,
  durationSeconds: 10,
  url: "/media/media_1722222222222_a1b2c3d4",
  createdAt: 1722222222222,
  checksum: "a".repeat(64)
};

class UploadRequest extends EventTarget {
  public static last: UploadRequest | undefined;
  public readonly upload = new EventTarget();
  public readonly headers = new Map<string, string>();
  public method = "";
  public url = "";
  public body: Document | XMLHttpRequestBodyInit | null = null;
  public status = 200;
  public responseText = JSON.stringify({ ok: true, data: uploadedItem });
  public timeout = 0;
  public withCredentials = false;

  public constructor() {
    super();
    UploadRequest.last = this;
  }

  public open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  public setRequestHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  public getResponseHeader(): string | null {
    return null;
  }

  public send(body: Document | XMLHttpRequestBodyInit | null): void {
    this.body = body;
    queueMicrotask(() => {
      this.upload.dispatchEvent(
        new ProgressEvent("progress", {
          lengthComputable: true,
          loaded: 5,
          total: 10
        })
      );
      this.dispatchEvent(new Event("load"));
    });
  }
}

afterEach(() => {
  UploadRequest.last = undefined;
  vi.unstubAllGlobals();
});

describe("signage multipart upload", () => {
  it("sends raw multipart data with CSRF and reports browser upload progress", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              data: {
                username: "admin",
                csrfToken: "csrf-for-upload",
                expiresAt: Date.now() + 60_000,
                mode: "mock"
              }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );
    vi.stubGlobal("XMLHttpRequest", UploadRequest as unknown as typeof XMLHttpRequest);
    const readAsDataUrl = vi.spyOn(FileReader.prototype, "readAsDataURL");
    const api = new ControllerApi();
    await api.login("admin", "test-only-password");
    const file = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])],
      "welcome.png",
      { type: "image/png" }
    );
    const progress: number[] = [];

    const result = await api.uploadMedia(file, 10, (percent) => progress.push(percent));
    const request = UploadRequest.last;

    expect(result).toEqual(uploadedItem);
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("/api/v1/media/items");
    expect(request?.withCredentials).toBe(true);
    expect(request?.timeout).toBe(300_000);
    expect(request?.headers.get("x-csrf-token")).toBe("csrf-for-upload");
    expect(request?.headers.has("content-type")).toBe(false);
    expect(request?.body).toBeInstanceOf(FormData);
    const form = request?.body as FormData;
    expect(form.get("durationSeconds")).toBe("10");
    expect((form.get("file") as File).name).toBe("welcome.png");
    expect((form.get("file") as File).size).toBe(file.size);
    expect(progress).toEqual([50, 100]);
    expect(readAsDataUrl).not.toHaveBeenCalled();
  });

  it("uses multipart upload followed by a media-id display command without base64 JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          data: {
            username: "admin",
            csrfToken: "csrf-for-display",
            expiresAt: Date.now() + 60_000,
            mode: "mock"
          }
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          data: { simulated: false, message: "Media displayed." }
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("XMLHttpRequest", UploadRequest as unknown as typeof XMLHttpRequest);
    const readAsDataUrl = vi.spyOn(FileReader.prototype, "readAsDataURL");
    const api = new ControllerApi();
    await api.login("admin", "test-only-password");
    const file = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])],
      "welcome.png",
      { type: "image/png" }
    );

    await expect(api.showMedia("image", file, 30, true)).resolves.toEqual({
      simulated: false,
      message: "Media displayed."
    });
    expect(UploadRequest.last?.url).toBe("/api/v1/media/items");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/display/media",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          mediaId: uploadedItem.id,
          durationSeconds: 30,
          restoreDashboard: true
        })
      })
    );
    expect(String(fetchMock.mock.calls[1]?.[1]?.body)).not.toContain("data:");
    expect(readAsDataUrl).not.toHaveBeenCalled();
  });
});

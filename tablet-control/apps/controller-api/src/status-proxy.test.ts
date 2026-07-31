import { describe, expect, it } from "vitest";
import { ReadOnlyIpWebcamAdapter } from "./adapters/readonly-ip-webcam.js";
import type { IpWebcamReadOnlyConfig } from "./config.js";
import { ApiProblem } from "./errors.js";

const BASE_URL = new URL("http://10.0.0.1:8080");
const BASE_CONFIG: IpWebcamReadOnlyConfig = {
  baseUrl: BASE_URL,
  transport: "trusted-lan",
  requestTimeoutMs: 2_000,
  maxReconnectAttempts: 3
};

function makeFetchReturning(
  body: string,
  options: { status?: number; contentType?: string; keepOpen?: boolean } = {}
): typeof fetch {
  const { status = 200, contentType = "application/json", keepOpen = false } = options;

  return async (_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;

    const encoder = new TextEncoder();
    const encoded = encoder.encode(body);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
        if (!keepOpen) {
          controller.close();
        } else {
          // Never close — simulate IP Webcam's non-closing connection
          signal?.addEventListener("abort", () => controller.close());
        }
      }
    });

    return new Response(stream, {
      status,
      headers: { "content-type": contentType }
    });
  };
}

function minimalStatusJson(): string {
  return JSON.stringify({
    curvals: {
      zoom: "100",
      quality: "65",
      video_size: "1280x720",
      ffc: "off",
      focusmode: "continuous-video",
      frame_duration: "33333333"
    }
  });
}

describe("ReadOnlyIpWebcamAdapter.getStatus — bounded JSON reader", () => {
  it("parses status JSON from a cleanly-closed connection", async () => {
    const adapter = new ReadOnlyIpWebcamAdapter(
      BASE_CONFIG,
      makeFetchReturning(minimalStatusJson())
    );
    const status = await adapter.getStatus();
    expect(status.healthy).toBe(true);
    expect(status.zoom).toBe(1);
    expect(status.quality).toBe(65);
    expect(status.resolution).toBe("1280x720");
  });

  it("parses status JSON from a non-closing connection (IP Webcam behavior)", async () => {
    const adapter = new ReadOnlyIpWebcamAdapter(
      { ...BASE_CONFIG, requestTimeoutMs: 500 },
      makeFetchReturning(minimalStatusJson(), { keepOpen: true })
    );
    const status = await adapter.getStatus();
    expect(status.healthy).toBe(true);
    expect(status.zoom).toBe(1);
  }, 2_000);

  it("throws UNAUTHENTICATED on 401", async () => {
    const adapter = new ReadOnlyIpWebcamAdapter(
      BASE_CONFIG,
      makeFetchReturning("Unauthorized", { status: 401 })
    );
    await expect(adapter.getStatus()).rejects.toSatisfy(
      (e) =>
        e instanceof ApiProblem &&
        e.statusCode === 401 &&
        e.response.error.code === "UNAUTHENTICATED"
    );
  });

  it("throws CAMERA_OFFLINE when fetch throws (connection refused)", async () => {
    const adapter = new ReadOnlyIpWebcamAdapter(BASE_CONFIG, async () => {
      throw new TypeError("fetch failed");
    });
    await expect(adapter.getStatus()).rejects.toSatisfy(
      (e) => e instanceof ApiProblem && e.response.error.code === "CAMERA_OFFLINE"
    );
  });

  it("throws TIMEOUT when request takes too long", async () => {
    const adapter = new ReadOnlyIpWebcamAdapter(
      { ...BASE_CONFIG, requestTimeoutMs: 50 },
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        });
        throw new DOMException("Aborted", "AbortError");
      }
    );
    await expect(adapter.getStatus()).rejects.toSatisfy(
      (e) => e instanceof ApiProblem && e.response.error.code === "TIMEOUT"
    );
  }, 1_000);

  it("throws MALFORMED_RESPONSE for invalid JSON body", async () => {
    const adapter = new ReadOnlyIpWebcamAdapter(
      BASE_CONFIG,
      makeFetchReturning("not valid json at all!!!")
    );
    await expect(adapter.getStatus()).rejects.toSatisfy(
      (e) => e instanceof ApiProblem && e.response.error.code === "MALFORMED_RESPONSE"
    );
  });

  it("throws MALFORMED_RESPONSE when body exceeds size limit", async () => {
    const huge = "x".repeat(70_000);
    const adapter = new ReadOnlyIpWebcamAdapter(BASE_CONFIG, makeFetchReturning(huge));
    await expect(adapter.getStatus()).rejects.toSatisfy(
      (e) => e instanceof ApiProblem && e.response.error.code === "MALFORMED_RESPONSE"
    );
  });

  it("throws MALFORMED_RESPONSE for wrong content-type", async () => {
    const adapter = new ReadOnlyIpWebcamAdapter(
      BASE_CONFIG,
      makeFetchReturning("<html>oops</html>", { contentType: "text/html" })
    );
    await expect(adapter.getStatus()).rejects.toSatisfy(
      (e) => e instanceof ApiProblem && e.response.error.code === "MALFORMED_RESPONSE"
    );
  });

  it("succeeds when JSON arrives in multiple chunks (non-closing connection)", async () => {
    const json = minimalStatusJson();
    const half = Math.floor(json.length / 2);
    const first = json.slice(0, half);
    const second = json.slice(half);

    const mockFetch: typeof fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(first));
          // Small delay between chunks
          await new Promise((r) => setTimeout(r, 10));
          controller.enqueue(encoder.encode(second));
          // Keep open — don't close (IP Webcam behavior)
          await new Promise<void>((_res, rej) => {
            signal?.addEventListener("abort", () => rej(new DOMException("abort", "AbortError")));
          });
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const adapter = new ReadOnlyIpWebcamAdapter(
      { ...BASE_CONFIG, requestTimeoutMs: 500 },
      mockFetch
    );
    const status = await adapter.getStatus();
    expect(status.zoom).toBe(1);
  }, 2_000);
});

describe("ReadOnlyIpWebcamAdapter.openReadOnlyStream — content-type validation", () => {
  it("throws STREAM_FAILURE when video content-type is wrong", async () => {
    const adapter = new ReadOnlyIpWebcamAdapter(
      BASE_CONFIG,
      makeFetchReturning("data", { contentType: "text/html" })
    );
    await expect(adapter.openReadOnlyStream("video")).rejects.toSatisfy(
      (e) => e instanceof ApiProblem && e.response.error.code === "STREAM_FAILURE"
    );
  });

  it("throws STREAM_FAILURE when audio content-type is wrong", async () => {
    const adapter = new ReadOnlyIpWebcamAdapter(
      BASE_CONFIG,
      makeFetchReturning("data", { contentType: "text/plain" })
    );
    await expect(adapter.openReadOnlyStream("audio")).rejects.toSatisfy(
      (e) => e instanceof ApiProblem && e.response.error.code === "STREAM_FAILURE"
    );
  });

  it("succeeds for video with correct multipart content-type", async () => {
    const stream = new ReadableStream<Uint8Array>({ start() {} });
    const mockFetch: typeof fetch = async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "multipart/x-mixed-replace;boundary=frame" }
      });
    const adapter = new ReadOnlyIpWebcamAdapter(BASE_CONFIG, mockFetch);
    const conn = await adapter.openReadOnlyStream("video");
    conn.cancel();
    expect(conn.diagnostics.kind).toBe("video");
  });

  it("succeeds for audio with audio/ content-type", async () => {
    const stream = new ReadableStream<Uint8Array>({ start() {} });
    const mockFetch: typeof fetch = async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "audio/wav" }
      });
    const adapter = new ReadOnlyIpWebcamAdapter(BASE_CONFIG, mockFetch);
    const conn = await adapter.openReadOnlyStream("audio");
    conn.cancel();
    expect(conn.diagnostics.kind).toBe("audio");
  });
});

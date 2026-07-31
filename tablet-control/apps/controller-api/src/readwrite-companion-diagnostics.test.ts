import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadWriteCompanionAdapter } from "./adapters/readwrite-companion.js";

const config = {
  baseUrl: "http://roshancore.invalid:8765",
  secret: "diagnostic-adapter-test-secret",
  requestTimeoutMs: 500,
  transport: "tailscale" as const
};

function diagnosticSnapshot() {
  return {
    schemaVersion: 1,
    generatedAtMs: 1_700_000_000_100,
    entryCount: 1,
    oldestSequence: 7,
    newestSequence: 7,
    limits: {
      maxEntries: 256,
      maxFileBytes: 128 * 1024,
      maxFieldsPerEntry: 8,
      maxFieldValueChars: 96
    },
    events: [
      {
        sequence: 7,
        timestampMs: 1_700_000_000_000,
        level: "warn",
        component: "supervisor",
        event: "service_degraded",
        fields: { service: "vpn", retry_attempt: "2" }
      }
    ]
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RoshanCore diagnostic adapter", () => {
  it("reads the bounded journal using the protected Companion credential", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: diagnosticSnapshot() }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new ReadWriteCompanionAdapter(config);

    await expect(adapter.getDiagnostics()).resolves.toMatchObject({
      entryCount: 1,
      events: [
        {
          sequence: 7,
          component: "supervisor",
          event: "service_degraded"
        }
      ]
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://roshancore.invalid:8765/api/v1/companion/diagnostics",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer diagnostic-adapter-test-secret"
        })
      })
    );
  });

  it("validates the upstream clear acknowledgement", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: true,
        data: { cleared: true, removedEntries: 4, remainingEntries: 0 }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new ReadWriteCompanionAdapter(config);

    await expect(adapter.clearDiagnostics()).resolves.toEqual({
      cleared: true,
      removedEntries: 4,
      remainingEntries: 0
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://roshancore.invalid:8765/api/v1/companion/diagnostics/clear",
      expect.objectContaining({
        method: "POST",
        body: "{}",
        headers: expect.objectContaining({
          authorization: "Bearer diagnostic-adapter-test-secret",
          "content-type": "application/json"
        })
      })
    );
  });

  it("rejects inconsistent or oversized diagnostic metadata", async () => {
    const malformed = {
      ...diagnosticSnapshot(),
      entryCount: 2
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true, data: malformed }))
    );
    const adapter = new ReadWriteCompanionAdapter(config);

    await expect(adapter.getDiagnostics()).rejects.toMatchObject({
      statusCode: 502,
      response: { error: { code: "MALFORMED_RESPONSE" } }
    });
  });
});

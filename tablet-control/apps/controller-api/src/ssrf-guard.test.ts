import { describe, expect, it, vi } from "vitest";
import { isPublicAddress, validateExternalUrl } from "./ssrf-guard.js";

const publicResolver = async () => [{ address: "1.1.1.1", family: 4 as const }];
const successfulProbe = async () => 200;

describe("external URL validation", () => {
  it.each([
    "0.0.0.1",
    "10.20.30.40",
    "100.64.1.2",
    "127.0.0.1",
    "169.254.169.254",
    "172.31.2.3",
    "192.168.40.10",
    "198.18.0.1",
    "224.0.0.1",
    "168.63.129.16",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fec0::1",
    "ff02::1"
  ])("classifies %s as non-public", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])("classifies %s as public", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    "http://localhost/",
    "http://api.localhost/",
    "http://tablet.local/",
    "http://metadata.google.internal/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "https://user:password@example.com/"
  ])("rejects local, metadata, or credential-bearing URL %s", async (url) => {
    const result = await validateExternalUrl(url, {
      resolveHostname: publicResolver,
      probe: successfulProbe
    });
    expect(result.valid).toBe(false);
  });

  it("rejects a hostname if any DNS answer is non-public", async () => {
    const probe = vi.fn(successfulProbe);
    const result = await validateExternalUrl("https://example.com/path", {
      resolveHostname: async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "10.0.0.5", family: 4 }
      ],
      probe
    });

    expect(result).toMatchObject({ valid: false });
    expect(probe).not.toHaveBeenCalled();
  });

  it("rejects redirecting targets without following the redirect", async () => {
    const probe = vi.fn(async () => 302);
    const result = await validateExternalUrl("https://example.com/start", {
      resolveHostname: publicResolver,
      probe
    });

    expect(result).toMatchObject({
      valid: false,
      error: "Redirecting webpage URLs are not permitted."
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("accepts a resolved public non-redirecting HTTP(S) URL", async () => {
    const probe = vi.fn(successfulProbe);
    const result = await validateExternalUrl("https://example.com/page?q=1", {
      resolveHostname: publicResolver,
      probe
    });

    expect(result.valid).toBe(true);
    expect(result.url?.toString()).toBe("https://example.com/page?q=1");
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ hostname: "example.com" }), {
      address: "1.1.1.1",
      family: 4
    });
  });
});

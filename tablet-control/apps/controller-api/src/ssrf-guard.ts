import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface ExternalUrlValidationOptions {
  resolveHostname?: (hostname: string) => Promise<ResolvedAddress[]>;
  probe?: (url: URL, address: ResolvedAddress) => Promise<number>;
}

export interface ExternalUrlValidationResult {
  valid: boolean;
  error?: string;
  url?: URL;
}

const BLOCKED_METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "169.254.169.254",
  "100.100.100.200",
  "168.63.129.16"
]);

function parseIpv4(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => Number(part));
  if (
    octets.some(
      (octet, index) =>
        !Number.isInteger(octet) || octet < 0 || octet > 255 || String(octet) !== parts[index]
    )
  ) {
    return undefined;
  }
  return (((octets[0]! << 24) >>> 0) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
}

function ipv4InCidr(value: number, base: number, prefix: number): boolean {
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (base & mask) >>> 0;
}

function isBlockedIpv4(address: string): boolean {
  const value = parseIpv4(address);
  if (value === undefined) return true;

  const blockedCidrs: readonly [string, number][] = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4]
  ];

  if (address === "168.63.129.16") return true;
  return blockedCidrs.some(([base, prefix]) => {
    const parsedBase = parseIpv4(base);
    return parsedBase !== undefined && ipv4InCidr(value, parsedBase, prefix);
  });
}

function parseIpv6(address: string): bigint | undefined {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === undefined || normalized.length === 0) return undefined;
  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;

  const parseSide = (side: string): number[] | undefined => {
    if (side.length === 0) return [];
    const values: number[] = [];
    for (const part of side.split(":")) {
      if (part.includes(".")) {
        const ipv4 = parseIpv4(part);
        if (ipv4 === undefined) return undefined;
        values.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/u.test(part)) return undefined;
      values.push(Number.parseInt(part, 16));
    }
    return values;
  };

  const left = parseSide(halves[0] ?? "");
  const right = parseSide(halves[1] ?? "");
  if (left === undefined || right === undefined) return undefined;
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || omitted < 0) return undefined;
  const groups = [...left, ...Array.from({ length: omitted }, () => 0), ...right];
  if (groups.length !== 8) return undefined;

  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

function ipv6InCidr(value: bigint, base: bigint, prefix: number): boolean {
  if (prefix === 0) return true;
  const shift = BigInt(128 - prefix);
  return value >> shift === base >> shift;
}

function isBlockedIpv6(address: string): boolean {
  const value = parseIpv6(address);
  if (value === undefined) return true;

  const mappedPrefix = parseIpv6("::ffff:0:0");
  if (mappedPrefix !== undefined && ipv6InCidr(value, mappedPrefix, 96)) {
    const ipv4 = Number(value & 0xffffffffn);
    return isBlockedIpv4(
      `${(ipv4 >>> 24) & 255}.${(ipv4 >>> 16) & 255}.${(ipv4 >>> 8) & 255}.${ipv4 & 255}`
    );
  }
  const compatiblePrefix = parseIpv6("::");
  const nat64Prefix = parseIpv6("64:ff9b::");
  if (
    (compatiblePrefix !== undefined && ipv6InCidr(value, compatiblePrefix, 96)) ||
    (nat64Prefix !== undefined && ipv6InCidr(value, nat64Prefix, 96))
  ) {
    const ipv4 = Number(value & 0xffffffffn);
    if (
      isBlockedIpv4(
        `${(ipv4 >>> 24) & 255}.${(ipv4 >>> 16) & 255}.${(ipv4 >>> 8) & 255}.${ipv4 & 255}`
      )
    ) {
      return true;
    }
  }

  const blockedCidrs: readonly [string, number][] = [
    ["::", 128],
    ["::1", 128],
    ["100::", 64],
    ["64:ff9b:1::", 48],
    ["2001::", 32],
    ["2001:2::", 48],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8]
  ];
  return blockedCidrs.some(([base, prefix]) => {
    const parsedBase = parseIpv6(base);
    return parsedBase !== undefined && ipv6InCidr(value, parsedBase, prefix);
  });
}

export function isPublicAddress(address: string): boolean {
  const normalized =
    address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const family = net.isIP(normalized);
  if (family === 4) return !isBlockedIpv4(normalized);
  if (family === 6) return !isBlockedIpv6(normalized);
  return false;
}

async function resolvePublicHostname(hostname: string): Promise<ResolvedAddress[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records
    .filter((record): record is ResolvedAddress => record.family === 4 || record.family === 6)
    .map((record) => ({ address: record.address, family: record.family }));
}

async function probeWithoutRedirect(url: URL, address: ResolvedAddress): Promise<number> {
  const client = url.protocol === "https:" ? https : http;
  return new Promise<number>((resolve, reject) => {
    const request = client.request(
      {
        protocol: url.protocol,
        hostname: address.address,
        family: address.family,
        port: url.port.length > 0 ? Number(url.port) : undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          host: url.host,
          range: "bytes=0-0",
          accept: "text/html,application/xhtml+xml",
          "user-agent": "RoshanOS-URL-Validator/1.0"
        },
        servername: url.protocol === "https:" ? url.hostname : undefined,
        rejectUnauthorized: true
      },
      (response) => {
        const status = response.statusCode ?? 0;
        response.destroy();
        resolve(status);
      }
    );
    request.setTimeout(4_000, () => {
      request.destroy(new Error("URL validation timed out."));
    });
    request.once("error", reject);
    request.end();
  });
}

export async function validateExternalUrl(
  urlString: string,
  options: ExternalUrlValidationOptions = {}
): Promise<ExternalUrlValidationResult> {
  if (!urlString || urlString.length > 2048) {
    return { valid: false, error: "URL length is invalid." };
  }

  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { valid: false, error: "URL string is invalid." };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { valid: false, error: "Only HTTP and HTTPS protocols are permitted." };
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { valid: false, error: "Embedded credentials in URLs are forbidden." };
  }

  const hostname = parsed.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/u, "")
    .toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    BLOCKED_METADATA_HOSTS.has(hostname)
  ) {
    return { valid: false, error: "Local and metadata endpoints are forbidden." };
  }

  let addresses: ResolvedAddress[];
  if (net.isIP(hostname) !== 0) {
    addresses = [{ address: hostname, family: net.isIP(hostname) as 4 | 6 }];
  } else {
    try {
      addresses = await (options.resolveHostname ?? resolvePublicHostname)(hostname);
    } catch {
      return { valid: false, error: "The webpage hostname could not be resolved safely." };
    }
  }

  if (addresses.length === 0 || addresses.some((record) => !isPublicAddress(record.address))) {
    return {
      valid: false,
      error: "Private, loopback, link-local, carrier, and metadata addresses are forbidden."
    };
  }

  try {
    const status = await (options.probe ?? probeWithoutRedirect)(parsed, addresses[0]!);
    if (status >= 300 && status < 400) {
      return { valid: false, error: "Redirecting webpage URLs are not permitted." };
    }
    if (status <= 0) {
      return { valid: false, error: "The webpage could not be verified safely." };
    }
  } catch {
    return { valid: false, error: "The webpage could not be verified safely." };
  }

  return { valid: true, url: parsed };
}

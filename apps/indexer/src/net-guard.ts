import dns from "node:dns";
import net from "node:net";
import { Agent, type Response } from "undici";

/**
 * Outbound-request guards for URLs taken from third-party data (token metadata, directory avatars): the destination
 * must resolve only to publicly routable addresses, and bodies are read with a cap on decoded bytes.
 */

/** URL that must not be fetched at all (scheme, private host/address); not worth retrying. */
export class UnfetchableUriError extends Error {}

const PRIVATE = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  PRIVATE.addSubnet(addr, prefix, "ipv4");
}
for (const [addr, prefix] of [
  ["::", 127],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  PRIVATE.addSubnet(addr, prefix, "ipv6");
}

/** Loopback, RFC 1918, CGNAT, link-local (cloud metadata), ULA, multicast, reserved, and IPv4-mapped forms of those. */
export function isPrivateIp(ip: string): boolean {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (dotted) return PRIVATE.check(dotted[1]!, "ipv4");
  // Hex form of an IPv4-mapped address (`::ffff:7f00:1`). Not a BlockList subnet: that also matches every IPv4.
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return PRIVATE.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, "ipv4");
  }
  return PRIVATE.check(ip, net.isIPv6(ip) ? "ipv6" : "ipv4");
}

const PRIVATE_NAME = /(?:^|\.)(?:localhost|internal|local|lan|home\.arpa)$/i;

/**
 * Throws unless `url` is an allowed scheme and its host is not a private literal or an internal-looking name.
 * The resolved addresses are checked separately at connect time (`guardedLookup`).
 */
export function assertPublicUrl(url: URL, schemes: readonly string[] = ["http:", "https:"]): void {
  if (!schemes.includes(url.protocol)) throw new UnfetchableUriError(`unsupported URL scheme ${url.protocol}`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) ? isPrivateIp(host) : !host.includes(".") || PRIVATE_NAME.test(host.replace(/\.$/, ""))) {
    throw new UnfetchableUriError(`host ${url.hostname} is not publicly routable`);
  }
}

/** Every address `hostname` resolves to, or throws if any of them (or none) is publicly routable. */
export async function resolvePublic(hostname: string): Promise<dns.LookupAddress[]> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIPv6(host) ? 6 : 4 }] : await dns.promises.lookup(host, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) throw new UnfetchableUriError(`host ${hostname} is not publicly routable`);
  return addrs;
}

/**
 * `net.connect` lookup that vets every resolved address and hands the socket exactly those addresses, so the host
 * checked is the host connected to (no DNS-rebinding window).
 */
const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  resolvePublic(hostname).then(
    (addrs) => {
      if (options.all) callback(null, addrs);
      else callback(null, addrs[0]!.address, addrs[0]!.family);
    },
    (err: Error) => callback(err as NodeJS.ErrnoException, []),
  );
};

/** undici dispatcher whose connections only reach publicly routable addresses. */
export function guardedDispatcher(connectTimeoutMs: number): Agent {
  return new Agent({ connect: { lookup: guardedLookup, timeout: connectTimeoutMs } });
}

/** undici wraps connect errors (a guard rejection included) in TypeError("fetch failed"); surface the guard's. */
export function unwrapGuardError(err: unknown): unknown {
  return err instanceof Error && err.cause instanceof UnfetchableUriError ? err.cause : err;
}

export class BodyTooLargeError extends Error {}

/** The response body, cancelled once more than `maxBytes` decoded bytes arrive (Content-Length is only a hint). */
export async function readCapped(res: Response | globalThis.Response, maxBytes: number): Promise<Buffer> {
  if (Number(res.headers.get("content-length") ?? "0") > maxBytes) {
    await res.body?.cancel();
    throw new BodyTooLargeError(`body larger than ${maxBytes} bytes`);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError(`body larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

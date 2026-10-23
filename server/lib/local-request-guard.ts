import type { IncomingHttpHeaders } from "node:http";
import { BlockList, isIP } from "node:net";
import type { RequestHandler } from "express";

/*
 * Browser access is limited to the app and its development renderer. CLI and
 * Electron main-process fetches omit Origin, so those requests rely on the
 * loopback peer check; the Host check also blocks DNS rebinding in browsers.
 */
const tailnetAddresses = new BlockList();
tailnetAddresses.addSubnet("100.64.0.0", 10, "ipv4");
tailnetAddresses.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

export function parseTrustedTailscaleHosts(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((host) => host.trim().toLowerCase()).filter((host) => {
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1" &&
      (isIP(host) === 4 || /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(host));
  });
}

export function isTrustedLocalRequest(
  headers: IncomingHttpHeaders,
  serverPort: number,
  devClientPort?: number,
  remoteAddress?: string,
  trustedTailscaleHosts: readonly string[] = [],
  localAddress?: string
): boolean {
  const loopbackPeer = remoteAddress === undefined || isLoopbackAddress(remoteAddress);
  const tailscalePeer = remoteAddress !== undefined && localAddress !== undefined &&
    isTailscaleAddress(remoteAddress) && isTailscaleAddress(localAddress);
  if (!loopbackPeer && !tailscalePeer) return false;
  const host = singleHeader(headers.host);
  if (!host) return false;
  const localHost = isLoopbackAuthority(host, serverPort, devClientPort);
  const tailnetHost = isTrustedTailscaleAuthority(host, serverPort, trustedTailscaleHosts);
  if (!(loopbackPeer && localHost) && !(tailscalePeer && tailnetHost)) return false;

  const origin = singleHeader(headers.origin);
  if (headers.origin !== undefined && !origin) return false;
  if (origin) {
    const originHosts = tailnetHost
      ? [new URL(`http://${host}`).hostname]
      : ["localhost", "127.0.0.1", "[::1]", ...trustedTailscaleHosts];
    const allowed = new Set<string>();
    for (const name of originHosts) {
      allowed.add(`http://${name}:${serverPort}`);
      if (devClientPort !== undefined) allowed.add(`http://${name}:${devClientPort}`);
    }
    return allowed.has(origin);
  }

  // Fetch Metadata covers browser requests that omit Origin (images, links, etc.).
  const site = singleHeader(headers["sec-fetch-site"]);
  return site !== "cross-site" && site !== "same-site";
}

export function localApiGuard(serverPort: () => number, devClientPort?: number, trustedTailscaleHosts: readonly string[] = []): RequestHandler {
  return (req, res, next) => {
    const trusted = req.socket.remoteAddress !== undefined &&
      isTrustedLocalRequest(req.headers, serverPort(), devClientPort, req.socket.remoteAddress, trustedTailscaleHosts, req.socket.localAddress);
    if (!trusted) {
      res.status(403).json({ error: "Request origin is not allowed" });
      return;
    }
    next();
  };
}

function isLoopbackAddress(address: string): boolean {
  return address === "::1" || address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

function isTailscaleAddress(address: string): boolean {
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
  const family = isIP(normalized);
  return family !== 0 && tailnetAddresses.check(normalized, family === 4 ? "ipv4" : "ipv6");
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isLoopbackAuthority(authority: string, serverPort: number, devClientPort?: number): boolean {
  try {
    const url = new URL(`http://${authority}`);
    return (
      url.host === authority &&
      (url.port === String(serverPort) || url.port === String(devClientPort)) &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function isTrustedTailscaleAuthority(authority: string, serverPort: number, hosts: readonly string[]): boolean {
  try {
    const url = new URL(`http://${authority}`);
    return url.host === authority &&
      url.port === String(serverPort) &&
      hosts.includes(url.hostname);
  } catch {
    return false;
  }
}

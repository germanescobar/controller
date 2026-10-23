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

export function isTrustedLocalRequest(
  headers: IncomingHttpHeaders,
  serverPort: number,
  devClientPort?: number,
  remoteAddress?: string,
  localAddress?: string
): boolean {
  const loopbackPeer = remoteAddress === undefined || isLoopbackAddress(remoteAddress);
  const tailscalePeer = remoteAddress !== undefined && localAddress !== undefined &&
    isTailscaleAddress(remoteAddress) && isTailscaleAddress(localAddress);
  if (!loopbackPeer && !tailscalePeer) return false;
  const host = singleHeader(headers.host);
  if (!host) return false;
  const localHost = isLoopbackAuthority(host, serverPort, devClientPort);
  const tailnetHost = tailscalePeer && isTrustedTailscaleAuthority(host, serverPort, localAddress!);
  if (!(loopbackPeer && localHost) && !(tailscalePeer && tailnetHost)) return false;

  const origin = singleHeader(headers.origin);
  if (headers.origin !== undefined && !origin) return false;
  if (origin) {
    if (tailnetHost) {
      const name = new URL(`http://${host}`).hostname;
      return origin === `http://${name}:${serverPort}` ||
        (devClientPort !== undefined && origin === `http://${name}:${devClientPort}`);
    }
    const localOrigins = ["localhost", "127.0.0.1", "[::1]"];
    for (const name of localOrigins) {
      if (origin === `http://${name}:${serverPort}` ||
        (devClientPort !== undefined && origin === `http://${name}:${devClientPort}`)) return true;
    }
    // Vite proxies browser API requests over loopback and preserves Origin.
    return devClientPort !== undefined && isTailnetOrigin(origin, devClientPort);
  }

  // Fetch Metadata covers browser requests that omit Origin (images, links, etc.).
  const site = singleHeader(headers["sec-fetch-site"]);
  return site !== "cross-site" && site !== "same-site";
}

export function localApiGuard(serverPort: () => number, devClientPort?: number): RequestHandler {
  return (req, res, next) => {
    const trusted = req.socket.remoteAddress !== undefined &&
      isTrustedLocalRequest(req.headers, serverPort(), devClientPort, req.socket.remoteAddress, req.socket.localAddress);
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

function isTrustedTailscaleAuthority(authority: string, serverPort: number, localAddress: string): boolean {
  try {
    const url = new URL(`http://${authority}`);
    return url.host === authority &&
      url.port === String(serverPort) &&
      isTailnetHostName(url.hostname, localAddress);
  } catch {
    return false;
  }
}

function isTailnetOrigin(origin: string, port: number): boolean {
  try {
    const url = new URL(origin);
    const name = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    return url.origin === origin && url.protocol === "http:" && url.port === String(port) &&
      (isTailnetHostName(url.hostname) || isTailscaleAddress(name));
  } catch {
    return false;
  }
}

function isTailnetHostName(name: string, localAddress?: string): boolean {
  if (name === "localhost" || name === "[::1]") return false;
  const normalized = name.startsWith("[") && name.endsWith("]") ? name.slice(1, -1) : name;
  if (isIP(normalized)) return localAddress !== undefined && normalized === localAddress.replace(/^::ffff:/, "");
  // MagicDNS short names and full *.ts.net names are private to a tailnet.
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name) ||
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+ts\.net$/.test(name);
}

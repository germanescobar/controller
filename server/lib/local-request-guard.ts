import type { IncomingHttpHeaders } from "node:http";
import type { RequestHandler } from "express";

/*
 * Browser access is limited to the app and its development renderer. CLI and
 * Electron main-process fetches omit Origin, so those requests rely on the
 * loopback peer check; the Host check also blocks DNS rebinding in browsers.
 */
export function isTrustedLocalRequest(
  headers: IncomingHttpHeaders,
  serverPort: number,
  devClientPort?: number,
  remoteAddress?: string
): boolean {
  if (remoteAddress !== undefined && !isLoopbackAddress(remoteAddress)) return false;
  const host = singleHeader(headers.host);
  if (!host || !isLoopbackAuthority(host, serverPort, devClientPort)) return false;

  const origin = singleHeader(headers.origin);
  if (headers.origin !== undefined && !origin) return false;
  if (origin) {
    const allowed = new Set([
      `http://localhost:${serverPort}`,
      `http://127.0.0.1:${serverPort}`,
      `http://[::1]:${serverPort}`,
    ]);
    if (devClientPort !== undefined) {
      allowed.add(`http://localhost:${devClientPort}`);
      allowed.add(`http://127.0.0.1:${devClientPort}`);
      allowed.add(`http://[::1]:${devClientPort}`);
    }
    if (!allowed.has(origin)) return false;
  }

  // Fetch Metadata covers browser GETs that omit Origin (images, links, etc.).
  const site = singleHeader(headers["sec-fetch-site"]);
  return site !== "cross-site" && site !== "same-site";
}

export function localApiGuard(serverPort: () => number, devClientPort?: number): RequestHandler {
  return (req, res, next) => {
    const trusted = req.socket.remoteAddress !== undefined &&
      isTrustedLocalRequest(req.headers, serverPort(), devClientPort, req.socket.remoteAddress);
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

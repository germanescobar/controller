/* Verify the document and its entry assets through HTTP, including their bodies. */
export async function assertUiReady(url: string): Promise<void> {
  const base = new URL(url);
  const read = async (target: URL, contentType: string): Promise<string> => {
    const response = await fetch(target, { signal: AbortSignal.timeout(1000), cache: "no-store" });
    if (!response.ok || !response.headers.get("content-type")?.includes(contentType)) {
      throw new Error(`UI readiness failed: ${target.pathname} HTTP ${response.status}`);
    }
    const body = await response.text();
    if (!body.trim()) throw new Error(`UI readiness failed: ${target.pathname} is empty`);
    return body;
  };
  const html = await read(new URL("/", base), "text/html");
  const assets = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))["']/g)];
  if (!assets.some((match) => match[1].endsWith(".js"))) {
    throw new Error("UI readiness failed: no JavaScript entry asset");
  }
  for (const [, asset] of assets) {
    const target = new URL(asset, base);
    if (target.origin !== base.origin) throw new Error("UI readiness failed: external entry asset");
    await read(target, asset.endsWith(".css") ? "text/css" : "javascript");
  }
}

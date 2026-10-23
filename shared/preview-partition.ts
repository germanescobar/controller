/** A reversible Electron session name using only letters, digits, and hyphens. */
export function previewPartitionForKey(browserKey: string): string {
  if (!browserKey) throw new Error("Preview pane key must not be empty");
  const bytes = new TextEncoder().encode(browserKey);
  const encoded = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `controller-preview-${encoded}`;
}

/** Certificate policy owned by one preview partition. */
export class PreviewCertPolicy {
  private insecure = false;

  setInsecure(insecure: boolean): void {
    this.insecure = insecure;
  }

  verify(hostname: string): number {
    if (!this.insecure) return -3;
    const host = hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1"
      ? 0
      : -3;
  }
}

export interface CompletedPreviewRequest {
  resourceType: string;
  statusCode: number;
  url: string;
  webContentsId?: number;
  webContents?: { id: number };
}

export function completedPreviewRequest(details: CompletedPreviewRequest): {
  guestId: number;
  response: { url: string; statusCode: number } | null;
  failure: string | null;
} | null {
  const guestId = details.webContentsId ?? details.webContents?.id;
  if (guestId === undefined) return null;
  return {
    guestId,
    response: details.resourceType === "mainFrame"
      ? { url: details.url, statusCode: details.statusCode }
      : null,
    failure: details.statusCode >= 400 ? `HTTP ${details.statusCode}` : null,
  };
}

/** Decode Controller's persisted follow-up prefixes for the chat bubble. */
export function parseFollowUpMarker(text: string): {
  kind: "monitor" | "from";
  label: string;
  content: string;
  sourceUri: string | null;
} | null {
  const marker = /^\[\/(monitor|from): ([^\]]+)\]\s*/.exec(text);
  if (!marker) return null;
  const body = text.slice(marker[0].length);
  const source = marker[1] === "from" ? /^(controller:\/\/\S+)\s*/.exec(body) : null;
  return {
    kind: marker[1] === "monitor" ? "monitor" : "from",
    label: marker[2],
    content: source ? body.slice(source[0].length) : body,
    sourceUri: source?.[1] ?? null,
  };
}

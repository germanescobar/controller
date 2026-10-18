/** Decode Controller's persisted follow-up prefixes for the chat bubble. */
export function parseFollowUpMarker(text: string): {
  kind: "monitor" | "from";
  label: string;
  content: string;
  sourceUri: string | null;
} | null {
  const prefix = /^\[\/(monitor|from): /.exec(text);
  if (!prefix) return null;
  let end = prefix[0].length;
  while (end < text.length) {
    if (text[end] === "\\" && (text[end + 1] === "]" || text[end + 1] === "\\")) {
      end += 2;
    } else if (text[end] === "]" && /\s|$/.test(text[end + 1] ?? "")) {
      break;
    } else {
      end += 1;
    }
  }
  if (end === text.length) return null;
  const label = decodeLabel(text.slice(prefix[0].length, end));
  const body = text.slice(end + 1).trimStart();
  const source = prefix[1] === "from" ? /^(controller:\/\/\S+)(?:\s|$)/.exec(body) : null;

  if (prefix[1] === "from" && !source) {
    // Older unescaped titles may contain `] `; the URI identifies their
    // actual marker boundary without confusing a URI in the message body.
    const legacy = /^\[\/from: (.*)\] (controller:\/\/\S+)(?:\s|$)/.exec(text);
    if (legacy) {
      return {
        kind: "from",
        label: decodeLabel(legacy[1]),
        content: text.slice(legacy[0].length),
        sourceUri: legacy[2],
      };
    }
  }
  return {
    kind: prefix[1] === "monitor" ? "monitor" : "from",
    label,
    content: source ? body.slice(source[0].length).trimStart() : body,
    sourceUri: source?.[1] ?? null,
  };
}

function decodeLabel(label: string): string {
  return label.replace(/\\([\\\]])/g, "$1");
}

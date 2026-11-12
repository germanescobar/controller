import { useEffect, useState } from "react";

export function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed || !src) return <span>{alt || "Image"} (image unavailable)</span>;
  return <img src={src} alt={alt ?? ""} onError={() => setFailed(true)} />;
}


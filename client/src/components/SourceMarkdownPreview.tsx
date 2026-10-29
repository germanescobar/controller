import { Children, isValidElement, useEffect, useId, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";

interface SourceMarkdownPreviewProps {
  content: string;
  filePath: string;
  projectId: string;
  worktreeId?: string;
  onOpenFile: (path: string) => void;
}

export function resolveMarkdownFilePath(filePath: string, href: string): string | null {
  const pathname = href.split(/[?#]/, 1)[0];
  if (!pathname || pathname.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(pathname)) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const segments = decoded.startsWith("/") ? [] : filePath.split("/").slice(0, -1);
  for (const segment of decoded.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment && segment !== ".") segments.push(segment);
  }
  return `${filePath.startsWith("/") ? "/" : ""}${segments.filter(Boolean).join("/")}`;
}

export function SourceMarkdownPreview({
  content,
  filePath,
  projectId,
  worktreeId,
  onOpenFile,
}: SourceMarkdownPreviewProps) {
  const imageUrl = (src: string) => {
    const path = resolveMarkdownFilePath(filePath, src);
    if (!path) return src;
    const params = new URLSearchParams({ path, format: "image" });
    if (worktreeId) params.set("worktreeId", worktreeId);
    return `/api/projects/${encodeURIComponent(projectId)}/source?${params}`;
  };

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none break-words p-5 [&_img]:max-w-full">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSlug]}
        components={{
          pre: ({ children, node: _node, ...props }) => {
            const code = Children.toArray(children)[0];
            if (
              isValidElement<{ className?: string; children?: ReactNode }>(code) &&
              code.props.className?.split(/\s+/).includes("language-mermaid")
            ) {
              return <MermaidDiagram source={String(code.props.children ?? "").replace(/\n$/, "")} />;
            }
            return <pre {...props}>{children}</pre>;
          },
          a: ({ href, children, node: _node, ...props }) => {
            if (href?.startsWith("#")) {
              return <a href={href} {...props}>{children}</a>;
            }
            const localPath = href ? resolveMarkdownFilePath(filePath, href) : null;
            if (localPath) {
              return (
                <a href={href} {...props} onClick={(event) => {
                  event.preventDefault();
                  onOpenFile(localPath);
                }}>
                  {children}
                </a>
              );
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                {children}
              </a>
            );
          },
          img: ({ src, alt, node: _node, ...props }) => (
            <img src={src ? imageUrl(src) : undefined} alt={alt ?? ""} {...props} />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

interface DiagramResult {
  imageUrl?: string;
  error?: string;
}

// Mermaid has global configuration. Serialize renders so a theme change cannot
// reconfigure a diagram while another one is rendering.
let renderQueue: Promise<void> = Promise.resolve();

function renderDiagram(source: string, id: string, dark: boolean): Promise<string> {
  const render = async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      secure: [
        "secure", "securityLevel", "startOnLoad", "maxTextSize",
        "suppressErrorRendering", "maxEdges", "htmlLabels", "theme",
      ],
      htmlLabels: false,
      suppressErrorRendering: true,
      theme: dark ? "dark" : "default",
    });
    const { svg } = await mermaid.render(id, source);
    // SVG loaded as an image cannot execute scripts or navigate through links.
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  };
  const result = renderQueue.then(render);
  renderQueue = result.then(() => {}, () => {});
  return result;
}

function MermaidDiagram({ source }: { source: string }) {
  const id = `mermaid-${useId().replace(/:/g, "")}`;
  const [dark, setDark] = useState(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
  );
  const [result, setResult] = useState<DiagramResult>({});

  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains("dark"))
    );
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setResult({});
    void renderDiagram(source, id, dark).then(
      (imageUrl) => { if (!cancelled) setResult({ imageUrl }); },
      (error: unknown) => {
        if (!cancelled) setResult({ error: error instanceof Error ? error.message : "Unknown error" });
      },
    );
    return () => { cancelled = true; };
  }, [source, id, dark]);

  if (result.error) {
    return (
      <div role="alert" className="rounded border border-destructive p-3">
        <p>Could not render Mermaid diagram: {result.error}</p>
        <pre><code>{source}</code></pre>
      </div>
    );
  }
  if (!result.imageUrl) return <p role="status">Rendering Mermaid diagram…</p>;
  return <img src={result.imageUrl} alt="Mermaid diagram" className="max-w-full" />;
}

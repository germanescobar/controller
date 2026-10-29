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

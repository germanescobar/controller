import React, { useMemo, useState } from "react";
import {
  GitPullRequest,
  GitMerge,
  ExternalLink,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Clock,
  MinusCircle,
  CircleDashed,
  ChevronDown,
  ChevronRight,
  GitPullRequestDraft,
  CircleSlash,
  MessageSquare,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import type {
  PrAuthor,
  PrCheck,
  PrComment,
  PrReview,
  PullRequest,
} from "../api.ts";

/**
 * Read-only PR panel bound to the worktree's current branch (issue #387).
 *
 * Renders only when a PR exists. Mirrors the GitHub PR view at
 * sidebar scale: header (title / state / draft / review decision /
 * diff stats), CI checks (collapsible), description (markdown),
 * chronological timeline (comments + reviews, oldest-first), and a
 * persistent "Open on GitHub" footer. Every actionable item links
 * back to its canonical GitHub URL — actions like approving, replying,
 * or merging intentionally live elsewhere.
 *
 * The panel is purely presentational: `SessionView` owns polling and
 * keeps `pullRequest` fresh whenever the tab is visible, then renders
 * this component with the cached payload.
 */

interface PrPanelProps {
  /** Pull-request data to render. Pass `null` to render the
   *  "no PR for this branch" empty state. */
  pullRequest: PullRequest | null;
  /** Optional override for `Date.now()` in tests. */
  now?: () => number;
}

const NOW_FALLBACK: () => number = () => Date.now();

interface TimelineItem {
  kind: "comment" | "review";
  /** ISO timestamp — used for chronological sort. */
  at: string;
  /** Render discriminator — distinct per item kind. */
  id: string;
  data: PrComment | PrReview;
}

/**
 * `react-markdown` overrides for the PR panel.
 *
 * GitHub PR / comment / review bodies are arbitrary user markdown —
 * they often contain external links. The default anchor renderer
 * emits a same-window anchor; in the packaged Electron app only
 * `_blank` requests are forwarded to `shell.openExternal` (see
 * `electron/main.ts`), so a same-window click would navigate the
 * Controller renderer away from the app instead of opening the
 * browser. Force every link to `target="_blank"` so the
 * orchestration host takes over (issue #387 review feedback).
 *
 * Relative URLs (e.g., `docs/setup.md`) are rewritten against the
 * PR's canonical `/files/` view on GitHub so the browser doesn't
 * resolve them against the Controller origin. Absolute URLs,
 * fragments, mailto:, and protocol-relative links are left alone
 * (issue #387 review feedback).
 */
function prMarkdownAnchor(prUrl: string) {
  return function PrMarkdownAnchor(
    props: React.AnchorHTMLAttributes<HTMLAnchorElement>
  ) {
    const { href, children, ...rest } = props;
    const resolved = resolvePrRelativeLink(href, prUrl);
    return (
      <a
        href={resolved}
        target="_blank"
        rel="noopener noreferrer"
        {...rest}
      >
        {children}
      </a>
    );
  };
}

/**
 * Markdown image override — mirrors the anchor resolver so a
 * description like `![diagram](docs/diagram.png)` does not request
 * a relative path from the Controller renderer origin. We rewrite
 * repo-relative sources to the PR's `/files` overview (the safe
 * landing page for any file path) and root-relative sources to
 * the GitHub origin; absolute URLs and data: URIs pass through.
 * The image itself won't render if the file isn't in the PR's
 * diff, but the request will at least target a real GitHub URL
 * instead of 404-ing against the Controller renderer (issue #387
 * review feedback).
 */
function prMarkdownImage(prUrl: string) {
  return function PrMarkdownImage(
    props: React.ImgHTMLAttributes<HTMLImageElement>
  ) {
    const { src, alt, ...rest } = props;
    const resolved = resolvePrRelativeImageSrc(src, prUrl);
    return <img src={resolved} alt={alt ?? ""} loading="lazy" {...rest} />;
  };
}

/**
 * Same rewrite rules as `resolvePrRelativeLink`, but specialised
 * for image `src` attributes. Skips `data:` URIs and absolute
 * URLs (which are valid as-is).
 */
function resolvePrRelativeImageSrc(
  src: string | undefined,
  prUrl: string
): string | undefined {
  if (!src) return src;
  if (
    src.startsWith("http://") ||
    src.startsWith("https://") ||
    src.startsWith("data:") ||
    src.startsWith("//")
  ) {
    return src;
  }
  if (src.startsWith("/")) {
    const origin = extractGitHubOrigin(prUrl);
    return origin ? `${origin}${src}` : src;
  }
  // Repo-relative image source → point at the PR's `/files`
  // overview (no deep path; arbitrary repo-relative paths would
  // 404 on GitHub otherwise).
  const base = prUrl.endsWith("/") ? prUrl : `${prUrl}/`;
  return `${base}files`;
}

/**
 * Resolve a markdown link against the PR's GitHub context.
 *
 * Three classes of rewrites (issue #387 review feedback):
 *
 *   1. Fragment-only links (`[details](#details)`) — Electron
 *      resolves a bare `#anchor` against the Controller renderer
 *      origin and forwards that to the system browser instead of
 *      the PR. Merge onto the PR URL so the anchor lands on the
 *      PR page.
 *   2. Root-relative links (`[issue](/owner/repo/issues/1)`) —
 *      the browser resolves these against the Controller origin
 *      and opens a Controller URL rather than GitHub. Prepend the
 *      GitHub origin parsed from `prUrl`.
 *   3. Repo-relative file links (`[guide](docs/setup.md)`) — the
 *      PR's `/files/<path>` URL only addresses paths that already
 *      appear in the PR's diff; for an arbitrary relative file
 *      link, GitHub would 404. Send the user to the PR's `/files`
 *      overview instead, which lists every changed file and
 *      clearly indicates whether the linked file is part of the
 *      PR.
 */
function resolvePrRelativeLink(
  href: string | undefined,
  prUrl: string
): string | undefined {
  if (!href) return href;
  // Absolute URLs, protocol-relative URLs, and mailto: all resolve
  // to a real external host already; pass them through.
  if (
    href.startsWith("http://") ||
    href.startsWith("https://") ||
    href.startsWith("mailto:") ||
    href.startsWith("//")
  ) {
    return href;
  }
  if (href.startsWith("#")) {
    // `<prUrl>#anchor` — drop any trailing slash on the PR url so
    // the rendered form matches what GitHub copies to the
    // clipboard (no double-slash).
    const base = prUrl.endsWith("/") ? prUrl.slice(0, -1) : prUrl;
    return `${base}${href}`;
  }
  if (href.startsWith("/")) {
    // Root-relative — rebuild against the GitHub origin parsed
    // from the PR URL. `/issues/1` becomes
    // `https://github.com/issues/1`, etc.
    const origin = extractGitHubOrigin(prUrl);
    if (!origin) return href;
    return `${origin}${href}`;
  }
  // Repo-relative file link — point at the PR's `/files` overview
  // rather than fabricating a path under `/files/...` that won't
  // resolve for arbitrary file paths (issue #387 review feedback).
  const base = prUrl.endsWith("/") ? prUrl : `${prUrl}/`;
  return `${base}files`;
}

/**
 * Pull the GitHub origin (scheme + host + optional :port) out of a
 * PR URL like `https://github.com/foo/bar/pull/388`. Returns null
 * if the URL is malformed or doesn't look like a real GitHub host
 * — the caller then leaves the original href untouched.
 */
function extractGitHubOrigin(prUrl: string): string | null {
  try {
    const u = new URL(prUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Build the per-PR `react-markdown` overrides. Pulled into a
 * helper so the description, comment, and review bodies all share
 * the same link-rewriting + target=_blank logic without leaking
 * the `prUrl` closure into module scope.
 */
function buildPrMarkdownComponents(prUrl: string) {
  return { a: prMarkdownAnchor(prUrl), img: prMarkdownImage(prUrl) };
}

const RELATIVE_TIME_UNITS: Array<{ limit: number; divisor: number; suffix: string }> = [
  { limit: 60, divisor: 1, suffix: "s" },
  { limit: 60 * 60, divisor: 60, suffix: "m" },
  { limit: 60 * 60 * 24, divisor: 60 * 60, suffix: "h" },
  { limit: 60 * 60 * 24 * 30, divisor: 60 * 60 * 24, suffix: "d" },
  { limit: 60 * 60 * 24 * 365, divisor: 60 * 60 * 24 * 30, suffix: "mo" },
];

function relativeTime(iso: string, now: () => number): string {
  const diffMs = now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs)) return "";
  const elapsedSec = Math.max(0, Math.floor(diffMs / 1000));
  for (const { limit, divisor, suffix } of RELATIVE_TIME_UNITS) {
    if (elapsedSec < limit) {
      const value = Math.floor(elapsedSec / divisor);
      return `${value}${suffix}`;
    }
  }
  return `${Math.floor(elapsedSec / (60 * 60 * 24 * 365))}y`;
}

function isComment(item: TimelineItem): item is TimelineItem & { data: PrComment } {
  return item.kind === "comment";
}

function isReview(item: TimelineItem): item is TimelineItem & { data: PrReview } {
  return item.kind === "review";
}

function stateColorClasses(state: string): string {
  const upper = state.toUpperCase();
  if (upper === "OPEN") return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  if (upper === "MERGED") return "bg-violet-500/15 text-violet-300 border-violet-500/30";
  if (upper === "CLOSED") return "bg-red-500/15 text-red-300 border-red-500/30";
  return "bg-muted text-muted-foreground border-border";
}

function reviewDecisionLabel(decision: string): { label: string; classes: string } {
  const upper = decision.toUpperCase();
  if (upper === "APPROVED") {
    return {
      label: "Approved",
      classes: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    };
  }
  if (upper === "CHANGES_REQUESTED") {
    return {
      label: "Changes requested",
      classes: "bg-red-500/15 text-red-300 border-red-500/30",
    };
  }
  if (upper === "REVIEW_REQUIRED") {
    return {
      label: "Review required",
      classes: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    };
  }
  return {
    label: decision,
    classes: "bg-muted text-muted-foreground border-border",
  };
}

function checkIcon(state: string): React.ReactElement {
  const upper = state.toUpperCase();
  if (upper === "SUCCESS") return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
  if (upper === "FAILURE" || upper === "ERROR" || upper === "CANCELLED")
    return <XCircle className="h-3.5 w-3.5 text-red-400" />;
  if (upper === "ACTION_REQUIRED" || upper === "STALE")
    return <AlertCircle className="h-3.5 w-3.5 text-amber-400" />;
  if (
    upper === "PENDING" ||
    upper === "IN_PROGRESS" ||
    upper === "QUEUED" ||
    upper === "WAITING" ||
    upper === "REQUESTED" ||
    upper === "EXPECTED"
  )
    return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
  if (upper === "SKIPPED" || upper === "NEUTRAL")
    return <MinusCircle className="h-3.5 w-3.5 text-muted-foreground" />;
  return <CircleDashed className="h-3.5 w-3.5 text-muted-foreground" />;
}

function checkStateLabel(state: string): string {
  const upper = state.toUpperCase();
  if (upper === "SUCCESS") return "Passed";
  if (upper === "FAILURE" || upper === "ERROR") return "Failed";
  if (upper === "IN_PROGRESS") return "Running";
  return state.toLowerCase();
}

function reviewStateLabel(state: string): string {
  const upper = state.toUpperCase();
  if (upper === "APPROVED") return "Approved";
  if (upper === "CHANGES_REQUESTED") return "Changes requested";
  if (upper === "DISMISSED") return "Dismissed";
  if (upper === "PENDING") return "Pending";
  return "Commented";
}

function reviewStateClasses(state: string): string {
  const upper = state.toUpperCase();
  if (upper === "APPROVED")
    return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  if (upper === "CHANGES_REQUESTED")
    return "bg-red-500/15 text-red-300 border-red-500/30";
  if (upper === "PENDING")
    return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  if (upper === "DISMISSED")
    return "bg-muted text-muted-foreground border-border";
  return "bg-sky-500/15 text-sky-300 border-sky-500/30";
}

function buildTimeline(pr: PullRequest): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const c of pr.comments) {
    items.push({ kind: "comment", id: c.id, at: c.createdAt, data: c });
  }
  for (const r of pr.reviews) {
    items.push({ kind: "review", id: r.id, at: r.submittedAt, data: r });
  }
  // Oldest-first so the reading order matches the GitHub timeline.
  items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return items;
}

function AuthorLine({ author }: { author: PrAuthor }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {author.avatarUrl ? (
        <img
          src={author.avatarUrl}
          alt=""
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 rounded-full"
          loading="lazy"
        />
      ) : null}
      <span className="truncate font-medium text-foreground/90">
        {author.name || author.login || "unknown"}
      </span>
    </span>
  );
}

function PrCheckRow({ check, prUrl }: { check: PrCheck; prUrl: string }) {
  // The check's own `targetUrl` is the deep link to the run details
  // page; when `gh` doesn't supply one (some rollup entries), fall
  // back to the PR's overall `/checks` page so the row is still
  // clickable into GitHub (issue #387 review feedback).
  const href = check.targetUrl ?? `${prUrl}/checks`;
  return (
    <li className="flex min-w-0 items-center justify-between gap-2 py-1 text-xs">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="flex min-w-0 flex-1 items-center gap-1.5 truncate rounded px-1 py-0.5 transition-colors hover:bg-accent/30"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {checkIcon(check.state)}
          <span className="min-w-0 truncate text-foreground/90">{check.name}</span>
          {check.description ? (
            <span className="hidden truncate text-[10px] text-muted-foreground/70 md:inline">
              {check.description}
            </span>
          ) : null}
        </span>
      </a>
      <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">
        {checkStateLabel(check.state)}
      </span>
    </li>
  );
}

function TimelineComment({
  comment,
  now,
  prUrl,
}: {
  comment: PrComment;
  now: () => number;
  prUrl: string;
}) {
  return (
    <article className="space-y-1.5 border-l border-border/60 pl-3">
      <div className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5">
          <AuthorLine author={comment.author} />
          <span className="text-muted-foreground/70">
            commented {relativeTime(comment.createdAt, now)} ago
          </span>
        </span>
        <a
          href={comment.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground"
          title="Open comment on GitHub"
          aria-label="Open comment on GitHub"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      {comment.body ? (
        <div className="prose prose-invert prose-sm max-w-none break-words rounded-md border border-border/60 bg-background/40 px-2.5 py-1.5 text-xs leading-5">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={buildPrMarkdownComponents(prUrl)}
          >
            {comment.body}
          </ReactMarkdown>
        </div>
      ) : null}
    </article>
  );
}

function TimelineReview({
  review,
  now,
  prUrl,
}: {
  review: PrReview;
  now: () => number;
  prUrl: string;
}) {
  const decision = reviewStateLabel(review.state);
  const classes = reviewStateClasses(review.state);
  return (
    <article className="space-y-1.5 border-l border-border/60 pl-3">
      <div className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5">
          <AuthorLine author={review.author} />
          <span className="text-muted-foreground/70">
            reviewed {relativeTime(review.submittedAt, now)} ago
          </span>
          <Badge variant="outline" className={`border ${classes} text-[10px] font-medium`}>
            {decision}
          </Badge>
        </span>
        {review.url ? (
          <a
            href={review.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground"
            title="Open review on GitHub"
            aria-label="Open review on GitHub"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          // `gh pr view --json reviews` does not emit a per-review
          // URL — only the parent PR + comment URLs — so the
          // "open on GitHub" affordance is omitted rather than
          // fabricated (issue #387 review feedback).
          <span
            aria-hidden="true"
            className="inline-block h-5 w-5 shrink-0"
          />
        )}
      </div>
      {review.body ? (
        <div className="prose prose-invert prose-sm max-w-none break-words rounded-md border border-border/60 bg-background/40 px-2.5 py-1.5 text-xs leading-5">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={buildPrMarkdownComponents(prUrl)}
          >
            {review.body}
          </ReactMarkdown>
        </div>
      ) : null}
    </article>
  );
}

function Timeline({
  items,
  now,
  prUrl,
}: {
  items: TimelineItem[];
  now: () => number;
  prUrl: string;
}) {
  if (items.length === 0) {
    return (
      <div className="flex items-center gap-1.5 px-1 py-2 text-[11px] text-muted-foreground/60">
        <CircleSlash className="h-3 w-3" />
        No conversation yet.
      </div>
    );
  }
  return (
    <ol className="space-y-3">
      {items.map((item) => (
        <li key={`${item.kind}:${item.id}`}>
          {isComment(item) ? (
            <TimelineComment comment={item.data} now={now} prUrl={prUrl} />
          ) : null}
          {isReview(item) ? (
            <TimelineReview review={item.data} now={now} prUrl={prUrl} />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function mergeableLabel(value: string): { label: string; tone: "ok" | "warn" | "muted" } {
  const upper = value.toUpperCase();
  if (upper === "MERGEABLE") return { label: "Mergeable", tone: "ok" };
  if (upper === "CONFLICTING") return { label: "Has conflicts", tone: "warn" };
  return { label: "Unknown", tone: "muted" };
}

function StatusIcon({ pr }: { pr: PullRequest }) {
  if (pr.state === "MERGED") {
    return <GitMerge className="h-3.5 w-3.5 text-violet-300" aria-hidden="true" />;
  }
  if (pr.state === "CLOSED") {
    return <GitPullRequest className="h-3.5 w-3.5 text-red-300" aria-hidden="true" />;
  }
  if (pr.isDraft) {
    return (
      <GitPullRequestDraft
        className="h-3.5 w-3.5 text-muted-foreground"
        aria-hidden="true"
      />
    );
  }
  return (
    <GitPullRequest
      className="h-3.5 w-3.5 text-emerald-300"
      aria-hidden="true"
    />
  );
}

function Header({ pr }: { pr: PullRequest }) {
  const stateClasses = stateColorClasses(pr.state);
  const stateLabel = pr.state.charAt(0) + pr.state.slice(1).toLowerCase();
  const decision = pr.reviewDecision ? reviewDecisionLabel(pr.reviewDecision) : null;
  const merge = mergeableLabel(pr.mergeable);
  return (
    <section className="border-b border-border/60 bg-background/40 px-3 py-3">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group/title flex min-w-0 flex-1 items-start gap-2"
        >
          <StatusIcon pr={pr} />
          <h2 className="line-clamp-2 break-words text-sm font-medium leading-snug text-foreground group-hover/title:underline">
            {pr.title}
          </h2>
        </a>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="font-mono">#{pr.number}</span>
        <Badge variant="outline" className={`border ${stateClasses} text-[10px] font-medium`}>
          {stateLabel}
        </Badge>
        {pr.isDraft ? (
          <Badge
            variant="outline"
            className="border-border bg-muted/40 text-[10px] font-medium text-muted-foreground"
          >
            Draft
          </Badge>
        ) : null}
        {decision ? (
          <Badge
            variant="outline"
            className={`border ${decision.classes} text-[10px] font-medium`}
            title={`Review decision: ${decision.label}`}
          >
            {decision.label}
          </Badge>
        ) : null}
        <span
          className={
            merge.tone === "ok"
              ? "text-emerald-300"
              : merge.tone === "warn"
              ? "text-amber-300"
              : "text-muted-foreground/70"
          }
          title={`Mergeability: ${merge.label}`}
        >
          · {merge.label}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[10px] text-muted-foreground/80">
        <span>
          <span className="text-emerald-400">+{pr.additions}</span>{" "}
          <span className="text-red-400">−{pr.deletions}</span>
        </span>
        <span>
          {pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"} changed
        </span>
        <span>
          {pr.headRefName}{" "}
          <span className="text-muted-foreground/50">→</span> {pr.baseRefName}
        </span>
      </div>
    </section>
  );
}

function Description({ body, prUrl }: { body: string; prUrl: string }) {
  const trimmed = body.trim();
  if (!trimmed) {
    return (
      <section className="px-3 py-2 text-xs text-muted-foreground/60">
        <em>No description provided.</em>
      </section>
    );
  }
  return (
    <section className="border-b border-border/60 px-3 py-2">
      <div className="prose prose-invert prose-sm max-w-none break-words text-xs leading-5">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={buildPrMarkdownComponents(prUrl)}
        >
          {trimmed}
        </ReactMarkdown>
      </div>
    </section>
  );
}

function ChecksSection({ checks, prUrl }: { checks: PrCheck[]; prUrl: string }) {
  const [open, setOpen] = useState(true);
  const passing = checks.filter((c) => c.state.toUpperCase() === "SUCCESS").length;
  const failing = checks.filter((c) =>
    ["FAILURE", "ERROR", "CANCELLED"].includes(c.state.toUpperCase())
  ).length;
  const summary =
    failing > 0
      ? `${failing} failing`
      : passing === checks.length && checks.length > 0
      ? "All passing"
      : `${passing}/${checks.length} passing`;
  const summaryClasses =
    failing > 0
      ? "text-red-300"
      : passing === checks.length && checks.length > 0
      ? "text-emerald-300"
      : "text-muted-foreground";
  return (
    <section className="border-b border-border/60 px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="-mx-1 flex w-full items-center justify-between gap-2 rounded px-1 py-1 text-left text-[11px] uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground"
      >
        <span className="flex items-center gap-1.5">
          {open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          Checks
        </span>
        <span className={`font-mono text-[10px] ${summaryClasses}`}>{summary}</span>
      </button>
      {open ? (
        checks.length === 0 ? (
          <div className="px-1 py-2 text-[11px] text-muted-foreground/60">
            <em>No checks reported on the branch's head.</em>{" "}
            <a
              href={`${prUrl}/checks`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline-offset-2 hover:underline"
            >
              View on GitHub
            </a>
          </div>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {checks.map((check, idx) => (
              <PrCheckRow
                key={`${check.name}:${idx}`}
                check={check}
                prUrl={prUrl}
              />
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}

export function PrPanel({
  pullRequest,
  now = NOW_FALLBACK,
}: PrPanelProps) {
  const timeline = useMemo(
    () => (pullRequest ? buildTimeline(pullRequest) : []),
    [pullRequest]
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {pullRequest ? (
        <>
          <Header pr={pullRequest} />
          <div className="flex-1 overflow-y-auto">
            <ChecksSection
              checks={pullRequest.statusCheckRollup ?? []}
              prUrl={pullRequest.url}
            />
            <Description body={pullRequest.body} prUrl={pullRequest.url} />
            <section className="px-3 py-2">
              <div className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                <MessageSquare className="h-3 w-3" />
                Conversation
                <span className="font-mono text-[10px] text-muted-foreground/70">
                  {timeline.length}
                </span>
              </div>
              <Timeline
                items={timeline}
                now={now}
                prUrl={pullRequest.url}
              />
            </section>
          </div>
          <Footer prUrl={pullRequest.url} />
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
          <GitPullRequest className="h-5 w-5 text-muted-foreground/40" />
          <span>No pull request is open for this branch.</span>
        </div>
      )}
    </div>
  );
}

function Footer({ prUrl }: { prUrl: string }) {
  return (
    <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 bg-background px-3 py-2">
      <span className="truncate text-[10px] text-muted-foreground/70">
        View &amp; act on GitHub
      </span>
      <a
        href={prUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
      >
        <span>Open on GitHub</span>
        <ExternalLink className="h-3 w-3" />
      </a>
    </footer>
  );
}

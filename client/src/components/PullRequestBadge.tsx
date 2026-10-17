import { GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react";
import { cn } from "@/lib/utils";

/*
 * Compact PR marker: a state-colored icon plus the PR number. Clicking it
 * opens the PR tab inside Controller rather than GitHub.
 */
export function PullRequestBadge({
  number,
  state,
  onClick,
  nested = false,
  className,
}: {
  number: number;
  state: string;
  onClick: () => void;
  /** Render as a span with button semantics when placed inside another button. */
  nested?: boolean;
  className?: string;
}) {
  const { label } = prStyle(state);
  const props = {
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      onClick();
    },
    title: `PR #${number} (${label})`,
    "aria-label": `Open PR #${number} (${label})`,
    className: cn(
      "inline-flex shrink-0 items-center gap-1 rounded px-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors",
      className,
    ),
  };
  const content = (
    <>
      <PullRequestStateIcon state={state} className="h-3.5 w-3.5" />
      #{number}
    </>
  );
  if (!nested) return <button type="button" {...props}>{content}</button>;
  return (
    <span
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      {...props}
    >
      {content}
    </span>
  );
}

/* PR icon colored by state: green open, violet merged, grey closed. */
export function PullRequestStateIcon({ state, className }: { state: string; className?: string }) {
  const { Icon, iconClassName } = prStyle(state);
  return <Icon className={cn(iconClassName, className)} />;
}

function prStyle(state: string) {
  switch (state) {
    case "MERGED":
      return { Icon: GitMerge, iconClassName: "text-violet-500", label: "merged" };
    case "CLOSED":
      return { Icon: GitPullRequestClosed, iconClassName: "text-muted-foreground", label: "closed" };
    default:
      return { Icon: GitPullRequest, iconClassName: "text-emerald-500", label: "open" };
  }
}

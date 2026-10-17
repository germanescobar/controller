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
  className,
}: {
  number: number;
  state: string;
  onClick: () => void;
  className?: string;
}) {
  const { Icon, iconClassName, label } = prStyle(state);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={`PR #${number} (${label})`}
      aria-label={`Open PR #${number} (${label})`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded px-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors",
        className,
      )}
    >
      <Icon className={cn("h-3.5 w-3.5", iconClassName)} />
      #{number}
    </button>
  );
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

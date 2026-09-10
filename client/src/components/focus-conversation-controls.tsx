import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, Pause, Plus, StepForward } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { formatChord, isMacPlatform } from "@/lib/shortcut-match";
import type { ShortcutBindings } from "../../../shared/shortcuts.ts";

interface FocusConversationControlsProps {
  variant: "mobile" | "desktop";
  bindings: ShortcutBindings | null;
  isOnRadar: boolean;
  autoAdvance: boolean;
  onNext: () => void;
  onDone: () => void;
  onAddToRadar: () => void;
  onToggleAutoAdvance: () => void;
  countdown?: {
    scheduledAt: number;
    durationMs: number;
    onStay: () => void;
  } | null;
}

export function FocusConversationControls({
  variant,
  bindings,
  isOnRadar,
  autoAdvance,
  onNext,
  onDone,
  onAddToRadar,
  onToggleAutoAdvance,
  countdown = null,
}: FocusConversationControlsProps) {
  const nextChord = formatChord(
    bindings?.focusAdvanceNext ?? "ctrl-n",
    isMacPlatform(),
  );
  const doneChord = formatChord(
    bindings?.focusDone ?? "ctrl-d",
    isMacPlatform(),
  );
  const autoAdvanceChord = formatChord(
    bindings?.focusAutoAdvance ?? "ctrl-t",
    isMacPlatform(),
  );
  const stayChord = formatChord(
    bindings?.focusStay ?? "ctrl-s",
    isMacPlatform(),
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!countdown) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [countdown?.scheduledAt]);

  const elapsedMs = countdown
    ? Math.max(0, now - countdown.scheduledAt)
    : 0;
  const remainingProgress = countdown
    ? Math.max(0, 1 - elapsedMs / countdown.durationMs)
    : 0;
  const secondsRemaining = countdown
    ? Math.max(0, Math.ceil((countdown.durationMs - elapsedMs) / 1000))
    : 0;

  return (
    <div
      data-testid={`focus-conversation-controls-${variant}`}
      className={cn(
        "gap-2 overflow-hidden border-blue-500/20 bg-background/95 backdrop-blur",
        variant === "mobile"
          ? "relative flex shrink-0 items-center justify-between border-b px-2 py-2 md:hidden"
          : "absolute right-4 top-4 z-20 hidden flex-col items-stretch rounded-lg border px-3 py-2 shadow-lg md:flex",
      )}
    >
      {countdown ? (
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-blue-500" />
          <span className="truncate">Advancing in {secondsRemaining}s</span>
        </div>
      ) : (
        <label
          className={cn(
            "flex shrink-0 items-center gap-2 px-1 text-xs text-muted-foreground",
            variant === "desktop" && "w-full justify-between",
          )}
          title={
            variant === "desktop"
              ? `Toggle auto-advance (${autoAdvanceChord})`
              : undefined
          }
        >
          <span className="flex items-center gap-1.5">
            Auto-advance
            {variant === "desktop" ? <Kbd>{autoAdvanceChord}</Kbd> : null}
          </span>
          <Switch
            checked={autoAdvance}
            onCheckedChange={onToggleAutoAdvance}
            aria-label="Auto advance"
            className="scale-90"
          />
        </label>
      )}
      <div
        className={cn(
          "flex shrink-0 items-center gap-1",
          variant === "desktop" && "w-full justify-end",
        )}
      >
        {countdown ? (
          <button
            type="button"
            onClick={countdown.onStay}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-500/15 hover:text-blue-600 dark:text-blue-300 dark:hover:text-blue-200"
            title={variant === "desktop" ? `Stay (${stayChord})` : undefined}
          >
            <Pause className="h-3.5 w-3.5" />
            Stay
            {variant === "desktop" ? <Kbd>{stayChord}</Kbd> : null}
          </button>
        ) : isOnRadar ? (
          <button
            type="button"
            onClick={onDone}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-500/15 hover:text-blue-600 dark:text-blue-300 dark:hover:text-blue-200"
            title={variant === "desktop" ? `Mark done (${doneChord})` : undefined}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Done
            {variant === "desktop" ? <Kbd>{doneChord}</Kbd> : null}
          </button>
        ) : (
          <button
            type="button"
            onClick={onAddToRadar}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-500/15 hover:text-blue-600 dark:text-blue-300 dark:hover:text-blue-200"
          >
            <Plus className="h-3.5 w-3.5" />
            Add to radar
          </button>
        )}
        {!countdown || variant === "desktop" ? (
          <button
            type="button"
            onClick={onNext}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-500/15 hover:text-blue-600 dark:text-blue-300 dark:hover:text-blue-200"
            title={variant === "desktop" ? `Next (${nextChord})` : undefined}
          >
            <StepForward className="h-3.5 w-3.5" />
            Next
            {variant === "desktop" ? <Kbd>{nextChord}</Kbd> : null}
          </button>
        ) : null}
      </div>
      {countdown ? (
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-muted">
          <div
            className="h-full bg-blue-500 transition-[width] duration-200 ease-linear"
            style={{ width: `${remainingProgress * 100}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

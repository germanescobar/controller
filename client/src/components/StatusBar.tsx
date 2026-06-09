import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  getController,
  isControllerAvailable,
  type ControllerStatus,
} from "@/lib/controller";

function labelFor(status: ControllerStatus | null): string {
  if (!status) return "Backend";
  if (status.state === "listening") return `Listening on port ${status.port}`;
  if (status.state === "starting") return "Starting backend...";
  return status.message || "Backend error";
}

function dotColor(status: ControllerStatus | null): string {
  if (!status || status.state === "starting") {
    return "bg-muted-foreground/60";
  }
  if (status.state === "listening") return "bg-emerald-500";
  return "bg-destructive";
}

export function StatusBar() {
  // Read the current state synchronously so we don't flash "Backend"
  // when the server is already up (e.g. when the user reactivates a
  // still-running packaged app).
  const [status, setStatus] = useState<ControllerStatus | null>(() => {
    if (!isControllerAvailable()) return null;
    return getController().getStatus();
  });

  useEffect(() => {
    if (!isControllerAvailable()) return;
    const unsubscribe = getController().onStatus((next) => setStatus(next));
    return () => {
      unsubscribe();
    };
  }, []);

  if (!isControllerAvailable()) return null;

  const port =
    status && (status.state === "listening" || status.state === "starting")
      ? status.port
      : null;
  const url = port !== null ? `http://localhost:${port}` : null;

  const handleCopy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Copied", { description: url });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to copy URL");
    }
  };

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex h-7 w-full items-center justify-between gap-2 border-t border-border bg-background/80 px-3 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label="Backend status"
          />
        }
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className={`h-2 w-2 shrink-0 rounded-full ${dotColor(status)}`}
          />
          <span className="truncate">{labelFor(status)}</span>
        </span>
      </PopoverTrigger>
      <PopoverContent>
        <div className="space-y-3">
          <div>
            <div className="text-xs font-medium text-foreground">Local URL</div>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted px-2 py-1 font-mono text-[11px] text-foreground">
                {url ?? "—"}
              </code>
              <Button
                type="button"
                size="icon-xs"
                variant="outline"
                onClick={handleCopy}
                disabled={!url}
                aria-label="Copy local URL"
              >
                <Copy className="h-3 w-3" />
              </Button>
            </div>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            To open this app from your phone, install{" "}
            <a
              href="https://tailscale.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-2 hover:text-foreground/80"
            >
              Tailscale
            </a>{" "}
            to reach it over a private network — don't expose the server to the
            public internet.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

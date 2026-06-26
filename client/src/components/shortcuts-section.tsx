import { useEffect, useState } from "react";
import { RotateCcw, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  setRecordingChord,
  useShortcutBindingsContext,
} from "@/lib/useShortcutBindings";
import {
  formatChord,
  isMacPlatform,
  parseChord,
  serialiseEvent,
} from "@/lib/shortcut-match";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  RESERVED_SHORTCUTS,
  SHORTCUT_ACTIONS,
  type ShortcutActionId,
  type ShortcutBindings,
} from "../../../shared/shortcuts.ts";

/*
 * Settings panel for Controller Mode keyboard shortcuts.
 *
 * Each action shows its current chord and a "Record" button. Clicking
 * Record waits for the next key chord, then auto-saves it (no separate
 * Save button — every Record persists immediately). Conflicts are
 * surfaced inline as warnings; the user can re-record to override.
 *
 * "Restore defaults" is the one explicit action: it wipes all overrides
 * and is gated behind a confirm so an accidental click doesn't blow
 * away a carefully tuned set of rebinds.
 *
 * Overrides are persisted to `~/.local/state/Controller/shortcuts.json`
 * (or platform equivalent) — see issue #235.
 */
export function ShortcutsSection() {
  const { bindings, save, reset } = useShortcutBindingsContext();
  const [recording, setRecording] = useState<ShortcutActionId | null>(null);
  const [pendingAction, setPendingAction] = useState<ShortcutActionId | null>(
    null,
  );

  const effective: ShortcutBindings =
    bindings ?? { ...DEFAULT_SHORTCUT_BINDINGS };
  const conflict = detectConflict(effective);

  // Persist a chord change for one action. We always send only the diff
  // against the bundled defaults so the on-disk file stays minimal.
  // Errors roll back the chord in the local view (the server is the
  // source of truth via the provider state).
  const persistChord = async (action: ShortcutActionId, chord: string) => {
    const next: Partial<ShortcutBindings> = {};
    const current = bindings ?? { ...DEFAULT_SHORTCUT_BINDINGS };
    for (const id of SHORTCUT_ACTIONS.map((a) => a.id)) {
      const value = id === action ? chord : current[id];
      if (value !== DEFAULT_SHORTCUT_BINDINGS[id]) {
        next[id] = value;
      }
    }
    try {
      await save(next);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to save shortcut",
      );
    }
  };

  const handleResetDefaults = async () => {
    if (
      !window.confirm(
        "Restore default shortcuts? Any custom bindings you've set will be removed.",
      )
    ) {
      return;
    }
    try {
      await reset();
      toast.success("Shortcuts restored to defaults");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to restore defaults",
      );
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
        Controller Mode shortcuts now use platform modifiers so they fire
        even while the composer has focus. On macOS, ⌘ is the primary
        modifier; on Linux / Windows, Ctrl is. The chord you see matches
        the keys your browser actually receives. Press{" "}
        <Kbd>Esc</Kbd> to cancel recording.
      </div>

      <div className="rounded-lg border border-border divide-y divide-border">
        {SHORTCUT_ACTIONS.map((action) => {
          const chord = effective[action.id] ?? DEFAULT_SHORTCUT_BINDINGS[action.id];
          const isRecording = recording === action.id;
          const isPending = pendingAction === action.id;
          const label = formatChord(chord, isMacPlatform());
          return (
            <div
              key={action.id}
              className="flex flex-col gap-2 p-3 md:flex-row md:items-center md:justify-between"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{action.label}</div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {action.description}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Kbd className="min-w-16 justify-center">{label}</Kbd>
                <Button
                  size="sm"
                  variant={isRecording ? "default" : "outline"}
                  onClick={() =>
                    setRecording(isRecording ? null : action.id)
                  }
                >
                  {isRecording ? "Cancel" : "Record"}
                </Button>
              </div>
              {isRecording ? (
                <Recorder
                  onCapture={async (chord) => {
                    setRecording(null);
                    setPendingAction(action.id);
                    await persistChord(action.id, chord);
                    setPendingAction(null);
                  }}
                  onCancel={() => setRecording(null)}
                />
              ) : null}
              {isPending ? (
                <div className="md:hidden text-xs text-muted-foreground">
                  Saving…
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {conflict ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            <div className="font-medium">{conflict.title}</div>
            <div className="mt-0.5 text-amber-200/80">{conflict.body}</div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="outline"
          onClick={() => void handleResetDefaults()}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Restore defaults
        </Button>
      </div>
    </div>
  );
}

function Recorder({
  onCapture,
  onCancel,
}: {
  onCapture: (chord: string) => void;
  onCancel: () => void;
}) {
  // Listens for the next meaningful keydown. Esc cancels. We mount the
  // listener directly on the window because the user is mid-flow and
  // focus might be anywhere (a button, the page body).
  //
  // We also set the `recordingChord` module flag while recording so the
  // global App-level listener (registered on window capture too) skips
  // its handler — otherwise Ctrl+T / Ctrl+N / Ctrl+D / Ctrl+S would
  // actually toggle / navigate / mark-done instead of being captured
  // for the new binding (issue #235 P2 review).
  useEffect(() => {
    setRecordingChord(true);
    return () => setRecordingChord(false);
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.repeat) return;
      const chord = serialiseEvent(event);
      if (!chord) return;
      if (!parseChord(chord)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onCapture(chord);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onCapture, onCancel]);

  return (
    <div className="md:hidden rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-xs text-blue-200">
      Press the new shortcut now. <Kbd>Esc</Kbd> to cancel.
    </div>
  );
}

interface Conflict {
  title: string;
  body: string;
}

function detectConflict(bindings: ShortcutBindings): Conflict | null {
  // Two-pass: first find duplicates, then find reserved.
  const byChord = new Map<string, ShortcutActionId[]>();
  for (const action of SHORTCUT_ACTIONS) {
    const chord = bindings[action.id] ?? DEFAULT_SHORTCUT_BINDINGS[action.id];
    const list = byChord.get(chord) ?? [];
    list.push(action.id);
    byChord.set(chord, list);
  }
  for (const [chord, ids] of byChord) {
    if (ids.length > 1) {
      return {
        title: "Duplicate shortcut",
        body: `${formatChord(chord, isMacPlatform())} is bound to ${
          ids
            .map((id) =>
              SHORTCUT_ACTIONS.find((a) => a.id === id)?.label ?? id,
            )
            .join(" and ")
        }. Only the first will fire.`,
      };
    }
  }

  for (const action of SHORTCUT_ACTIONS) {
    const chord = bindings[action.id] ?? DEFAULT_SHORTCUT_BINDINGS[action.id];
    if (RESERVED_SHORTCUTS.includes(chord)) {
      return {
        title: "Reserved shortcut",
        body: `${formatChord(chord, isMacPlatform())} is reserved by the OS or browser (e.g. close window, reload). Binding it here may cause unexpected behaviour.`,
      };
    }
  }

  return null;
}

import { useEffect, useState } from "react";
import { RotateCcw, AlertTriangle, Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { useShortcutBindings, bindingFor } from "@/lib/useShortcutBindings";
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
 * Each action shows its current chord, the platform-correct label, and a
 * "Record" button that captures the next chord the user presses. Conflicts
 * (chord already bound to another action, or reserved OS chord) are
 * surfaced inline as warnings — the user can save anyway, but can't
 * accidentally shadow Cmd+W without seeing the warning first.
 *
 * Overrides are persisted to `~/.local/state/Controller/shortcuts.json`
 * (or platform equivalent) — see issue #235.
 */
export function ShortcutsSection() {
  const { bindings, save, reset } = useShortcutBindings();
  const [drafts, setDrafts] = useState<ShortcutBindings | null>(null);
  const [recording, setRecording] = useState<ShortcutActionId | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Keep the draft in sync with the server until the user starts
  // editing. Once they've changed at least one field we own the draft
  // until they hit "Restore defaults" or save.
  useEffect(() => {
    if (bindings && !drafts) setDrafts({ ...bindings });
  }, [bindings, drafts]);

  const effective = drafts ?? bindings ?? { ...DEFAULT_SHORTCUT_BINDINGS };
  const isDirty =
    drafts !== null &&
    bindings !== null &&
    !equalRecord(drafts, bindings);

  const conflict = detectConflict(effective);

  const updateChord = (action: ShortcutActionId, chord: string) => {
    setDrafts((prev) => {
      const base = prev ?? bindings ?? { ...DEFAULT_SHORTCUT_BINDINGS };
      return { ...base, [action]: chord };
    });
  };

  const handleResetDrafts = async () => {
    const next = await reset();
    setDrafts({ ...next });
    setSavedAt(Date.now());
  };

  const handleSave = async () => {
    if (!drafts) return;
    setSaving(true);
    try {
      // Only send the actions that differ from the bundled defaults —
      // keeps the on-disk shape minimal.
      const overrides: Partial<ShortcutBindings> = {};
      for (const [action, chord] of Object.entries(drafts)) {
        const id = action as ShortcutActionId;
        if (chord !== DEFAULT_SHORTCUT_BINDINGS[id]) {
          overrides[id] = chord;
        }
      }
      const next = await save(overrides);
      setDrafts({ ...next });
      setSavedAt(Date.now());
      setRecording(null);
    } finally {
      setSaving(false);
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
                  onCapture={(chord) => {
                    updateChord(action.id, chord);
                    setRecording(null);
                  }}
                  onCancel={() => setRecording(null)}
                />
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
        {savedAt ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Check className="h-3 w-3" />
            Saved
          </span>
        ) : null}
        <Button
          variant="outline"
          onClick={() => void handleResetDrafts()}
          disabled={saving}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Restore defaults
        </Button>
        <Button
          onClick={() => void handleSave()}
          disabled={!isDirty || saving}
        >
          {saving ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Saving…
            </>
          ) : (
            "Save"
          )}
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

function equalRecord(a: ShortcutBindings, b: ShortcutBindings): boolean {
  for (const id of Object.keys(DEFAULT_SHORTCUT_BINDINGS) as ShortcutActionId[]) {
    if ((a[id] ?? "") !== (b[id] ?? "")) return false;
  }
  return true;
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

// Exposed so unit tests can exercise the conflict detector without
// mounting the full settings UI.
export const __testing = { detectConflict, equalRecord, bindingFor };
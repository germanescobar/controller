import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { go } from "@codemirror/lang-go";
import { Check, Loader2, Save, X } from "lucide-react";
import { toast } from "sonner";
import { saveSourceFile } from "@/api.ts";
import type { SourceFile } from "@/api.ts";

/*
 * In-experience code editor for the Files tab (issue #313 follow-up).
 *
 * The right panel previously rendered the file content as a static
 * syntax-highlighted `<div>` — useful for reading what an agent did,
 * not for editing it. This component wraps CodeMirror 6 (via the
 * `@uiw/react-codemirror` adapter) and pairs it with a Save / Discard
 * bar in the header.
 *
 * Design notes:
 *   - The editor is uncontrolled inside CodeMirror but we mirror the
 *     buffer into React state on every change so the dirty flag,
 *     the Save button enablement, and the parent component's
 *     `onDirtyChange` callback all see the latest content. We avoid
 *     pushing the value back into `<CodeMirror value=…>` on every
 *     keystroke — that would re-create the editor state and lose the
 *     undo history each time.
 *   - `Cmd/Ctrl+S` is bound via CodeMirror's `keymap` extension so it
 *     fires regardless of focus. The OS-level save dialog is
 *     suppressed with `event.preventDefault()`.
 *   - If the file changes on disk while the user is editing (e.g.
 *     an agent rewrites it), we toast a "file changed on disk"
 *     message with a Reload button instead of silently overwriting
 *     the in-flight buffer. The file path drives the comparison, so
 *     opening a different file in the same panel resets the editor
 *     and the saved-state indicator.
 */

function getEditorLanguage(filePath: string) {
  const basename = filePath.split("/").pop()?.toLowerCase() ?? "";
  const extension = filePath.split(".").pop()?.toLowerCase();
  // CodeMirror matches the hljs mapping used by the read-only viewer
  // in `SourceViewerPanel` so the highlighted colors stay consistent
  // between the two surfaces.
  if (basename === "dockerfile") return javascript({ jsx: false });
  if (extension === "ts" || extension === "tsx") return javascript({ typescript: true, jsx: extension === "tsx" });
  if (extension === "js" || extension === "jsx" || extension === "mjs" || extension === "cjs") {
    return javascript({ jsx: extension === "jsx" });
  }
  if (extension === "html" || extension === "htm" || extension === "xml" || extension === "svg") {
    return html();
  }
  if (extension === "css") return css();
  if (extension === "scss" || extension === "sass") return css();
  if (extension === "json") return json();
  if (extension === "md" || extension === "mdx") return markdown();
  if (extension === "py") return python();
  if (extension === "rs") return rust();
  if (extension === "go") return go();
  if (extension === "sql") return sql();
  if (extension === "yml" || extension === "yaml") return yaml();
  // shell, ini, toml, diff, plaintext, graphql → no dedicated language
  // pack on the editor side. CodeMirror's default tokenization is
  // good enough and we'd rather not bloat the bundle for the rare
  // cases where the read-only viewer would have shown a color hint.
  return null;
}

export interface SourceEditorProps {
  file: SourceFile;
  projectId: string;
  worktreeId?: string;
  /** Optional 1-based line to scroll the editor to after the
   *  buffer loads. Used by the agent's `path:line` references so
   *  the cursor lands on the line the agent was talking about
   *  (matches the behaviour of the previous static viewer). */
  initialLine?: number;
  /** Called when the user saves the file. The parent can use this
   *  to update its preview cache and the file-tree refresh button. */
  onSaved: (saved: { path: string; relativePath: string; content: string; savedAt: string }) => void;
  /** Notifies the parent about dirty-state transitions so the Files
   *  tab can intercept tab-switches that would discard unsaved work. */
  onDirtyChange?: (dirty: boolean) => void;
}

export function SourceEditor({
  file,
  projectId,
  worktreeId,
  initialLine,
  onSaved,
  onDirtyChange,
}: SourceEditorProps) {
  const cmRef = useRef<ReactCodeMirrorRef | null>(null);
  const [draft, setDraft] = useState<string>(file.content);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);

  // Scroll-to-line support. When the parent opens a file with an
  // `initialLine`, we wait for the editor to mount, then dispatch
  // a CodeMirror `scrollIntoView` on the target line. We only
  // honour the latest `initialLine` value per file load so a
  // user scrolling on their own doesn't get yanked back when
  // the parent re-renders.
  useEffect(() => {
    if (!initialLine) return;
    let cancelled = false;
    const tryScroll = () => {
      if (cancelled) return;
      const view = cmRef.current?.view;
      if (!view) {
        // Editor not mounted yet — try again next frame.
        window.requestAnimationFrame(tryScroll);
        return;
      }
      const line = Math.min(Math.max(initialLine, 1), view.state.doc.lines);
      const from = view.state.doc.line(line).from;
      view.dispatch({
        effects: EditorView.scrollIntoView(from, { y: "center" }),
        selection: { anchor: from, head: from },
      });
      view.focus();
    };
    tryScroll();
    return () => {
      cancelled = true;
    };
  }, [initialLine, file.path, file.content]);

  // Track the last `file` prop we synced from so we know when an
  // external reload (e.g. an agent rewriting the file) should
  // replace the editor buffer. Without this, a remote change would
  // be invisible while the user is editing.
  const lastSyncedPathRef = useRef<string>(file.path);
  const lastSyncedContentRef = useRef<string>(file.content);
  useEffect(() => {
    if (file.path !== lastSyncedPathRef.current) {
      lastSyncedPathRef.current = file.path;
      lastSyncedContentRef.current = file.content;
      setDraft(file.content);
      setLastSavedAt(null);
      return;
    }
    if (file.content !== lastSyncedContentRef.current) {
      lastSyncedContentRef.current = file.content;
      // External change to the same file — only overwrite the buffer
      // when the user hasn't dirtied it. Otherwise we'd silently
      // throw away in-flight edits.
      if (draft === lastSyncedContentRef.current) {
        setDraft(file.content);
      } else {
        toast.message(`${file.relativePath} changed on disk`, {
          description: "Reload to pick up the new contents (your unsaved edits are kept).",
          action: {
            label: "Reload",
            onClick: () => setDraft(file.content),
          },
        });
      }
    }
    // We intentionally don't depend on `draft` — that would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path, file.content, file.relativePath]);

  const dirty = draft !== file.content;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const save = useCallback(async () => {
    if (saving) return;
    if (!dirty) return;
    setSaving(true);
    try {
      const saved = await saveSourceFile(projectId, file.path, draft, worktreeId);
      lastSyncedContentRef.current = saved.content;
      setDraft(saved.content);
      setLastSavedAt(saved.savedAt);
      onSaved(saved);
      toast.success(`Saved ${saved.relativePath}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save file";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }, [saving, dirty, projectId, file.path, draft, worktreeId, onSaved]);

  const discard = useCallback(() => {
    if (!dirty) return;
    setDraft(file.content);
    cmRef.current?.view?.focus();
  }, [dirty, file.content]);

  const extensions = useMemo<Extension[]>(() => {
    const lang = getEditorLanguage(file.path);
    return [
      lineNumbers(),
      highlightActiveLine(),
      history(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            void save();
            return true;
          },
        },
        {
          key: "Mod-Shift-s",
          preventDefault: true,
          run: () => {
            void save();
            return true;
          },
        },
      ]),
      EditorView.lineWrapping,
      // The CodeMirror `<CodeMirror theme="dark" />` prop only
      // retunes the syntax-highlight palette. To make the
      // surrounding chrome (gutter, line numbers, active-line
      // band, selection, scrollbar, caret) match, we layer a
      // matching dark theme on top. Colors are chosen to read as
      // a "VS Code Dark+" style surface: muted gutter, soft
      // selection, slightly-lifted active line.
      EditorView.theme({
        "&": {
          backgroundColor: "#1e1e1e",
          color: "#d4d4d4",
          height: "100%",
        },
        "&.cm-focused": {
          outline: "none",
        },
        ".cm-scroller": {
          fontFamily:
            "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
          fontSize: "12px",
        },
        ".cm-content": {
          padding: "8px 0",
          caretColor: "#d4d4d4",
        },
        ".cm-line": {
          padding: "0 12px",
        },
        ".cm-gutters": {
          backgroundColor: "#1e1e1e",
          color: "#858585",
          border: "none",
        },
        ".cm-activeLine": {
          backgroundColor: "#2a2d2e",
        },
        ".cm-activeLineGutter": {
          backgroundColor: "#2a2d2e",
          color: "#c6c6c6",
        },
        ".cm-selectionBackground, ::selection": {
          backgroundColor: "#264f78",
        },
        "&.cm-focused .cm-selectionBackground": {
          backgroundColor: "#264f78",
        },
      }, { dark: true }),
      ...(lang ? [lang] : []),
    ];
  }, [file.path, save]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-muted/20 px-3">
        <DirtyDot dirty={dirty} saving={saving} />
        <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {lastSavedAt
            ? `Saved ${formatSavedAt(lastSavedAt)}${dirty ? " · unsaved changes" : ""}`
            : dirty
              ? "Unsaved changes"
              : "No changes"}
        </div>
        <button
          type="button"
          onClick={discard}
          disabled={!dirty || saving}
          className="flex h-7 items-center gap-1 rounded border border-border bg-background px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          title="Discard unsaved changes"
        >
          <X className="h-3 w-3" />
          Discard
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="flex h-7 items-center gap-1 rounded border border-border bg-background px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
          title="Save (⌘S)"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <CodeMirror
          ref={cmRef}
          value={draft}
          basicSetup={{
            lineNumbers: true,
            foldGutter: false,
            highlightActiveLine: true,
            highlightSelectionMatches: false,
            autocompletion: false,
            bracketMatching: true,
            closeBrackets: false,
          }}
          extensions={extensions}
          onChange={(value) => setDraft(value)}
          // Dark syntax palette (the surrounding Files-tab chrome
          // stays light on purpose — see the follow-up plan in the
          // PR description for a full dark-mode pass). Switching
          // the theme to "dark" only retunes the highlight.js
          // colors, so we also paint the editor's chrome via the
          // `EditorView.theme` extension above (gutter, selection,
          // scrollbar, caret) to match — otherwise the code area
          // goes dark while the gutter stays light, which looks
          // worse than either pure light or pure dark.
          theme="dark"
          height="100%"
          className="h-full min-h-0"
        />
      </div>
    </div>
  );
}

function DirtyDot({ dirty, saving }: { dirty: boolean; saving: boolean }) {
  if (saving) {
    return <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" aria-label="Saving" />;
  }
  if (dirty) {
    return (
      <span
        className="inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500"
        aria-label="Unsaved changes"
        title="Unsaved changes"
      />
    );
  }
  return <Check className="h-3 w-3 shrink-0 text-emerald-500" aria-label="Saved" />;
}

function formatSavedAt(iso: string): string {
  const saved = new Date(iso);
  if (Number.isNaN(saved.getTime())) return "just now";
  return saved.toLocaleTimeString();
}

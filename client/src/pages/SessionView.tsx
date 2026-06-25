import { memo, useCallback, useMemo, useState, useEffect, useRef, createContext, useContext } from "react";
import { diffLines } from "diff";
import { ArrowUp, Loader2, Copy, Check, ChevronDown, ChevronRight, TerminalSquare, MessageSquare, Square, Diff, PanelRight, Zap, Plus, X, Paperclip, FileText, FileCode, Folder, FolderOpen, CheckCircle2, StepForward, LogOut, Radar, Play, Sparkles, Globe2, RefreshCw, Pencil, Archive } from "lucide-react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { visit, SKIP } from "unist-util-visit";
import type { Root, Text, Link } from "mdast";
import {
  CONTROLLER_URI_PATTERN,
  parseControllerUri,
  type ControllerLinkTarget,
} from "../../../shared/conversation-links.ts";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
import { Terminal, type TerminalHandle } from "@/components/terminal";
import { TerminalMobileControls } from "@/components/terminal-mobile-controls";
import { useResizablePanel } from "@/lib/useResizablePanel";
import { isControllerAvailable } from "@/lib/controller";
import {
  usePreviewPane,
  useActivePreviewPane,
  usePreviewOpen,
  type PreviewPaneState,
} from "@/components/PreviewBrowserPool";
import {
  fetchActiveRuntimes,
  fetchAgents,
  fetchEvents,
  fetchBranchDiff,
  fetchGitDiff,
  fetchModels,
  fetchSourceDirectory,
  fetchSourceFile,
  fetchTerminalTabs,
  fetchAgentProviders,
  fetchSession,
  fetchWorktrees,
  dismissSessionUserInput,
  fetchAgentSkills,
  runProjectScript,
  startSession,
  stopSession,
  steerSession,
  submitSessionUserInput,
  pinSessionFocus,
  unpinSessionFocus,
  updateSessionTitle,
  fetchSessionQueue,
  enqueueSessionMessage,
  removeSessionQueuedMessage,
  type QueuedMessage,
  type QueuedMessageInput,
  type AgentSkill,
  type Project,
  type SourceDirectoryEntry,
  type SourceFile,
  uploadSessionAttachments,
  updateTerminalTabs,
  type Worktree,
  type TerminalTab,
  type AgentEvent,
  type AgentProviderInfo,
  type Model,
  type PlanStep,
  type ReasoningEffort,
  type ServiceTier,
  type SessionStreamEvent,
  type SessionAttachment,
  type UserInputQuestion,
  submitToolApproval,
  type ToolApprovalDecision,
} from "../api.ts";
import { canonicalProviderId } from "../lib/provider-id.ts";
import {
  parseSkillTokenAtCaret,
  removeSkillToken,
  buildSkillHistoryText,
  buildSkillAgentText,
  parseSkillMarkers,
} from "../lib/skill-picker.ts";
import { modelProviderLabel } from "../lib/model-labels.ts";

interface SessionViewProps {
  projectId: string;
  sessionId?: string;
  worktreeId?: string;
  project?: Project;
  onSessionCreated: (sessionId: string) => void;
  onBackgroundComplete?: (sessionId: string) => void;
  // Navigates to another conversation referenced by a `controller://` link in
  // the transcript. Resolves the short form (session-only) to its owning
  // project/worktree before navigating. No-op if the parent doesn't provide it.
  onOpenConversation?: (target: ControllerLinkTarget) => void;
  controllerMode?: boolean;
  focusPosition?: { current: number; total: number };
  onFocusDone?: () => void;
  onFocusSkip?: () => void;
  onFocusExit?: () => void;
  onFocusPinnedChange?: () => void;
  // Opens the archive confirmation dialog for the current session.
  // Owned by the parent because it shares its `archiveConfirmOpen`
  // state with the mobile header archive button (App.tsx) so a single
  // dialog covers both surfaces. No-op if the parent doesn't provide it.
  onArchive?: () => void;
  /**
   * Reports the live git/branch diff totals so the parent can mirror
   * the desktop header's `+X -Y` chip in surfaces that aren't owned
   * by this component (e.g. the mobile top header in App.tsx). The
   * callback fires when the summary actually changes; pass `null`
   * when there are no changes to report or no session is open.
   */
  onDiffSummary?: (summary: { added: number; deleted: number } | null) => void;
  // Fires after the session title is renamed so the parent can refresh
  // other views (sidebar, focus queue) that cache the title separately.
  onTitleChange?: () => void;
  // Fires right after the user sends a message (or answers an agent
  // prompt) in controller mode, with the id of the session the message
  // was sent from. The parent can use this to advance to the next
  // focus item. See issue #81 follow-up: "respond and advance to the
  // next conversation".
  onFocusAdvanceAfterSend?: (sessionId: string) => void;
  /**
   * When non-null, a controller-mode advance has been scheduled after
   * a send. While this is set, SessionView preserves the in-flight
   * user-message bubble in the originating session (we skip the
   * session-change cleanup that would otherwise wipe it) so the user
   * always has time to see the message they just sent. Typing in the
   * originating composer cancels the pending advance.
   */
  focusAdvanceCountdown?: {
    sentFromSessionId: string;
    onCancel: () => void;
  } | null;
}

type StreamItem = (
  | { type: "assistant"; text: string }
  | { type: "user_message"; text: string; attachments?: SessionAttachment[] }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; name?: string; content: string; isError: boolean }
  | { type: "plan_updated"; explanation: string | null; plan: PlanStep[] }
  | { type: "plan_delta"; id: string; delta: string }
  | { type: "user_input_requested"; id: string; questions: UserInputQuestion[] }
  | {
      type: "tool_approval_requested";
      id: string;
      toolName: string;
      input: Record<string, unknown>;
    }
  | { type: "thread_status"; status: string; activeFlags: string[] }
  | { type: "error"; text: unknown }
  | { type: "run_cancelled"; reason: string }
) & { at: number };

function isSessionIsolationDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("debugSessionIsolation") === "1";
  } catch {
    return false;
  }
}

function debugSessionIsolation(event: string, data: Record<string, unknown>) {
  if (!isSessionIsolationDebugEnabled()) return;
  console.debug(`[session-isolation] ${event}`, data);
}

const REASONING_EFFORT_OPTIONS: Array<{
  value: ReasoningEffort;
  label: string;
}> = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "none", label: "None" },
];

const CLAUDE_REASONING_EFFORTS = new Set<ReasoningEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
]);

function supportsPlanMode(provider: string): boolean {
  return provider === "codex" || provider === "claude";
}

function supportsReasoningEffort(provider: string): boolean {
  return provider === "codex" || provider === "claude";
}

function supportsServiceTier(provider: string): boolean {
  return provider === "codex";
}

/*
 * Whether the provider can steer a running turn natively (Codex's
 * `turn/steer`). All providers support steering in the UI; the others
 * emulate it by stopping the run and resuming with the steer text. See
 * issue #113.
 */
function usesNativeSteering(provider: string): boolean {
  return provider === "codex";
}

// Label for the steer chord, platform-aware (Cmd on macOS, Ctrl elsewhere).
const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const STEER_KEY_LABEL = IS_MAC ? "⌘+Enter" : "Ctrl+Enter";

// Touch devices use an on-screen keyboard whose Return key should insert a
// newline rather than submit — there's no Shift+Enter affordance, and the
// composer has a dedicated Send button. Detected via a coarse pointer so a
// narrow desktop window (which still has a physical keyboard) keeps the
// Enter-to-send keymap.
const IS_TOUCH_DEVICE =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(pointer: coarse)").matches;

function supportsAttachments(provider: string): boolean {
  return provider === "anita" || provider === "codex" || provider === "claude";
}

function modelAcceptsAttachments(model: Model | undefined): boolean {
  if (!model) return false;
  if (model.provider === "codex" || model.provider === "claude") return true;
  // For Anita and other providers, defer to the per-model capability flag
  // reported by `anita models --json`. Models without capabilities are
  // treated as not supporting attachments.
  if (!model.capabilities) return false;
  return model.capabilities.images || model.capabilities.files;
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

function isFileMimeType(mimeType: string): boolean {
  return !isImageMimeType(mimeType);
}

const MAX_ATTACHMENT_COUNT = 5;
const MAX_ATTACHMENT_SIZE = 15 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_SIZE = 35 * 1024 * 1024;
const SUPPORTED_ATTACHMENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/heic",
  "image/heif",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/json",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/zip",
]);
const PREVIEWABLE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

interface ComposerAttachment {
  id: string;
  file: File;
  previewUrl?: string;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileDisplayName(file: File): string {
  const name = typeof file.name === "string" ? file.name.trim() : "";
  return name || "attachment";
}

function getFileMimeType(file: File): string {
  return typeof file.type === "string" && file.type.trim()
    ? file.type.trim()
    : "application/octet-stream";
}

function makeClientId(prefix: string): string {
  const cryptoApi = typeof globalThis.crypto === "object" ? globalThis.crypto : undefined;
  if (typeof cryptoApi?.randomUUID === "function") {
    return `${prefix}-${cryptoApi.randomUUID()}`;
  }
  if (typeof cryptoApi?.getRandomValues === "function") {
    const values = new Uint32Array(2);
    cryptoApi.getRandomValues(values);
    return `${prefix}-${Date.now().toString(36)}-${values[0].toString(36)}-${values[1].toString(36)}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function normalizeToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";

  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

function normalizeMarkdownText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeMarkdownText(item))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object") {
    const raw = value as Record<string, unknown>;
    if (typeof raw.text === "string") return raw.text;
    if (typeof raw.content === "string") return raw.content;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncateInlineText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function CollapsibleUserMessage({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const lineCount = text.split("\n").length;
  const shouldCollapse = lineCount > 12 || text.length > 1000;

  return (
    <div>
      <div
        className={`whitespace-pre-wrap break-words ${
          !expanded && shouldCollapse ? "max-h-[15rem] overflow-hidden" : ""
        }`}
      >
        {text}
      </div>
      {shouldCollapse && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-1 cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function buildToolInputPreview(input?: Record<string, unknown>): string {
  if (!input) return "";

  return Object.entries(input)
    .map(([key, value]) => {
      const stringValue =
        typeof value === "string" ? value : JSON.stringify(value);
      const maxLength = key === "cmd" || key === "command" ? 120 : 60;
      return `${key}: ${truncateInlineText(stringValue, maxLength)}`;
    })
    .join(", ");
}

// ---------------------------------------------------------------------------
// Diff utilities
// ---------------------------------------------------------------------------

interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
}

interface DiffFile {
  path: string;
  op: "add" | "delete" | "update";
  lines: DiffLine[];
}

function extractPatchText(input: Record<string, unknown>): string | null {
  const candidates: string[] = [];
  const collect = (v: unknown) => {
    if (typeof v === "string") candidates.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
  };
  Object.values(input).forEach(collect);
  return candidates.find((s) => s.includes("*** Begin Patch")) ?? null;
}

function parseApplyPatch(input: Record<string, unknown>): DiffFile[] {
  const patchText = extractPatchText(input);
  if (!patchText) return [];

  const match = patchText.match(/\*\*\* Begin Patch\n([\s\S]*?)\*\*\* End Patch/);
  if (!match) return [];

  const files: DiffFile[] = [];
  const sections = match[1].split(/(?=\*\*\* (?:Add|Delete|Update) File:)/);

  for (const section of sections) {
    if (!section.trim()) continue;

    const addM = section.match(/^\*\*\* Add File: (.+)\n([\s\S]*)/);
    if (addM) {
      const lines = addM[2]
        .split("\n")
        .filter((l) => l.startsWith("+"))
        .map((l) => ({ kind: "add" as const, text: l.slice(1) }));
      files.push({ path: addM[1].trim(), op: "add", lines });
      continue;
    }

    const delM = section.match(/^\*\*\* Delete File: (.+)/);
    if (delM) {
      files.push({ path: delM[1].trim(), op: "delete", lines: [] });
      continue;
    }

    const updM = section.match(/^\*\*\* Update File: (.+)\n([\s\S]*)/);
    if (updM) {
      const lines: DiffLine[] = [];
      for (const raw of updM[2].split("\n")) {
        if (raw.startsWith("@@")) lines.push({ kind: "ctx", text: raw });
        else if (raw.startsWith("+")) lines.push({ kind: "add", text: raw.slice(1) });
        else if (raw.startsWith("-")) lines.push({ kind: "del", text: raw.slice(1) });
        else if (raw.startsWith(" ")) lines.push({ kind: "ctx", text: raw.slice(1) });
      }
      files.push({ path: updM[1].trim(), op: "update", lines });
    }
  }

  return files;
}

function parseStrReplaceDiff(input: Record<string, unknown>): DiffFile[] {
  const command = input.command as string | undefined;
  const path = (input.path as string | undefined) ?? "";

  if (command === "str_replace") {
    const oldStr = (input.old_string as string | undefined) ?? "";
    const newStr = (input.new_string as string | undefined) ?? "";
    const lines: DiffLine[] = [];
    for (const change of diffLines(oldStr, newStr)) {
      const text = change.value.replace(/\n$/, "");
      for (const line of text.split("\n")) {
        if (change.added) lines.push({ kind: "add", text: line });
        else if (change.removed) lines.push({ kind: "del", text: line });
        else lines.push({ kind: "ctx", text: line });
      }
    }
    return [{ path, op: "update", lines }];
  }

  if (command === "create" || command === "write") {
    const content = ((input.file_text ?? input.content ?? "") as string).replace(/\n$/, "");
    const lines = content.split("\n").map((text) => ({ kind: "add" as const, text }));
    return [{ path, op: "add", lines }];
  }

  return [];
}

function parseWriteFileDiff(input: Record<string, unknown>): DiffFile[] {
  const path = (input.path ?? input.file_path ?? "") as string;
  const content = ((input.content ?? input.file_text ?? "") as string).replace(/\n$/, "");
  if (!content) return [];
  const lines = content.split("\n").map((text) => ({ kind: "add" as const, text }));
  return [{ path, op: "add", lines }];
}

function parseUnifiedDiff(diffText: string, path: string, op: "add" | "delete" | "update"): DiffFile {
  const lines: DiffLine[] = [];
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("@@")) lines.push({ kind: "ctx", text: raw });
    else if (raw.startsWith("+")) lines.push({ kind: "add", text: raw.slice(1) });
    else if (raw.startsWith("-")) lines.push({ kind: "del", text: raw.slice(1) });
    else if (raw.startsWith(" ")) lines.push({ kind: "ctx", text: raw.slice(1) });
    // skip "\ No newline at end of file" markers
  }
  return { path, op, lines };
}

interface CodexFileChange {
  path: string;
  kind?: { type?: string; move_path?: string | null };
  diff?: string;
}

function parseFileChangeDiff(input: Record<string, unknown>): DiffFile[] {
  const changes = input.changes as CodexFileChange[] | undefined;
  if (!Array.isArray(changes) || changes.length === 0) return [];
  return changes
    .filter((c) => c.path)
    .map((c) => {
      const op = c.kind?.type === "add" ? "add" : c.kind?.type === "delete" ? "delete" : "update";
      return c.diff ? parseUnifiedDiff(c.diff, c.path, op) : { path: c.path, op, lines: [] };
    });
}

interface BrowserToolCall {
  action: string;
  /** Short, human-readable summary, e.g. `open localhost:5173`. */
  summary: string;
  /** Full shell command, shown when expanded. */
  raw: string;
}

function extractShellCommand(input?: Record<string, unknown>): string | null {
  if (!input) return null;
  const value = input.command ?? input.cmd;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => (typeof part === "string" ? part : "")).join(" ");
  }
  return null;
}

// Detect agent shell calls that drive the preview browser CLI so the timeline
// can label them clearly (issue #109). Agents invoke it by absolute path, e.g.
// `"/Users/x/coding-orchestrator/bin/controller-browser" open localhost:5173`.
function parseBrowserToolCall(input?: Record<string, unknown>): BrowserToolCall | null {
  const command = extractShellCommand(input);
  if (!command || !command.includes("controller-browser")) return null;
  const match = command.match(
    /controller-browser["']?\s+([A-Za-z-]+)(?:\s+([^\n]*))?/
  );
  const action = match?.[1] ?? "";
  const rest = (match?.[2] ?? "").trim();
  const summary = action
    ? `${action}${rest ? ` ${truncateInlineText(rest, 60)}` : ""}`
    : "browser";
  return { action, summary, raw: command };
}

function parseDiffFromToolCall(tool: string, input?: Record<string, unknown>): DiffFile[] {
  if (!input) return [];
  const t = tool.toLowerCase();
  if (t === "apply_patch" || t === "applypatch") return parseApplyPatch(input);
  if (t === "str_replace_based_edit_tool" || t === "str_replace_editor") return parseStrReplaceDiff(input);
  if (t === "write_file" || t === "create_file" || t === "edit_file") return parseWriteFileDiff(input);
  if (t === "filechange" || t === "file_change") return parseFileChangeDiff(input);
  return [];
}

function parseFullGitDiff(diff: string): DiffFile[] {
  if (!diff.trim()) return [];
  const files: DiffFile[] = [];
  const sections = diff.split(/(?=^diff --git )/m);
  for (const section of sections) {
    if (!section.trim()) continue;
    const pathMatch = section.match(/^diff --git a\/.+ b\/(.+)$/m);
    if (!pathMatch) continue;
    const filePath = pathMatch[1].trim();
    const isNew = /^new file mode/m.test(section) || /^--- \/dev\/null/m.test(section);
    const isDeleted = /^deleted file mode/m.test(section);
    const op: "add" | "delete" | "update" = isNew ? "add" : isDeleted ? "delete" : "update";

    // Only process lines inside hunks — skip all diff/index/---/+++ header lines
    const lines: DiffLine[] = [];
    let inHunk = false;
    for (const raw of section.split("\n")) {
      if (raw.startsWith("@@")) {
        inHunk = true;
        lines.push({ kind: "ctx", text: raw });
      } else if (inHunk) {
        if (raw.startsWith("+")) lines.push({ kind: "add", text: raw.slice(1) });
        else if (raw.startsWith("-")) lines.push({ kind: "del", text: raw.slice(1) });
        else if (raw.startsWith(" ")) lines.push({ kind: "ctx", text: raw.slice(1) });
      }
    }

    files.push({ path: filePath, op, lines });
  }
  return files;
}

const ProjectRootContext = createContext<string | undefined>(undefined);

interface SourceReference {
  path: string;
  line?: number;
}

interface OpenSourceReferenceOptions extends SourceReference {
  label: string;
}

interface SourceFilePreview {
  file: SourceFile;
  line?: number;
}

interface PreviewActions {
  available: boolean;
  open: (url: string) => void;
}

type RightPanelTab = "terminal" | "changes" | "files" | "preview";
type MobilePanel = "agent" | RightPanelTab;

const OpenSourceReferenceContext = createContext<
  ((reference: OpenSourceReferenceOptions) => void) | undefined
>(undefined);
// Navigates to another conversation referenced by a `controller://` link in
// the transcript. Provided by SessionView, wired up the tree to App's
// session navigation. Undefined in surfaces that can't navigate.
const OpenConversationContext = createContext<
  ((target: ControllerLinkTarget) => void) | undefined
>(undefined);
const PreviewContext = createContext<PreviewActions>({ available: false, open: () => {} });

/*
 * remark plugin: turn bare `controller://` URIs in text into link nodes so
 * they render through `MarkdownLink` and become clickable. remark-gfm only
 * autolinks http(s)/www/email, so these internal URIs would otherwise stay
 * inert plain text. Text inside code spans/blocks isn't visited (it lives on
 * `code`/`inlineCode` nodes, not `text`), and we skip text already nested in
 * a link.
 */
function remarkControllerLinks() {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === undefined || parent.type === "link") return;

      const value = node.value;
      CONTROLLER_URI_PATTERN.lastIndex = 0;
      if (!CONTROLLER_URI_PATTERN.test(value)) return;

      const replacement: Array<Text | Link> = [];
      let lastIndex = 0;
      CONTROLLER_URI_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = CONTROLLER_URI_PATTERN.exec(value)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (start > lastIndex) {
          replacement.push({ type: "text", value: value.slice(lastIndex, start) });
        }
        replacement.push({
          type: "link",
          url: match[0],
          children: [{ type: "text", value: match[0] }],
        });
        lastIndex = end;
      }
      if (lastIndex < value.length) {
        replacement.push({ type: "text", value: value.slice(lastIndex) });
      }

      parent.children.splice(index, 1, ...replacement);
      // Continue after the nodes we just inserted.
      return [SKIP, index + replacement.length];
    });
  };
}

const remarkPlugins = [remarkGfm, remarkControllerLinks];

/*
 * react-markdown's default url sanitizer strips unknown protocols, which would
 * blank out the `href` of our `controller://` links before `MarkdownLink` ever
 * sees it. Preserve those URIs and defer to the default for everything else.
 */
function controllerUrlTransform(url: string): string {
  if (parseControllerUri(url)) return url;
  return defaultUrlTransform(url);
}

const PREVIEW_URL_PATTERN =
  /\b(?:https?:\/\/[^\s"'`<>)\]]+|(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)[^\s"'`<>)\]]*|file:\/\/[^\s"'`<>)\]]+)/gi;

function extractPreviewUrls(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of text.matchAll(PREVIEW_URL_PATTERN)) {
    const raw = match[0].replace(/[.,;:!?]+$/, "");
    const normalized = raw.startsWith("http") || raw.startsWith("file://") ? raw : `http://${raw}`;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
  }
  return urls.slice(0, 3);
}

function usePreviewActions(): PreviewActions {
  return useContext(PreviewContext);
}

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("graphql", graphql);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("scss", scss);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

function parseLocalCodeReference(href: string | undefined): SourceReference | null {
  if (!href) return null;
  let value = href.trim();
  if (!value) return null;

  if (typeof window !== "undefined") {
    const origin = window.location.origin;
    if (value.startsWith(`${origin}/`)) {
      value = value.slice(origin.length);
    }
  }

  if (!value.startsWith("/") || value.startsWith("//")) return null;

  try {
    value = decodeURI(value);
  } catch {
    return null;
  }

  const match = value.match(/^(.*?):([1-9]\d*)$/);
  if (!match) return { path: value };
  return {
    path: match[1],
    line: Number.parseInt(match[2], 10),
  };
}

function relativizePath(path: string, root: string | undefined): string {
  if (!root) return path;
  const trimmedRoot = root.replace(/\/+$/, "");
  if (path === trimmedRoot) return ".";
  const prefix = trimmedRoot + "/";
  if (path.startsWith(prefix)) return path.slice(prefix.length);
  return path;
}

function summarizeDiffFiles(files: DiffFile[]): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const f of files) {
    for (const line of f.lines) {
      if (line.kind === "add") added += 1;
      else if (line.kind === "del") deleted += 1;
    }
  }
  return { added, deleted };
}

interface ProcessedLine {
  kind: "add" | "del" | "ctx" | "hunk";
  text: string;
  oldLine?: number;
  newLine?: number;
}

function processLinesWithNumbers(lines: DiffLine[]): ProcessedLine[] {
  const result: ProcessedLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const line of lines) {
    if (line.kind === "ctx" && line.text.startsWith("@@")) {
      const m = line.text.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldLine = parseInt(m[1], 10); newLine = parseInt(m[2], 10); }
      result.push({ kind: "hunk", text: line.text });
    } else if (line.kind === "del") {
      result.push({ kind: "del", text: line.text, oldLine: oldLine++ });
    } else if (line.kind === "add") {
      result.push({ kind: "add", text: line.text, newLine: newLine++ });
    } else {
      result.push({ kind: "ctx", text: line.text, oldLine, newLine });
      oldLine++; newLine++;
    }
  }
  return result;
}

function DiffBlock({ files }: { files: DiffFile[] }) {
  const [expanded, setExpanded] = useState(false);
  const projectRoot = useContext(ProjectRootContext);
  const { added, deleted } = summarizeDiffFiles(files);
  const summary =
    files.length === 1
      ? relativizePath(files[0].path, projectRoot)
      : `${files.length} files changed`;

  return (
    <div className="rounded-md border border-border/30 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left min-w-0 hover:bg-muted/40 transition-colors bg-muted/20"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        )}
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground/80">
          {summary}
        </span>
        <span className="shrink-0 font-mono text-xs">
          <span className="text-green-400/90">+{added}</span>{" "}
          <span className="text-red-400/90">-{deleted}</span>
        </span>
      </button>
      {expanded && <DiffView files={files} />}
    </div>
  );
}

function DiffView({ files }: { files: DiffFile[] }) {
  const projectRoot = useContext(ProjectRootContext);
  return (
    <div className="border-t border-border/30 divide-y divide-border/20">
      {files.map((file, i) => {
        const processed = processLinesWithNumbers(file.lines);
        return (
          <div key={i}>
            {files.length > 1 && (
              <div className="px-3 py-1 bg-muted/10 font-mono text-[10px] text-muted-foreground/50 border-b border-border/20">
                {relativizePath(file.path, projectRoot)}
              </div>
            )}
            {file.lines.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground/60">
                Binary or metadata-only change
              </div>
            ) : (
              <div className="overflow-x-auto">
                {processed.map((line, j) => {
                  if (line.kind === "hunk") {
                    return (
                      <div key={j} className="flex bg-blue-950/20 border-y border-blue-900/20 first:border-t-0">
                        <span className="w-9 shrink-0 border-r border-border/20 bg-background/10" />
                        <span className="w-9 shrink-0 border-r border-border/20 bg-background/10" />
                        <span className="px-3 py-0.5 font-mono text-[10px] text-blue-400/50 whitespace-pre">
                          {line.text}
                        </span>
                      </div>
                    );
                  }
                  const isAdd = line.kind === "add";
                  const isDel = line.kind === "del";
                  return (
                    <div key={j} className={`flex min-w-0 ${isAdd ? "bg-green-950/30" : isDel ? "bg-red-950/30" : ""}`}>
                      <span className="w-9 shrink-0 text-right pr-2 py-0.5 select-none font-mono text-[10px] text-muted-foreground/25 border-r border-border/20 bg-background/10">
                        {line.oldLine ?? ""}
                      </span>
                      <span className="w-9 shrink-0 text-right pr-2 py-0.5 select-none font-mono text-[10px] text-muted-foreground/25 border-r border-border/20 bg-background/10">
                        {line.newLine ?? ""}
                      </span>
                      <span className={`pl-2 pr-1 py-0.5 shrink-0 select-none font-mono text-[11px] ${isAdd ? "text-green-400/70" : isDel ? "text-red-400/70" : "text-muted-foreground/30"}`}>
                        {isAdd ? "+" : isDel ? "−" : " "}
                      </span>
                      <span className={`py-0.5 pr-3 whitespace-pre font-mono text-[11px] flex-1 min-w-0 ${isAdd ? "text-green-300/90" : isDel ? "text-red-300/90" : "text-muted-foreground/70"}`}>
                        {line.text}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const RunDiffCard = memo(function RunDiffCard({ data }: { data: Record<string, unknown> }) {
  const [showAllFiles, setShowAllFiles] = useState(false);
  const projectRoot = useContext(ProjectRootContext);
  const diff = typeof data.diff === "string" ? data.diff : "";
  const files = parseFullGitDiff(diff);
  if (files.length === 0) return null;

  const summary = summarizeDiffFiles(files);
  const added = typeof data.added === "number" ? data.added : summary.added;
  const deleted = typeof data.deleted === "number" ? data.deleted : summary.deleted;
  const filesChanged =
    typeof data.filesChanged === "number" ? data.filesChanged : files.length;
  const visibleFiles = showAllFiles ? files : files.slice(0, 3);
  const hiddenCount = Math.max(0, files.length - visibleFiles.length);

  return (
    <div className="overflow-hidden rounded-md border border-border/60 bg-card">
      <div className="flex items-center gap-2.5 border-b border-border/60 px-3 py-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-background">
          <Diff className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium">
            Edited {filesChanged} file{filesChanged === 1 ? "" : "s"}
          </div>
          <div className="mt-0.5 font-mono text-[11px]">
            <span className="text-green-400/90">+{added}</span>{" "}
            <span className="text-red-400/90">-{deleted}</span>
          </div>
        </div>
      </div>
      <div className="divide-y divide-border/50">
        {visibleFiles.map((file) => (
          <RunDiffFileRow
            key={file.path}
            file={file}
            label={relativizePath(file.path, projectRoot)}
          />
        ))}
        {hiddenCount > 0 && (
          <button
            onClick={() => setShowAllFiles(true)}
            className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/40"
          >
            <span>Show {hiddenCount} more file{hiddenCount === 1 ? "" : "s"}</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        )}
      </div>
    </div>
  );
});

function RunDiffFileRow({ file, label }: { file: DiffFile; label: string }) {
  const [expanded, setExpanded] = useState(false);
  const fileSummary = summarizeDiffFiles([file]);

  return (
    <div>
      <button
        onClick={() => setExpanded((open) => !open)}
        className="flex w-full cursor-pointer min-w-0 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/40"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground/90">
          {label}
        </span>
        <span className="shrink-0 font-mono text-xs">
          <span className="text-green-400/90">+{fileSummary.added}</span>{" "}
          <span className="text-red-400/90">-{fileSummary.deleted}</span>
        </span>
      </button>
      {expanded && (
        <div className="max-h-96 overflow-y-auto border-t border-border/30">
          <DiffView files={[file]} />
        </div>
      )}
    </div>
  );
}

const COMPOSER_MAX_LINES = 5;
const DEFAULT_TERMINAL_ID = "default";

const DEFAULT_TERMINAL_TAB: TerminalTab = {
  id: DEFAULT_TERMINAL_ID,
  label: "Terminal 1",
};

function buildTerminalStorageKey(projectId: string, worktreeId?: string): string {
  return `terminalTabs:${projectId}:${worktreeId ?? "main"}`;
}

function normalizeTerminalTabs(value: unknown): TerminalTab[] {
  if (!Array.isArray(value)) return [DEFAULT_TERMINAL_TAB];
  const seen = new Set<string>();
  const tabs = value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const raw = item as Record<string, unknown>;
      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      const label = typeof raw.label === "string" ? raw.label.trim() : "";
      if (!id || !label || seen.has(id) || !/^[a-zA-Z0-9._-]+$/.test(id)) return null;
      seen.add(id);
      return { id, label };
    })
    .filter((tab): tab is TerminalTab => Boolean(tab));

  return tabs.length > 0 ? tabs : [DEFAULT_TERMINAL_TAB];
}

function terminalTabsEqual(a: TerminalTab[], b: TerminalTab[]): boolean {
  return (
    a.length === b.length &&
    a.every((tab, index) => tab.id === b[index]?.id && tab.label === b[index]?.label)
  );
}

function mergeTerminalTabs(a: TerminalTab[], b: TerminalTab[]): TerminalTab[] {
  const seen = new Set<string>();
  return [...a, ...b].filter((tab) => {
    if (seen.has(tab.id)) return false;
    seen.add(tab.id);
    return true;
  });
}

function loadStoredTerminals(projectId: string, worktreeId?: string): {
  tabs: TerminalTab[];
  activeId: string;
} {
  if (typeof window === "undefined") {
    return { tabs: [DEFAULT_TERMINAL_TAB], activeId: DEFAULT_TERMINAL_ID };
  }

  try {
    const raw = window.localStorage.getItem(buildTerminalStorageKey(projectId, worktreeId));
    if (!raw) return { tabs: [DEFAULT_TERMINAL_TAB], activeId: DEFAULT_TERMINAL_ID };
    const parsed = JSON.parse(raw) as { tabs?: unknown; activeId?: unknown };
    const tabs = normalizeTerminalTabs(parsed.tabs);
    const activeId =
      typeof parsed.activeId === "string" && tabs.some((tab) => tab.id === parsed.activeId)
        ? parsed.activeId
        : tabs[0].id;
    return { tabs, activeId };
  } catch {
    return { tabs: [DEFAULT_TERMINAL_TAB], activeId: DEFAULT_TERMINAL_ID };
  }
}

function makeTerminalId(): string {
  return makeClientId("terminal");
}

function getRunStatusText(
  stopReason: "completed" | "max_iterations" | string,
  status: "completed" | "max_iterations"
) {
  if (status === "max_iterations" || stopReason === "max_turns") {
    return "Paused after a long run. You can keep going with a follow-up message.";
  }

  return "Done.";
}

function getLatestPendingUserInputRequest(
  events: AgentEvent[]
): { eventId: string; questions: UserInputQuestion[] } | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type === "user_input_response") return null;
    if (event.type === "user_input_requested") {
      const questions =
        ((event.data.questions as UserInputQuestion[] | undefined) ?? []).filter(
          Boolean
        );
      return questions.length > 0 ? { eventId: event.id, questions } : null;
    }
  }

  return null;
}

function getLatestPendingToolApproval(
  events: AgentEvent[]
): { requestId: string; toolName: string; input: Record<string, unknown> } | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    // A response settles every earlier request, so the most recent terminal
    // marker wins: a response means nothing is pending.
    if (event.type === "tool_approval_response") return null;
    if (event.type === "tool_approval_requested") {
      const requestId = event.data.requestId as string | undefined;
      if (!requestId) return null;
      return {
        requestId,
        toolName: (event.data.toolName as string | undefined) ?? "tool",
        input: (event.data.input as Record<string, unknown> | undefined) ?? {},
      };
    }
  }

  return null;
}

function hasMatchingPersistedUserMessage(
  events: AgentEvent[],
  pendingMessage: string | null
): boolean {
  if (!pendingMessage) return false;

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type !== "user_message") continue;
    return (
      typeof event.data.text === "string" &&
      event.data.text === pendingMessage
    );
  }

  return false;
}

type EventRenderItem =
  | { kind: "working_group"; key: string; events: AgentEvent[] }
  | { kind: "event"; key: string; event: AgentEvent };

type StreamRenderItem =
  | { kind: "working_group"; key: string; items: StreamItem[]; startIndex: number }
  | { kind: "item"; key: string; item: StreamItem; index: number };

interface QueuedStreamStart {
  message: string;
  pendingVisibleMessage: string;
  modeOverride?: "default" | "plan";
  resumeSessionId?: string;
}

const WORKING_EVENT_TYPES = new Set([
  "tool_call",
  "tool_result",
  "assistant_reasoning",
  "assistant.reasoning",
  "plan_updated",
  "plan_delta",
  "policy_decision",
  "thread_status",
]);

const WORKING_STREAM_TYPES = new Set([
  "tool_call",
  "tool_result",
  "reasoning",
  "plan_updated",
  "plan_delta",
  "thread_status",
]);
const EMPTY_STREAM_ITEMS: StreamItem[] = [];

function isWorkingEvent(event: AgentEvent): boolean {
  return WORKING_EVENT_TYPES.has(event.type);
}

function isWorkingStreamItem(item: StreamItem): boolean {
  return WORKING_STREAM_TYPES.has(item.type);
}

function groupEventsForRender(events: AgentEvent[]): EventRenderItem[] {
  const result: EventRenderItem[] = [];
  let group: AgentEvent[] = [];

  const flush = () => {
    if (group.length === 0) return;
    result.push({
      kind: "working_group",
      key: `working-group-${group[0].id}`,
      events: group,
    });
    group = [];
  };

  for (const event of events) {
    if (isWorkingEvent(event)) {
      group.push(event);
    } else {
      flush();
      result.push({ kind: "event", key: event.id, event });
    }
  }
  flush();
  return result;
}

function groupStreamItemsForRender(items: StreamItem[]): StreamRenderItem[] {
  const result: StreamRenderItem[] = [];
  let group: StreamItem[] = [];
  let groupStart = 0;

  const flush = () => {
    if (group.length === 0) return;
    result.push({
      kind: "working_group",
      key: `stream-working-group-${groupStart}`,
      items: group,
      startIndex: groupStart,
    });
    group = [];
  };

  items.forEach((item, index) => {
    if (isWorkingStreamItem(item)) {
      if (group.length === 0) groupStart = index;
      group.push(item);
    } else {
      flush();
      result.push({ kind: "item", key: `stream-${index}`, item, index });
    }
  });
  flush();
  return result;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function WorkingShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-muted/30 overflow-hidden">
      {children}
    </div>
  );
}

function WorkingBlock({
  startMs,
  endMs,
  live,
  stepCount,
  children,
}: {
  startMs: number;
  endMs?: number;
  live?: boolean;
  stepCount: number;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [live]);

  const elapsed = (live ? now : endMs ?? now) - startMs;
  const stepLabel = stepCount > 0 ? ` · ${stepCount} step${stepCount === 1 ? "" : "s"}` : "";

  return (
    <div className="rounded-lg bg-muted/30 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        )}
        {live ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground/60" />
        ) : null}
        <span className="text-xs text-muted-foreground">
          {live ? "Working for" : "Worked for"} {formatDuration(elapsed)}
          {stepLabel}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border/30 py-1">
          {children}
        </div>
      )}
    </div>
  );
}

const EventBlock = memo(function EventBlock({
  event,
  copiedId,
  onCopy,
  hiddenPendingUserInputEventId,
}: {
  event: AgentEvent;
  copiedId: string | null;
  onCopy: (e: AgentEvent) => void;
  hiddenPendingUserInputEventId?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const data = event.data;

  // user_message: show as chat bubble. If one or more skills were active,
  // render a `Skill: <name>` badge per marker (in declaration order) and
  // strip the leading `[/skill: name]` chain from the visible text.
  if (event.type === "user_message" && data.text) {
    const attachments = (data.attachments as SessionAttachment[] | undefined) ?? [];
    const rawText = normalizeMarkdownText(data.text);
    const { skillNames, text: visibleText } = parseSkillMarkers(rawText);
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%]">
          <AttachmentStrip attachments={attachments} />
          <div className="rounded-2xl bg-secondary px-4 py-3 text-sm">
            {skillNames.length > 0 && (
              <div className="mb-1.5 flex flex-wrap justify-end gap-1">
                {skillNames.map((skillName, index) => (
                  <span
                    key={`${skillName}-${index}`}
                    className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                  >
                    <Sparkles className="h-3 w-3 text-primary" />
                    <span>Skill: {skillName}</span>
                  </span>
                ))}
              </div>
            )}
            <CollapsibleUserMessage text={visibleText} />
          </div>
        </div>
      </div>
    );
  }

  // assistant_response: render markdown
  if (event.type === "assistant_response") {
    const content = Array.isArray(data.content)
      ? (data.content as Array<{ type?: unknown; text?: unknown; content?: unknown }>)
      : [];
    const reasoningText = content
      ?.filter((b) => b.type === "reasoning")
      .map((b) => normalizeMarkdownText(b.text ?? b.content))
      .filter(Boolean)
      .join("\n");
    const text = content
      ?.filter((b) => b.type === "text")
      .map((b) => normalizeMarkdownText(b.text ?? b.content))
      .filter(Boolean)
      .join("\n");
    if (!reasoningText && !text) return null;
    return (
      <div className="space-y-3">
        {reasoningText ? <ReasoningBlock text={reasoningText} /> : null}
        {text ? (
          <AssistantBlock text={text}>
            <button
              onClick={() => onCopy(event)}
              className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
            >
              {copiedId === event.id ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          </AssistantBlock>
        ) : null}
      </div>
    );
  }

  if (event.type === "run_diff") {
    return <RunDiffCard data={data} />;
  }

  // Working-group events are rendered inside WorkingBlock at the parent level.
  if (isWorkingEvent(event)) {
    return null;
  }

  // Skill metadata events emitted by the agent CLI (e.g. Anita's
  // `skills_loaded`) are pure bookkeeping. The user already gets a
  // `Skill: <name>` badge on the matching user message bubble, so
  // rendering the raw JSON here would just show the skill body again.
  if (event.type === "skills_loaded") {
    return null;
  }
  // Silence unused-warning suppression (expanded used by fallback case below).
  void expanded;

  if (event.type === "user_input_requested") {
    if (hiddenPendingUserInputEventId === event.id) return null;
    const questions = ((data.questions as UserInputQuestion[] | undefined) ?? []).filter(Boolean);
    if (questions.length === 0) return null;
    return <UserInputRequestedBlock questions={questions} />;
  }

  // A pending approval renders interactively from the bottom action area (see
  // `pendingToolApproval`); the persisted request itself is not shown inline.
  if (event.type === "tool_approval_requested") {
    return null;
  }

  if (event.type === "tool_approval_response") {
    const decision = data.decision as ToolApprovalDecision | undefined;
    const label =
      decision === "deny"
        ? "Denied"
        : decision === "always_allow"
          ? "Approved (always allow)"
          : "Approved";
    return (
      <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
        <div className="h-px flex-1 bg-border" />
        <span>{label}</span>
        <div className="h-px flex-1 bg-border" />
      </div>
    );
  }

  // session_start / session_end: compact
  if (event.type === "session_start" || event.type === "session_end") {
    return (
      <div className="flex items-center gap-2 py-1">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">{event.type.replace("_", " ")}</span>
        <div className="h-px flex-1 bg-border" />
      </div>
    );
  }

  // error
  if (event.type === "error") {
    const msg =
      (data.message as string) ?? (data.text as string) ?? JSON.stringify(data);
    return <ErrorBlock text={msg} />;
  }

  // run_cancelled: same soft, non-error indicator as the live SSE
  // path so reloads and `fetchEvents()` replays don't fall through
  // to the generic expandable card fallback (see issue #94 follow-up).
  if (event.type === "run_cancelled") {
    const reason =
      typeof data.reason === "string" && data.reason.trim() ? data.reason : "";
    return <CancelledBlock reason={reason} />;
  }

  // Fallback: generic expandable
  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 p-3 text-left"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          {event.type}
        </Badge>
      </button>
      {expanded && (
        <pre className="border-t border-border px-4 py-3 text-xs text-muted-foreground font-mono whitespace-pre-wrap overflow-x-auto">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
});

function MarkdownLink({
  children,
  href,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const openSourceReference = useContext(OpenSourceReferenceContext);
  const openConversation = useContext(OpenConversationContext);

  const conversationTarget = parseControllerUri(href);
  if (conversationTarget) {
    return (
      <a
        href={href}
        {...props}
        onClick={(event) => {
          event.preventDefault();
          if (openConversation) {
            openConversation(conversationTarget);
          } else {
            toast.error("Conversation links are not available in this view");
          }
        }}
      >
        {children}
      </a>
    );
  }

  const sourceReference = parseLocalCodeReference(href);

  if (!sourceReference) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    );
  }

  return (
    <a
      href={href}
      {...props}
      onClick={(event) => {
        event.preventDefault();
        if (openSourceReference) {
          openSourceReference({
            ...sourceReference,
            label: typeof children === "string" ? children : href ?? sourceReference.path,
          });
        } else {
          toast.error("Source links are not available in this view");
        }
      }}
    >
      {children}
    </a>
  );
}

const markdownComponents = {
  a: MarkdownLink,
};

const PreviewUrlActions = memo(function PreviewUrlActions({ content }: { content: string }) {
  const preview = usePreviewActions();
  const urls = useMemo(() => extractPreviewUrls(content), [content]);

  if (!preview.available || urls.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 px-4 pb-2">
      {urls.map((url) => (
        <button
          key={url}
          type="button"
          onClick={() => preview.open(url)}
          className="inline-flex max-w-full items-center gap-1.5 rounded border border-border bg-background/70 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={url}
        >
          <Globe2 className="h-3 w-3 shrink-0" />
          <span className="min-w-0 truncate">Open Preview</span>
          <span className="max-w-48 truncate font-mono text-[10px] text-muted-foreground/70">
            {url}
          </span>
        </button>
      ))}
    </div>
  );
});

const AssistantBlock = memo(function AssistantBlock({
  text,
  children,
}: {
  text: unknown;
  children?: React.ReactNode;
}) {
  const normalizedText = normalizeMarkdownText(text);
  return (
    <div className="space-y-2">
      <div className="prose prose-invert prose-sm max-w-none overflow-x-auto break-words">
        <ReactMarkdown components={markdownComponents} remarkPlugins={remarkPlugins} urlTransform={controllerUrlTransform}>
          {normalizedText}
        </ReactMarkdown>
      </div>
      {children}
    </div>
  );
});

const ReasoningBlock = memo(function ReasoningBlock({ text }: { text: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const normalizedText = normalizeMarkdownText(text);
  const preview = normalizedText.replace(/\s+/g, " ").trim();

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left min-w-0 hover:bg-muted/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        )}
        <span className="shrink-0 text-xs text-muted-foreground/80">
          thought
        </span>
        {!expanded && preview && (
          <span className="min-w-0 truncate text-xs text-muted-foreground/60">
            {preview.slice(0, 120)}
            {preview.length > 120 ? "..." : ""}
          </span>
        )}
      </button>
      {expanded && (
        <div className="px-4 py-2 bg-background/30">
          <div className="prose prose-invert prose-sm max-w-none overflow-x-auto break-words text-muted-foreground/80 text-[13px]">
            <ReactMarkdown components={markdownComponents} remarkPlugins={remarkPlugins} urlTransform={controllerUrlTransform}>
              {normalizedText}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
});

const BrowserToolRow = memo(function BrowserToolRow({ call }: { call: BrowserToolCall }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left min-w-0 hover:bg-muted/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        )}
        <Globe2 className="h-3 w-3 shrink-0 text-primary/80" />
        <span className="shrink-0 font-mono text-xs text-muted-foreground/80">Browser</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground/60">
          {call.summary}
        </span>
      </button>
      {expanded && (
        <pre className="px-4 py-2 text-[11px] text-muted-foreground/80 font-mono whitespace-pre-wrap overflow-x-auto bg-background/30">
          {call.raw}
        </pre>
      )}
    </div>
  );
});

const ToolCallRow = memo(function ToolCallRow({
  input,
  inputPreview,
  tool,
}: {
  input?: Record<string, unknown>;
  inputPreview: string;
  tool: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const toolLabel = truncateInlineText(tool, 80);
  const browserCall = parseBrowserToolCall(input);
  const diffFiles = parseDiffFromToolCall(tool, input);
  const hasDiff = diffFiles.length > 0;

  if (browserCall) {
    return <BrowserToolRow call={browserCall} />;
  }

  if (hasDiff) {
    return <DiffBlock files={diffFiles} />;
  }

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left min-w-0 hover:bg-muted/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        )}
        <span
          className="min-w-0 max-w-60 truncate font-mono text-xs text-muted-foreground/80"
          title={tool}
        >
          {toolLabel}
        </span>
        {!expanded && inputPreview && (
          <span className="min-w-0 truncate text-xs text-muted-foreground/60">
            {inputPreview}
          </span>
        )}
      </button>
      {expanded && input && (
        <pre className="px-4 py-2 text-[11px] text-muted-foreground/80 font-mono whitespace-pre-wrap overflow-x-auto bg-background/30">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
});

const ToolResultRow = memo(function ToolResultRow({
  content,
  isError,
  isLong,
  tool,
}: {
  content: string;
  isError: boolean;
  isLong: boolean;
  tool?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const toolLabel = tool ? truncateInlineText(tool, 80) : null;

  const t = tool?.toLowerCase();
  const isFileChangeResult = t === "filechange" || t === "file_change";
  if (isFileChangeResult) {
    try {
      const files = parseFileChangeDiff(JSON.parse(content) as Record<string, unknown>);
      if (files.some((f) => f.lines.length > 0)) return null;
    } catch {
      // Fall through to default rendering if content isn't parseable.
    }
  }

  const collapsedPreview = content.slice(0, 120) + (isLong ? "..." : "");

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left min-w-0 hover:bg-muted/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        )}
        <span
          className={`shrink-0 text-[10px] leading-none ${
            isError ? "text-red-400/80" : "text-muted-foreground/50"
          }`}
        >
          {isError ? "✗" : "↳"}
        </span>
        {tool && toolLabel && (
          <span
            className="min-w-0 max-w-60 truncate font-mono text-xs text-muted-foreground/80"
            title={tool}
          >
            {toolLabel}
          </span>
        )}
        {!expanded && (
          <span
            className={`min-w-0 truncate text-xs ${
              isError ? "text-red-400/80" : "text-muted-foreground/60"
            }`}
          >
            {collapsedPreview}
          </span>
        )}
      </button>
      {expanded && (
        <pre className="px-4 py-2 text-[11px] text-muted-foreground/80 font-mono whitespace-pre-wrap overflow-x-auto max-h-96 overflow-y-auto bg-background/30">
          {content}
        </pre>
      )}
      <PreviewUrlActions content={content} />
    </div>
  );
});

const WorkingChildEvent = memo(function WorkingChildEvent({ event }: { event: AgentEvent }) {
  const data = event.data;

  if (event.type === "tool_call") {
    const tool = data.tool as string | undefined;
    const input = data.input as Record<string, unknown> | undefined;
    if (!tool) return null;
    return (
      <ToolCallRow
        input={input}
        inputPreview={buildToolInputPreview(input)}
        tool={tool}
      />
    );
  }

  if (event.type === "tool_result") {
    const tool = data.tool as string | undefined;
    const content = normalizeToolResultContent(data.content);
    const isError = data.isError as boolean | undefined;
    if (!content) return null;
    return (
      <ToolResultRow
        content={content}
        isError={isError ?? false}
        isLong={content.length > 200}
        tool={tool}
      />
    );
  }

  if (
    event.type === "assistant_reasoning" ||
    event.type === "assistant.reasoning"
  ) {
    const text = normalizeMarkdownText(data.text ?? data.content);
    if (!text) return null;
    return <ReasoningBlock text={text} />;
  }

  if (event.type === "plan_updated") {
    const explanation = (data.explanation as string | null | undefined) ?? null;
    const plan = ((data.plan as PlanStep[] | undefined) ?? []).filter(Boolean);
    return <PlanUpdatedBlock explanation={explanation} plan={plan} />;
  }

  if (event.type === "policy_decision") {
    const decision = data.decision as string | undefined;
    if (decision === "allow") return null;
    const tool = data.tool as string | undefined;
    return (
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            <span className="text-purple-400">policy</span>
          </Badge>
          <span className="text-xs text-muted-foreground">
            {tool}: <span className="font-medium text-foreground">{decision}</span>
          </span>
        </div>
      </div>
    );
  }

  return null;
});

const WorkingChildStreamItem = memo(function WorkingChildStreamItem({ item }: { item: StreamItem }) {
  if (item.type === "tool_call") {
    return (
      <ToolCallRow
        input={item.input}
        inputPreview={buildToolInputPreview(item.input)}
        tool={item.name}
      />
    );
  }
  if (item.type === "tool_result") {
    return (
      <ToolResultRow
        content={item.content}
        isError={item.isError}
        isLong={item.content.length > 200}
        tool={item.name}
      />
    );
  }
  if (item.type === "reasoning") {
    return <ReasoningBlock text={item.text} />;
  }
  if (item.type === "plan_updated") {
    return <PlanUpdatedBlock explanation={item.explanation} plan={item.plan} />;
  }
  if (item.type === "plan_delta") {
    return (
      <div className="rounded-lg border border-border bg-card/70 px-4 py-3 text-sm text-muted-foreground">
        {item.delta}
      </div>
    );
  }
  return null;
});

function PlanUpdatedBlock({
  explanation,
  plan,
}: {
  explanation: string | null;
  plan: PlanStep[];
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="text-[10px]">
          <span className="text-emerald-400">plan</span>
        </Badge>
        <span className="text-xs text-muted-foreground">
          {plan.length} step{plan.length === 1 ? "" : "s"}
        </span>
      </div>
      {explanation ? (
        <p className="mt-3 text-sm text-muted-foreground">{explanation}</p>
      ) : null}
      <div className="mt-3 space-y-2">
        {plan.map((item, index) => (
          <div
            key={`${item.step}-${index}`}
            className="flex items-start gap-3 rounded-md border border-border/70 px-3 py-2"
          >
            <Badge
              variant="secondary"
              className="mt-0.5 shrink-0 text-[10px] uppercase"
            >
              {item.status.replace("_", " ")}
            </Badge>
            <span className="text-sm text-foreground">{item.step}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function UserInputRequestedBlock({
  answers,
  questions,
  onAnswerSelect,
  onDismiss,
  onSubmit,
  submitting = false,
}: {
  answers?: Record<string, string>;
  questions: UserInputQuestion[];
  onAnswerSelect?: (questionId: string, answer: string) => void;
  onDismiss?: () => void;
  onSubmit?: () => void;
  submitting?: boolean;
}) {
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);
  const activeQuestion = questions[activeQuestionIndex] ?? questions[0];
  const activeAnswer = activeQuestion ? answers?.[activeQuestion.id] ?? "" : "";
  const optionLabels = activeQuestion?.options.map((option) => option.label) ?? [];
  const customAnswer = activeAnswer && !optionLabels.includes(activeAnswer) ? activeAnswer : "";
  const allAnswered = questions.every((question) => Boolean(answers?.[question.id]?.trim()));
  const activeAnswered = Boolean(activeAnswer.trim());
  const isLastQuestion = activeQuestionIndex >= questions.length - 1;
  const isPlanApproval =
    activeQuestion.id === "claude_exit_plan_mode" ||
    activeQuestion.header.toLowerCase().includes("plan");
  const showCustomAnswer = Boolean(onAnswerSelect || customAnswer);

  useEffect(() => {
    setActiveQuestionIndex((index) => Math.min(index, Math.max(questions.length - 1, 0)));
  }, [questions.length]);

  if (!activeQuestion) return null;

  const handleContinue = () => {
    if (!isLastQuestion) {
      setActiveQuestionIndex((index) => index + 1);
      return;
    }
    onSubmit?.();
  };

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-[10px]">
            <span className="text-amber-400">waiting</span>
          </Badge>
          <span className="text-sm text-foreground">Agent requested user input</span>
        </div>
        {questions.length > 1 ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {activeQuestionIndex + 1} / {questions.length}
          </span>
        ) : null}
      </div>
      <div className="mt-3 rounded-md border border-border/70 p-3">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          {activeQuestion.header}
        </div>
        <div className="mt-1 text-sm text-foreground">{activeQuestion.question}</div>
        {activeQuestion.options.length > 0 ? (
          <div className="mt-3 space-y-2">
            {activeQuestion.options.map((option) => (
              <button
                key={`${activeQuestion.id}-${option.label}`}
                type="button"
                onClick={() => onAnswerSelect?.(activeQuestion.id, option.label)}
                disabled={!onAnswerSelect || submitting}
                className={`w-full rounded-md px-3 py-2 text-left transition-colors ${
                  activeAnswer === option.label
                    ? "bg-accent text-accent-foreground"
                    : "bg-background/70"
                } ${onAnswerSelect ? "hover:bg-accent/70" : "cursor-default"}`}
              >
                <div className="text-sm text-foreground">{option.label}</div>
                <div className="text-xs text-muted-foreground">{option.description}</div>
              </button>
            ))}
          </div>
        ) : null}
        {showCustomAnswer ? (
          <textarea
            value={customAnswer}
            onChange={(event) => onAnswerSelect?.(activeQuestion.id, event.target.value)}
            disabled={!onAnswerSelect || submitting}
            rows={3}
            placeholder={
              isPlanApproval
                ? "Tell the agent what to do instead..."
                : "Or type your own answer..."
            }
            className="mt-3 min-h-20 w-full resize-y rounded-md border border-border bg-background/80 px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-amber-500/60 disabled:cursor-default disabled:opacity-70"
          />
        ) : null}
      </div>
      {onSubmit || onDismiss ? (
        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {onDismiss ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onDismiss}
                disabled={submitting}
              >
                Dismiss
              </Button>
            ) : null}
            {onSubmit ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setActiveQuestionIndex((index) => Math.max(index - 1, 0))}
                disabled={activeQuestionIndex === 0 || submitting}
              >
                Back
              </Button>
            ) : null}
          </div>
          {onSubmit ? (
            <Button
              type="button"
              size="sm"
              onClick={handleContinue}
              disabled={submitting || !activeAnswered || (isLastQuestion && !allAnswered)}
            >
              {submitting ? "Submitting..." : isLastQuestion ? "Continue" : "Next"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ToolApprovalBlock({
  toolName,
  input,
  onDecision,
  submitting = false,
}: {
  toolName: string;
  input: Record<string, unknown>;
  onDecision?: (decision: ToolApprovalDecision) => void;
  submitting?: boolean;
}) {
  // ExitPlanMode is an approve-the-plan gate, not a per-tool permission. Its
  // plan text already renders as an assistant message above, so the block only
  // carries the decision buttons.
  const isPlanApproval = toolName === "ExitPlanMode";
  const summary = isPlanApproval ? "" : describeApprovalInput(toolName, input);
  const disabled = !onDecision || submitting;

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="text-[10px]">
          <span className="text-amber-400">approval</span>
        </Badge>
        <span className="text-sm text-foreground">
          {isPlanApproval
            ? "Claude is ready to exit plan mode and implement"
            : `Claude wants to use ${toolName}`}
        </span>
      </div>
      {summary ? (
        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-md border border-border/70 bg-background/70 p-3 text-xs text-foreground">
          {summary}
        </pre>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {isPlanApproval ? (
          <>
            <Button size="sm" disabled={disabled} onClick={() => onDecision?.("allow_once")}>
              Approve &amp; implement
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => onDecision?.("deny")}
            >
              Keep planning
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" disabled={disabled} onClick={() => onDecision?.("allow_once")}>
              Allow once
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={() => onDecision?.("always_allow")}
            >
              Always allow
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => onDecision?.("deny")}
            >
              Deny
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** Best-effort one-line/-block summary of the action awaiting approval. */
function describeApprovalInput(
  toolName: string,
  input: Record<string, unknown>
): string {
  if (toolName === "Bash" && typeof input.command === "string") {
    return input.command;
  }
  if (
    (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") &&
    typeof input.file_path === "string"
  ) {
    return input.file_path;
  }
  try {
    const json = JSON.stringify(input, null, 2);
    return json && json !== "{}" ? json : "";
  } catch {
    return "";
  }
}

function ThreadStatusBlock({
  status,
  activeFlags,
}: {
  status: string;
  activeFlags: string[];
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="text-[10px]">
          <span className="text-cyan-400">thread</span>
        </Badge>
        <span className="text-sm text-foreground">{status}</span>
      </div>
      {activeFlags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {activeFlags.map((flag) => (
            <Badge key={flag} variant="secondary" className="text-[10px]">
              {flag}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ErrorBlock({ text }: { text: unknown }) {
  const normalizedText = normalizeMarkdownText(text);
  return (
    <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3">
      <div className="flex items-center gap-2">
        <Badge variant="destructive" className="shrink-0 text-[10px]">
          error
        </Badge>
        <span className="text-xs text-destructive-foreground">{normalizedText}</span>
      </div>
    </div>
  );
}

function CancelledBlock({ reason }: { reason: string }) {
  // Soft, non-error indicator for a cooperative run cancellation
  // (Anita SIGINT path, see coding-agent#66). Mirrors the muted
  // styling of a `run.completed` indicator so the user sees a single
  // clean "Run cancelled" line and *not* a red error banner.
  const label = `Run cancelled${reason ? ` · ${reason}` : ""}`;
  return (
    <div className="flex items-center gap-2 py-1">
      <div className="h-px flex-1 bg-border" />
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function getSourceLanguage(filePath: string): string {
  const basename = filePath.split("/").pop()?.toLowerCase() ?? "";
  const extension = filePath.split(".").pop()?.toLowerCase();

  if (basename === ".env" || basename.endsWith(".env")) return "ini";
  if (basename === "dockerfile") return "bash";
  if (extension === "ts" || extension === "tsx") return "typescript";
  if (extension === "js" || extension === "jsx" || extension === "mjs" || extension === "cjs") return "javascript";
  if (extension === "css") return "css";
  if (extension === "scss" || extension === "sass") return "scss";
  if (extension === "html" || extension === "htm" || extension === "xml" || extension === "svg") return "xml";
  if (extension === "json") return "json";
  if (extension === "graphql" || extension === "gql") return "graphql";
  if (extension === "md" || extension === "mdx") return "markdown";
  if (extension === "sh" || extension === "bash" || extension === "zsh") return "bash";
  if (extension === "py") return "python";
  if (extension === "rs") return "rust";
  if (extension === "go") return "go";
  if (extension === "swift") return "swift";
  if (extension === "sql") return "sql";
  if (extension === "yml" || extension === "yaml") return "yaml";
  if (extension === "ini" || extension === "toml") return "ini";
  if (extension === "diff" || extension === "patch") return "diff";
  return "plaintext";
}

function SourceViewerPanel({
  projectId,
  preview,
  worktreeId,
  onOpenFile,
}: {
  projectId: string;
  preview: SourceFilePreview | null;
  worktreeId?: string;
  onOpenFile: (path: string) => void;
}) {
  const selectedLineRef = useRef<HTMLDivElement | null>(null);
  const selectedLine = preview?.line;
  const highlightedCode = preview
    ? hljs.highlight(preview.file.content, {
        language: getSourceLanguage(preview.file.path),
        ignoreIllegals: true,
      }).value
    : "";
  const highlightedLines = highlightedCode.split("\n");

  useEffect(() => {
    if (!preview || !selectedLine) return;
    window.setTimeout(() => {
      selectedLineRef.current?.scrollIntoView({ block: "center" });
    }, 0);
  }, [preview, selectedLine]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex min-h-0 flex-1">
        <div className="w-56 shrink-0 overflow-y-auto border-r border-border bg-muted/10 py-2">
          <FileTree
            activePath={preview?.file.path}
            onOpenFile={onOpenFile}
            projectId={projectId}
            worktreeId={worktreeId}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
            <FileCode className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
              {preview ? (
                <>
                  {preview.file.relativePath}
                  {selectedLine ? <span className="text-muted-foreground">:{selectedLine}</span> : null}
                </>
              ) : (
                <span className="font-sans text-muted-foreground">Select a file</span>
              )}
            </div>
          </div>
          {preview ? (
            <div className="flex-1 overflow-auto py-3">
              <div className="min-w-max font-mono text-xs leading-5">
                {highlightedLines.map((line, index) => {
                  const lineNumber = index + 1;
                  const highlighted = lineNumber === selectedLine;
                  return (
                    <div
                      key={lineNumber}
                      ref={highlighted ? selectedLineRef : undefined}
                      className={`flex ${
                        highlighted ? "bg-amber-500/15" : "hover:bg-muted/20"
                      }`}
                    >
                      <span className="w-14 shrink-0 select-none border-r border-border/60 pr-3 text-right text-muted-foreground/50">
                        {lineNumber}
                      </span>
                      <span
                        className="whitespace-pre px-3"
                        dangerouslySetInnerHTML={{ __html: line || " " }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-muted-foreground">
              Choose a file from the tree.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FileTree({
  activePath,
  onOpenFile,
  projectId,
  worktreeId,
}: {
  activePath?: string;
  onOpenFile: (path: string) => void;
  projectId: string;
  worktreeId?: string;
}) {
  const [entriesByPath, setEntriesByPath] = useState<Record<string, SourceDirectoryEntry[]>>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set([""]));
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const entriesByPathRef = useRef(entriesByPath);
  const loadingPathsRef = useRef(loadingPaths);

  useEffect(() => {
    entriesByPathRef.current = entriesByPath;
  }, [entriesByPath]);

  useEffect(() => {
    loadingPathsRef.current = loadingPaths;
  }, [loadingPaths]);

  const loadDirectory = (dirPath: string) => {
    if (entriesByPathRef.current[dirPath] || loadingPathsRef.current.has(dirPath)) return;
    setError(null);
    setLoadingPaths((current) => new Set(current).add(dirPath));
    fetchSourceDirectory(projectId, dirPath || undefined, worktreeId)
      .then((entries) => {
        setEntriesByPath((current) => ({ ...current, [dirPath]: entries }));
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to list files");
      })
      .finally(() => {
        setLoadingPaths((current) => {
          const next = new Set(current);
          next.delete(dirPath);
          return next;
        });
      });
  };

  useEffect(() => {
    entriesByPathRef.current = {};
    loadingPathsRef.current = new Set();
    setEntriesByPath({});
    setExpandedPaths(new Set([""]));
    setLoadingPaths(new Set());
    setError(null);
  }, [projectId, worktreeId]);

  useEffect(() => {
    loadDirectory("");
  }, [projectId, worktreeId]);

  const toggleDirectory = (entry: SourceDirectoryEntry) => {
    const dirPath = entry.path;
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
        loadDirectory(dirPath);
      }
      return next;
    });
  };

  const renderEntries = (dirPath: string, depth: number): React.ReactNode => {
    const entries = entriesByPath[dirPath] ?? [];
    if (loadingPaths.has(dirPath) && entries.length === 0) {
      return (
        <div className="px-3 py-1.5 text-xs text-muted-foreground">
          Loading...
        </div>
      );
    }

    return entries.map((entry) => {
      const isDirectory = entry.type === "directory";
      const expanded = isDirectory && expandedPaths.has(entry.path);
      const active = !isDirectory && activePath === entry.path;
      return (
        <div key={entry.path}>
          <button
            type="button"
            onClick={() => {
              if (isDirectory) {
                toggleDirectory(entry);
              } else {
                onOpenFile(entry.path);
              }
            }}
            className={`flex h-7 w-full min-w-0 items-center gap-1.5 px-2 pr-3 text-left text-xs transition-colors ${
              active
                ? "bg-accent/40 text-foreground"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            }`}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            title={entry.relativePath}
          >
            {isDirectory ? (
              expanded ? (
                <FolderOpen className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <Folder className="h-3.5 w-3.5 shrink-0" />
              )
            ) : (
              <FileText className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="min-w-0 truncate">{entry.name}</span>
          </button>
          {expanded ? renderEntries(entry.path, depth + 1) : null}
        </div>
      );
    });
  };

  return (
    <div>
      <div className="px-3 pb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
        Explorer
      </div>
      {error ? (
        <div className="mx-2 mb-2 rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      {renderEntries("", 0)}
    </div>
  );
}

/*
 * Preview chrome (URL bar, status, empty state). The live `<webview>` itself is
 * owned by the app-level `PreviewBrowserProvider` and overlaid onto the
 * `placeholderRef` element so it survives session/worktree switches (issue #158).
 */
function PreviewPanel({
  projectRoot,
  state,
  onClear,
  onOpenUrl,
  onReload,
  onSetInput,
  placeholderRef,
}: {
  projectRoot?: string;
  state: PreviewPaneState;
  onClear: () => void;
  onOpenUrl: (url: string) => void;
  onReload: () => void;
  onSetInput: (input: string) => void;
  // Region the pool sizes/positions the live webview over.
  placeholderRef: (element: HTMLDivElement | null) => void;
}) {
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    onOpenUrl(state.input);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <form
        onSubmit={submit}
        className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-[#1c1c1e] px-2"
      >
        <Globe2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          value={state.input}
          onChange={(event) => onSetInput(event.target.value)}
          placeholder="https://example.com, localhost:5173, or project file path"
          className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
        />
        <button
          type="submit"
          className="h-7 shrink-0 rounded border border-border bg-background px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          Open
        </button>
        <button
          type="button"
          onClick={onReload}
          disabled={!state.url}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/20 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          title="Reload preview"
          aria-label="Reload preview"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${state.loading ? "animate-spin" : ""}`} />
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={!state.url}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/20 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          title="Close preview"
          aria-label="Close preview"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </form>
      {state.error ? (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {state.error}
        </div>
      ) : null}
      {state.title || state.url ? (
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border px-3 text-[11px] text-muted-foreground">
          <span className="min-w-0 truncate">{state.title ?? state.url}</span>
          {projectRoot ? (
            <span className="hidden shrink-0 text-muted-foreground/50 lg:inline">
              Web URLs and project files
            </span>
          ) : null}
        </div>
      ) : null}
      <div ref={placeholderRef} className="relative min-h-0 flex-1">
        {!state.url && (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="max-w-sm">
              <Globe2 className="mx-auto mb-3 h-7 w-7 text-muted-foreground/60" />
              <div className="text-sm font-medium text-foreground">No preview open</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Open a web URL or an HTML/file path inside the active project.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AttachmentStrip({ attachments }: { attachments?: SessionAttachment[] }) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap justify-end gap-2">
      {attachments.map((attachment, index) => {
        const id = normalizeMarkdownText(attachment.id) || `attachment-${index}`;
        const name = normalizeMarkdownText(attachment.name) || "attachment";
        const mimeType = normalizeMarkdownText(attachment.mimeType);
        const path = normalizeMarkdownText(attachment.path);
        const url = normalizeMarkdownText(attachment.url);
        const size = typeof attachment.size === "number" ? attachment.size : Number.NaN;
        const canPreview = PREVIEWABLE_IMAGE_TYPES.has(mimeType);
        return (
        <div
          key={id}
          className="flex max-w-56 items-center gap-2 rounded-md border border-border/70 bg-background/70 px-2 py-1.5 text-xs"
          title={path}
        >
          {attachment.isImage && url && canPreview ? (
            <img
              src={url}
              alt=""
              className="h-8 w-8 shrink-0 rounded object-cover"
            />
          ) : (
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <div className="truncate text-foreground">{name}</div>
            {Number.isFinite(size) ? (
              <div className="text-[10px] text-muted-foreground">
                {formatBytes(size)}
              </div>
            ) : null}
          </div>
        </div>
        );
      })}
    </div>
  );
}

function ChangesPanel({
  localFiles,
  branchFiles,
  projectRoot,
}: {
  localFiles: DiffFile[];
  branchFiles: DiffFile[];
  projectRoot?: string;
}) {
  const hasBranch = branchFiles.length > 0;
  const [tab, setTab] = useState<"local" | "branch">("local");
  const activeFiles = tab === "branch" && hasBranch ? branchFiles : localFiles;
  const { added: localAdded, deleted: localDeleted } = summarizeDiffFiles(localFiles);
  const { added: branchAdded, deleted: branchDeleted } = summarizeDiffFiles(branchFiles);
  const hasLocal = localFiles.length > 0;

  return (
    <ProjectRootContext.Provider value={projectRoot}>
      <div className="flex flex-col h-full">
        {hasBranch && (
          <div className="flex shrink-0 items-center gap-1 px-2 pt-2 pb-1">
            <button
              onClick={() => hasLocal && setTab("local")}
              disabled={!hasLocal}
              className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                !hasLocal
                  ? "text-muted-foreground/40 cursor-not-allowed"
                  : tab === "local"
                  ? "bg-accent/40 text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Local
              <span className="font-mono text-[10px] text-muted-foreground/40">
                <span className={hasLocal ? "text-green-400/90" : ""}>+{localAdded}</span>{" "}
                <span className={hasLocal ? "text-red-400/90" : ""}>-{localDeleted}</span>
              </span>
            </button>
            <button
              onClick={() => setTab("branch")}
              className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                tab === "branch" ? "bg-accent/40 text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Branch
              <span className="font-mono text-[10px] text-muted-foreground/70">
                <span className="text-green-400/90">+{branchAdded}</span>{" "}
                <span className="text-red-400/90">-{branchDeleted}</span>
              </span>
            </button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto py-2 px-3 space-y-2">
          {activeFiles.length === 0 ? (
            <p className="px-1 pt-1 text-xs text-muted-foreground/50">No changes</p>
          ) : activeFiles.map((file) => (
            <DiffBlock key={file.path} files={[file]} />
          ))}
        </div>
      </div>
    </ProjectRootContext.Provider>
  );
}

export function SessionView({
  projectId,
  sessionId,
  worktreeId,
  project,
  onSessionCreated,
  onBackgroundComplete,
  onOpenConversation,
  controllerMode = false,
  focusPosition,
  onFocusDone,
  onFocusSkip,
  onFocusExit,
  onFocusPinnedChange,
  onTitleChange,
  onFocusAdvanceAfterSend,
  focusAdvanceCountdown = null,
  onArchive,
  onDiffSummary,
}: SessionViewProps) {
  const [message, setMessage] = useState("");
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<SessionAttachment[]>([]);
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  // True while this component has its own live SSE for the viewed session.
  // Distinct from `streaming`, which stays true across server-driven queue
  // draining (when there's no own SSE). The event poller keys off this so it
  // engages once our SSE closes but the run continues server-side (#113).
  const [ownStreamActive, setOwnStreamActive] = useState(false);
  // Messages enqueued while a run is streaming (replayed one-at-a-time on
  // clean completion). The server is the source of truth; this mirrors it
  // for rendering. See issue #113.
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  // Stable view of `queue` for use inside stream-event closures.
  const queueRef = useRef<QueuedMessage[]>([]);
  // True while a Claude/Anita "steer" is stopping the current run and
  // resuming with the steer text. The composer is disabled during this
  // transition so a second steer can't race the stop+resume.
  const [steerInProgress, setSteerInProgress] = useState(false);
  const steerInProgressRef = useRef(false);
  // Carries the steer text across the stop -> stream-close -> resume hop
  // for emulated (Claude/Anita) steering.
  const pendingSteerRef = useRef<string | null>(null);
  const [queuedStreamStart, setQueuedStreamStart] = useState<QueuedStreamStart | null>(null);
  const [streamItems, setStreamItems] = useState<StreamItem[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedReasoningEffort, setSelectedReasoningEffort] =
    useState<ReasoningEffort>("medium");
  const [selectedServiceTier, setSelectedServiceTier] =
    useState<ServiceTier>("flex");
  const [selectedMode, setSelectedMode] = useState<"default" | "plan">("default");
  const [isFocusPinned, setIsFocusPinned] = useState(false);
  const [sessionTitle, setSessionTitle] = useState<string | undefined>();
  const [titleDialogOpen, setTitleDialogOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showReasoningEffortPicker, setShowReasoningEffortPicker] = useState(false);
  const [activeStreamSessionId, setActiveStreamSessionId] = useState<string | null>(sessionId ?? null);
  const [agentProviders, setAgentProviders] = useState<AgentProviderInfo[]>([]);
  const [agents, setAgents] = useState<import("../api.ts").AgentStatus[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [providerLoadError, setProviderLoadError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string>("anita");
  const [providerResolved, setProviderResolved] = useState(!sessionId);
  const [showProviderPicker, setShowProviderPicker] = useState(false);
  const initialTerminalState = loadStoredTerminals(projectId, worktreeId);
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>(initialTerminalState.tabs);
  const [activeTerminalId, setActiveTerminalId] = useState<string>(initialTerminalState.activeId);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const rightPanelResize = useResizablePanel({
    storageKey: "rightPanelWidth",
    defaultWidth: Math.round(window.innerWidth / 2),
    minWidth: 280,
    maxWidth: Math.round(window.innerWidth * 0.75),
    invert: true,
  });
  const [runScriptPending, setRunScriptPending] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("agent");
  const [rightTab, setRightTab] = useState<RightPanelTab>("terminal");
  const [gitDiffFiles, setGitDiffFiles] = useState<DiffFile[]>([]);
  const [gitDiffLoaded, setGitDiffLoaded] = useState(false);
  const [branchDiffFiles, setBranchDiffFiles] = useState<DiffFile[]>([]);
  // Mirror the diff totals to the parent so it can render the same
  // `+X -Y` chip in surfaces SessionView doesn't own (the mobile top
  // header in App.tsx). Null when there's no session or no changes.
  const diffSummary = useMemo(
    () => {
      if (!sessionId) return null;
      const { added, deleted } = summarizeDiffFiles(
        gitDiffFiles.length > 0 ? gitDiffFiles : branchDiffFiles,
      );
      if (added === 0 && deleted === 0) return null;
      return { added, deleted };
    },
    [sessionId, gitDiffFiles, branchDiffFiles],
  );
  useEffect(() => {
    onDiffSummary?.(diffSummary);
  }, [diffSummary, onDiffSummary]);
  const [userInputDraft, setUserInputDraft] = useState<Record<string, string>>({});
  const [submittingUserInput, setSubmittingUserInput] = useState(false);
  const [submittingApprovalId, setSubmittingApprovalId] = useState<string | null>(null);
  const [activeWorktree, setActiveWorktree] = useState<Worktree | null>(null);
  const [sourcePreview, setSourcePreview] = useState<SourceFilePreview | null>(null);
  // Element the app-level preview pool overlays the live `<webview>` onto. Set
  // by `PreviewPanel` only while the Preview tab is visible (issue #158).
  const [previewPlaceholder, setPreviewPlaceholder] = useState<HTMLDivElement | null>(null);
  // Slash-command skills. The list is fetched for the current provider +
  // worktree; `activeSkills` is the ordered stack that gets sent on the next
  // message (the chip row + autocomplete popover UI is driven by these). The
  // first skill rides through the single-valued `skillName` transport; the
  // rest ride as `[/skill: name]` markers prepended to the message text.
  const [availableSkills, setAvailableSkills] = useState<AgentSkill[]>([]);
  const [activeSkills, setActiveSkills] = useState<AgentSkill[]>([]);
  const [skillPopoverOpen, setSkillPopoverOpen] = useState(false);
  const [skillHighlightIndex, setSkillHighlightIndex] = useState(0);
  // Ref to the highlighted skill option so keyboard navigation can scroll it
  // into view when the selection moves past the scrollable viewport (#216).
  const highlightedSkillRef = useRef<HTMLButtonElement | null>(null);
  // Caret position in the composer, used to scan the token under the caret so
  // the `/` picker opens from any position (not only the start of the input).
  const [caretPos, setCaretPos] = useState(0);
  // Caret to restore after a chip is applied and the textarea value changes.
  const pendingCaretRef = useRef<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const terminalRef = useRef<TerminalHandle | null>(null);
  const terminalRefs = useRef<Record<string, TerminalHandle | null>>({});
  const terminalTabsSavePendingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hadVisibleFocusAdvanceRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const reasoningEffortPickerRef = useRef<HTMLDivElement>(null);
  const providerPickerRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const streamingRef = useRef(streaming);
  const pendingAttachedSessionIdRef = useRef<string | null>(null);
  // Set when a focus-mode send originates from the new-thread composer
  // (no `sessionId` yet). The advance can't be scheduled until the stream
  // attaches and the brand-new session id is known (issue #120).
  const focusAdvanceOnAttachRef = useRef(false);
  const currentViewRef = useRef({
    projectId,
    worktreeId,
    sessionId,
  });
  const sendContextRef = useRef<{
    projectId: string;
    worktreeId?: string;
    sessionId?: string;
  } | null>(null);
  const viewMatchesStreamContext = (context: typeof sendContextRef.current) => {
    if (!context) return false;
    const currentView = currentViewRef.current;
    return (
      currentView.projectId === context.projectId &&
      currentView.worktreeId === context.worktreeId &&
      currentView.sessionId === context.sessionId
    );
  };
  const targetMatchesStreamContext = (
    context: typeof sendContextRef.current,
    target: { projectId: string; worktreeId?: string; sessionId?: string }
  ) => {
    if (!context) return false;
    return (
      target.projectId === context.projectId &&
      target.worktreeId === context.worktreeId &&
      target.sessionId === context.sessionId
    );
  };
  const selectedProviderIsAvailable = agentProviders.some(
    (provider) => provider.id === selectedProvider
  );
  const providerReady = !!sessionId || (providersLoaded && selectedProviderIsAvailable);
  const providerSupportsPlanMode = supportsPlanMode(selectedProvider);
  const providerSupportsReasoningEffort = supportsReasoningEffort(selectedProvider);
  const providerSupportsServiceTier = supportsServiceTier(selectedProvider);
  const providerUsesNativeSteering = usesNativeSteering(selectedProvider);
  const providerSupportsAttachments = supportsAttachments(selectedProvider);
  const selectedModelEntry = models.find((m) => m.id === selectedModel);
  const modelSupportsAttachments = modelAcceptsAttachments(selectedModelEntry);
  const providerUsesImplicitAttachmentTypes =
    selectedProvider === "codex" || selectedProvider === "claude";
  const modelSupportsImages =
    providerUsesImplicitAttachmentTypes ||
    selectedModelEntry?.capabilities?.images === true;
  const modelSupportsFiles =
    providerUsesImplicitAttachmentTypes ||
    selectedModelEntry?.capabilities?.files === true;
  // Restrict the file picker to the mime types the selected model can accept.
  // For providers without per-model capabilities (codex/claude) we keep the
  // full list. For Anita models we filter down to whatever `anita models --json`
  // reports.
  const attachmentAcceptMimeTypes: string[] = (() => {
    if (!providerSupportsAttachments) return [];
    if (!selectedModelEntry) {
      return selectedProvider === "anita" ? [] : Array.from(SUPPORTED_ATTACHMENT_TYPES);
    }
    if (selectedProvider === "anita" && !selectedModelEntry.capabilities) return [];
    const types: string[] = [];
    for (const mimeType of SUPPORTED_ATTACHMENT_TYPES) {
      if (isImageMimeType(mimeType) && !modelSupportsImages) continue;
      if (!isImageMimeType(mimeType) && !modelSupportsFiles) continue;
      types.push(mimeType);
    }
    return types;
  })();
  const canAttachMore = providerSupportsAttachments && modelSupportsAttachments;
  const previewAvailable = isControllerAvailable();
  const previewProjectRoot = activeWorktree?.path ?? project?.path;
  const shouldPollChanges = terminalOpen || rightTab === "changes" || mobilePanel === "changes";
  const providerStatusMessage =
    !sessionId && providerLoadError
      ? providerLoadError
      : !sessionId && providersLoaded && !selectedProviderIsAvailable
      ? "Selected agent provider is unavailable. Retry provider discovery."
      : null;
  const reasoningEffortOptions =
    selectedProvider === "claude"
      ? REASONING_EFFORT_OPTIONS.filter((option) =>
          CLAUDE_REASONING_EFFORTS.has(option.value)
        )
      : REASONING_EFFORT_OPTIONS;
  const terminalStorageKey = buildTerminalStorageKey(projectId, worktreeId);

  useEffect(() => {
    let cancelled = false;
    const stored = loadStoredTerminals(projectId, worktreeId);
    setTerminalTabs(stored.tabs);
    setActiveTerminalId(stored.activeId);
    terminalRef.current = terminalRefs.current[stored.activeId] ?? null;

    fetchTerminalTabs(projectId, worktreeId)
      .then((serverTabs) => {
        if (cancelled) return;
        const normalizedServerTabs = normalizeTerminalTabs(serverTabs);
        const shouldMigrateLocalTabs =
          normalizedServerTabs.length === 1 &&
          normalizedServerTabs[0].id === DEFAULT_TERMINAL_ID &&
          stored.tabs.some((tab) => tab.id !== DEFAULT_TERMINAL_ID);
        const nextTabs = shouldMigrateLocalTabs
          ? mergeTerminalTabs(normalizedServerTabs, stored.tabs)
          : normalizedServerTabs;

        setTerminalTabs(nextTabs);
        setActiveTerminalId((current) =>
          nextTabs.some((tab) => tab.id === current) ? current : nextTabs[0].id
        );

        if (shouldMigrateLocalTabs) {
          terminalTabsSavePendingRef.current = true;
          updateTerminalTabs(projectId, nextTabs, worktreeId).finally(() => {
            terminalTabsSavePendingRef.current = false;
          });
        }
      })
      .catch(() => {
        // Keep the local fallback when the shared terminal registry is unavailable.
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, worktreeId]);

  useEffect(() => {
    terminalRef.current = terminalRefs.current[activeTerminalId] ?? null;
  }, [activeTerminalId, terminalTabs]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        terminalStorageKey,
        JSON.stringify({ tabs: terminalTabs, activeId: activeTerminalId })
      );
    } catch {}
  }, [terminalStorageKey, terminalTabs, activeTerminalId]);

  useEffect(() => {
    let cancelled = false;

    const syncTerminalTabs = async () => {
      if (terminalTabsSavePendingRef.current) return;
      try {
        const nextTabs = normalizeTerminalTabs(await fetchTerminalTabs(projectId, worktreeId));
        if (cancelled) return;
        setTerminalTabs((current) => (terminalTabsEqual(current, nextTabs) ? current : nextTabs));
        setActiveTerminalId((current) =>
          nextTabs.some((tab) => tab.id === current) ? current : nextTabs[0].id
        );
      } catch {
        // Polling is best-effort; terminal tabs still work locally if this fails.
      }
    };

    const interval = window.setInterval(syncTerminalTabs, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [projectId, worktreeId]);

  const saveSharedTerminalTabs = (
    tabs: TerminalTab[],
    options?: { removeTerminalId?: string }
  ) => {
    terminalTabsSavePendingRef.current = true;
    updateTerminalTabs(projectId, tabs, worktreeId, options)
      .then((serverTabs) => {
        const normalizedTabs = normalizeTerminalTabs(serverTabs);
        setTerminalTabs((current) =>
          terminalTabsEqual(current, normalizedTabs) ? current : normalizedTabs
        );
        setActiveTerminalId((current) =>
          normalizedTabs.some((tab) => tab.id === current) ? current : normalizedTabs[0].id
        );
      })
      .catch(() => {
        // The local tab list remains usable; the next successful save/poll will converge.
      })
      .finally(() => {
        terminalTabsSavePendingRef.current = false;
      });
  };

  const handleTerminalRef = (terminalId: string, handle: TerminalHandle | null) => {
    terminalRefs.current[terminalId] = handle;
    if (terminalId === activeTerminalId) {
      terminalRef.current = handle;
    }
  };

  const handleAddTerminal = () => {
    const usedLabels = new Set(terminalTabs.map((tab) => tab.label));
    let nextNumber = terminalTabs.length + 1;
    while (usedLabels.has(`Terminal ${nextNumber}`)) nextNumber += 1;

    const nextTab = {
      id: makeTerminalId(),
      label: `Terminal ${nextNumber}`,
    };
    const nextTabs = [...terminalTabs, nextTab];
    setTerminalTabs(nextTabs);
    saveSharedTerminalTabs(nextTabs);
    setActiveTerminalId(nextTab.id);
    setRightTab("terminal");
    if (mobilePanel !== "agent") setMobilePanel("terminal");
  };

  const handleRunProjectScript = async () => {
    if (runScriptPending) return;
    setRunScriptPending(true);
    try {
      const result = await runProjectScript(projectId, worktreeId);
      const normalizedTabs = normalizeTerminalTabs(result.tabs);
      setTerminalTabs(normalizedTabs);
      setActiveTerminalId(result.terminalId);
      setRightTab("terminal");
      if (mobilePanel !== "agent") setMobilePanel("terminal");
      toast.success("Run script started");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to run project script");
    } finally {
      setRunScriptPending(false);
    }
  };

  const handleCloseTerminal = (terminalId: string) => {
    if (terminalTabs.length <= 1) return;
    terminalRefs.current[terminalId]?.close();
    const closingIndex = terminalTabs.findIndex((tab) => tab.id === terminalId);
    if (closingIndex === -1) return;
    const nextTabs = terminalTabs.filter((tab) => tab.id !== terminalId);
    if (activeTerminalId === terminalId) {
      const nextActive = nextTabs[Math.min(closingIndex, nextTabs.length - 1)] ?? nextTabs[0];
      setActiveTerminalId(nextActive.id);
    }
    setTerminalTabs(nextTabs);
    saveSharedTerminalTabs(nextTabs, { removeTerminalId: terminalId });
    terminalRefs.current[terminalId] = null;
  };

  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  useEffect(() => {
    debugSessionIsolation("view.mounted", { projectId, worktreeId, sessionId });
    return () => {
      debugSessionIsolation("view.unmounted", { projectId, worktreeId, sessionId });
    };
  }, [projectId, worktreeId, sessionId]);

  // While controller mode is active, drop the user straight into the composer
  // whenever the active session changes (entering controller mode, skipping to
  // the next pinned session, or marking the current one done). This keeps
  // the controller-mode triage loop keyboard-driven: the user can `Esc` out
  // of the input to fire a shortcut and is placed back at the keyboard the
  // moment the new session is ready.
  useEffect(() => {
    if (!controllerMode || !sessionId) return;
    const textarea = textareaRef.current;
    if (!textarea || textarea.disabled) return;
    textarea.focus();
  }, [sessionId, controllerMode]);

  useEffect(() => {
    const isOriginatingCountdown =
      Boolean(focusAdvanceCountdown) &&
      focusAdvanceCountdown?.sentFromSessionId === sessionId;
    const textarea = textareaRef.current;

    if (isOriginatingCountdown) {
      hadVisibleFocusAdvanceRef.current = true;
      if (document.activeElement === textarea) {
        textarea?.blur();
      }
      return;
    }

    if (
      hadVisibleFocusAdvanceRef.current &&
      controllerMode &&
      sessionId &&
      textarea &&
      !textarea.disabled
    ) {
      textarea.focus();
    }
    hadVisibleFocusAdvanceRef.current = false;
  }, [focusAdvanceCountdown, controllerMode, sessionId]);

  useEffect(() => {
    const isOriginatingCountdown =
      Boolean(focusAdvanceCountdown) &&
      focusAdvanceCountdown?.sentFromSessionId === sessionId;
    if (!isOriginatingCountdown || !focusAdvanceCountdown) return;

    const handleStayShortcut = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      event.stopPropagation();
      focusAdvanceCountdown.onCancel();
    };

    window.addEventListener("keydown", handleStayShortcut, true);
    return () => window.removeEventListener("keydown", handleStayShortcut, true);
  }, [focusAdvanceCountdown, sessionId]);


  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";

    const computedStyle = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(computedStyle.lineHeight) || 20;
    const borderHeight =
      Number.parseFloat(computedStyle.borderTopWidth) +
      Number.parseFloat(computedStyle.borderBottomWidth);
    const paddingHeight =
      Number.parseFloat(computedStyle.paddingTop) +
      Number.parseFloat(computedStyle.paddingBottom);
    const maxHeight =
      lineHeight * COMPOSER_MAX_LINES + paddingHeight + borderHeight;
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);

    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [message]);

  const attachToSession = (nextSessionId: string) => {
    debugSessionIsolation("stream.attachedToSession", {
      projectId,
      worktreeId,
      previousSessionId: sendContextRef.current?.sessionId,
      nextSessionId,
    });
    setActiveStreamSessionId(nextSessionId);
    sendContextRef.current = { projectId, worktreeId, sessionId: nextSessionId };
    if (currentViewRef.current.sessionId !== nextSessionId) {
      pendingAttachedSessionIdRef.current = nextSessionId;
      onSessionCreated(nextSessionId);
      // Server auto-pins every brand-new session to the focus queue
      // (issue #81). We just need to (a) reflect that locally so the
      // session chrome renders the right state and (b) nudge the
      // sidebar to refresh so the new pin shows up in the queue.
      // We deliberately do NOT call `pinSessionFocus` here: an explicit
      // pin would clobber the server's `userUnpinned` flag and could
      // re-pin a session the user has previously removed.
      setIsFocusPinned(true);
      onFocusPinnedChange?.();
      // A focus-mode send from the new-thread composer couldn't schedule
      // the advance at send time (no session id yet). Now that the brand-new
      // session is pinned and identified, schedule it (issue #120).
      if (focusAdvanceOnAttachRef.current) {
        focusAdvanceOnAttachRef.current = false;
        onFocusAdvanceAfterSend?.(nextSessionId);
      }
    }
  };

  const loadModels = (provider?: string, defaultModelId?: string | null) => {
    fetchModels(provider ?? selectedProvider)
      .then((m) => {
        setModels(m);
        setSelectedModel((prev) => {
          // When the caller supplies a saved default, prefer it over any prior
          // selection so the new-session composer starts from the user's setting.
          if (defaultModelId && m.some((model) => model.id === defaultModelId)) {
            return defaultModelId;
          }
          if (prev && m.some((model) => model.id === prev)) return prev;
          return m.length > 0 ? m[0].id : "";
        });

        // Surface a toast when the saved default is no longer in the agent's
        // current catalog. Only fire on the new-session screen and only when
        // we explicitly tried to apply a default.
        if (defaultModelId && !sessionId) {
          const fallbackModel = m[0];
          if (!m.some((model) => model.id === defaultModelId) && fallbackModel) {
            const agentName =
              agentProviders.find((p) => p.id === (provider ?? selectedProvider))?.name ??
              selectedProvider;
            toast.info(
              `Your default model for ${agentName} (${defaultModelId}) is no longer available. Using ${fallbackModel.name} for this session. Update it in Settings.`,
              { duration: 6000 }
            );
          }
        }
      })
      .catch(() => {});
  };

  const getAgentDefaultModel = (providerId: string): string | null => {
    return agents.find((a) => a.id === providerId)?.defaultModel ?? null;
  };

  const loadAgentProviders = () => {
    setProvidersLoaded(false);
    setProviderLoadError(null);
    Promise.all([fetchAgentProviders(), fetchAgents()])
      .then(([providers, agentsList]) => {
        setAgentProviders(providers);
        setAgents(agentsList);
        if (providers.length === 0) {
          setProviderLoadError("No agent providers were found. Check your CLI installs and retry.");
        }
        if (!sessionId) {
          setSelectedProvider((prev) =>
            providers.some((provider) => provider.id === prev) ? prev : providers[0]?.id ?? prev
          );
        }
      })
      .catch(() => {
        setAgentProviders([]);
        setAgents([]);
        setProviderLoadError("Could not load agent providers. Retry before starting a session.");
      })
      .finally(() => setProvidersLoaded(true));
  };

  useEffect(() => {
    if (providerResolved && providerReady) {
      const defaultModelId = sessionId ? undefined : getAgentDefaultModel(selectedProvider);
      loadModels(selectedProvider, defaultModelId);
    }
  }, [selectedProvider, providerResolved, providerReady, sessionId]);

  useEffect(() => {
    if (!providerSupportsPlanMode && selectedMode !== "default") {
      setSelectedMode("default");
    }
  }, [providerSupportsPlanMode, selectedMode]);

  useEffect(() => {
    if (!providerSupportsReasoningEffort) {
      setShowReasoningEffortPicker(false);
    }
  }, [providerSupportsReasoningEffort]);

  useEffect(() => {
    if (
      selectedProvider === "claude" &&
      !CLAUDE_REASONING_EFFORTS.has(selectedReasoningEffort)
    ) {
      setSelectedReasoningEffort("medium");
    }
  }, [selectedProvider, selectedReasoningEffort]);

  useEffect(() => {
    loadAgentProviders();
  }, [sessionId]);

  useEffect(() => {
    // Resolve the worktree for this view. When no worktreeId is passed we fall
    // back to the project's main worktree so downstream consumers (preview
    // browser key, project root) always have a concrete worktree id/path.
    fetchWorktrees(projectId)
      .then((wts) =>
        setActiveWorktree(
          worktreeId
            ? wts.find((w) => w.id === worktreeId) ?? null
            : wts.find((w) => w.isMain) ?? null
        )
      )
      .catch(() => {});
  }, [projectId, worktreeId]);

  // Slash-command skill catalog for the current provider + cwd. We don't
  // surface this on the very first paint (it's not blocking) and we always
  // re-fetch when the user switches provider or worktree so the chip and
  // autocomplete reflect whatever's installed in that worktree.
  useEffect(() => {
    if (!providerReady) {
      setAvailableSkills([]);
      setActiveSkills([]);
      return;
    }
    const cwd = activeWorktree?.path ?? project?.path ?? "";
    let cancelled = false;
    fetchAgentSkills(selectedProvider, cwd)
      .then((skills) => {
        if (cancelled) return;
        setAvailableSkills(skills);
        // Drop any active skills that no longer exist in the new catalog
        // (provider switch, worktree switch) so we don't send a stale name.
        setActiveSkills((current) =>
          current.filter((skill) =>
            skills.some((entry) => entry.name === skill.name)
          )
        );
      })
      .catch(() => {
        if (cancelled) return;
        setAvailableSkills([]);
        setActiveSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProvider, activeWorktree?.path, project?.path, providerReady]);

  // When loading an existing session, restore the provider and model that were used
  useEffect(() => {
    // While a focus-mode auto-advance countdown is pending and we
    // are still on the originating session, don't touch the
    // in-flight state. The session hasn't actually changed yet (the
    // parent is about to navigate in FOCUS_ADVANCE_COUNTDOWN_MS),
    // and clearing pendingMessage / pendingAttachments / events
    // here is what made the user's message look "lost" before the
    // fix in #104. Bail out and let the session-change effect run
    // when the advance actually commits.
    if (
      focusAdvanceCountdown &&
      focusAdvanceCountdown.sentFromSessionId === sessionId
    ) {
      return;
    }

    let cancelled = false;
    const viewingActiveStream = targetMatchesStreamContext(sendContextRef.current, {
      projectId,
      worktreeId,
      sessionId,
    });
    if (!viewingActiveStream) {
      setStreamItems([]);
      setPendingMessage(null);
      setPendingAttachments([]);
    }

    if (sessionId) {
      setProviderResolved(false);
      Promise.allSettled([
        fetchSession(projectId, sessionId, worktreeId),
        fetchEvents(projectId, sessionId, worktreeId),
        fetchActiveRuntimes(),
      ])
        .then(([sessionResult, eventsResult, runtimesResult]) => {
          if (cancelled) return;
          if (sessionResult.status === "fulfilled") {
            const session = sessionResult.value;
            setSelectedProvider(canonicalProviderId(session.provider));
            setSelectedMode(session.mode || "default");
            if (session.model) {
              setSelectedModel(session.model);
            }
            setSelectedReasoningEffort(session.reasoningEffort || "medium");
            setSelectedServiceTier(session.serviceTier || "flex");
            setIsFocusPinned(Boolean(session.focusPinnedAt));
            setSessionTitle(session.title);
            setTitleDialogOpen(false);
          }

          if (eventsResult.status === "fulfilled") {
            setEvents(eventsResult.value);
          } else {
            setEvents([]);
          }

          if (runtimesResult.status === "fulfilled") {
            const active = runtimesResult.value.some(
              (entry) => entry.sessionId === sessionId && entry.active,
            );
            setStreaming(active);
          } else {
            setStreaming(false);
          }
        })
        .finally(() => {
          if (!cancelled) setProviderResolved(true);
        });
    } else {
      setIsFocusPinned(false);
      setSessionTitle(undefined);
      setTitleDialogOpen(false);
      setEvents([]);
      setStreamItems([]);
      setStreaming(false);
      setProviderResolved(true);
      setSelectedMode("default");
      setSelectedReasoningEffort("medium");
      setSelectedServiceTier("flex");
      // Pre-select the saved default model for this provider when starting a
      // new session. If the saved default is no longer in the catalog, the
      // loadModels fallback will pick the first model and surface a toast.
      const defaultModelId = getAgentDefaultModel(selectedProvider);
      if (defaultModelId) {
        // Defer slightly so the provider effect has resolved models first, or
        // just call loadModels with the default to handle both cases.
        loadModels(selectedProvider, defaultModelId);
      }
    }
    setActiveStreamSessionId(sessionId ?? null);
    setUserInputDraft({});
    return () => {
      cancelled = true;
    };
  }, [projectId, sessionId, worktreeId, focusAdvanceCountdown]);

  // Open the rename dialog, seeding the draft with the current title.
  const openTitleDialog = useCallback(() => {
    if (!sessionId) return;
    setTitleDraft(sessionTitle ?? "");
    setTitleDialogOpen(true);
  }, [sessionId, sessionTitle]);

  // Persist the edited title from the rename dialog. Optimistically updates
  // local state and rolls back if the request fails.
  const commitTitle = useCallback(async () => {
    if (!sessionId) return;
    const next = titleDraft.trim();
    if (next === (sessionTitle ?? "")) {
      setTitleDialogOpen(false);
      return;
    }
    const previous = sessionTitle;
    setSavingTitle(true);
    setSessionTitle(next || undefined);
    try {
      await updateSessionTitle(projectId, sessionId, next, worktreeId);
      setTitleDialogOpen(false);
      // Let the parent refresh views (sidebar, focus queue) that cache the
      // title separately from this component.
      onTitleChange?.();
    } catch (err) {
      setSessionTitle(previous);
      toast.error(
        err instanceof Error ? err.message : "Failed to rename conversation",
      );
    } finally {
      setSavingTitle(false);
    }
  }, [projectId, sessionId, worktreeId, titleDraft, sessionTitle, onTitleChange]);

  // Reload the persisted message queue for whichever session this view is
  // bound to. The server owns the queue; this keeps the rendered list and
  // the "promote first enqueued to steer" shortcut in sync.
  const refreshQueue = useCallback(async () => {
    const targetSessionId = activeStreamSessionId ?? sessionId;
    if (!targetSessionId) {
      setQueue([]);
      return;
    }
    try {
      setQueue(await fetchSessionQueue(projectId, targetSessionId));
    } catch {
      // A missing/unreadable queue is treated as empty — non-fatal.
    }
  }, [projectId, activeStreamSessionId, sessionId]);

  useEffect(() => {
    void refreshQueue();
  }, [refreshQueue]);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  // Reflect server-driven runs for the viewed session. The server drains the
  // queue on its own (issue #113), so when it starts the next run we won't
  // have an EventSource for it — detect the active runtime here, flip into
  // the streaming state (the event poller then shows progress), and keep the
  // queue list fresh as it drains. We never set streaming false here; the
  // streaming-gated poller owns that.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const tick = async () => {
      if (eventSourceRef.current || streamingRef.current) {
        void refreshQueue();
        return;
      }
      try {
        const runtimes = await fetchActiveRuntimes();
        if (cancelled) return;
        const active = runtimes.some(
          (entry) => entry.sessionId === sessionId && entry.active
        );
        if (active) setStreaming(true);
        void refreshQueue();
      } catch {
        // Ignore transient polling failures.
      }
    };
    const interval = window.setInterval(tick, 2000);
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [sessionId, refreshQueue]);

  useEffect(() => {
    if (!sessionId) return;
    if (!streaming) return;
    // While our own SSE is feeding this view, let it drive updates. Once it
    // closes (e.g. the live turn ended but the server keeps draining the
    // queue), `ownStreamActive` flips false and this effect re-runs to poll
    // events for the server-driven runs (#113).
    if (
      ownStreamActive &&
      targetMatchesStreamContext(sendContextRef.current, {
        projectId,
        worktreeId,
        sessionId,
      })
    ) {
      return;
    }

    let cancelled = false;
    const interval = window.setInterval(async () => {
      try {
        const [evts, runtimes] = await Promise.all([
          fetchEvents(projectId, sessionId, worktreeId),
          fetchActiveRuntimes(),
        ]);
        if (cancelled) return;
        setEvents(evts);
        const isActive = runtimes.some(
          (entry) => entry.sessionId === sessionId && entry.active,
        );
        if (!isActive) {
          // An emulated steer (Claude/Anita) on a run this component is only
          // watching via polling — not its own SSE — resumes here once the
          // stopped process goes inactive.
          if (
            steerInProgressRef.current &&
            pendingSteerRef.current &&
            sessionId
          ) {
            const steerText = pendingSteerRef.current;
            pendingSteerRef.current = null;
            steerInProgressRef.current = false;
            setSteerInProgress(false);
            streamingRef.current = false;
            void startAgentStream(
              steerText,
              steerText,
              undefined,
              sessionId,
              undefined,
              undefined,
              { skillName: undefined }
            );
            return;
          }
          setStreaming(false);
          setPendingMessage(null);
          setPendingAttachments([]);
          setStreamItems([]);
        }
      } catch {
        if (!cancelled) {
          setStreaming(false);
        }
      }
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [projectId, sessionId, worktreeId, streaming, ownStreamActive]);

  // Track current session and manage stream visibility on session switch
  useEffect(() => {
    const prevSessionId = currentViewRef.current.sessionId;
    const prevProjectId = currentViewRef.current.projectId;
    const prevWorktreeId = currentViewRef.current.worktreeId;
    currentViewRef.current = {
      projectId,
      worktreeId,
      sessionId,
    };
    if (
      pendingAttachedSessionIdRef.current &&
      pendingAttachedSessionIdRef.current === sessionId
    ) {
      pendingAttachedSessionIdRef.current = null;
    }

    debugSessionIsolation("view.changed", {
      prevProjectId,
      prevWorktreeId,
      prevSessionId,
      projectId,
      worktreeId,
      sessionId,
      streamContext: sendContextRef.current,
      hasEventSource: !!eventSourceRef.current,
    });

    if (eventSourceRef.current && sendContextRef.current) {
      const viewingOriginStream = viewMatchesStreamContext(sendContextRef.current);

      if (!viewingOriginStream) {
        debugSessionIsolation("view.hidStreamingUi", {
          projectId,
          worktreeId,
          sessionId,
          streamContext: sendContextRef.current,
        });
        // Navigated away from the streaming session — hide streaming UI
        setStreaming(false);
        setPendingMessage(null);
        setPendingAttachments([]);
        setStreamItems([]);
      } else if (prevSessionId !== sessionId) {
        debugSessionIsolation("view.restoredStreamingUi", {
          projectId,
          worktreeId,
          sessionId,
        });
        // Navigated back to the streaming session — restore indicator
        setStreaming(true);
      }
    }
  }, [projectId, worktreeId, sessionId]);

  // Cleanup EventSource on unmount
  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  useEffect(() => {
    stickToBottomRef.current = true;
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, [sessionId]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events, streamItems]);

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 80;
  };

  // Poll git diff for the Changes tab
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchGitDiff(projectId, worktreeId)
        .then(({ diff }) => {
          if (!cancelled) {
            setGitDiffFiles(parseFullGitDiff(diff));
            setGitDiffLoaded(true);
          }
        })
        .catch(() => { if (!cancelled) setGitDiffLoaded(true); });
    };
    load();
    if (!shouldPollChanges) {
      return () => { cancelled = true; };
    }
    const interval = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [projectId, worktreeId, shouldPollChanges]);

  // Poll branch diff for the Changes tab (PR view)
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchBranchDiff(projectId, worktreeId)
        .then(({ diff }) => { if (!cancelled) setBranchDiffFiles(parseFullGitDiff(diff)); })
        .catch(() => {});
    };
    load();
    if (!shouldPollChanges) {
      return () => { cancelled = true; };
    }
    const interval = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [projectId, worktreeId, shouldPollChanges]);

  // Auto-switch away from Changes tab when there are no changes
  useEffect(() => {
    if (gitDiffLoaded && gitDiffFiles.length === 0 && branchDiffFiles.length === 0 && rightTab === "changes") {
      setRightTab("terminal");
      if (mobilePanel === "changes") setMobilePanel("terminal");
    }
  }, [gitDiffLoaded, gitDiffFiles.length, branchDiffFiles.length, rightTab, mobilePanel]);

  const addComposerFiles = (files: FileList | File[]) => {
    const nextFiles = Array.from(files);
    if (nextFiles.length === 0) return;
    setAttachmentError(null);

    setComposerAttachments((prev) => {
      const next = [...prev];
      let totalSize = next.reduce((sum, item) => sum + item.file.size, 0);
      for (const file of nextFiles) {
        const fileName = getFileDisplayName(file);
        const mimeType = getFileMimeType(file);
        if (next.length >= MAX_ATTACHMENT_COUNT) {
          setAttachmentError(`Attach up to ${MAX_ATTACHMENT_COUNT} files`);
          break;
        }
        if (!SUPPORTED_ATTACHMENT_TYPES.has(mimeType)) {
          setAttachmentError(`${fileName} is not a supported file type`);
          continue;
        }
        if (isImageMimeType(mimeType) && !modelSupportsImages) {
          setAttachmentError(
            `The selected model does not support image attachments`
          );
          continue;
        }
        if (!isImageMimeType(mimeType) && !modelSupportsFiles) {
          setAttachmentError(
            `The selected model does not support file attachments`
          );
          continue;
        }
        if (file.size > MAX_ATTACHMENT_SIZE) {
          setAttachmentError(`${fileName} is larger than 15 MB`);
          continue;
        }
        if (totalSize + file.size > MAX_ATTACHMENT_TOTAL_SIZE) {
          setAttachmentError("Attachments are larger than 35 MB total");
          break;
        }
        totalSize += file.size;
        next.push({
          id: `${fileName}-${file.size}-${file.lastModified}-${makeClientId("attachment")}`,
          file,
          previewUrl: PREVIEWABLE_IMAGE_TYPES.has(mimeType)
            ? URL.createObjectURL(file)
            : undefined,
        });
      }
      return next;
    });
  };

  const removeComposerAttachment = (id: string) => {
    setComposerAttachments((prev) => {
      const target = prev.find((attachment) => attachment.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((attachment) => attachment.id !== id);
    });
  };

  const uploadComposerAttachments = async () => {
    if (composerAttachments.length === 0) return [];
    const uploads = await Promise.all(
      composerAttachments.map(async ({ file }) => ({
        name: getFileDisplayName(file),
        mimeType: getFileMimeType(file),
        size: file.size,
        data: await fileToBase64(file),
      }))
    );
    return uploadSessionAttachments(projectId, uploads, worktreeId);
  };

  // Slash-command filtering. The popover opens whenever the token under the
  // caret looks like a `/<skill>` invocation (any position, not only the
  // start of the input). Typing more after `/` narrows the list to skills
  // whose name *starts with* the typed token; an empty filter shows every
  // skill.
  const skillQuery = useMemo(
    () => parseSkillTokenAtCaret(message, caretPos),
    [message, caretPos]
  );
  const isSkillActive = useCallback(
    (skill: AgentSkill) => activeSkills.some((s) => s.name === skill.name),
    [activeSkills]
  );
  const filteredSkills = useMemo(() => {
    if (skillQuery === null) return [];
    // Every skill in `availableSkills` is now user-invokable. The
    // server sorts the list by scope (`unified` → `user`/`repo`/`system`
    // → `controller`), so the picker groups them visually via the scope
    // badge rendered next to the name.
    const needle = skillQuery.token.toLowerCase();
    if (!needle) return availableSkills;
    return availableSkills.filter((entry) =>
      entry.name.toLowerCase().startsWith(needle)
    );
  }, [availableSkills, skillQuery]);
  // Popover visibility: open while a `/` query is in progress and at least
  // one candidate exists. Keep the highlight index in range whenever the
  // filtered list changes.
  useEffect(() => {
    if (skillQuery !== null && filteredSkills.length > 0) {
      setSkillPopoverOpen(true);
      setSkillHighlightIndex((current) =>
        Math.min(current, filteredSkills.length - 1)
      );
    } else {
      setSkillPopoverOpen(false);
    }
  }, [skillQuery, filteredSkills.length]);
  // Keep the highlighted option visible as arrow keys move the selection past
  // the scrollable viewport (#216). `nearest` avoids jumping the list when the
  // item is already on screen.
  useEffect(() => {
    if (!skillPopoverOpen) return;
    highlightedSkillRef.current?.scrollIntoView({ block: "nearest" });
  }, [skillHighlightIndex, skillPopoverOpen]);

  /**
   * Add the chosen skill to the active stack and strip the in-progress
   * `/<token>` from the textarea. Adding the same skill twice is a no-op.
   * Returns the cleaned message so the keyboard handler can reuse it for the
   * exact-match submit path.
   */
  const addSkillToStack = useCallback(
    (skill: AgentSkill): string | null => {
      if (skillQuery === null) return null;
      const { message: newMessage, caret } = removeSkillToken(message, skillQuery);
      setMessage(newMessage);
      pendingCaretRef.current = caret;
      setActiveSkills((prev) =>
        prev.some((s) => s.name === skill.name) ? prev : [...prev, skill]
      );
      setSkillPopoverOpen(false);
      textareaRef.current?.focus();
      return newMessage;
    },
    [skillQuery, message]
  );

  const removeSkill = useCallback((index: number) => {
    setActiveSkills((prev) => prev.filter((_, i) => i !== index));
    textareaRef.current?.focus();
  }, []);

  const clearAllSkills = useCallback(() => {
    setActiveSkills([]);
    textareaRef.current?.focus();
  }, []);

  // Restore the caret after a chip is applied: `addSkillToStack` updates the
  // textarea value, so the cursor must be repositioned once React re-renders.
  useEffect(() => {
    const pos = pendingCaretRef.current;
    if (pos === null || !textareaRef.current) return;
    pendingCaretRef.current = null;
    textareaRef.current.selectionStart = pos;
    textareaRef.current.selectionEnd = pos;
    setCaretPos(pos);
  }, [message]);

  // Submit-after-chip effect: when the user adds a skill via an exact
  // `/<skill>` match (or Shift+Enter), the keyboard handler adds the skill to
  // the stack, sets `pendingSkillSubmit`, and React re-renders. This effect
  // then runs after the render so `activeSkills` and `message` reflect the
  // updated stack, and submits the turn in one keystroke.
  const [pendingSkillSubmit, setPendingSkillSubmit] = useState<
    { text: string } | null
  >(null);
  useEffect(() => {
    if (!pendingSkillSubmit) return;
    const { text } = pendingSkillSubmit;
    // Clear before submitting so a re-render from startAgentStream's
    // state updates doesn't try to submit again. `sendComposerMessage`
    // validates/uploads attachments and clears the composer on success, so
    // the add-and-submit path keeps any selected files (and the full skill
    // stack now reflected in `activeSkills`).
    setPendingSkillSubmit(null);
    void sendComposerMessage(text);
  }, [pendingSkillSubmit]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        modelPickerRef.current &&
        !modelPickerRef.current.contains(e.target as Node)
      ) {
        setShowModelPicker(false);
      }
      if (
        reasoningEffortPickerRef.current &&
        !reasoningEffortPickerRef.current.contains(e.target as Node)
      ) {
        setShowReasoningEffortPicker(false);
      }
      if (
        providerPickerRef.current &&
        !providerPickerRef.current.contains(e.target as Node)
      ) {
        setShowProviderPicker(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const startAgentStream = async (
    sentMessage: string,
    pendingVisibleMessage = sentMessage,
    modeOverride?: "default" | "plan",
    resumeSessionIdOverride?: string,
    attachmentIds?: string[],
    visibleAttachments?: SessionAttachment[],
    // Replay overrides for queued/steer continuations. When provided, the
    // run uses these params (and explicit skill) instead of the composer's
    // current selection, and skips focus auto-advance — a continuation is
    // not a fresh user send.
    runOverrides?: {
      provider?: string;
      model?: string;
      reasoningEffort?: ReasoningEffort;
      serviceTier?: ServiceTier;
      skillName?: string;
    }
  ) => {
    if (!sentMessage.trim() || streamingRef.current) return false;
    if (!providerReady) {
      setProviderLoadError(
        providerLoadError ?? "Could not start because agent providers are not ready. Retry provider discovery."
      );
      return false;
    }

    // In controller mode, signal the parent to advance to the next focus
    // item as soon as the user commits to a message. The parent owns
    // the navigation logic and the "stay put if the only pinned item
    // is the one we just sent to" rule (issue #81 follow-up).
    // Continuations (queued replay / emulated steer) never advance focus.
    // For an existing session we can advance immediately; for a send from
    // the new-thread composer (no `sessionId` yet) we defer until the
    // stream attaches and the new session id is known (issue #120).
    if (controllerMode && onFocusAdvanceAfterSend && !runOverrides) {
      if (sessionId) {
        onFocusAdvanceAfterSend(sessionId);
      } else {
        focusAdvanceOnAttachRef.current = true;
      }
    }

    const streamSessionId = resumeSessionIdOverride ?? sessionId;
    streamingRef.current = true;
    setPendingMessage(pendingVisibleMessage);
    setPendingAttachments(visibleAttachments ?? []);
    setStreaming(true);
    setStreamItems([]);
    let detectedSessionId = streamSessionId;
    let runFailed = false;

    const runProvider = runOverrides?.provider ?? selectedProvider;
    const runModel = runOverrides?.model ?? selectedModel;
    const runReasoningEffort =
      runOverrides?.reasoningEffort ?? selectedReasoningEffort;
    const runServiceTier = runOverrides?.serviceTier ?? selectedServiceTier;
    // For continuations the skill is whatever the queued item carried
    // (possibly none); for fresh sends it's the first skill in the stack — the
    // remaining skills travel as `[/skill: name]` markers inside the message.
    const runSkillName = runOverrides
      ? runOverrides.skillName
      : activeSkills[0]?.name;

    // Track which session this stream belongs to
    sendContextRef.current = { projectId, worktreeId, sessionId: streamSessionId };
    debugSessionIsolation("stream.started", {
      projectId,
      worktreeId,
      sessionId,
      provider: runProvider,
      mode: selectedMode,
    });

    const es = startSession(projectId, sentMessage, {
      resumeSessionId: streamSessionId,
      model: runModel,
      reasoningEffort:
        supportsReasoningEffort(runProvider) ? runReasoningEffort : undefined,
      serviceTier:
        supportsServiceTier(runProvider) && runServiceTier === "fast"
          ? runServiceTier
          : undefined,
      provider: runProvider || undefined,
      mode: supportsPlanMode(runProvider) ? modeOverride ?? selectedMode : "default",
      worktreeId,
      attachmentIds,
      skillName: runSkillName,
    });
    eventSourceRef.current = es;
    setOwnStreamActive(true);

    // Check if the user is still viewing the session this stream belongs to
    const isVisible = () => {
      const streamContext = sendContextRef.current;
      if (!streamContext) return false;

      const currentView = currentViewRef.current;
      const currentMatchesStreamView =
        currentView.projectId === streamContext.projectId &&
        currentView.worktreeId === streamContext.worktreeId &&
        currentView.sessionId === streamContext.sessionId;

      const visible =
        currentMatchesStreamView ||
        (
          currentView.projectId === streamContext.projectId &&
          currentView.worktreeId === streamContext.worktreeId &&
          currentView.sessionId == null &&
          pendingAttachedSessionIdRef.current === streamContext.sessionId &&
          streamContext.sessionId === detectedSessionId
        );

      debugSessionIsolation("stream.visibilityCheck", {
        streamContext,
        currentView,
        detectedSessionId,
        visible,
      });

      if (currentMatchesStreamView) return true;

      return (
        currentView.projectId === streamContext.projectId &&
        currentView.worktreeId === streamContext.worktreeId &&
        currentView.sessionId == null &&
        pendingAttachedSessionIdRef.current === streamContext.sessionId &&
        streamContext.sessionId === detectedSessionId
      );
    };

    es.onmessage = (event) => {
      const data = JSON.parse(event.data) as SessionStreamEvent;
      debugSessionIsolation("stream.message", {
        streamContext: sendContextRef.current,
        currentView: currentViewRef.current,
        detectedSessionId,
        type: data.type,
      });
      if (data.type === "started" || data.type === "stderr") {
        if (data.type === "stderr") {
          const text = normalizeMarkdownText(data.text).trim();
          if (text && isVisible()) {
            setStreamItems((prev) => [...prev, { type: "error", text, at: Date.now() }]);
          }
        }
      } else if (data.type === "session_focus") {
        setIsFocusPinned(Boolean(data.focusPinnedAt));
        onFocusPinnedChange?.();
      } else if (data.type === "anita_event") {
        const adaEvent = data.event;
        if (adaEvent.type === "run.started") {
          detectedSessionId = adaEvent.sessionId;
          attachToSession(adaEvent.sessionId);
        } else if (adaEvent.type === "assistant.text") {
          if (adaEvent.text && isVisible()) {
            setStreamItems((prev) => [
              ...prev,
              { type: "assistant", text: adaEvent.text, at: Date.now() },
            ]);
          }
        } else if (adaEvent.type === "assistant.reasoning") {
          if (adaEvent.text && isVisible()) {
            setStreamItems((prev) => [
              ...prev,
              { type: "reasoning", text: adaEvent.text, at: Date.now() },
            ]);
          }
        } else if (adaEvent.type === "tool.call") {
          if (isVisible()) {
            setStreamItems((prev) => [
              ...prev,
              { type: "tool_call", name: adaEvent.name, input: adaEvent.input, at: Date.now() },
            ]);
          }
        } else if (adaEvent.type === "tool.result") {
          if (isVisible()) {
            const content = normalizeToolResultContent(adaEvent.content);
            setStreamItems((prev) => [
              ...prev,
              {
                type: "tool_result",
                name: adaEvent.name,
                content,
                isError: adaEvent.isError,
                at: Date.now(),
              },
            ]);
          }
        } else if (adaEvent.type === "plan.updated") {
          if (isVisible()) {
            setStreamItems((prev) => [
              ...prev,
              {
                type: "plan_updated",
                explanation: adaEvent.explanation,
                plan: adaEvent.plan,
                at: Date.now(),
              },
            ]);
          }
        } else if (adaEvent.type === "plan.delta") {
          if (isVisible()) {
            setStreamItems((prev) => {
              const lastItem = prev[prev.length - 1];
              if (
                lastItem?.type === "plan_delta" &&
                lastItem.id === adaEvent.id
              ) {
                return [
                  ...prev.slice(0, -1),
                  {
                    type: "plan_delta",
                    id: adaEvent.id,
                    delta: `${lastItem.delta}${adaEvent.delta}`,
                    at: lastItem.at,
                  },
                ];
              }

              return [
                ...prev,
                {
                  type: "plan_delta",
                  id: adaEvent.id,
                  delta: adaEvent.delta,
                  at: Date.now(),
                },
              ];
            });
          }
        } else if (adaEvent.type === "user.input_requested") {
          setUserInputDraft({});
          if (isVisible()) {
            setStreamItems((prev) => [
              ...prev,
              {
                type: "user_input_requested",
                id: adaEvent.id,
                questions: adaEvent.questions,
                at: Date.now(),
              },
            ]);
          }
        } else if (adaEvent.type === "tool.approval_requested") {
          if (isVisible()) {
            setStreamItems((prev) => [
              ...prev,
              {
                type: "tool_approval_requested",
                id: adaEvent.id,
                toolName: adaEvent.toolName,
                input: adaEvent.input,
                at: Date.now(),
              },
            ]);
          }
        } else if (adaEvent.type === "thread.status") {
          // Thread status changes are useful internally, but they're noisy in
          // the visible transcript when there's no actionable information.
        } else if (adaEvent.type === "run.cancelled") {
          // Clean cancellation (Anita SIGINT path). Surface a soft
          // indicator carrying the orchestrator-supplied reason, but
          // do NOT set runFailed: the run is expected to exit with
          // code 130, and the synthetic "Anita process exited with
          // code 130" banner has already been suppressed server-side.
          if (isVisible()) {
            setStreamItems((prev) => [
              ...prev,
              {
                type: "run_cancelled",
                reason: adaEvent.reason,
                at: Date.now(),
              },
            ]);
          }
        } else if (adaEvent.type === "run.failed") {
          runFailed = true;
          if (isVisible()) {
            setStreamItems((prev) => [
              ...prev,
              { type: "error", text: adaEvent.error, at: Date.now() },
            ]);
          }
        } else if (adaEvent.type === "run.completed") {
          if (adaEvent.sessionId) detectedSessionId = adaEvent.sessionId;
          if ((adaEvent.status === "max_iterations" || adaEvent.stopReason === "max_turns") && isVisible()) {
            setStreamItems((prev) => [
              ...prev,
              {
                type: "error",
                text: getRunStatusText(adaEvent.stopReason, adaEvent.status),
                at: Date.now(),
              },
            ]);
          }
        }
      } else if (data.type === "done") {
        debugSessionIsolation("stream.done", {
          detectedSessionId,
          streamContext: sendContextRef.current,
          currentView: currentViewRef.current,
          exitCode: data.exitCode,
        });
        es.close();
        eventSourceRef.current = null;
        setOwnStreamActive(false);
        const wasVisible = isVisible();
        sendContextRef.current = null;
        const completedSessionId = detectedSessionId;

        // Emulated steer (Claude/Anita): the active run was stopped so we
        // could steer. Resume immediately with the steer text only,
        // skipping the normal completion + auto-advance path.
        if (
          steerInProgressRef.current &&
          pendingSteerRef.current &&
          completedSessionId
        ) {
          const steerText = pendingSteerRef.current;
          pendingSteerRef.current = null;
          steerInProgressRef.current = false;
          setSteerInProgress(false);
          streamingRef.current = false;
          void startAgentStream(
            steerText,
            steerText,
            undefined,
            completedSessionId,
            undefined,
            undefined,
            { skillName: undefined }
          );
          return;
        }

        if (wasVisible) {
          streamingRef.current = false;
          setPendingMessage(null);
          setPendingAttachments([]);
          setActiveStreamSessionId(completedSessionId || null);
          if (completedSessionId) {
            fetchEvents(projectId, completedSessionId, worktreeId)
              .then((evts) => {
                setEvents(evts);
                // Once the persisted transcript is loaded it covers the whole
                // run — including cancelled/failed runs, which #166 now
                // persists. Clearing the live items only on a clean exit left
                // both lists rendering on cancel/failure, duplicating every
                // paragraph. Drop the live items that the transcript now
                // mirrors, but keep terminal status banners (`error`,
                // `run_cancelled`): the server never persists run.failed /
                // run.cancelled events, so these are the only record of the
                // cancel/failure reason.
                if (evts.length > 0) {
                  setStreamItems((prev) =>
                    prev.filter(
                      (item) =>
                        item.type === "error" || item.type === "run_cancelled"
                    )
                  );
                }
              })
              .catch(() => {});
          }
          // The server drains the queue (one-at-a-time, on clean completion).
          // When items remain, stay in the streaming state so the runtime
          // poller picks up the next server-driven run without a flicker;
          // otherwise end the run here. Refresh the list either way.
          void refreshQueue();
          const cleanCompletion = !runFailed && (data.exitCode ?? 1) === 0;
          if (cleanCompletion && queueRef.current.length > 0) {
            setStreaming(true);
          } else {
            setStreaming(false);
          }
        } else {
          // Stream completed while user was viewing another session
          if (completedSessionId && onBackgroundComplete) {
            onBackgroundComplete(completedSessionId);
          }
        }
      } else if (data.type === "error") {
        const text = normalizeMarkdownText(data.text).trim();
        debugSessionIsolation("stream.error", {
          text,
          detectedSessionId,
          streamContext: sendContextRef.current,
          currentView: currentViewRef.current,
        });
        es.close();
        eventSourceRef.current = null;
        setOwnStreamActive(false);
        const wasVisible = isVisible();
        sendContextRef.current = null;
        // Stream failed before attaching — drop the pending focus advance
        // so it can't fire against an unrelated later attach (issue #120).
        focusAdvanceOnAttachRef.current = false;
        if (wasVisible) {
          setStreamItems((prev) => [...prev, { type: "error", text, at: Date.now() }]);
          streamingRef.current = false;
          setStreaming(false);
          setPendingMessage(null);
          setPendingAttachments([]);
        }
      }
    };

    es.onerror = () => {
      const wasVisible = isVisible();
      debugSessionIsolation("stream.transportError", {
        detectedSessionId,
        streamContext: sendContextRef.current,
        currentView: currentViewRef.current,
        wasVisible,
      });
      es.close();
      eventSourceRef.current = null;
      sendContextRef.current = null;
      // Stream failed before attaching — drop the pending focus advance
      // so it can't fire against an unrelated later attach (issue #120).
      focusAdvanceOnAttachRef.current = false;
      if (wasVisible) {
        streamingRef.current = false;
        setStreaming(false);
        setPendingMessage(null);
        setPendingAttachments([]);
      }
    };

    return true;
  };

  useEffect(() => {
    if (!queuedStreamStart || streaming || !providerReady) return;
    const queued = queuedStreamStart;
    setQueuedStreamStart(null);
    void (async () => {
      const started = await startAgentStream(
        queued.message,
        queued.pendingVisibleMessage,
        queued.modeOverride,
        queued.resumeSessionId
      );
      if (!started) {
        setStreamItems((prev) => [
          ...prev,
          {
            type: "error",
            text: "Could not resume the agent. Please retry your answer.",
            at: Date.now(),
          },
        ]);
      }
    })();
  }, [queuedStreamStart, streaming, providerReady]);

  /** Validate composer attachments against provider/model capabilities. */
  const validateComposerAttachments = (): boolean => {
    if (composerAttachments.length === 0) return true;
    if (!providerSupportsAttachments) {
      setAttachmentError(
        `Attachments are not supported by the ${selectedProvider} provider`
      );
      return false;
    }
    if (!modelSupportsAttachments) {
      setAttachmentError(
        `The selected model does not support attachments${
          selectedModelEntry ? ` (${selectedModelEntry.name})` : ""
        }`
      );
      return false;
    }
    if (
      composerAttachments.some((attachment) =>
        isImageMimeType(getFileMimeType(attachment.file))
      ) &&
      !modelSupportsImages
    ) {
      setAttachmentError("The selected model does not support image attachments");
      return false;
    }
    if (
      composerAttachments.some((attachment) =>
        isFileMimeType(getFileMimeType(attachment.file))
      ) &&
      !modelSupportsFiles
    ) {
      setAttachmentError("The selected model does not support file attachments");
      return false;
    }
    return true;
  };

  /** Reset the composer (text, skill chip, attachments) after a submit. */
  const clearComposer = () => {
    composerAttachments.forEach((attachment) => {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    });
    setComposerAttachments([]);
    setMessage("");
    setActiveSkills([]);
    setSkillPopoverOpen(false);
  };

  // Validate + upload composer attachments, then start the turn with the
  // current composer text and active-skill stack, clearing the composer on a
  // successful start. Shared by the Send button and the picker's
  // add-and-submit path so attachment handling can't drift between them.
  // `textOverride` lets the picker path submit the text it just stripped the
  // `/<token>` from without depending on `message` state timing.
  const sendComposerMessage = async (textOverride?: string): Promise<void> => {
    const baseText = textOverride ?? message;
    if (!baseText.trim() && composerAttachments.length === 0) return;
    if (!validateComposerAttachments()) return;
    const rawText = baseText.trim() || "Please use the attached files as context.";
    const skillNames = activeSkills.map((s) => s.name);
    // `agentMessage` carries the trailing skills as markers (the first rides
    // through `skillName`); `visibleMessage` mirrors the full marker chain for
    // the local transcript, matching what the server persists.
    const agentMessage = buildSkillAgentText(skillNames, rawText);
    const visibleMessage = buildSkillHistoryText(skillNames, rawText);
    setAttachmentError(null);
    try {
      const uploadedAttachments = await uploadComposerAttachments();
      if (
        await startAgentStream(
          agentMessage,
          visibleMessage,
          undefined,
          undefined,
          uploadedAttachments.map((attachment) => attachment.id),
          uploadedAttachments
        )
      ) {
        clearComposer();
      }
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "Failed to upload attachments");
      streamingRef.current = false;
      setStreaming(false);
      setPendingMessage(null);
      setPendingAttachments([]);
    }
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    void sendComposerMessage();
  };

  // Enqueue the current composer contents to run after the active turn
  // completes (the default action for Enter while streaming). Requires a
  // known session to attach to.
  const handleEnqueue = async () => {
    if (!message.trim() && composerAttachments.length === 0) return;
    const targetSessionId = activeStreamSessionId ?? sessionId;
    if (!targetSessionId) return;
    if (!validateComposerAttachments()) return;
    setAttachmentError(null);
    const rawText = message.trim() || "Please use the attached files as context.";
    const skillNames = activeSkills.map((s) => s.name);
    const agentMessage = buildSkillAgentText(skillNames, rawText);
    const visibleMessage = buildSkillHistoryText(skillNames, rawText);
    try {
      const uploadedAttachments = await uploadComposerAttachments();
      const input: QueuedMessageInput = {
        text: agentMessage,
        visibleText: visibleMessage,
        provider: selectedProvider,
        model: selectedModel,
        reasoningEffort: providerSupportsReasoningEffort
          ? selectedReasoningEffort
          : undefined,
        serviceTier:
          providerSupportsServiceTier && selectedServiceTier === "fast"
            ? "fast"
            : undefined,
        mode: providerSupportsPlanMode ? selectedMode : "default",
        attachmentIds: uploadedAttachments.map((attachment) => attachment.id),
        skillName: activeSkills[0]?.name,
      };
      const queued = await enqueueSessionMessage(projectId, targetSessionId, input);
      setQueue((prev) => [...prev, queued]);
      clearComposer();
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : "Failed to enqueue message"
      );
    }
  };

  // Remove an enqueued message from the queue (the only queue management
  // action in v1).
  const handleRemoveQueued = async (messageId: string) => {
    const targetSessionId = activeStreamSessionId ?? sessionId;
    if (!targetSessionId) return;
    setQueue((prev) => prev.filter((m) => m.id !== messageId));
    try {
      await removeSessionQueuedMessage(projectId, targetSessionId, messageId);
    } catch {
      // Re-sync from the server if the optimistic removal failed.
      void refreshQueue();
    }
  };

  const handleStop = async () => {
    const targetSessionId = activeStreamSessionId ?? sessionId;
    if (!targetSessionId) return;
    try {
      await stopSession(projectId, targetSessionId, worktreeId);
    } catch (err) {
      setStreamItems((prev) => [
        ...prev,
        { type: "error", text: err instanceof Error ? err.message : "Failed to stop session", at: Date.now() },
      ]);
    }
  };

  // Steer the running turn (Shift+Enter while streaming). Uses the composer
  // text, or the first enqueued message when the composer is empty
  // ("promote queued to steer"). Codex steers natively; Claude/Anita stop the
  // run and resume with the steer text via the stream's `done` handler.
  const handleSteer = async () => {
    const targetSessionId = activeStreamSessionId ?? sessionId;
    if (!targetSessionId) return;
    if (steerInProgressRef.current) return;

    let steerText = message.trim();
    let promotedId: string | null = null;
    if (!steerText) {
      const first = queue[0];
      if (!first) return;
      steerText = first.text;
      promotedId = first.id;
    }

    if (promotedId) {
      try {
        await removeSessionQueuedMessage(projectId, targetSessionId, promotedId);
        setQueue((prev) => prev.filter((m) => m.id !== promotedId));
      } catch {
        // Fall through and still steer with the promoted text.
      }
    }

    setMessage("");
    setStreamItems((prev) => [...prev, { type: "user_message", text: steerText, at: Date.now() }]);

    if (providerUsesNativeSteering) {
      try {
        await steerSession(projectId, targetSessionId, steerText, worktreeId);
      } catch (err) {
        setStreamItems((prev) => [
          ...prev,
          { type: "error", text: err instanceof Error ? err.message : "Failed to steer session", at: Date.now() },
        ]);
      }
      return;
    }

    // Emulated steer (Claude/Anita): stop the current run; the stream's
    // `done` handler resumes with the steer text once the process exits.
    // The composer stays disabled until the resumed run starts so a second
    // steer can't race the stop+resume.
    steerInProgressRef.current = true;
    setSteerInProgress(true);
    pendingSteerRef.current = steerText;
    try {
      await stopSession(projectId, targetSessionId, worktreeId);
    } catch (err) {
      steerInProgressRef.current = false;
      setSteerInProgress(false);
      pendingSteerRef.current = null;
      setStreamItems((prev) => [
        ...prev,
        { type: "error", text: err instanceof Error ? err.message : "Failed to steer session", at: Date.now() },
      ]);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (skillPopoverOpen && filteredSkills.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSkillHighlightIndex((current) =>
          (current + 1) % filteredSkills.length
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSkillHighlightIndex((current) =>
          (current - 1 + filteredSkills.length) % filteredSkills.length
        );
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const choice = filteredSkills[skillHighlightIndex];
        // Already-active skills are a no-op (the picker shows them disabled).
        // Plain Tab adds and keeps typing; Shift+Tab adds and submits.
        if (!choice || isSkillActive(choice)) return;
        const newMessage = addSkillToStack(choice);
        if (e.shiftKey && newMessage !== null) {
          setPendingSkillSubmit({ text: newMessage });
        }
        return;
      }
      if (e.key === "Enter" && skillQuery !== null) {
        e.preventDefault();
        const choice = filteredSkills[skillHighlightIndex];
        if (!choice || isSkillActive(choice)) return;
        // Enter adds the highlighted skill to the stack. It also submits the
        // turn in the same keystroke when the typed `/<token>` is an exact
        // (case-insensitive) match for a known skill — the documented
        // `/skill text` flow — or when the user holds Shift. Partial matches
        // only add the chip, so the user can keep typing (e.g. to stack a
        // second skill) and submit on a follow-up Enter.
        const exactMatch = filteredSkills.some(
          (entry) =>
            entry.name.toLowerCase() === skillQuery.token.toLowerCase()
        );
        // Add the chip immediately so the bubble picks up the marker chain on
        // render, and queue the submit for the post-render effect (see
        // `pendingSkillSubmit`) once `activeSkills` reflects the new skill.
        const newMessage = addSkillToStack(choice);
        if ((exactMatch || e.shiftKey) && newMessage !== null) {
          setPendingSkillSubmit({ text: newMessage });
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSkillPopoverOpen(false);
        return;
      }
      return;
    }
    // On touch devices the Return key always inserts a newline; submitting
    // is done via the Send button. Fall through to the textarea default.
    if (IS_TOUCH_DEVICE && e.key === "Enter" && !(e.metaKey || e.ctrlKey)) {
      return;
    }
    // Unified keymap (issue #113). Shift+Enter always inserts a newline.
    // Cmd/Ctrl+Enter steers the running turn (using the composer text, or
    // the first enqueued message when empty). Plain Enter enqueues while a
    // run is streaming and sends when idle.
    if (steerInProgress) {
      // Composer is locked during a stop->resume steer transition.
      if (e.key === "Enter") e.preventDefault();
      return;
    }
    const isSteerChord =
      e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey;
    if (streaming) {
      if (isSteerChord) {
        e.preventDefault();
        void handleSteer();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleEnqueue();
        return;
      }
      // Shift+Enter falls through to the default newline behavior.
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend(e);
    }
  };

  const copyEventData = useCallback((event: AgentEvent) => {
    navigator.clipboard.writeText(JSON.stringify(event.data, null, 2));
    setCopiedId(event.id);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  const openSourcePath = useCallback((path: string, line?: number, errorLabel = path) => {
    fetchSourceFile(projectId, path, worktreeId)
      .then((file) => {
        const lineCount = file.content.split("\n").length;
        const selectedLine =
          typeof line === "number"
            ? Math.min(Math.max(line, 1), lineCount)
            : undefined;
        setSourcePreview({ file, line: selectedLine });
        setTerminalOpen(true);
        setRightTab("files");
        setMobilePanel("files");
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : `Could not open ${errorLabel}`);
      });
  }, [projectId, worktreeId]);

  const openSourceReference = useCallback((reference: OpenSourceReferenceOptions) => {
    openSourcePath(reference.path, reference.line, reference.label);
  }, [openSourcePath]);

  // The live preview pane (state + `<webview>` + bridge socket) is owned by the
  // app-level pool, keyed by `projectId:worktreeId` to match the worktree the
  // server resolves from the agent's cwd. Keeping it above the (remounting)
  // SessionView lets the browser survive session/worktree switches (issue #158).
  const browserKey = activeWorktree ? `${projectId}:${activeWorktree.id}` : null;
  const previewPane = usePreviewPane(browserKey);
  const openPreviewUrl = usePreviewOpen();

  // Bring the Preview tab forward when an agent opens a URL on this pane.
  const surfacePreview = useCallback(() => {
    setTerminalOpen(true);
    setRightTab("preview");
    setMobilePanel("preview");
  }, []);

  useActivePreviewPane({
    key: browserKey,
    projectRoot: previewProjectRoot,
    placeholder: previewPlaceholder,
    onSurface: surfacePreview,
  });

  const previewActions = useMemo<PreviewActions>(() => ({
    available: previewAvailable,
    open: (url: string) => {
      if (browserKey) openPreviewUrl(browserKey, url);
    },
  }), [previewAvailable, browserKey, openPreviewUrl]);

  const handleStructuredUserInputSubmit = async (
    requestId: string,
    questions: UserInputQuestion[]
  ) => {
    const targetSessionId = activeStreamSessionId ?? sessionId;
    if (!targetSessionId) return;

    const answers = Object.fromEntries(
      questions.map((question) => [question.id, userInputDraft[question.id]])
    );

    setSubmittingUserInput(true);
    try {
      const result = await submitSessionUserInput(projectId, targetSessionId, answers, worktreeId);
      setUserInputDraft({});
      setStreamItems((prev) =>
        prev.filter(
          (item) => item.type !== "user_input_requested" || item.id !== requestId
        )
      );
      fetchEvents(projectId, targetSessionId, worktreeId)
        .then(setEvents)
        .catch(() => {});
      if (result.resumeMessage) {
        const resumeStart: QueuedStreamStart = {
          message: result.resumeMessage,
          pendingVisibleMessage: "Answered agent request",
          modeOverride: result.resumeMode,
          resumeSessionId: targetSessionId,
        };
        if (streamingRef.current || eventSourceRef.current) {
          setQueuedStreamStart(resumeStart);
        } else if (
          !(await startAgentStream(
            resumeStart.message,
            resumeStart.pendingVisibleMessage,
            resumeStart.modeOverride,
            resumeStart.resumeSessionId
          ))
        ) {
          setStreamItems((prev) => [
            ...prev,
            {
              type: "error",
              text: "Could not resume the agent. Please retry your answer.",
              at: Date.now(),
            },
          ]);
        }
      }
    } catch (error) {
      setStreamItems((prev) => [
        ...prev,
        {
          type: "error",
          text: error instanceof Error ? error.message : "Failed to submit user input",
          at: Date.now(),
        },
      ]);
    } finally {
      setSubmittingUserInput(false);
    }
  };

  const handleStructuredUserInputDismiss = async (requestId: string) => {
    const targetSessionId = activeStreamSessionId ?? sessionId;
    if (!targetSessionId) return;

    setSubmittingUserInput(true);
    try {
      await dismissSessionUserInput(projectId, targetSessionId, worktreeId);
      setUserInputDraft({});
      setStreamItems((prev) =>
        prev.filter(
          (item) => item.type !== "user_input_requested" || item.id !== requestId
        )
      );
      fetchEvents(projectId, targetSessionId, worktreeId)
        .then(setEvents)
        .catch(() => {});
    } catch (error) {
      setStreamItems((prev) => [
        ...prev,
        {
          type: "error",
          text: error instanceof Error ? error.message : "Failed to dismiss user input",
          at: Date.now(),
        },
      ]);
    } finally {
      setSubmittingUserInput(false);
    }
  };

  const handleToolApproval = async (
    requestId: string,
    decision: ToolApprovalDecision
  ) => {
    const targetSessionId = activeStreamSessionId ?? sessionId;
    if (!targetSessionId) return;

    setSubmittingApprovalId(requestId);
    // Drop the prompt immediately; the run continues on the live SSE stream
    // with the decision applied.
    setStreamItems((prev) =>
      prev.filter(
        (item) => item.type !== "tool_approval_requested" || item.id !== requestId
      )
    );
    try {
      await submitToolApproval(projectId, targetSessionId, requestId, decision, worktreeId);
      fetchEvents(projectId, targetSessionId, worktreeId)
        .then(setEvents)
        .catch(() => {});
    } catch (error) {
      setStreamItems((prev) => [
        ...prev,
        {
          type: "error",
          text: error instanceof Error ? error.message : "Failed to submit approval",
          at: Date.now(),
        },
      ]);
    } finally {
      setSubmittingApprovalId(null);
    }
  };

  const selectedModelName = (() => {
    const model = models.find((m) => m.id === selectedModel);
    if (!model) return selectedModel;
    const providerLabel = modelProviderLabel(model);
    // For Anita we always show provider - model because the same model name
    // can be available from multiple providers (e.g., local Ollama vs. Ollama
    // Cloud). For other agents (codex, claude) the provider is implicit, so
    // we keep showing just the model name.
    if (selectedProvider === "anita" && providerLabel) {
      return `${providerLabel} - ${model.name}`;
    }
    return model.name;
  })();
  const selectedReasoningEffortLabel =
    REASONING_EFFORT_OPTIONS.find((option) => option.value === selectedReasoningEffort)?.label ??
    selectedReasoningEffort;
  const streamBelongsToCurrentView =
    streamItems.length === 0 ||
    (activeStreamSessionId
      ? activeStreamSessionId === sessionId ||
        (!sessionId && pendingAttachedSessionIdRef.current === activeStreamSessionId)
      : !sessionId);
  const visibleStreamItems = streamBelongsToCurrentView ? streamItems : EMPTY_STREAM_ITEMS;
  const latestStructuredInputRequestFromStream =
    [...visibleStreamItems]
      .reverse()
      .find(
        (item): item is Extract<StreamItem, { type: "user_input_requested" }> =>
          item.type === "user_input_requested"
      ) ?? null;
  const latestStructuredInputRequest =
    latestStructuredInputRequestFromStream
      ? latestStructuredInputRequestFromStream
      : (() => {
          const pendingRequest = getLatestPendingUserInputRequest(events);
          return pendingRequest
            ? {
                type: "user_input_requested" as const,
                id: pendingRequest.eventId,
                questions: pendingRequest.questions,
              }
            : null;
        })();
  const showPendingMessage = !hasMatchingPersistedUserMessage(
    events,
    pendingMessage
  );
  const waitingForStructuredInput = Boolean(latestStructuredInputRequest);
  // Live approvals render inline as stream items; this covers the reload case
  // where only persisted events exist and an approval is still pending.
  const pendingToolApprovalFromStream = visibleStreamItems.some(
    (item) => item.type === "tool_approval_requested"
  );
  const pendingToolApproval = pendingToolApprovalFromStream
    ? null
    : getLatestPendingToolApproval(events);
  const waitingForToolApproval =
    pendingToolApprovalFromStream || Boolean(pendingToolApproval);
  const eventRenderItems = useMemo(() => groupEventsForRender(events), [events]);
  const streamRenderItems = useMemo(
    () => groupStreamItemsForRender(visibleStreamItems),
    [visibleStreamItems]
  );

  const handleHeaderFocusPin = async () => {
    if (!sessionId) return;
    try {
      if (isFocusPinned) {
        await unpinSessionFocus(projectId, sessionId, worktreeId);
        setIsFocusPinned(false);
        toast.success("Session removed from radar");
      } else {
        await pinSessionFocus(projectId, sessionId, worktreeId);
        setIsFocusPinned(true);
        toast.success("Session added to radar");
      }
      onFocusPinnedChange?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update focus queue");
    }
  };

  return (
    <>
      {controllerMode && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-blue-500/20 bg-blue-500/15 px-3 py-2 text-blue-200 md:px-4">
          <div className="min-w-0 text-xs text-blue-200/80">
            <span className="font-medium text-blue-200">Controller Mode</span>
            <span className="ml-2">
              {focusPosition && focusPosition.total > 0
                ? `${focusPosition.current || 1} / ${focusPosition.total}`
                : "No sessions on radar"}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onFocusSkip}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-blue-200/80 transition-colors hover:bg-blue-500/20 hover:text-blue-100 disabled:pointer-events-none disabled:opacity-50"
              title="Next (N)"
            >
              <StepForward className="h-3.5 w-3.5" />
              Next
              <Kbd>N</Kbd>
            </button>
            <button
              type="button"
              onClick={onFocusDone}
              disabled={!sessionId}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-blue-200/80 transition-colors hover:bg-blue-500/20 hover:text-blue-100 disabled:pointer-events-none disabled:opacity-50"
              title="Mark done (D)"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              Done
              <Kbd>D</Kbd>
            </button>
            <button
              type="button"
              onClick={onFocusExit}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-blue-200/80 transition-colors hover:bg-blue-500/20 hover:text-blue-100"
              title="Exit Controller Mode (E)"
            >
              <LogOut className="h-3.5 w-3.5" />
              Exit
              <Kbd>E</Kbd>
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <header className={`${sessionId ? "flex" : "hidden md:flex"} h-12 md:h-14 shrink-0 items-center justify-end md:justify-between border-b border-border bg-background px-3 md:px-4`}>
        <div className="hidden md:flex flex-col justify-center min-w-0">
          {sessionId ? (
            <div className="group/title flex items-center gap-1.5 min-w-0">
              <h1 className="truncate text-sm font-medium">
                {sessionTitle || "Untitled conversation"}
              </h1>
              <button
                type="button"
                onClick={openTitleDialog}
                title="Rename conversation"
                aria-label="Rename conversation"
                className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/title:opacity-100 focus-visible:opacity-100"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <h1 className="text-sm font-medium truncate">
              {project?.name ?? "Project"}
            </h1>
          )}
          {sessionId && (project?.name || activeWorktree?.name) && (
            <span className="block truncate text-[11px] text-muted-foreground">
              {project?.name ?? "Project"}
              {activeWorktree?.name ? ` / ${activeWorktree.name}` : ""}
            </span>
          )}
        </div>

        {/* Mobile: Agent/Terminal/Changes tabs in header */}
        {sessionId && (
          <div className="flex items-center gap-1 md:hidden">
            <button
              onClick={() => setMobilePanel("agent")}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                mobilePanel === "agent"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground"
              }`}
            >
              <MessageSquare className="h-3 w-3" />
              Agent
            </button>
            <button
              onClick={() => { setMobilePanel("terminal"); setRightTab("terminal"); }}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                mobilePanel === "terminal"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground"
              }`}
            >
              <TerminalSquare className="h-3 w-3" />
              Terminal
            </button>
            {(gitDiffFiles.length > 0 || branchDiffFiles.length > 0) && (
              <button
                onClick={() => { setMobilePanel("changes"); setRightTab("changes"); }}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  mobilePanel === "changes"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground"
                }`}
              >
                <Diff className="h-3 w-3" />
                Changes
              </button>
            )}
            <button
              onClick={() => { setMobilePanel("files"); setRightTab("files"); }}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                mobilePanel === "files"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground"
              }`}
            >
              <FileCode className="h-3 w-3" />
              Files
            </button>
            {previewAvailable && (
              <button
                onClick={() => { setMobilePanel("preview"); setRightTab("preview"); setTerminalOpen(true); }}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  mobilePanel === "preview"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground"
                }`}
              >
                <Globe2 className="h-3 w-3" />
                Preview
              </button>
            )}
          </div>
        )}

        {/* Desktop: terminal toggle */}
        <div className="hidden md:flex items-center gap-2">
          {(() => {
            const { added: headerAdded, deleted: headerDeleted } = summarizeDiffFiles(
              gitDiffFiles.length > 0 ? gitDiffFiles : branchDiffFiles
            );
            if (headerAdded === 0 && headerDeleted === 0) return null;
            return (
              <span className="font-mono text-xs">
                <span className="text-green-400/90">+{headerAdded}</span>{" "}
                <span className="text-red-400/90">-{headerDeleted}</span>
              </span>
            );
          })()}
          <div className="ml-3 flex items-center gap-1">
            {sessionId && (
              <button
                type="button"
                onClick={handleHeaderFocusPin}
                className={`rounded-md p-1.5 transition-colors ${
                  isFocusPinned
                    ? "bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 hover:text-blue-200"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
                title={isFocusPinned ? "Remove from Radar" : "Add to Radar"}
              >
                <Radar className="h-4 w-4" />
              </button>
            )}
            {sessionId && onArchive && (
              <button
                type="button"
                onClick={onArchive}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                title="Archive session"
                aria-label="Archive session"
              >
                <Archive className="h-4 w-4" />
              </button>
            )}
          </div>
          <button
            onClick={() => setTerminalOpen(!terminalOpen)}
            className={`ml-2 rounded-md p-1.5 transition-colors ${
              terminalOpen
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
            title={terminalOpen ? "Hide panel" : "Show panel"}
          >
            <PanelRight className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Rename conversation dialog */}
      <Dialog
        open={titleDialogOpen}
        onOpenChange={(open) => {
          if (!savingTitle) setTitleDialogOpen(open);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Rename conversation</DialogTitle>
            <DialogDescription>
              Give this conversation a title to help you find it later.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void commitTitle();
            }}
          >
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              placeholder="Untitled conversation"
              className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
            <DialogFooter className="mt-4">
              <DialogClose render={<Button type="button" variant="outline" />}>
                Cancel
              </DialogClose>
              <Button type="submit" disabled={savingTitle}>
                {savingTitle ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Main content area: chat + terminal side by side on desktop, tabbed on mobile */}
      <div className="flex flex-1 min-h-0">
        {/* Chat panel — hidden on mobile when terminal or changes tab is active */}
        <div className={`flex-col min-h-0 min-w-0 w-full ${
          sessionId && mobilePanel !== "agent" ? "hidden md:flex" : "flex"
        } flex-1`}>
          {/* Messages / Events area */}
          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto min-h-0"
          >
            <ProjectRootContext.Provider value={activeWorktree?.path ?? project?.path}>
            <OpenSourceReferenceContext.Provider value={openSourceReference}>
            <OpenConversationContext.Provider value={onOpenConversation}>
            <PreviewContext.Provider value={previewActions}>
            <div className="mx-auto max-w-3xl px-3 py-4 md:px-4 md:py-6">
              {!sessionId && events.length === 0 && streamItems.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20">
                  <h2 className="text-lg font-medium text-muted-foreground">
                    Start a new thread
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground/70">
                    Send a message to begin working with the coding agent
                  </p>
                </div>
              )}

              {/* Event timeline */}
              <div className="space-y-4">
                {eventRenderItems.map((renderItem) => {
                  if (renderItem.kind === "working_group") {
                    const groupEvents = renderItem.events;
                    if (groupEvents.length === 1) {
                      return (
                        <WorkingShell key={renderItem.key}>
                          <WorkingChildEvent event={groupEvents[0]} />
                        </WorkingShell>
                      );
                    }
                    const startMs = Date.parse(groupEvents[0].timestamp);
                    const endMs = Date.parse(
                      groupEvents[groupEvents.length - 1].timestamp
                    );
                    const stepCount = groupEvents.filter(
                      (e) => e.type === "tool_call"
                    ).length;
                    return (
                      <WorkingBlock
                        key={renderItem.key}
                        startMs={startMs}
                        endMs={endMs}
                        stepCount={stepCount}
                      >
                        {groupEvents.map((event) => (
                          <WorkingChildEvent key={event.id} event={event} />
                        ))}
                      </WorkingBlock>
                    );
                  }
                  return (
                    <EventBlock
                      key={renderItem.key}
                      event={renderItem.event}
                      copiedId={copiedId}
                      onCopy={copyEventData}
                      hiddenPendingUserInputEventId={
                        visibleStreamItems.length === 0 ? latestStructuredInputRequest?.id : null
                      }
                    />
                  );
                })}
              </div>

              {/* Pending user message */}
              {pendingMessage && showPendingMessage && (() => {
                const { skillNames: pendingSkillNames, text: pendingVisible } =
                  parseSkillMarkers(pendingMessage);
                return (
                <div className="flex justify-end mt-4">
                  <div className="max-w-[85%]">
                    <AttachmentStrip attachments={pendingAttachments} />
                    <div className="rounded-2xl bg-secondary px-4 py-3 text-sm">
                      {pendingSkillNames.length > 0 && (
                        <div className="mb-1.5 flex flex-wrap justify-end gap-1">
                          {pendingSkillNames.map((skillName, index) => (
                            <span
                              key={`${skillName}-${index}`}
                              className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                            >
                              <Sparkles className="h-3 w-3 text-primary" />
                              <span>Skill: {skillName}</span>
                            </span>
                          ))}
                        </div>
                      )}
                      <CollapsibleUserMessage text={pendingVisible} />
                    </div>
                  </div>
                </div>
                );
              })()}

              {/* Stream output */}
              {visibleStreamItems.length > 0 && (
                <div className="mt-4 space-y-3">
                  {streamRenderItems.map((render, idx) => {
                    if (render.kind === "working_group") {
                      if (render.items.length === 1) {
                        return (
                          <WorkingShell key={render.key}>
                            <WorkingChildStreamItem item={render.items[0]} />
                          </WorkingShell>
                        );
                      }
                      const startMs = render.items[0].at;
                      const endMs = render.items[render.items.length - 1].at;
                      const stepCount = render.items.filter(
                        (it) => it.type === "tool_call"
                      ).length;
                      const live = streaming && idx === streamRenderItems.length - 1;
                      return (
                        <WorkingBlock
                          key={render.key}
                          startMs={startMs}
                          endMs={live ? undefined : endMs}
                          live={live}
                          stepCount={stepCount}
                        >
                          {render.items.map((item, j) => (
                            <WorkingChildStreamItem
                              key={`${render.startIndex}-${j}`}
                              item={item}
                            />
                          ))}
                        </WorkingBlock>
                      );
                    }

                    const item = render.item;

                    if (item.type === "user_message") {
                      return (
                        <div key={render.key} className="flex justify-end">
                          <div className="max-w-[85%]">
                            <AttachmentStrip attachments={item.attachments} />
                            <div className="rounded-2xl bg-secondary px-4 py-3 text-sm">
                              <CollapsibleUserMessage text={normalizeMarkdownText(item.text)} />
                            </div>
                          </div>
                        </div>
                      );
                    }

                    if (item.type === "assistant") {
                      return <AssistantBlock key={render.key} text={item.text} />;
                    }

                    if (item.type === "user_input_requested") {
                      return (
                        <UserInputRequestedBlock
                          key={render.key}
                          answers={
                            latestStructuredInputRequest?.id === item.id
                              ? userInputDraft
                              : undefined
                          }
                          questions={item.questions}
                          onAnswerSelect={
                            latestStructuredInputRequest?.id === item.id
                              ? (questionId, answer) =>
                                  setUserInputDraft((prev) => ({
                                    ...prev,
                                    [questionId]: answer,
                                  }))
                              : undefined
                          }
                          onSubmit={
                            latestStructuredInputRequest?.id === item.id
                              ? () => handleStructuredUserInputSubmit(item.id, item.questions)
                              : undefined
                          }
                          onDismiss={
                            latestStructuredInputRequest?.id === item.id
                              ? () => handleStructuredUserInputDismiss(item.id)
                              : undefined
                          }
                          submitting={submittingUserInput}
                        />
                      );
                    }

                    if (item.type === "tool_approval_requested") {
                      return (
                        <ToolApprovalBlock
                          key={render.key}
                          toolName={item.toolName}
                          input={item.input}
                          submitting={submittingApprovalId === item.id}
                          onDecision={(decision) =>
                            handleToolApproval(item.id, decision)
                          }
                        />
                      );
                    }

                    if (item.type === "thread_status") {
                      return null;
                    }

                    if (item.type === "error") {
                      return <ErrorBlock key={render.key} text={item.text} />;
                    }

                    if (item.type === "run_cancelled") {
                      return <CancelledBlock key={render.key} reason={item.reason} />;
                    }

                    return null;
                  })}
                </div>
              )}

              {visibleStreamItems.length === 0 && latestStructuredInputRequest && (
                <div className="mt-4">
                  <UserInputRequestedBlock
                    answers={userInputDraft}
                    questions={latestStructuredInputRequest.questions}
                    onAnswerSelect={(questionId, answer) =>
                      setUserInputDraft((prev) => ({
                        ...prev,
                        [questionId]: answer,
                      }))
                    }
                    onSubmit={() =>
                      handleStructuredUserInputSubmit(
                        latestStructuredInputRequest.id,
                        latestStructuredInputRequest.questions
                      )
                    }
                    onDismiss={() =>
                      handleStructuredUserInputDismiss(latestStructuredInputRequest.id)
                    }
                    submitting={submittingUserInput}
                  />
                </div>
              )}

              {pendingToolApproval && (
                <div className="mt-4">
                  <ToolApprovalBlock
                    toolName={pendingToolApproval.toolName}
                    input={pendingToolApproval.input}
                    submitting={submittingApprovalId === pendingToolApproval.requestId}
                    onDecision={(decision) =>
                      handleToolApproval(pendingToolApproval.requestId, decision)
                    }
                  />
                </div>
              )}

              {streaming && !waitingForStructuredInput && !waitingForToolApproval && (
                <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Working...</span>
                </div>
              )}

              <div ref={bottomRef} />
            </div>
            </PreviewContext.Provider>
            </OpenConversationContext.Provider>
            </OpenSourceReferenceContext.Provider>
            </ProjectRootContext.Provider>
          </div>

          {/* Input */}
          <div className="shrink-0 border-t border-border bg-background px-3 pb-3 pt-2 md:px-4 md:pb-4 md:pt-3">
            <div className="mx-auto max-w-3xl">
              {queue.length > 0 && (
                <div className="mb-2 space-y-1">
                  <div className="flex items-center gap-1.5 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    <StepForward className="h-3 w-3" />
                    <span>Queued ({queue.length})</span>
                  </div>
                  {queue.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center gap-2 rounded-md border border-border bg-background/60 px-2 py-1.5 text-sm"
                    >
                      <span className="min-w-0 flex-1 truncate text-foreground">
                        {item.visibleText}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleRemoveQueued(item.id)}
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        aria-label="Remove queued message"
                        title="Remove from queue"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (steerInProgress) return;
                  if (streaming) void handleEnqueue();
                  else void handleSend(e);
                }}
              >
                <div
                  className="rounded-xl border border-border bg-input p-3"
                  onDragOver={(event) => {
                    if (!canAttachMore) return;
                    event.preventDefault();
                  }}
                  onDrop={(event) => {
                    if (!canAttachMore) return;
                    event.preventDefault();
                    addComposerFiles(event.dataTransfer.files);
                  }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    accept={attachmentAcceptMimeTypes.join(",")}
                    onChange={(event) => {
                      if (event.target.files) addComposerFiles(event.target.files);
                      event.currentTarget.value = "";
                    }}
                  />
                  {activeSkills.length > 0 && !skillPopoverOpen && (
                    <div className="mb-2 flex flex-wrap items-center gap-1.5">
                      {activeSkills.map((skill, index) => (
                        <span
                          key={skill.name}
                          data-testid="active-skill-chip"
                          className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-1 text-xs font-medium text-foreground"
                          title={skill.description || skill.name}
                        >
                          <Sparkles className="h-3 w-3 text-primary" />
                          <span>/{skill.name}</span>
                          <button
                            type="button"
                            onClick={() => removeSkill(index)}
                            className="ml-1 flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            aria-label={`Remove skill ${skill.name}`}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                      {activeSkills.length > 1 && (
                        <button
                          type="button"
                          onClick={clearAllSkills}
                          className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                        >
                          Clear all
                        </button>
                      )}
                    </div>
                  )}
                  <div className="relative">
                    <textarea
                      ref={textareaRef}
                      value={message}
                      onChange={(e) => {
                        setMessage(e.target.value);
                        setCaretPos(e.target.selectionStart ?? e.target.value.length);
                        // Typing in the composer of the originating
                        // session signals "I want to keep working
                        // here" — cancel any pending auto-advance
                        // countdown. Don't cancel if the user is
                        // typing in some other session's view (the
                        // countdown target is different from the
                        // session they're in, which is the case
                        // where the user manually navigated and
                        // typed somewhere else — the right thing is
                        // still to advance to the queued target).
                        if (
                          focusAdvanceCountdown &&
                          focusAdvanceCountdown.sentFromSessionId === sessionId &&
                          e.target.value.length > 0
                        ) {
                          focusAdvanceCountdown.onCancel();
                        }
                      }}
                      onKeyDown={handleKeyDown}
                      onSelect={(e) =>
                        setCaretPos(e.currentTarget.selectionStart ?? 0)
                      }
                      placeholder={
                        steerInProgress
                          ? "Steering…"
                          : streaming
                          ? IS_TOUCH_DEVICE
                            ? "Send to queue"
                            : `Enter to queue · ${STEER_KEY_LABEL} to steer`
                          : availableSkills.length > 0
                          ? "Describe what you want to build… type / to use a skill"
                          : sessionId
                          ? "Ask for follow-up changes"
                          : "Describe what you want to build..."
                      }
                      rows={1}
                      disabled={steerInProgress}
                      className="w-full resize-none overflow-y-auto bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
                      style={{ maxHeight: "calc(1.25rem * 5)" }}
                    />
                    {skillPopoverOpen && filteredSkills.length > 0 && (
                      <div
                        role="listbox"
                        aria-label="Skills"
                        className="absolute bottom-full left-0 z-20 mb-1 w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
                        onMouseDown={(e) => e.preventDefault()}
                      >
                        <div className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          Skills
                        </div>
                        <div className="max-h-64 overflow-y-auto">
                          {filteredSkills.map((entry, index) => {
                            const active = isSkillActive(entry);
                            return (
                            <button
                              key={entry.path}
                              ref={
                                index === skillHighlightIndex
                                  ? highlightedSkillRef
                                  : undefined
                              }
                              type="button"
                              role="option"
                              aria-selected={index === skillHighlightIndex}
                              aria-disabled={active}
                              disabled={active}
                              onClick={() => addSkillToStack(entry)}
                              onMouseEnter={() => setSkillHighlightIndex(index)}
                              className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                                active
                                  ? "cursor-not-allowed opacity-50"
                                  : index === skillHighlightIndex
                                  ? "bg-accent text-accent-foreground"
                                  : "text-popover-foreground hover:bg-accent/60"
                              }`}
                            >
                              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5 text-sm font-medium">
                                  <span>/{entry.name}</span>
                                  <Badge variant="outline" className="text-[10px]">
                                    {entry.scope}
                                  </Badge>
                                  {active && (
                                    <span className="text-[10px] font-normal text-muted-foreground">
                                      added
                                    </span>
                                  )}
                                </div>
                                {entry.description && (
                                  <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                                    {entry.description}
                                  </div>
                                )}
                              </div>
                            </button>
                            );
                          })}
                        </div>
                        <div className="mt-1 flex items-center justify-between border-t border-border/60 px-2 py-1 text-[10px] text-muted-foreground">
                          <span>
                            <Kbd>↑</Kbd> <Kbd>↓</Kbd> to navigate
                          </span>
                          <span>
                            <Kbd>Tab</Kbd> to add · <Kbd>⇧Enter</Kbd> to add &amp; send · <Kbd>Esc</Kbd> to dismiss
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                  {composerAttachments.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {composerAttachments.map((attachment) => {
                        const fileName = getFileDisplayName(attachment.file);
                        return (
                        <div
                          key={attachment.id}
                          className="flex max-w-56 items-center gap-2 rounded-md border border-border/70 bg-background/70 px-2 py-1.5 text-xs"
                        >
                          {attachment.previewUrl ? (
                            <img
                              src={attachment.previewUrl}
                              alt=""
                              className="h-8 w-8 shrink-0 rounded object-cover"
                            />
                          ) : (
                            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                          )}
                          <div className="min-w-0">
                            <div className="truncate text-foreground">{fileName}</div>
                            <div className="text-[10px] text-muted-foreground">
                              {formatBytes(attachment.file.size)}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeComposerAttachment(attachment.id)}
                            className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            title="Remove attachment"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                        );
                      })}
                    </div>
                  )}
                  {attachmentError && (
                    <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      {attachmentError}
                    </div>
                  )}
                  {providerStatusMessage && (
                    <div className="mt-2 flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      <span className="min-w-0">{providerStatusMessage}</span>
                      <button
                        type="button"
                        onClick={loadAgentProviders}
                        disabled={!providersLoaded}
                        className="shrink-0 rounded px-2 py-1 font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Retry
                      </button>
                    </div>
                  )}
                  <div className="mt-2 flex items-center gap-2 sm:justify-between">
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 sm:gap-2">
                      {/* Agent provider + run-option pickers. */}
                      {(<>
                      <div className="relative" ref={providerPickerRef}>
                        <button
                          type="button"
                          onClick={() => !sessionId && setShowProviderPicker(!showProviderPicker)}
                          disabled={!!sessionId}
                          className={`flex min-w-0 max-w-full items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors ${
                            sessionId ? "opacity-50 cursor-not-allowed" : "hover:bg-accent hover:text-foreground"
                          }`}
                        >
                          <span className="truncate">
                            {agentProviders.find((p) => p.id === selectedProvider)?.name ?? selectedProvider}
                          </span>
                          {!sessionId && <ChevronDown className="h-3 w-3" />}
                        </button>
                        {showProviderPicker && (
                          <div className="absolute bottom-full left-0 z-20 mb-1 w-40 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-1 shadow-lg">
                            {agentProviders.map((p) => (
                              <button
                                key={p.id}
                                type="button"
                                onClick={() => {
                                  setSelectedProvider(p.id);
                                  setShowProviderPicker(false);
                                }}
                                className={`flex w-full items-center rounded-md px-3 py-2 text-sm text-left transition-colors ${
                                  selectedProvider === p.id
                                    ? "bg-accent text-accent-foreground"
                                    : "text-popover-foreground hover:bg-accent"
                                }`}
                              >
                                {p.name}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <span className="hidden text-muted-foreground/40 sm:inline">|</span>
                      {providerSupportsPlanMode && (
                        <>
                          <div className="flex items-center rounded-md border border-border bg-background/60 p-0.5">
                            <button
                              type="button"
                              onClick={() => setSelectedMode("default")}
                              disabled={streaming}
                              className={`rounded px-2 py-1 text-xs transition-colors ${
                                selectedMode === "default"
                                  ? "bg-accent text-accent-foreground"
                                  : "text-muted-foreground"
                              } ${streaming ? "cursor-not-allowed opacity-50" : ""}`}
                            >
                              Default
                            </button>
                            <button
                              type="button"
                              onClick={() => setSelectedMode("plan")}
                              disabled={streaming}
                              className={`rounded px-2 py-1 text-xs transition-colors ${
                                selectedMode === "plan"
                                  ? "bg-accent text-accent-foreground"
                                  : "text-muted-foreground"
                              } ${streaming ? "cursor-not-allowed opacity-50" : ""}`}
                            >
                              Plan
                            </button>
                          </div>
                          <span className="hidden text-muted-foreground/40 sm:inline">|</span>
                          {providerSupportsReasoningEffort && (
                            <>
                              <div className="relative" ref={reasoningEffortPickerRef}>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setShowReasoningEffortPicker(!showReasoningEffortPicker)
                                  }
                                  className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                >
                                  {selectedReasoningEffortLabel}
                                  <ChevronDown className="h-3 w-3" />
                                </button>
                                {showReasoningEffortPicker && (
                                  <div className="absolute bottom-full left-0 z-20 mb-1 w-40 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-1 shadow-lg">
                                    {reasoningEffortOptions.map((option) => (
                                      <button
                                        key={option.value}
                                        type="button"
                                        onClick={() => {
                                          setSelectedReasoningEffort(option.value);
                                          setShowReasoningEffortPicker(false);
                                        }}
                                        className={`flex w-full items-center rounded-md px-3 py-2 text-sm text-left transition-colors ${
                                          selectedReasoningEffort === option.value
                                            ? "bg-accent text-accent-foreground"
                                            : "text-popover-foreground hover:bg-accent"
                                        }`}
                                      >
                                        {option.label}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </>
                          )}
                          {providerSupportsServiceTier && (
                            <button
                              type="button"
                              aria-pressed={selectedServiceTier === "fast"}
                              title={
                                selectedServiceTier === "fast"
                                  ? "Fast mode active"
                                  : "Fast mode inactive"
                              }
                              onClick={() =>
                                setSelectedServiceTier((tier) =>
                                  tier === "fast" ? "flex" : "fast"
                                )
                              }
                              className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                                selectedServiceTier === "fast"
                                  ? "bg-amber-500/15 text-amber-500 hover:bg-amber-500/20"
                                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
                              }`}
                            >
                              <Zap className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <span className="hidden text-muted-foreground/40 sm:inline">|</span>
                        </>
                      )}
                      {/* Model picker */}
                          <div className="relative min-w-0 shrink-0 sm:w-auto" ref={modelPickerRef}>
                            <button
                              type="button"
                              onClick={() => {
                                if (!showModelPicker && models.length === 0) loadModels(selectedProvider);
                                setShowModelPicker(!showModelPicker);
                              }}
                              className="flex min-w-0 items-center justify-between gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            >
                              <span className="truncate">{selectedModelName || "Select model"}</span>
                              <ChevronDown className="h-3 w-3 shrink-0" />
                            </button>
                            {showModelPicker && (
                              <div className="absolute bottom-full left-0 z-20 mb-1 max-h-80 w-[min(calc(100vw-2rem),24rem)] overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
                                {models.length === 0 ? (
                                  <div className="px-3 py-2 text-xs text-muted-foreground">
                                    No models found. Check ollama or add API keys in Settings.
                                  </div>
                                ) : (
                                  Object.entries(
                                    models.reduce<Record<string, Model[]>>((acc, m) => {
                                      // Prefer the structured `group` field from
                                      // `anita models --json`; fall back to the
                                      // provider when the model list comes from
                                      // another source.
                                      const key = m.group || m.provider || "ollama";
                                      if (!acc[key]) acc[key] = [];
                                      acc[key].push(m);
                                      return acc;
                                    }, {})
                                  ).map(([group, providerModels]) => (
                                    <div key={group}>
                                      <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                                        {group}
                                      </div>
                                      {providerModels.map((model) => {
                                        const caps = model.capabilities;
                                        const supportsAttachments =
                                          modelAcceptsAttachments(model);
                                        return (
                                        <button
                                          key={model.id}
                                          type="button"
                                          onClick={() => {
                                            setSelectedModel(model.id);
                                            setShowModelPicker(false);
                                          }}
                                          className={`flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                                            selectedModel === model.id
                                              ? "bg-accent text-accent-foreground"
                                              : "text-popover-foreground hover:bg-accent"
                                          }`}
                                        >
                                          <span className="min-w-0 truncate font-mono text-xs">{model.name}</span>
                                          <span className="ml-auto flex shrink-0 items-center gap-1.5">
                                            {supportsAttachments && (
                                              <span
                                                title={
                                                  caps?.images && caps?.files
                                                    ? "Supports image and file attachments"
                                                    : caps?.images
                                                    ? "Supports image attachments"
                                                    : "Supports file attachments"
                                                }
                                              >
                                                <Paperclip
                                                  className="h-3 w-3 text-muted-foreground"
                                                  aria-label={
                                                    caps?.images && caps?.files
                                                      ? "Supports image and file attachments"
                                                      : caps?.images
                                                      ? "Supports image attachments"
                                                      : "Supports file attachments"
                                                  }
                                                />
                                              </span>
                                            )}
                                            {model.size && (
                                              <span className="text-xs text-muted-foreground">
                                                {model.size}
                                              </span>
                                            )}
                                          </span>
                                        </button>
                                        );
                                      })}
                                    </div>
                                  ))
                                )}
                              </div>
                            )}
                          </div>
                    </>)}
                    </div>
                    <div className="flex shrink-0 items-center justify-end gap-2 self-end sm:self-auto">
                      {!streaming && canAttachMore && (
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          title={
                            !providerSupportsAttachments
                              ? `${selectedProvider} does not support attachments`
                              : !modelSupportsAttachments
                              ? "Selected model does not support attachments"
                              : "Attach files"
                          }
                          className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        >
                          <Paperclip className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {streaming && (
                        <button
                          type="button"
                          onClick={handleStop}
                          title="Stop"
                          className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                        >
                          <Square className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <Button
                        type="submit"
                        size="icon"
                        title={streaming ? "Queue for next run" : "Send"}
                        disabled={
                          steerInProgress ||
                          (!message.trim() && composerAttachments.length === 0) ||
                          !providerReady ||
                          (streaming && !(activeStreamSessionId ?? sessionId))
                        }
                        className="h-8 w-8 rounded-full"
                      >
                        {streaming ? (
                          <Plus className="h-4 w-4" />
                        ) : (
                          <ArrowUp className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              </form>
            </div>
          </div>
        </div>

        {/* Chat ↔ Right panel resize handle — desktop only */}
        {terminalOpen && mobilePanel === "agent" && (
          <div
            {...rightPanelResize.handleProps}
            className={`hidden md:flex w-1.5 cursor-col-resize shrink-0 items-center justify-center bg-transparent hover:bg-border/50 active:bg-border transition-colors ${
              rightPanelResize.dragging ? "bg-border" : ""
            }`}
          />
        )}

        {/* Right panel — desktop: side panel with Terminal/Changes/Files/Preview tabs; mobile: full screen when a panel tab is active */}
        {(terminalOpen || mobilePanel === "terminal" || mobilePanel === "changes" || mobilePanel === "files" || mobilePanel === "preview") && (() => {
          const { added: changesAdded, deleted: changesDeleted } = summarizeDiffFiles(gitDiffFiles.length > 0 ? gitDiffFiles : branchDiffFiles);
          const hasChanges = gitDiffFiles.length > 0 || branchDiffFiles.length > 0;
          return (
          <div className={`flex flex-col min-h-0 min-w-0 overflow-hidden ${
            mobilePanel === "terminal" || mobilePanel === "changes" || mobilePanel === "files" || mobilePanel === "preview" ? "flex-1 md:w-1/2" : "hidden md:flex"
          }`}
          style={terminalOpen && mobilePanel === "agent" ? { width: `${rightPanelResize.width}px`, minWidth: `${rightPanelResize.width}px` } : undefined}
          >
            {/* Tab bar — desktop only; mobile uses the header tabs */}
            <div className="hidden md:flex h-9 shrink-0 items-center border-b border-border bg-[#1c1c1e] px-2 gap-1">
              <button
                onClick={() => { setRightTab("terminal"); if (mobilePanel !== "agent") setMobilePanel("terminal"); }}
                className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  rightTab === "terminal"
                    ? "bg-accent/30 text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <TerminalSquare className="h-3 w-3" />
                Terminal
              </button>
              {hasChanges && (
                <button
                  onClick={() => { setRightTab("changes"); if (mobilePanel !== "agent") setMobilePanel("changes"); }}
                  className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                    rightTab === "changes"
                      ? "bg-accent/30 text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Diff className="h-3 w-3" />
                  Changes
                  <span className="font-mono text-[10px] text-muted-foreground/70">
                    <span className="text-green-400/90">+{changesAdded}</span>
                    {" "}
                    <span className="text-red-400/90">-{changesDeleted}</span>
                  </span>
                </button>
              )}
              <button
                onClick={() => { setRightTab("files"); if (mobilePanel !== "agent") setMobilePanel("files"); }}
                className={`flex min-w-0 items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  rightTab === "files"
                    ? "bg-accent/30 text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                title={sourcePreview?.file.relativePath ?? "Files"}
              >
                <FileCode className="h-3 w-3 shrink-0" />
                <span className="shrink-0">Files</span>
                {sourcePreview ? (
                  <span className="max-w-36 truncate font-mono text-[10px] text-muted-foreground/70">
                    {sourcePreview.file.relativePath}
                  </span>
                ) : null}
              </button>
              {previewAvailable && (
                <button
                  onClick={() => { setRightTab("preview"); if (mobilePanel !== "agent") setMobilePanel("preview"); }}
                  className={`flex min-w-0 items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                    rightTab === "preview"
                      ? "bg-accent/30 text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  title={previewPane.state.url ?? "Preview"}
                >
                  <Globe2 className="h-3 w-3 shrink-0" />
                  <span className="shrink-0">Preview</span>
                  {previewPane.state.url ? (
                    <span className="max-w-36 truncate font-mono text-[10px] text-muted-foreground/70">
                      {previewPane.state.url}
                    </span>
                  ) : null}
                </button>
              )}
            </div>
            {rightTab === "terminal" && (
              <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-[#1c1c1e] px-2">
                {terminalTabs.map((tab) => {
                  const active = tab.id === activeTerminalId;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveTerminalId(tab.id)}
                      className={`group flex h-7 max-w-40 shrink-0 items-center gap-1.5 rounded px-2 text-xs font-medium transition-colors ${
                        active
                          ? "bg-accent/30 text-foreground"
                          : "text-muted-foreground hover:bg-accent/20 hover:text-foreground"
                      }`}
                      title={tab.label}
                    >
                      <span className="min-w-0 truncate">{tab.label}</span>
                      {terminalTabs.length > 1 && (
                        <span
                          role="button"
                          tabIndex={0}
                          aria-label={`Close ${tab.label}`}
                          title={`Close ${tab.label}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleCloseTerminal(tab.id);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              event.stopPropagation();
                              handleCloseTerminal(tab.id);
                            }
                          }}
                          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/70 opacity-70 transition-colors hover:bg-background/40 hover:text-foreground group-hover:opacity-100"
                        >
                          <X className="h-3 w-3" />
                        </span>
                      )}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={handleAddTerminal}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/20 hover:text-foreground"
                  title="New terminal"
                  aria-label="New terminal"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={handleRunProjectScript}
                  disabled={runScriptPending}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/20 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  title="Run project script"
                  aria-label="Run project script"
                >
                  {runScriptPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            )}
            {/* Content area — terminal always mounted and sized, changes panel overlaid */}
            <div className="relative flex-1 min-h-0">
              <div className={`absolute inset-0 ${rightTab !== "terminal" ? "invisible pointer-events-none" : ""}`}>
                {terminalTabs.map((tab) => (
                  <div
                    key={tab.id}
                    className={`absolute inset-0 ${
                      tab.id !== activeTerminalId ? "invisible pointer-events-none" : ""
                    }`}
                  >
                    <Terminal
                      ref={(handle) => handleTerminalRef(tab.id, handle)}
                      projectId={projectId}
                      worktreeId={worktreeId}
                      terminalId={tab.id}
                    />
                  </div>
                ))}
              </div>
              {rightTab === "changes" && (gitDiffFiles.length > 0 || branchDiffFiles.length > 0) && (
                <div className="absolute inset-0 overflow-auto bg-background">
                  <ChangesPanel
                    localFiles={gitDiffFiles}
                    branchFiles={branchDiffFiles}
                    projectRoot={activeWorktree?.path ?? project?.path}
                  />
                </div>
              )}
              {rightTab === "files" && (
                <div className="absolute inset-0 overflow-hidden bg-background">
                  <SourceViewerPanel
                    onOpenFile={(path) => openSourcePath(path)}
                    preview={sourcePreview}
                    projectId={projectId}
                    worktreeId={worktreeId}
                  />
                </div>
              )}
              {rightTab === "preview" && previewAvailable && (
                <div className="absolute inset-0 overflow-hidden bg-background">
                  <PreviewPanel
                    projectRoot={previewProjectRoot}
                    state={previewPane.state}
                    onClear={previewPane.clear}
                    onOpenUrl={previewPane.open}
                    onReload={previewPane.reload}
                    onSetInput={previewPane.setInput}
                    placeholderRef={setPreviewPlaceholder}
                  />
                </div>
              )}
            </div>
            {rightTab === "terminal" && <TerminalMobileControls terminalRef={terminalRef} />}
          </div>
          );
        })()}
      </div>
    </>
  );
}

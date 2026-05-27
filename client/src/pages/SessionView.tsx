import { useState, useEffect, useRef, createContext, useContext } from "react";
import { diffLines } from "diff";
import { ArrowUp, Loader2, Copy, Check, ChevronDown, ChevronRight, TerminalSquare, MessageSquare, Square, Diff, PanelRight, Zap, Plus, X, Paperclip, FileText } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Terminal, type TerminalHandle } from "@/components/terminal";
import { TerminalMobileControls } from "@/components/terminal-mobile-controls";
import {
  fetchEvents,
  fetchBranchDiff,
  fetchGitDiff,
  fetchModels,
  fetchAgentProviders,
  fetchSession,
  fetchSessionRuntime,
  fetchWorktrees,
  dismissSessionUserInput,
  startSession,
  stopSession,
  steerSession,
  submitSessionUserInput,
  type Project,
  uploadSessionAttachments,
  type Worktree,
  type AgentEvent,
  type AgentProviderInfo,
  type Model,
  type PlanStep,
  type ReasoningEffort,
  type ServiceTier,
  type SessionStreamEvent,
  type SessionAttachment,
  type UserInputQuestion,
} from "../api.ts";

interface SessionViewProps {
  projectId: string;
  sessionId?: string;
  worktreeId?: string;
  project?: Project;
  onSessionCreated: (sessionId: string) => void;
  onBackgroundComplete?: (sessionId: string) => void;
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
  | { type: "thread_status"; status: string; activeFlags: string[] }
  | { type: "error"; text: unknown }
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

function supportsLiveSteering(provider: string): boolean {
  return provider === "codex";
}

function supportsAttachments(provider: string): boolean {
  return provider === "codex" || provider === "claude";
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
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left min-w-0 hover:bg-muted/40 transition-colors bg-muted/20"
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

function RunDiffCard({ data }: { data: Record<string, unknown> }) {
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
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/40"
          >
            <span>Show {hiddenCount} more file{hiddenCount === 1 ? "" : "s"}</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        )}
      </div>
    </div>
  );
}

function RunDiffFileRow({ file, label }: { file: DiffFile; label: string }) {
  const [expanded, setExpanded] = useState(false);
  const fileSummary = summarizeDiffFiles([file]);

  return (
    <div>
      <button
        onClick={() => setExpanded((open) => !open)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/40"
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

interface TerminalTab {
  id: string;
  label: string;
}

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
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
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

function EventBlock({
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

  // user_message: show as chat bubble
  if (event.type === "user_message" && data.text) {
    const attachments = (data.attachments as SessionAttachment[] | undefined) ?? [];
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%]">
          <AttachmentStrip attachments={attachments} />
          <div className="rounded-2xl bg-secondary px-4 py-3 text-sm">
            {normalizeMarkdownText(data.text)}
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
  // Silence unused-warning suppression (expanded used by fallback case below).
  void expanded;

  if (event.type === "user_input_requested") {
    if (hiddenPendingUserInputEventId === event.id) return null;
    const questions = ((data.questions as UserInputQuestion[] | undefined) ?? []).filter(Boolean);
    if (questions.length === 0) return null;
    return <UserInputRequestedBlock questions={questions} />;
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
}

function AssistantBlock({
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
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{normalizedText}</ReactMarkdown>
      </div>
      {children}
    </div>
  );
}

function ReasoningBlock({ text }: { text: unknown }) {
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
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{normalizedText}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolCallRow({
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
  const diffFiles = parseDiffFromToolCall(tool, input);
  const hasDiff = diffFiles.length > 0;

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
}

function ToolResultRow({
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
    </div>
  );
}

function WorkingChildEvent({ event }: { event: AgentEvent }) {
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
}

function WorkingChildStreamItem({ item }: { item: StreamItem }) {
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
}

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
}: SessionViewProps) {
  const [message, setMessage] = useState("");
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<SessionAttachment[]>([]);
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
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
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showReasoningEffortPicker, setShowReasoningEffortPicker] = useState(false);
  const [activeStreamSessionId, setActiveStreamSessionId] = useState<string | null>(sessionId ?? null);
  const [agentProviders, setAgentProviders] = useState<AgentProviderInfo[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [providerLoadError, setProviderLoadError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string>("ada");
  const [providerResolved, setProviderResolved] = useState(!sessionId);
  const [showProviderPicker, setShowProviderPicker] = useState(false);
  const initialTerminalState = loadStoredTerminals(projectId, worktreeId);
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>(initialTerminalState.tabs);
  const [activeTerminalId, setActiveTerminalId] = useState<string>(initialTerminalState.activeId);
  const [loadedTerminalStorageKey, setLoadedTerminalStorageKey] = useState(() =>
    buildTerminalStorageKey(projectId, worktreeId)
  );
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<"agent" | "terminal" | "changes">("agent");
  const [rightTab, setRightTab] = useState<"terminal" | "changes">("terminal");
  const [gitDiffFiles, setGitDiffFiles] = useState<DiffFile[]>([]);
  const [gitDiffLoaded, setGitDiffLoaded] = useState(false);
  const [branchDiffFiles, setBranchDiffFiles] = useState<DiffFile[]>([]);
  const [userInputDraft, setUserInputDraft] = useState<Record<string, string>>({});
  const [submittingUserInput, setSubmittingUserInput] = useState(false);
  const [activeWorktree, setActiveWorktree] = useState<Worktree | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const terminalRef = useRef<TerminalHandle | null>(null);
  const terminalRefs = useRef<Record<string, TerminalHandle | null>>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const reasoningEffortPickerRef = useRef<HTMLDivElement>(null);
  const providerPickerRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const streamingRef = useRef(streaming);
  const pendingAttachedSessionIdRef = useRef<string | null>(null);
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
  const providerSupportsLiveSteering = supportsLiveSteering(selectedProvider);
  const providerSupportsAttachments = supportsAttachments(selectedProvider);
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
    const stored = loadStoredTerminals(projectId, worktreeId);
    setTerminalTabs(stored.tabs);
    setActiveTerminalId(stored.activeId);
    setLoadedTerminalStorageKey(buildTerminalStorageKey(projectId, worktreeId));
    terminalRef.current = terminalRefs.current[stored.activeId] ?? null;
  }, [projectId, worktreeId]);

  useEffect(() => {
    terminalRef.current = terminalRefs.current[activeTerminalId] ?? null;
  }, [activeTerminalId, terminalTabs]);

  useEffect(() => {
    if (loadedTerminalStorageKey !== terminalStorageKey) return;
    try {
      window.localStorage.setItem(
        terminalStorageKey,
        JSON.stringify({ tabs: terminalTabs, activeId: activeTerminalId })
      );
    } catch {}
  }, [loadedTerminalStorageKey, terminalStorageKey, terminalTabs, activeTerminalId]);

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
    setTerminalTabs((prev) => [...prev, nextTab]);
    setActiveTerminalId(nextTab.id);
    setRightTab("terminal");
    if (mobilePanel === "changes") setMobilePanel("terminal");
  };

  const handleCloseTerminal = (terminalId: string) => {
    if (terminalTabs.length <= 1) return;
    terminalRefs.current[terminalId]?.close();
    setTerminalTabs((prev) => {
      if (prev.length <= 1) return prev;
      const closingIndex = prev.findIndex((tab) => tab.id === terminalId);
      if (closingIndex === -1) return prev;
      const next = prev.filter((tab) => tab.id !== terminalId);
      if (activeTerminalId === terminalId) {
        const nextActive = next[Math.min(closingIndex, next.length - 1)] ?? next[0];
        setActiveTerminalId(nextActive.id);
      }
      return next;
    });
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
    }
  };

  const loadModels = (provider?: string) => {
    fetchModels(provider ?? selectedProvider)
      .then((m) => {
        setModels(m);
        // Only reset to the first model if the current selection isn't in the list
        setSelectedModel((prev) => {
          if (prev && m.some((model) => model.id === prev)) return prev;
          return m.length > 0 ? m[0].id : "";
        });
      })
      .catch(() => {});
  };

  const loadAgentProviders = () => {
    setProvidersLoaded(false);
    setProviderLoadError(null);
    fetchAgentProviders()
      .then((p) => {
        setAgentProviders(p);
        if (p.length === 0) {
          setProviderLoadError("No agent providers were found. Check your CLI installs and retry.");
        }
        if (!sessionId) {
          setSelectedProvider((prev) =>
            p.some((provider) => provider.id === prev) ? prev : p[0]?.id ?? prev
          );
        }
      })
      .catch(() => {
        setAgentProviders([]);
        setProviderLoadError("Could not load agent providers. Retry before starting a session.");
      })
      .finally(() => setProvidersLoaded(true));
  };

  useEffect(() => {
    if (providerResolved && providerReady) loadModels(selectedProvider);
  }, [selectedProvider, providerResolved, providerReady]);

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
    if (!worktreeId) {
      setActiveWorktree(null);
      return;
    }
    fetchWorktrees(projectId)
      .then((wts) => setActiveWorktree(wts.find((w) => w.id === worktreeId) ?? null))
      .catch(() => {});
  }, [projectId, worktreeId]);

  // When loading an existing session, restore the provider and model that were used
  useEffect(() => {
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
        fetchSessionRuntime(projectId, sessionId, worktreeId),
      ])
        .then(([sessionResult, eventsResult, runtimeResult]) => {
          if (cancelled) return;
          if (sessionResult.status === "fulfilled") {
            const session = sessionResult.value;
            setSelectedProvider(session.provider || "ada");
            setSelectedMode(session.mode || "default");
            if (session.model) {
              setSelectedModel(session.model);
            }
            setSelectedReasoningEffort(session.reasoningEffort || "medium");
            setSelectedServiceTier(session.serviceTier || "flex");
          }

          if (eventsResult.status === "fulfilled") {
            setEvents(eventsResult.value);
          } else {
            setEvents([]);
          }

          if (runtimeResult.status === "fulfilled") {
            setStreaming(runtimeResult.value.active);
          } else {
            setStreaming(false);
          }
        })
        .finally(() => {
          if (!cancelled) setProviderResolved(true);
        });
    } else {
      setEvents([]);
      setStreamItems([]);
      setStreaming(false);
      setProviderResolved(true);
      setSelectedMode("default");
      setSelectedReasoningEffort("medium");
      setSelectedServiceTier("flex");
    }
    setActiveStreamSessionId(sessionId ?? null);
    setUserInputDraft({});
    return () => {
      cancelled = true;
    };
  }, [projectId, sessionId, worktreeId]);

  useEffect(() => {
    if (!sessionId) return;
    if (!streaming) return;
    if (
      eventSourceRef.current &&
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
        const [evts, runtime] = await Promise.all([
          fetchEvents(projectId, sessionId, worktreeId),
          fetchSessionRuntime(projectId, sessionId, worktreeId),
        ]);
        if (cancelled) return;
        setEvents(evts);
        if (!runtime.active) {
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
  }, [projectId, sessionId, worktreeId, streaming]);

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
    visibleAttachments?: SessionAttachment[]
  ) => {
    if (!sentMessage.trim() || streamingRef.current) return false;
    if (!providerReady) {
      setProviderLoadError(
        providerLoadError ?? "Could not start because agent providers are not ready. Retry provider discovery."
      );
      return false;
    }

    const streamSessionId = resumeSessionIdOverride ?? sessionId;
    streamingRef.current = true;
    setPendingMessage(pendingVisibleMessage);
    setPendingAttachments(visibleAttachments ?? []);
    setStreaming(true);
    setStreamItems([]);
    let detectedSessionId = streamSessionId;
    let runFailed = false;

    // Track which session this stream belongs to
    sendContextRef.current = { projectId, worktreeId, sessionId: streamSessionId };
    debugSessionIsolation("stream.started", {
      projectId,
      worktreeId,
      sessionId,
      provider: selectedProvider,
      mode: selectedMode,
    });

    const es = startSession(projectId, sentMessage, {
      resumeSessionId: streamSessionId,
      model: selectedModel,
      reasoningEffort:
        providerSupportsReasoningEffort ? selectedReasoningEffort : undefined,
      serviceTier:
        providerSupportsServiceTier && selectedServiceTier === "fast"
          ? selectedServiceTier
          : undefined,
      provider: selectedProvider || undefined,
      mode: providerSupportsPlanMode ? modeOverride ?? selectedMode : "default",
      worktreeId,
      attachmentIds,
    });
    eventSourceRef.current = es;

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
      } else if (data.type === "ada_event") {
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
        } else if (adaEvent.type === "thread.status") {
          // Thread status changes are useful internally, but they're noisy in
          // the visible transcript when there's no actionable information.
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
        const wasVisible = isVisible();
        sendContextRef.current = null;

        if (wasVisible) {
          streamingRef.current = false;
          setStreaming(false);
          setPendingMessage(null);
          setPendingAttachments([]);
          setActiveStreamSessionId(detectedSessionId || null);
          if (detectedSessionId) {
            fetchEvents(projectId, detectedSessionId, worktreeId)
              .then((evts) => {
                setEvents(evts);
                if (evts.length > 0 && !runFailed && (data.exitCode ?? 1) === 0) {
                  setStreamItems([]);
                }
              })
              .catch(() => {});
          }
        } else {
          // Stream completed while user was viewing another session
          if (detectedSessionId && onBackgroundComplete) {
            onBackgroundComplete(detectedSessionId);
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
        const wasVisible = isVisible();
        sendContextRef.current = null;
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

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() && composerAttachments.length === 0) return;
    if (composerAttachments.length > 0 && !providerSupportsAttachments) {
      setAttachmentError("Attachments are available for Codex and Claude Code");
      return;
    }
    const sentMessage = message.trim() || "Please use the attached files as context.";
    setAttachmentError(null);
    try {
      const uploadedAttachments = await uploadComposerAttachments();
      if (
        await startAgentStream(
          sentMessage,
          sentMessage,
          undefined,
          undefined,
          uploadedAttachments.map((attachment) => attachment.id),
          uploadedAttachments
        )
      ) {
        composerAttachments.forEach((attachment) => {
          if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
        });
        setComposerAttachments([]);
        setMessage("");
      }
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "Failed to upload attachments");
      streamingRef.current = false;
      setStreaming(false);
      setPendingMessage(null);
      setPendingAttachments([]);
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

  const handleSteer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    const targetSessionId = activeStreamSessionId ?? sessionId;
    if (!targetSessionId) return;
    const steerText = message;
    setMessage("");
    setStreamItems((prev) => [...prev, { type: "user_message", text: steerText, at: Date.now() }]);
    try {
      await steerSession(projectId, targetSessionId, steerText, worktreeId);
    } catch (err) {
      setStreamItems((prev) => [
        ...prev,
        { type: "error", text: err instanceof Error ? err.message : "Failed to steer session", at: Date.now() },
      ]);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (streaming && providerSupportsLiveSteering) {
        handleSteer(e as unknown as React.FormEvent);
      } else {
        handleSend(e);
      }
    }
  };

  const copyEventData = (event: AgentEvent) => {
    navigator.clipboard.writeText(JSON.stringify(event.data, null, 2));
    setCopiedId(event.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

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

  const selectedModelName =
    models.find((m) => m.id === selectedModel)?.name ?? selectedModel;
  const selectedReasoningEffortLabel =
    REASONING_EFFORT_OPTIONS.find((option) => option.value === selectedReasoningEffort)?.label ??
    selectedReasoningEffort;
  const streamBelongsToCurrentView =
    streamItems.length === 0 ||
    (activeStreamSessionId
      ? activeStreamSessionId === sessionId ||
        (!sessionId && pendingAttachedSessionIdRef.current === activeStreamSessionId)
      : !sessionId);
  const visibleStreamItems = streamBelongsToCurrentView ? streamItems : [];
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

  return (
    <>
      {/* Header */}
      <header className="flex h-12 md:h-14 shrink-0 items-center justify-between border-b border-border bg-background px-3 md:px-4">
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
          <h1 className="text-sm font-medium truncate">
            {project?.name ?? "Project"}
          </h1>
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

      {/* Main content area: chat + terminal side by side on desktop, tabbed on mobile */}
      <div className="flex flex-1 min-h-0">
        {/* Chat panel — hidden on mobile when terminal or changes tab is active */}
        <div className={`flex-col min-h-0 min-w-0 w-full ${
          sessionId && mobilePanel !== "agent" ? "hidden md:flex" : "flex"
        } ${terminalOpen ? "md:w-1/2 md:border-r md:border-border" : "flex-1"}`}>
          {/* Messages / Events area */}
          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto min-h-0"
          >
            <ProjectRootContext.Provider value={activeWorktree?.path ?? project?.path}>
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
                {groupEventsForRender(events).map((renderItem) => {
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
              {pendingMessage && showPendingMessage && (
                <div className="flex justify-end mt-4">
                  <div className="max-w-[85%]">
                    <AttachmentStrip attachments={pendingAttachments} />
                    <div className="rounded-2xl bg-secondary px-4 py-3 text-sm">
                      {pendingMessage}
                    </div>
                  </div>
                </div>
              )}

              {/* Stream output */}
              {visibleStreamItems.length > 0 && (() => {
                const streamGroups = groupStreamItemsForRender(visibleStreamItems);
                return (
                <div className="mt-4 space-y-3">
                  {streamGroups.map((render, idx) => {
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
                      const live = streaming && idx === streamGroups.length - 1;
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
                              {normalizeMarkdownText(item.text)}
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

                    if (item.type === "thread_status") {
                      return null;
                    }

                    if (item.type === "error") {
                      return <ErrorBlock key={render.key} text={item.text} />;
                    }

                    return null;
                  })}
                </div>
              );
              })()}

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

              {streaming && !waitingForStructuredInput && (
                <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Working...</span>
                </div>
              )}

              <div ref={bottomRef} />
            </div>
            </ProjectRootContext.Provider>
          </div>

          {/* Input */}
          <div className="shrink-0 border-t border-border bg-background px-3 pb-3 pt-2 md:px-4 md:pb-4 md:pt-3">
            <div className="mx-auto max-w-3xl">
              <form onSubmit={streaming && providerSupportsLiveSteering ? handleSteer : handleSend}>
                <div
                  className="rounded-xl border border-border bg-input p-3"
                  onDragOver={(event) => {
                    if (!providerSupportsAttachments) return;
                    event.preventDefault();
                  }}
                  onDrop={(event) => {
                    if (!providerSupportsAttachments) return;
                    event.preventDefault();
                    addComposerFiles(event.dataTransfer.files);
                  }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    accept={Array.from(SUPPORTED_ATTACHMENT_TYPES).join(",")}
                    onChange={(event) => {
                      if (event.target.files) addComposerFiles(event.target.files);
                      event.currentTarget.value = "";
                    }}
                  />
                  <textarea
                    ref={textareaRef}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={
                      streaming && providerSupportsLiveSteering
                        ? "Steer the agent..."
                        : sessionId
                        ? "Ask for follow-up changes"
                        : "Describe what you want to build..."
                    }
                    rows={1}
                    disabled={streaming && !providerSupportsLiveSteering}
                    className="w-full resize-none overflow-y-auto bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
                    style={{ maxHeight: "calc(1.25rem * 5)" }}
                  />
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
                      {/* Agent provider picker — hidden while the active provider supports steering */}
                      {streaming && providerSupportsLiveSteering ? null : (<>
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
                                      const provider = m.provider || "ollama";
                                      if (!acc[provider]) acc[provider] = [];
                                      acc[provider].push(m);
                                      return acc;
                                    }, {})
                                  ).map(([provider, providerModels]) => (
                                    <div key={provider}>
                                      <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                                        {provider}
                                      </div>
                                      {providerModels.map((model) => (
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
                                          {model.size && (
                                            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                                              {model.size}
                                            </span>
                                          )}
                                        </button>
                                      ))}
                                    </div>
                                  ))
                                )}
                              </div>
                            )}
                          </div>
                    </>)}
                    </div>
                    <div className="flex shrink-0 items-center justify-end gap-2 self-end sm:self-auto">
                      {!streaming && providerSupportsAttachments && (
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          title="Attach files"
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
                        disabled={
                          streaming && providerSupportsLiveSteering
                            ? !message.trim() || !providerReady
                            : (!message.trim() && composerAttachments.length === 0) ||
                              streaming ||
                              !providerReady
                        }
                        className="h-8 w-8 rounded-full"
                      >
                        {streaming && providerSupportsLiveSteering ? (
                          <MessageSquare className="h-4 w-4" />
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

        {/* Right panel — desktop: side panel with Terminal/Changes tabs; mobile: full screen when terminal/changes tab active */}
        {(terminalOpen || mobilePanel === "terminal" || mobilePanel === "changes") && (() => {
          const { added: changesAdded, deleted: changesDeleted } = summarizeDiffFiles(gitDiffFiles.length > 0 ? gitDiffFiles : branchDiffFiles);
          const hasChanges = gitDiffFiles.length > 0 || branchDiffFiles.length > 0;
          return (
          <div className={`flex flex-col min-h-0 min-w-0 overflow-hidden ${
            mobilePanel === "terminal" || mobilePanel === "changes" ? "flex-1 md:w-1/2" : "hidden md:flex md:w-1/2"
          }`}>
            {/* Tab bar — desktop only; mobile uses the header tabs */}
            <div className="hidden md:flex h-9 shrink-0 items-center border-b border-border bg-[#1c1c1e] px-2 gap-1">
              <button
                onClick={() => { setRightTab("terminal"); if (mobilePanel === "changes") setMobilePanel("terminal"); }}
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
                  onClick={() => { setRightTab("changes"); if (mobilePanel === "terminal") setMobilePanel("changes"); }}
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
            </div>
            {rightTab === "terminal" && <TerminalMobileControls terminalRef={terminalRef} />}
          </div>
          );
        })()}
      </div>
    </>
  );
}

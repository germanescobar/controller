import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { orchestratorHome, terminalTabsRegistryFile } from "./paths.js";

export interface TerminalTab {
  id: string;
  label: string;
}

const DEFAULT_TERMINAL_TAB: TerminalTab = {
  id: "default",
  label: "Terminal 1",
};
const TMUX_SESSION_PREFIX = "controller-";
/* Sessions created by builds before the coding-orchestrator → Controller
 * rename used this prefix. Discovery matches it too so terminals from an older
 * build still surface as tabs. */
const LEGACY_TMUX_SESSION_PREFIX = "coding-orchestrator-";

type Registry = Record<string, TerminalTab[]>;

interface SetTerminalTabsOptions {
  removeTerminalId?: string;
}

function registryKey(projectId: string, worktreeId: string): string {
  return `${projectId}:${worktreeId}`;
}

function sanitizeTmuxName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function listTmuxTerminalIds(projectId: string, worktreeId: string): string[] {
  let output = "";
  try {
    output = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }

  const suffix = sanitizeTmuxName(`${projectId}:${worktreeId}:`);
  const prefixes = [`${TMUX_SESSION_PREFIX}${suffix}`, `${LEGACY_TMUX_SESSION_PREFIX}${suffix}`];
  const seen = new Set<string>();
  return output
    .split("\n")
    .map((line) => line.trim())
    .map((line) => {
      const prefix = prefixes.find((candidate) => line.startsWith(candidate));
      return prefix ? line.slice(prefix.length).replace(/-[0-9a-f]{12}$/, "") : "";
    })
    .filter((id) => id && /^[a-zA-Z0-9._-]+$/.test(id) && !seen.has(id) && seen.add(id));
}

function mergeDiscoveredTabs(tabs: TerminalTab[], terminalIds: string[]): TerminalTab[] {
  const existingIds = new Set(tabs.map((tab) => tab.id));
  const usedLabels = new Set(tabs.map((tab) => tab.label));
  const next = [...tabs];
  let nextNumber = tabs.length + 1;

  for (const id of terminalIds) {
    if (existingIds.has(id)) continue;
    while (usedLabels.has(`Terminal ${nextNumber}`)) nextNumber += 1;
    const label = `Terminal ${nextNumber}`;
    next.push({ id, label });
    existingIds.add(id);
    usedLabels.add(label);
    nextNumber += 1;
  }

  return next;
}

function mergeTerminalTabs(tabs: TerminalTab[], incomingTabs: TerminalTab[]): TerminalTab[] {
  const existingIds = new Set(tabs.map((tab) => tab.id));
  return [
    ...tabs,
    ...incomingTabs.filter((tab) => {
      if (existingIds.has(tab.id)) return false;
      existingIds.add(tab.id);
      return true;
    }),
  ];
}

function removeTerminalTab(tabs: TerminalTab[], terminalId?: string): TerminalTab[] {
  if (!terminalId || terminalId === DEFAULT_TERMINAL_TAB.id) return tabs;
  const next = tabs.filter((tab) => tab.id !== terminalId);
  return next.length > 0 ? next : [DEFAULT_TERMINAL_TAB];
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

async function readRegistry(): Promise<Registry> {
  try {
    const content = await fs.readFile(terminalTabsRegistryFile(), "utf-8");
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Registry)
      : {};
  } catch {
    return {};
  }
}

async function writeRegistry(registry: Registry): Promise<void> {
  await fs.mkdir(orchestratorHome(), { recursive: true });
  await fs.writeFile(terminalTabsRegistryFile(), JSON.stringify(registry, null, 2));
}

export async function getTerminalTabs(
  projectId: string,
  worktreeId: string
): Promise<TerminalTab[]> {
  const registry = await readRegistry();
  const key = registryKey(projectId, worktreeId);
  const tabs = normalizeTerminalTabs(registry[key]);
  const merged = mergeDiscoveredTabs(tabs, listTmuxTerminalIds(projectId, worktreeId));
  if (merged.length !== tabs.length) {
    registry[key] = merged;
    await writeRegistry(registry);
  }
  return merged;
}

export async function setTerminalTabs(
  projectId: string,
  worktreeId: string,
  tabs: unknown,
  options: SetTerminalTabsOptions = {}
): Promise<TerminalTab[]> {
  const registry = await readRegistry();
  const key = registryKey(projectId, worktreeId);
  const currentTabs = normalizeTerminalTabs(registry[key]);
  const incomingTabs = normalizeTerminalTabs(tabs);
  const discoveredIds = listTmuxTerminalIds(projectId, worktreeId).filter(
    (id) => id !== options.removeTerminalId
  );
  const mergedTabs = mergeDiscoveredTabs(
    mergeTerminalTabs(currentTabs, incomingTabs),
    discoveredIds
  );
  const normalized = removeTerminalTab(mergedTabs, options.removeTerminalId);
  registry[key] = normalized;
  await writeRegistry(registry);
  return normalized;
}

export async function removeTerminalTabsForWorktree(
  projectId: string,
  worktreeId: string
): Promise<void> {
  const registry = await readRegistry();
  const key = registryKey(projectId, worktreeId);
  if (!(key in registry)) return;
  delete registry[key];
  await writeRegistry(registry);
}

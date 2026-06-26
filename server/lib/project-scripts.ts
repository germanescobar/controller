import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Project } from "./projects.js";
import type { Worktree } from "./worktrees.js";

export type ProjectScriptSource = "native" | "conductor" | "superset";
export type ProjectRunMode = "concurrent" | "nonconcurrent";

export interface ProjectScriptCommand {
  command: string;
  label: string;
  source: ProjectScriptSource;
}

export interface ProjectScripts {
  setup: ProjectScriptCommand[];
  run: ProjectScriptCommand[];
  archive: ProjectScriptCommand[];
  runMode: ProjectRunMode;
}

interface NativeScripts {
  setup?: string;
  run?: string;
  archive?: string;
}

interface ScriptContext {
  project: Project;
  worktree: Pick<Worktree, "id" | "name" | "path" | "branch" | "portOffset">;
}

interface SupersetScriptExtension {
  before?: string[];
  after?: string[];
}

const DEFAULT_RUN_MODE: ProjectRunMode = "concurrent";

/* Current native-script directory. New projects write here. */
export const NATIVE_SCRIPT_DIR = ".controller";
/* Legacy native-script directory used before the coding-orchestrator →
 * Controller rename. Still read (and written back to, for already-onboarded
 * repos) so the rename doesn't strand existing projects. */
export const LEGACY_NATIVE_SCRIPT_DIR = ".coding-orchestrator";

/*
 * Resolves which native-script directory a project uses. Prefers the current
 * `.controller/` directory; falls back to the legacy `.coding-orchestrator/`
 * directory only when that is the one present on disk. A project with neither
 * (a brand-new project) resolves to `.controller/`, so all fresh writes land
 * in the new location while an already-onboarded `.coding-orchestrator/` repo
 * keeps reading and writing its existing directory. Mirrors the read-both /
 * no-auto-move shape of the macOS-home migration in #223.
 */
export function resolveNativeScriptDir(projectPath: string): string {
  const current = path.join(projectPath, NATIVE_SCRIPT_DIR);
  if (existsSync(current)) return current;
  const legacy = path.join(projectPath, LEGACY_NATIVE_SCRIPT_DIR);
  if (existsSync(legacy)) return legacy;
  return current;
}

export async function resolveProjectScripts(projectPath: string): Promise<ProjectScripts> {
  const native = await readNativeScripts(projectPath);
  const external =
    (await readConductorScripts(projectPath)) ??
    (await readSupersetScripts(projectPath)) ??
    emptyProjectScripts();

  return {
    setup: native.setup.length > 0 ? native.setup : external.setup,
    run: native.run.length > 0 ? native.run : external.run,
    archive: native.archive.length > 0 ? native.archive : external.archive,
    runMode: native.run.length > 0 ? native.runMode : external.runMode,
  };
}

export function buildScriptEnv(context: ScriptContext): Record<string, string> {
  const port = String(context.worktree.portOffset ?? 0);
  const branch = context.worktree.branch ?? "";
  return {
    WORKTREE_PATH: context.worktree.path,
    SOURCE_PATH: context.project.path,
    WORKTREE_NAME: context.worktree.name,
    BRANCH: branch,
    PROJECT_ID: context.project.id,
    PORT_OFFSET: port,
    CONDUCTOR_WORKSPACE_PATH: context.worktree.path,
    CONDUCTOR_ROOT_PATH: context.project.path,
    CONDUCTOR_WORKSPACE_NAME: context.worktree.name,
    CONDUCTOR_DEFAULT_BRANCH: branch,
    CONDUCTOR_PORT: port,
    SUPERSET_WORKSPACE_PATH: context.worktree.path,
    SUPERSET_ROOT_PATH: context.project.path,
    SUPERSET_WORKSPACE_NAME: context.worktree.name,
  };
}

export function buildTerminalScriptCommand(
  commands: ProjectScriptCommand[],
  env: Record<string, string>
): string {
  const body = joinShellCommands(commands.map((item) => item.command));
  return `${formatEnvAssignments(env)} bash -lc ${shellQuote(`set -e; ${body}`)}`;
}

function joinShellCommands(commands: string[]): string {
  return commands.reduce((script, command) => {
    if (!script) return command;
    return `${script}${needsCommandSeparator(script) ? ";" : ""}\n${command}`;
  }, "");
}

function needsCommandSeparator(command: string): boolean {
  return !/[;&|]\s*$/.test(command);
}

function emptyProjectScripts(): ProjectScripts {
  return {
    setup: [],
    run: [],
    archive: [],
    runMode: DEFAULT_RUN_MODE,
  };
}

async function readNativeScripts(projectPath: string): Promise<ProjectScripts> {
  const dir = resolveNativeScriptDir(projectPath);
  const scripts: NativeScripts = {
    setup: await commandForScriptFile(dir, "setup.sh"),
    run: await commandForScriptFile(dir, "run.sh"),
    archive: await commandForScriptFile(dir, "archive.sh"),
  };

  return {
    setup: toScriptCommands(scripts.setup, "setup.sh", "native"),
    run: toScriptCommands(scripts.run, "run.sh", "native"),
    archive: toScriptCommands(scripts.archive, "archive.sh", "native"),
    runMode: DEFAULT_RUN_MODE,
  };
}

async function commandForScriptFile(dir: string, fileName: string): Promise<string | undefined> {
  const filePath = path.join(dir, fileName);
  if (!existsSync(filePath)) return undefined;
  return `bash ${shellQuote(filePath)}`;
}

async function readConductorScripts(projectPath: string): Promise<ProjectScripts | null> {
  const configPath = path.join(projectPath, "conductor.json");
  const raw = await readJsonObject(configPath);
  if (!raw) return null;

  const scripts = getObject(raw, "scripts");
  if (!scripts) return emptyProjectScripts();

  return {
    setup: toScriptCommands(getString(scripts, "setup"), "conductor setup", "conductor"),
    run: toScriptCommands(getString(scripts, "run"), "conductor run", "conductor"),
    archive: toScriptCommands(getString(scripts, "archive"), "conductor archive", "conductor"),
    runMode: normalizeRunMode(getString(raw, "runScriptMode")),
  };
}

async function readSupersetScripts(projectPath: string): Promise<ProjectScripts | null> {
  const configPath = path.join(projectPath, ".superset", "config.json");
  const config = await readJsonObject(configPath);
  if (!config) return null;

  const localPath = path.join(projectPath, ".superset", "config.local.json");
  const local = await readJsonObject(localPath);

  return {
    setup: toScriptCommands(
      mergeSupersetScriptConfig(config.setup, local?.setup),
      "superset setup",
      "superset"
    ),
    run: toScriptCommands(
      mergeSupersetScriptConfig(config.run, local?.run),
      "superset run",
      "superset"
    ),
    archive: toScriptCommands(
      mergeSupersetScriptConfig(config.teardown, local?.teardown),
      "superset teardown",
      "superset"
    ),
    runMode: DEFAULT_RUN_MODE,
  };
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(filePath)) return null;
  const content = await fs.readFile(filePath, "utf-8");
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function toScriptCommands(
  value: string | string[] | undefined,
  label: string,
  source: ProjectScriptSource
): ProjectScriptCommand[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values
    .map((command) => command.trim())
    .filter(Boolean)
    .map((command) => ({ command, label, source }));
}

function getObject(
  value: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const item = value[key];
  return item && typeof item === "object" && !Array.isArray(item)
    ? (item as Record<string, unknown>)
    : undefined;
}

function getString(value: Record<string, unknown>, key: string): string | undefined {
  const item = value[key];
  return typeof item === "string" ? item : undefined;
}

function getStringArray(value: Record<string, unknown>, key: string): string[] | undefined {
  const item = value[key];
  return normalizeStringArray(item);
}

function mergeSupersetScriptConfig(base: unknown, local: unknown): string[] | undefined {
  const baseCommands = normalizeStringArray(base);
  if (local === undefined) return baseCommands;

  const localCommands = normalizeStringArray(local);
  if (localCommands) return localCommands;

  const extension = normalizeSupersetScriptExtension(local);
  if (!extension) return baseCommands;

  return [
    ...(normalizeStringArray(extension.before) ?? []),
    ...(baseCommands ?? []),
    ...(normalizeStringArray(extension.after) ?? []),
  ];
}

function normalizeSupersetScriptExtension(value: unknown): SupersetScriptExtension | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  return {
    before: normalizeStringArray(raw.before),
    after: normalizeStringArray(raw.after),
  };
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function normalizeRunMode(value: string | undefined): ProjectRunMode {
  return value === "nonconcurrent" ? "nonconcurrent" : DEFAULT_RUN_MODE;
}

function formatEnvAssignments(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

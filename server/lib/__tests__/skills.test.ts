import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  buildSkillHistoryMessage,
  buildSkillPrefix,
  extractSkillInvocation,
  getSkillProvider,
  parseSkillFile,
  type SkillProvider,
} from "../skills.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeSkillFile(
  dir: string,
  name: string,
  frontmatter: Record<string, string>,
  body: string
): void {
  const skillDir = path.join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push("---", "");
  writeFileSync(path.join(skillDir, "SKILL.md"), `${lines.join("\n")}${body}`);
}

function initGitRepo(cwd: string): void {
  execSync("git init -q", { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  execSync("git -c user.email=test@example.com -c user.name=test commit --allow-empty -q -m init", {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = makeTempDir("skills-home-");
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return run(home).finally(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  });
}

function withProviderHome(
  providerId: "ada" | "codex" | "claude",
  run: (home: string, provider: SkillProvider) => Promise<void>
): Promise<void> {
  return withHome(async (home) => {
    const provider = getSkillProvider(providerId);
    assert.ok(provider, `${providerId} provider must be registered`);
    await run(home, provider);
  });
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

test("parseSkillFile extracts name, description, and body", () => {
  const parsed = parseSkillFile(
    "---\nname: foo\ndescription: A foo skill\n---\n# Body\nHello\n"
  );
  assert.deepEqual(parsed?.metadata, { name: "foo", description: "A foo skill" });
  assert.equal(parsed?.body, "# Body\nHello");
});

test("parseSkillFile strips surrounding quotes from values", () => {
  const parsed = parseSkillFile(
    '---\nname: "bar"\ndescription: \'A bar skill\'\n---\nbody\n'
  );
  assert.deepEqual(parsed?.metadata, { name: "bar", description: "A bar skill" });
  assert.equal(parsed?.body, "body");
});

test("parseSkillFile returns null for missing frontmatter", () => {
  assert.equal(parseSkillFile("no frontmatter here"), null);
});

test("parseSkillFile returns null when frontmatter is unterminated", () => {
  assert.equal(parseSkillFile("---\nname: foo\nbody"), null);
});

// ---------------------------------------------------------------------------
// Extraction of `/<name>` invocations from user input
// ---------------------------------------------------------------------------

test("extractSkillInvocation strips a leading slash command", () => {
  const result = extractSkillInvocation("/imagegen make a red panda");
  assert.deepEqual(result, { skillName: "imagegen", rest: "make a red panda" });
});

test("extractSkillInvocation lowercases the captured skill name", () => {
  const result = extractSkillInvocation("/Senior-Dev hi");
  assert.equal(result?.skillName, "senior-dev");
});

test("extractSkillInvocation returns null when there is no leading slash", () => {
  assert.equal(extractSkillInvocation("hello /imagegen"), null);
  assert.equal(extractSkillInvocation(""), null);
});

test("extractSkillInvocation keeps the rest of the message verbatim", () => {
  const result = extractSkillInvocation("/skill-creator   multi  spaces");
  assert.equal(result?.rest, "multi  spaces");
});

test("extractSkillInvocation recognizes uppercase, dot, and dash names", () => {
  assert.equal(extractSkillInvocation("/Senior-Dev hi")?.skillName, "senior-dev");
  assert.equal(extractSkillInvocation("/plugin.creator hi")?.skillName, "plugin.creator");
  assert.equal(extractSkillInvocation("/foo_bar hi")?.skillName, "foo_bar");
});

test("extractSkillInvocation does not match when `/` is not at column 0", () => {
  assert.equal(extractSkillInvocation("hello /imagegen"), null);
  assert.equal(extractSkillInvocation("  /imagegen"), null);
});

test("extractSkillInvocation does not match a bare `/`", () => {
  assert.equal(extractSkillInvocation("/"), null);
  assert.equal(extractSkillInvocation("/   foo"), null);
});

// ---------------------------------------------------------------------------
// Prefix + history helpers
// ---------------------------------------------------------------------------

test("buildSkillPrefix frames the body as plain prose (no skill-load marker)", () => {
  // The prefix must not include the `skill:<name>` fenced marker that some
  // agents (Ada) auto-detect and surface twice in the transcript. It
  // should be plain context the agent reads but doesn't echo.
  const prefix = buildSkillPrefix("imagegen", "do the thing");
  assert.doesNotMatch(prefix, /```skill:imagegen/);
  assert.match(prefix, /Skill: imagegen/);
  assert.match(prefix, /do the thing/);
  assert.ok(prefix.endsWith("\n"));
});

test("buildSkillHistoryMessage renders the marker before the user text", () => {
  assert.equal(
    buildSkillHistoryMessage("imagegen", "make a red panda"),
    "[/skill: imagegen] make a red panda"
  );
});

// ---------------------------------------------------------------------------
// Disk-backed provider: user-scope skills
// ---------------------------------------------------------------------------

test("ada provider lists user skills from ~/.ada/skills", async () => {
  await withProviderHome("ada", async (home, provider) => {
    makeSkillFile(
      path.join(home, ".ada/skills"),
      "github-issues",
      { name: "github-issues", description: "Work on GitHub issues" },
      "Body"
    );
    const metadata = await provider.listMetadata(os.tmpdir());
    assert.equal(metadata.length, 1);
    assert.equal(metadata[0].name, "github-issues");
    assert.equal(metadata[0].scope, "user");
    assert.equal(metadata[0].description, "Work on GitHub issues");
  });
});

test("codex provider lists user + system skills, scoped accordingly", async () => {
  await withProviderHome("codex", async (home, provider) => {
    makeSkillFile(
      path.join(home, ".codex/skills"),
      "user-skill",
      { name: "user-skill", description: "u" },
      "body"
    );
    makeSkillFile(
      path.join(home, ".codex/skills/.system"),
      "imagegen",
      { name: "imagegen", description: "i" },
      "body"
    );
    const metadata = await provider.listMetadata(os.tmpdir());
    const byName = Object.fromEntries(metadata.map((entry) => [entry.name, entry.scope]));
    assert.equal(byName["user-skill"], "user");
    assert.equal(byName["imagegen"], "system");
  });
});

test("claude provider reads ~/.claude/skills/<name>/SKILL.md", async () => {
  await withProviderHome("claude", async (home, provider) => {
    makeSkillFile(
      path.join(home, ".claude/skills"),
      "senior-dev",
      { name: "senior-dev", description: "Treat user as senior dev" },
      "# Senior\nBe terse."
    );
    const body = await provider.readBody("senior-dev", os.tmpdir());
    assert.ok(body);
    assert.equal(body.metadata.name, "senior-dev");
    assert.equal(body.metadata.scope, "user");
    assert.equal(body.body, "# Senior\nBe terse.");
  });
});

test("skill name match is case-insensitive but the user message is unchanged", async () => {
  await withProviderHome("ada", async (home, provider) => {
    makeSkillFile(
      path.join(home, ".ada/skills"),
      "ImageGen",
      { name: "ImageGen", description: "Image generator" },
      "body"
    );
    // The directory is mixed-case; the frontmatter name wins. The loader
    // lowercases the frontmatter for matching, so both casings find it.
    const mixed = await provider.readBody("IMAGEGEN", os.tmpdir());
    const lower = await provider.readBody("imagegen", os.tmpdir());
    assert.ok(mixed);
    assert.ok(lower);
    assert.equal(mixed.metadata.name, "ImageGen");
    assert.equal(lower.metadata.name, "ImageGen");
  });
});

// ---------------------------------------------------------------------------
// Disk-backed provider: repo-scope skills require a git work tree
// ---------------------------------------------------------------------------

test("repo skills are listed only when cwd is inside a git work tree", async () => {
  await withProviderHome("ada", async (home, provider) => {
    const worktree = makeTempDir("skills-worktree-");
    initGitRepo(worktree);
    makeSkillFile(
      path.join(worktree, ".ada/skills"),
      "repo-skill",
      { name: "repo-skill", description: "r" },
      "body"
    );

    const insideRepo = await provider.listMetadata(worktree);
    const outsideRepo = await provider.listMetadata(os.tmpdir());

    const insideNames = insideRepo.map((entry) => entry.name);
    const outsideNames = outsideRepo.map((entry) => entry.name);
    assert.ok(insideNames.includes("repo-skill"));
    assert.ok(!outsideNames.includes("repo-skill"));

    rmSync(worktree, { recursive: true, force: true });
  });
});

test("readBody returns null for an unknown skill", async () => {
  await withProviderHome("ada", async (_home, provider) => {
    assert.equal(await provider.readBody("not-a-skill", os.tmpdir()), null);
  });
});

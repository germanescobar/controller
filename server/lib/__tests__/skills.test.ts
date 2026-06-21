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
  mergeSkillMetadata,
  parseSkillFile,
  type SkillProvider,
  type SkillMetadata,
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

/**
 * Set `$CODEX_HOME` for the duration of `run` and restore the previous
 * value (or absence) afterwards. Lets the test probe the env-var
 * resolution path the loader uses for the Codex provider.
 */
function withCodexHome(
  codexHome: string,
  run: (codexHome: string) => Promise<void>
): Promise<void> {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  return run(codexHome).finally(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(codexHome, { recursive: true, force: true });
  });
}

function withProviderHome(
  providerId: "anita" | "codex" | "claude",
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
  // agents (Anita) auto-detect and surface twice in the transcript. It
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

test("anita provider lists user skills from ~/.anita/skills", async () => {
  await withProviderHome("anita", async (home, provider) => {
    makeSkillFile(
      path.join(home, ".anita/skills"),
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

test("anita provider falls back to the legacy ~/.ada/skills location", async () => {
  await withProviderHome("anita", async (home, provider) => {
    // No `~/.anita/skills` exists; the provider should read the legacy
    // location so setups created before the Ada→Anita rename keep working.
    makeSkillFile(
      path.join(home, ".ada/skills"),
      "legacy-skill",
      { name: "legacy-skill", description: "from the old home" },
      "Body"
    );
    const metadata = await provider.listMetadata(os.tmpdir());
    assert.equal(metadata.length, 1);
    assert.equal(metadata[0].name, "legacy-skill");
    assert.equal(metadata[0].scope, "user");
  });
});

test("legacy 'ada' provider id resolves to the anita provider", () => {
  assert.equal(getSkillProvider("ada"), getSkillProvider("anita"));
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
  await withProviderHome("anita", async (home, provider) => {
    makeSkillFile(
      path.join(home, ".anita/skills"),
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
  await withProviderHome("anita", async (home, provider) => {
    const worktree = makeTempDir("skills-worktree-");
    initGitRepo(worktree);
    makeSkillFile(
      path.join(worktree, ".anita/skills"),
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
  await withProviderHome("anita", async (_home, provider) => {
    assert.equal(await provider.readBody("not-a-skill", os.tmpdir()), null);
  });
});

// ---------------------------------------------------------------------------
// Codex-specific env var and binary-relative resolution
// ---------------------------------------------------------------------------

test("codex provider honors $CODEX_HOME for both user and system skills", async () => {
  // Set up two separate codex home roots: the "real" $HOME/.codex has
  // nothing, but $CODEX_HOME has both a user skill and a system skill.
  // The loader should find the latter and ignore the former.
  await withHome(async (realHome) => {
    await withCodexHome(makeTempDir("codex-home-"), async (codexHome) => {
      // Real home has no skills — the real $HOME/.codex/skills must
      // not contribute. We assert this implicitly by NOT creating it.
      void realHome;

      makeSkillFile(
        path.join(codexHome, "skills"),
        "imagegen",
        { name: "imagegen", description: "Generate images" },
        "body"
      );
      makeSkillFile(
        path.join(codexHome, "skills/.system"),
        "openai-docs",
        { name: "openai-docs", description: "OpenAI reference" },
        "body"
      );

      const provider = getSkillProvider("codex");
      assert.ok(provider);
      const metadata = await provider.listMetadata(os.tmpdir());
      const byName = Object.fromEntries(
        metadata.map((entry) => [entry.name, entry.scope])
      );
      assert.equal(byName["imagegen"], "user");
      assert.equal(byName["openai-docs"], "system");
    });
  });
});

test("codex provider expands ~ in $CODEX_HOME", async () => {
  // The provider must expand a leading `~` in $CODEX_HOME the same way
  // the rest of the orchestrator does (see `command-resolver.ts`).
  await withHome(async (realHome) => {
    const codexHome = path.join(realHome, "codex-from-tilde");
    process.env.CODEX_HOME = "~/" + path.basename(codexHome);
    try {
      makeSkillFile(
        path.join(codexHome, "skills"),
        "imagegen",
        { name: "imagegen", description: "i" },
        "body"
      );
      const provider = getSkillProvider("codex");
      assert.ok(provider);
      const metadata = await provider.listMetadata(os.tmpdir());
      assert.ok(
        metadata.some((entry) => entry.name === "imagegen"),
        "imagegen should be discovered under the tilde-expanded $CODEX_HOME"
      );
    } finally {
      delete process.env.CODEX_HOME;
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Unified skills + merge behavior
// ---------------------------------------------------------------------------

function skillMeta(
  name: string,
  scope: SkillMetadata["scope"],
  description = ""
): SkillMetadata {
  return {
    name,
    description,
    path: `/skills/${name}/SKILL.md`,
    scope,
  };
}

test("mergeSkillMetadata puts unified first and dedupes per-agent matches", () => {
  const unified = [skillMeta("browser", "unified", "managed")];
  const perAgent = [
    skillMeta("browser", "user"),
    skillMeta("imagegen", "system"),
  ];
  const merged = mergeSkillMetadata(unified, perAgent);
  assert.deepEqual(merged.map((entry) => [entry.name, entry.scope]), [
    ["browser", "unified"],
    ["imagegen", "system"],
  ]);
});

test("mergeSkillMetadata dedupe is case-insensitive", () => {
  const unified = [skillMeta("Browser", "unified")];
  const perAgent = [skillMeta("browser", "user")];
  const merged = mergeSkillMetadata(unified, perAgent);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, "Browser");
  assert.equal(merged[0].scope, "unified");
});

test("readBody resolves unified skill body over per-provider match", async () => {
  await withProviderHome("anita", async (home, provider) => {
    const orchestratorHome = path.join(home, "coding-orchestrator");
    const skillsDir = path.join(orchestratorHome, "skills");

    // Per-agent skill named "shared"
    makeSkillFile(
      path.join(home, ".anita/skills"),
      "shared",
      { name: "shared", description: "agent" },
      "per-agent body"
    );

    // Unified skill with the same name
    makeSkillFile(skillsDir, "shared", { name: "shared", description: "unified" }, "unified body");

    const body = await provider.readBody("shared", os.tmpdir());
    assert.ok(body);
    assert.equal(body.metadata.scope, "unified");
    assert.equal(body.body, "unified body");

    rmSync(orchestratorHome, { recursive: true, force: true });
  });
});

test("unified skills appear in listMetadata above per-agent skills", async () => {
  await withProviderHome("anita", async (home, provider) => {
    const orchestratorHome = path.join(home, "coding-orchestrator");
    const skillsDir = path.join(orchestratorHome, "skills");

    makeSkillFile(skillsDir, "shared", { name: "shared", description: "u" }, "body");
    makeSkillFile(path.join(home, ".anita/skills"), "anita-only", { name: "anita-only", description: "a" }, "body");

    const metadata = await provider.listMetadata(os.tmpdir());
    assert.equal(metadata[0].name, "shared");
    assert.equal(metadata[0].scope, "unified");
    assert.ok(metadata.some((entry) => entry.name === "anita-only"));

    rmSync(orchestratorHome, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Controller-managed skills: scope and dedupe behavior (issue #159)
// ---------------------------------------------------------------------------

const MANAGED_MARKER = "<!-- managed-by: coding-orchestrator (issue #159) -->";

test("per-agent SKILL.md with MANAGED_MARKER is surfaced as scope 'managed'", async () => {
  await withProviderHome("anita", async (home, provider) => {
    // A managed skill lives in the user home with the marker comment in the
    // body. The loader should tag its metadata as `scope: "managed"` so the
    // `/` picker can hide it.
    makeSkillFile(
      path.join(home, ".anita/skills"),
      "controller-browser",
      { name: "controller-browser", description: "Drive the preview browser" },
      `${MANAGED_MARKER}\n# controller-browser\nbody`
    );
    const metadata = await provider.listMetadata(os.tmpdir());
    assert.equal(metadata.length, 1);
    assert.equal(metadata[0].name, "controller-browser");
    assert.equal(metadata[0].scope, "managed");
  });
});

test("a user-authored SKILL.md in the same directory keeps scope 'user'", async () => {
  await withProviderHome("anita", async (home, provider) => {
    // No marker → regular user skill. The scope should not be silently
    // upgraded to "managed" just because the directory looks controlled.
    makeSkillFile(
      path.join(home, ".anita/skills"),
      "my-skill",
      { name: "my-skill", description: "Mine" },
      "# my-skill\nbody"
    );
    const metadata = await provider.listMetadata(os.tmpdir());
    assert.equal(metadata.length, 1);
    assert.equal(metadata[0].scope, "user");
  });
});

test("mergeSkillMetadata keeps managed entries for body lookup (unified still wins)", () => {
  const unified = [skillMeta("imagegen", "unified", "u")];
  const perAgent = [
    skillMeta("controller-browser", "managed", "managed browser"),
    skillMeta("github-issues", "user", "user skill"),
  ];
  const merged = mergeSkillMetadata(unified, perAgent);
  // Unified renders first; managed + user entries follow in their original
  // order. The managed entry must remain reachable so the agent can
  // `readBody` it on demand.
  assert.deepEqual(merged.map((entry) => [entry.name, entry.scope]), [
    ["imagegen", "unified"],
    ["controller-browser", "managed"],
    ["github-issues", "user"],
  ]);
});

test("extractSkillInvocation matches the renamed controller- names", () => {
  assert.deepEqual(extractSkillInvocation("/controller-browser do it"), {
    skillName: "controller-browser",
    rest: "do it",
  });
  assert.deepEqual(extractSkillInvocation("/controller-search-skills find x"), {
    skillName: "controller-search-skills",
    rest: "find x",
  });
});

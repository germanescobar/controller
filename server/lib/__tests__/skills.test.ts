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
import { orchestratorHome } from "../paths.js";
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
    // Pin the Controller home to a temp dir under the test home so the
    // platform default (e.g. `~/Library/Application Support/Controller` on
    // macOS) doesn't leak into the developer's real home during the run.
    const controllerHome = mkdtempSync(path.join(home, "controller-home-"));
    const previousControllerHome = process.env.CONTROLLER_HOME;
    const previousOrchHome = process.env.CODING_ORCHESTRATOR_HOME;
    process.env.CONTROLLER_HOME = controllerHome;
    delete process.env.CODING_ORCHESTRATOR_HOME;
    try {
      await run(home, provider);
    } finally {
      if (previousControllerHome === undefined) delete process.env.CONTROLLER_HOME;
      else process.env.CONTROLLER_HOME = previousControllerHome;
      if (previousOrchHome === undefined) delete process.env.CODING_ORCHESTRATOR_HOME;
      else process.env.CODING_ORCHESTRATOR_HOME = previousOrchHome;
      rmSync(controllerHome, { recursive: true, force: true });
    }
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
    const controllerHome = orchestratorHome();
    const skillsDir = path.join(controllerHome, "skills");

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
  });
});

test("unified skills appear in listMetadata above per-agent skills", async () => {
  await withProviderHome("anita", async (home, provider) => {
    const controllerHome = orchestratorHome();
    const skillsDir = path.join(controllerHome, "skills");

    makeSkillFile(skillsDir, "shared", { name: "shared", description: "u" }, "body");
    makeSkillFile(path.join(home, ".anita/skills"), "anita-only", { name: "anita-only", description: "a" }, "body");

    const metadata = await provider.listMetadata(os.tmpdir());
    assert.equal(metadata[0].name, "shared");
    assert.equal(metadata[0].scope, "unified");
    assert.ok(metadata.some((entry) => entry.name === "anita-only"));
  });
});

// ---------------------------------------------------------------------------
// Controller-managed skills: scope detection in the unified catalog
//
// Controller-managed skills (see MANAGED_SKILL_DIRS in
// `server/lib/managed-skills.ts`) now live in the unified catalog
// (`<orchestrator>/skills/<name>/SKILL.md`) and are tagged
// `scope: "controller"` by `listUnifiedSkills` so the `/<name>` picker can
// render them with a `controller` badge. The disk provider no longer
// reclassifies per-agent entries by directory name, so a user-authored
// skill in `~/.claude/skills/controller-something/` keeps its natural
// `user` scope.
// ---------------------------------------------------------------------------

test("a SKILL.md in the unified catalog whose name is in MANAGED_SKILL_DIRS is tagged scope 'controller'", async () => {
  await withProviderHome("anita", async (home, provider) => {
    const controllerHome = orchestratorHome();
    const skillsDir = path.join(controllerHome, "skills");
    makeSkillFile(
      skillsDir,
      "controller-browser",
      { name: "controller-browser", description: "Drive the preview browser" },
      "# controller-browser\nbody"
    );
    const metadata = await provider.listMetadata(os.tmpdir());
    assert.equal(metadata.length, 1);
    assert.equal(metadata[0].name, "controller-browser");
    assert.equal(metadata[0].scope, "controller");
  });
});

test("a user-authored SKILL.md in the unified catalog keeps scope 'unified'", async () => {
  await withProviderHome("anita", async (_home, provider) => {
    const controllerHome = orchestratorHome();
    const skillsDir = path.join(controllerHome, "skills");
    makeSkillFile(
      skillsDir,
      "github-issues",
      { name: "github-issues", description: "Work on GitHub issues" },
      "body"
    );
    const metadata = await provider.listMetadata(os.tmpdir());
    assert.equal(metadata.length, 1);
    assert.equal(metadata[0].scope, "unified");
  });
});

test("a user-authored SKILL.md in a per-agent home (any name) keeps its user scope", async () => {
  // The disk provider no longer reclassifies per-agent entries by
  // directory name. A `controller-` named skill in `~/.claude/skills/`
  // should be treated as a normal user skill — the orchestrator's
  // `installManagedSkills` writes its managed set into the unified
  // catalog, so a name collision here is the user's choice.
  await withProviderHome("anita", async (home, provider) => {
    makeSkillFile(
      path.join(home, ".anita/skills"),
      "my-skill",
      { name: "my-skill", description: "Mine" },
      "<!-- managed-by: coding-orchestrator (controller-something) -->\n# my-skill\nbody"
    );
    const metadata = await provider.listMetadata(os.tmpdir());
    assert.equal(metadata.length, 1);
    assert.equal(metadata[0].scope, "user");
  });
});

test("mergeSkillMetadata orders unified → user/repo/system → controller", () => {
  // Mixed list of every scope — the sort must produce the documented
  // grouping regardless of input order, and tiebreak by name.
  const unified = [
    skillMeta("controller-browser", "controller", "managed browser"),
    skillMeta("github-issues", "unified", "user-authored"),
    skillMeta("controller-search-skills", "controller", "managed search"),
  ];
  const perAgent = [
    skillMeta("my-user-skill", "user", "user authored"),
    skillMeta("zeta", "repo", "repo skill"),
    skillMeta("alpha", "user", "user authored"),
  ];
  const merged = mergeSkillMetadata(unified, perAgent);
  assert.deepEqual(
    merged.map((entry) => [entry.name, entry.scope]),
    [
      ["github-issues", "unified"],
      ["alpha", "user"],
      ["my-user-skill", "user"],
      ["zeta", "repo"],
      ["controller-browser", "controller"],
      ["controller-search-skills", "controller"],
    ]
  );
});

test("mergeSkillMetadata hides per-agent entries that collide with a unified name (case-insensitive)", () => {
  const unified = [skillMeta("github-issues", "unified", "u")];
  const perAgent = [
    skillMeta("github-issues", "user", "user copy"),
    skillMeta("GitHub-Issues", "repo", "another collision"),
  ];
  const merged = mergeSkillMetadata(unified, perAgent);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, "github-issues");
  assert.equal(merged[0].scope, "unified");
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

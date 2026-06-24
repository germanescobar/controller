import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  installManagedSkills,
  MANAGED_SKILL_DIRS,
  managedMarker,
} from "../managed-skills.js";

/**
 * Run `installManagedSkills` against temp homes so the test does not touch
 * the user's real `~/coding-orchestrator/skills/` directory or
 * `~/.claude/skills/`, `~/.codex/skills/`, `~/.anita/skills/`.
 *
 * `os.homedir()` reads `HOME`, so setting it redirects the per-agent homes.
 * `CODING_ORCHESTRATOR_HOME` (read by `paths.ts`) redirects the
 * orchestrator home where the unified catalog lives.
 */
function withIsolatedHomes(
  run: (homes: { orchestrator: string; user: string }) => Promise<void>
): Promise<void> {
  const userHome = mkdtempSync(path.join(os.tmpdir(), "managed-skills-user-"));
  const orchestratorHome = mkdtempSync(
    path.join(os.tmpdir(), "managed-skills-orch-")
  );
  const originalHome = process.env.HOME;
  const originalOrchHome = process.env.CODING_ORCHESTRATOR_HOME;
  process.env.HOME = userHome;
  process.env.CODING_ORCHESTRATOR_HOME = orchestratorHome;
  return run({ orchestrator: orchestratorHome, user: userHome }).finally(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalOrchHome === undefined) {
      delete process.env.CODING_ORCHESTRATOR_HOME;
    } else {
      process.env.CODING_ORCHESTRATOR_HOME = originalOrchHome;
    }
    rmSync(userHome, { recursive: true, force: true });
    rmSync(orchestratorHome, { recursive: true, force: true });
  });
}

/** Resolve the path to a managed skill in the unified catalog. */
function unifiedSkillFile(orchestratorHome: string, name: string): string {
  return path.join(orchestratorHome, "skills", name, "SKILL.md");
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(value: string): string {
  return value.replace(REGEX_META, "\\$&");
}

/**
 * Build a regex that matches a fully-rendered CLI command, wherever it
 * appears in a body. The command can sit inside a backticked span (e.g.
 * `` `${cliPath} integrations call ...` ``) or inside a fenced code block
 * (e.g. `${cliPath} skills create ...` on its own line). We anchor on the
 * CLI path + a leading boundary (backtick or whitespace).
 */
function cliCommandRegex(cliPath: string, command: string): RegExp {
  return new RegExp(
    "(?:`|^|\\n)\\s*" + escapeRegex(cliPath) + " " + escapeRegex(command),
    "m"
  );
}

/** Build a regex that matches any backtick-quoted CLI line in the body. */
function anyCliLineRegex(cliPath: string): RegExp {
  return new RegExp("`" + escapeRegex(cliPath) + " ([^`]+)`", "g");
}

test("managed skills install into the unified catalog under controller- prefixed directory names", async () => {
  await withIsolatedHomes(async ({ orchestrator }) => {
    await installManagedSkills();

    // Every entry in MANAGED_SKILL_DIRS is owned by the orchestrator and
    // must land at `<orchestrator>/skills/<name>/SKILL.md` after install.
    for (const name of MANAGED_SKILL_DIRS) {
      const skillFile = unifiedSkillFile(orchestrator, name);
      assert.ok(
        existsSync(skillFile),
        `expected ${skillFile} to be installed`
      );

      const body = readFileSync(skillFile, "utf-8");
      // The `name:` frontmatter must match the directory name so
      // `extractSkillInvocation` and the disk loader see consistent names.
      const frontmatterMatch = /^---\nname:\s*([^\n]+)\n/m.exec(body);
      assert.ok(
        frontmatterMatch,
        `${skillFile} is missing a 'name:' frontmatter line`
      );
      assert.equal(
        frontmatterMatch[1].trim(),
        name,
        `${skillFile} frontmatter name does not match the directory name`
      );
      // The body must carry the documentary marker for the matching
      // directory name.
      assert.ok(
        body.includes(managedMarker(name)),
        `${skillFile} is missing the managed marker for "${name}"`
      );
    }
  });
});

test("managed skills use a single `<cliPath> <surface> <command>` convention", async () => {
  await withIsolatedHomes(async ({ orchestrator }) => {
    await installManagedSkills();

    const cliPath = path.join(orchestrator, "bin", "controller");

    // Each managed skill body must render every CLI line as
    // `<cliPath> <surface> <command>`. Never a bare subcommand, never a
    // double-prefixed surface. `controller-worktrees` covers two
    // surfaces, so its lines must include one of them.
    const cases = [
      { name: "controller-browser", surfaces: ["browser"] },
      { name: "controller-integrations", surfaces: ["integrations"] },
      { name: "controller-search-skills", surfaces: ["skills"] },
      { name: "controller-skill-creator", surfaces: ["skills"] },
      { name: "controller-worktrees", surfaces: ["worktrees", "sessions"] },
    ] as const;

    for (const { name, surfaces } of cases) {
      const skillFile = unifiedSkillFile(orchestrator, name);
      const body = readFileSync(skillFile, "utf-8");

      // Collect every backtick-quoted CLI line and check each one embeds
      // at least one of the skill's surfaces.
      const lineRegex = anyCliLineRegex(cliPath);
      const lines: string[] = body.match(lineRegex) ?? [];
      assert.ok(
        lines.length > 0,
        `expected ${skillFile} to include at least one CLI command line`
      );

      for (const line of lines) {
        const matchedSurface = surfaces.find((s) =>
          line.includes(`${cliPath} ${s} `)
        );
        assert.ok(
          matchedSurface !== undefined,
          `${skillFile} rendered a CLI line without any of [${surfaces.join(", ")}]: ${line}`
        );
        // Guard against double-prefixed surfaces (e.g.
        // `controller worktrees worktrees ...`).
        for (const surface of surfaces) {
          const doublePrefix = new RegExp(
            "`" +
              escapeRegex(cliPath) +
              " " +
              surface +
              " " +
              surface +
              " "
          );
          assert.doesNotMatch(
            line,
            doublePrefix,
            `${skillFile} double-prefixed the "${surface}" surface: ${line}`
          );
        }
      }
    }
  });
});

test("browser, integrations, and skills bodies advertise concrete commands", async () => {
  await withIsolatedHomes(async ({ orchestrator }) => {
    await installManagedSkills();

    const cliPath = path.join(orchestrator, "bin", "controller");

    const browser = readFileSync(
      unifiedSkillFile(orchestrator, "controller-browser"),
      "utf-8"
    );
    assert.match(browser, cliCommandRegex(cliPath, "browser open <url>"));
    assert.match(
      browser,
      cliCommandRegex(cliPath, "browser snapshot [--a11y] [selector]")
    );

    const integrations = readFileSync(
      unifiedSkillFile(orchestrator, "controller-integrations"),
      "utf-8"
    );
    assert.match(integrations, cliCommandRegex(cliPath, "integrations list"));
    assert.match(
      integrations,
      cliCommandRegex(cliPath, "integrations call <integration> <tool>")
    );

    const searchSkills = readFileSync(
      unifiedSkillFile(orchestrator, "controller-search-skills"),
      "utf-8"
    );
    assert.match(searchSkills, cliCommandRegex(cliPath, "skills list"));
    assert.match(
      searchSkills,
      cliCommandRegex(cliPath, "skills import --provider <id>")
    );

    const skillCreator = readFileSync(
      unifiedSkillFile(orchestrator, "controller-skill-creator"),
      "utf-8"
    );
    assert.match(
      skillCreator,
      cliCommandRegex(cliPath, "skills create --name <name>")
    );

    // The worktrees skill replaces what used to be a static block in
    // the agent preamble (issue #190). It must surface the full
    // `worktrees` + `sessions` CLI surface so the agent can copy/paste
    // every command from `controller skills describe controller-worktrees`.
    const worktrees = readFileSync(
      unifiedSkillFile(orchestrator, "controller-worktrees"),
      "utf-8"
    );
    assert.match(worktrees, cliCommandRegex(cliPath, "worktrees list <project>"));
    assert.match(
      worktrees,
      cliCommandRegex(cliPath, "worktrees create <project> --name <name>")
    );
    assert.match(
      worktrees,
      cliCommandRegex(cliPath, "worktrees delete <project> <worktreeId>")
    );
    assert.match(
      worktrees,
      cliCommandRegex(cliPath, "sessions start <project> --worktree <worktreeId>")
    );
    // Notes that `<project>` accepts an id or a human name.
    assert.match(worktrees, /<project>\` accepts either the project's id \(UUID\) or its human name/);
    // Reminds callers that `--message` must be the last flag, since the
    // parser rejects reserved flags that appear after it.
    assert.match(worktrees, /--message\` must be \*\*last\*\* on the command line/);
  });
});

test("managed skill bodies no longer claim to be hidden from the / picker", async () => {
  // After moving the managed skills into the unified catalog, the body
  // text should advertise visibility — not hide them — so users discover
  // them in the `/<name>` picker.
  await withIsolatedHomes(async ({ orchestrator }) => {
    await installManagedSkills();

    for (const name of MANAGED_SKILL_DIRS) {
      const body = readFileSync(
        unifiedSkillFile(orchestrator, name),
        "utf-8"
      );
      assert.doesNotMatch(
        body,
        /It is hidden from the `\/` picker/,
        `${name} body still claims to be hidden from the picker`
      );
      assert.match(
        body,
        new RegExp(`controller`),
        `${name} body should mention that the / picker surfaces it`
      );
    }
  });
});

test("installManagedSkills rewrites a managed skill even when its body has no marker", async () => {
  // Regression test: when the marker comment was bumped, a leftover
  // app-owned skill whose body predated the bump used to be treated as
  // user-authored and never re-synchronized. With directory-name ownership
  // (in the unified catalog) the install loop must always re-sync a skill
  // whose name is in MANAGED_SKILL_DIRS, regardless of marker content.
  await withIsolatedHomes(async ({ orchestrator }) => {
    const skillDir = path.join(orchestrator, "skills", "controller-scripts");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "# stale body\nno marker, no managed-by line\n",
      "utf-8"
    );

    await installManagedSkills();

    const after = readFileSync(
      path.join(skillDir, "SKILL.md"),
      "utf-8"
    );
    assert.ok(
      after.includes(managedMarker("controller-scripts")),
      "managed directory should have been rewritten with the current body"
    );
    assert.ok(
      after.includes("# Controller Scripts"),
      "managed directory should now contain the current shipped body"
    );
  });
});

test("installManagedSkills does not touch unrelated directories under the unified skills home", async () => {
  // A user-authored skill dropped into the same parent must be left
  // strictly alone, even if it carries marker-shaped comments. The
  // install loop only iterates over MANAGED_SKILL_DIRS, so other
  // directories are never read or rewritten.
  await withIsolatedHomes(async ({ orchestrator }) => {
    const skillsDir = path.join(orchestrator, "skills");
    const userDir = path.join(skillsDir, "my-personal-skill");
    mkdirSync(userDir, { recursive: true });
    const userBody = "# mine\nThis is the user's skill body.\n";
    writeFileSync(path.join(userDir, "SKILL.md"), userBody, "utf-8");

    await installManagedSkills();

    const after = readFileSync(path.join(userDir, "SKILL.md"), "utf-8");
    assert.equal(after, userBody, "user-authored skill should be untouched");
  });
});

test("installManagedSkills removes stale per-agent managed skills left by older installs", async () => {
  // Older Controller releases mirrored the managed skills into each
  // provider's user skills home. The current design keeps them in the
  // unified catalog, so the per-agent copies are obsolete. The install
  // loop should remove them as a one-time cleanup.
  await withIsolatedHomes(async ({ user }) => {
    // Simulate a stale per-agent install for one of the managed skills.
    const staleDir = path.join(user, ".claude", "skills", "controller-browser");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(
      path.join(staleDir, "SKILL.md"),
      "<!-- managed-by: coding-orchestrator (controller-browser) -->\n# stale\n",
      "utf-8"
    );

    await installManagedSkills();

    assert.equal(
      existsSync(staleDir),
      false,
      `expected ${staleDir} to be cleaned up by the install loop`
    );
  });
});

test("installManagedSkills does not remove user-authored skills in per-agent homes", async () => {
  // The legacy cleanup targets only `controller-*` directories; a
  // user-authored skill in any per-agent home (e.g. `~/.claude/skills/`)
  // must be left alone.
  await withIsolatedHomes(async ({ user }) => {
    const userDir = path.join(user, ".claude", "skills", "my-personal-skill");
    mkdirSync(userDir, { recursive: true });
    const userBody = "# mine\nThis is the user's skill body.\n";
    writeFileSync(path.join(userDir, "SKILL.md"), userBody, "utf-8");

    await installManagedSkills();

    assert.ok(
      existsSync(userDir),
      `expected ${userDir} to be preserved by the install loop`
    );
    assert.equal(readFileSync(path.join(userDir, "SKILL.md"), "utf-8"), userBody);
  });
});

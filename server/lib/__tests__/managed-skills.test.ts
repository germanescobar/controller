import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installManagedSkills } from "../managed-skills.js";

/**
 * Run `installManagedSkills` against temp homes so the test does not touch
 * the user's real `~/.anita`, `~/.codex`, or `~/.claude` directories.
 *
 * `os.homedir()` reads `HOME`, so setting it redirects the three provider
 * skill homes. `CODING_ORCHESTRATOR_HOME` (read by `paths.ts`) redirects
 * the orchestrator home where the CLI path lives.
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

test("managed skills use a single `<cliPath> <surface> <command>` convention", async () => {
  await withIsolatedHomes(async () => {
    await installManagedSkills();

    const cliPath = path.join(
      process.env.CODING_ORCHESTRATOR_HOME!,
      "bin",
      "controller"
    );

    // Each managed skill body must render every CLI line as
    // `<cliPath> <surface> <command>`. Never a bare subcommand, never a
    // double-prefixed surface.
    const cases = [
      { name: "browser", surface: "browser" },
      { name: "integrations", surface: "integrations" },
      { name: "search-skills", surface: "skills" },
      { name: "skill-creator", surface: "skills" },
    ] as const;

    for (const provider of [".anita", ".codex", ".claude"]) {
      for (const { name, surface } of cases) {
        const skillFile = path.join(
          os.homedir(),
          provider,
          "skills",
          name,
          "SKILL.md"
        );
        assert.ok(
          existsSync(skillFile),
          `expected ${skillFile} to be installed`
        );
        const body = readFileSync(skillFile, "utf-8");

        // Collect every backtick-quoted CLI line and check each one embeds
        // the surface.
        const lineRegex = anyCliLineRegex(cliPath);
        const lines: string[] = body.match(lineRegex) ?? [];
        assert.ok(
          lines.length > 0,
          `expected ${skillFile} to include at least one CLI command line`
        );

        for (const line of lines) {
          assert.ok(
            line.includes(`${cliPath} ${surface} `),
            `${skillFile} rendered a CLI line without the "${surface}" surface: ${line}`
          );
          // Guard against `controller browser browser ...` double-prefix.
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
  await withIsolatedHomes(async () => {
    await installManagedSkills();

    const cliPath = path.join(
      process.env.CODING_ORCHESTRATOR_HOME!,
      "bin",
      "controller"
    );

    const anitaBrowser = readFileSync(
      path.join(os.homedir(), ".anita", "skills", "browser", "SKILL.md"),
      "utf-8"
    );
    assert.match(
      anitaBrowser,
      cliCommandRegex(cliPath, "browser open <url>")
    );
    assert.match(
      anitaBrowser,
      cliCommandRegex(cliPath, "browser snapshot [selector]")
    );

    const anitaIntegrations = readFileSync(
      path.join(os.homedir(), ".anita", "skills", "integrations", "SKILL.md"),
      "utf-8"
    );
    assert.match(
      anitaIntegrations,
      cliCommandRegex(cliPath, "integrations list")
    );
    assert.match(
      anitaIntegrations,
      cliCommandRegex(cliPath, "integrations call <integration> <tool>")
    );

    const anitaSearchSkills = readFileSync(
      path.join(os.homedir(), ".anita", "skills", "search-skills", "SKILL.md"),
      "utf-8"
    );
    assert.match(
      anitaSearchSkills,
      cliCommandRegex(cliPath, "skills list")
    );
    assert.match(
      anitaSearchSkills,
      cliCommandRegex(cliPath, "skills import --provider <id>")
    );

    const anitaSkillCreator = readFileSync(
      path.join(os.homedir(), ".anita", "skills", "skill-creator", "SKILL.md"),
      "utf-8"
    );
    assert.match(
      anitaSkillCreator,
      cliCommandRegex(cliPath, "skills create --name <name>")
    );
  });
});

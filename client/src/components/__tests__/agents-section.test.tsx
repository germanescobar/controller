import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentRow } from "../agents-section.tsx";
import type { AgentStatus } from "../../api.ts";

const NOOP = () => {};
const NOOP_ASYNC = async () => {};

const CLAUDE_AGENT: AgentStatus = {
  id: "claude",
  name: "Claude",
  command: "claude",
  installed: true,
  enabled: true,
  resolvedPath: "/usr/local/bin/claude",
  version: "1.2.3",
  defaultModel: null,
  autoApprove: false,
};

function renderAgentRow(
  agent: AgentStatus,
  options: { settingsOpen?: boolean; pathEditing?: boolean } = {},
): string {
  return renderToStaticMarkup(
    <AgentRow
      agent={agent}
      onToggle={NOOP}
      onSavePath={NOOP_ASYNC}
      onSaveDefaultModel={NOOP_ASYNC}
      onToggleAutoApprove={NOOP}
      initialSettingsOpen={options.settingsOpen}
      initialPathEditing={options.pathEditing}
    >
      <div>API Keys</div>
    </AgentRow>,
  );
}

test("AgentRow is collapsed to name, command/version badge, settings, and switch by default", () => {
  const html = renderAgentRow(CLAUDE_AGENT);

  assert.match(html, /Claude/);
  assert.match(html, /claude 1\.2\.3/);
  assert.match(html, /Open settings/);
  assert.doesNotMatch(html, /\/usr\/local\/bin\/claude/);
  assert.doesNotMatch(html, /Default model/);
  assert.doesNotMatch(html, /Auto-approve/);
  assert.doesNotMatch(html, /API Keys/);
});

test("AgentRow settings panel shows read-only path and enabled-only settings", () => {
  const html = renderAgentRow(CLAUDE_AGENT, { settingsOpen: true });

  assert.match(html, /Close settings/);
  assert.match(html, /CLI path/);
  assert.match(html, /\/usr\/local\/bin\/claude/);
  assert.match(html, /Edit CLI path/);
  assert.match(html, /Default model/);
  assert.match(html, /Auto-approve/);
  assert.match(html, /API Keys/);
});

test("AgentRow path edit mode exposes explicit confirm and cancel actions", () => {
  const html = renderAgentRow(CLAUDE_AGENT, {
    settingsOpen: true,
    pathEditing: true,
  });

  assert.match(html, /Leave empty to resolve on PATH/);
  assert.match(html, /Confirm path/);
  assert.match(html, /Cancel path edit/);
});

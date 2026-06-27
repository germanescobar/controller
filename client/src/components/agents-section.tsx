import { useState, useEffect, type ReactNode } from "react";
import { Key, Trash2, Check, Loader2, Settings2, Pencil, Plus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  fetchProviders,
  setProviderKey,
  deleteProviderKey,
  fetchAgents,
  updateAgent,
  fetchModels,
  resetAgentSessionPermissions,
  type ProviderStatus,
  type AgentStatus,
  type Model,
} from "../api.ts";
import { modelProviderLabel } from "../lib/model-labels.ts";

// API-key providers are model backends consumed by the Anita agent, so they are
// rendered nested under the Anita row rather than as a top-level section.
const ANITA_AGENT_ID = "anita";

/**
 * Worktree context for the reset-session-permissions action (issue
 * #259). `undefined` when Settings was opened from a view that
 * doesn't carry a project/worktree — the button is disabled in that
 * case because we have no worktree to scope the reset to.
 */
export interface AgentsSectionWorktreeContext {
  projectId: string;
  worktreeId: string;
}

/*
 * Settings section for enabling agents, setting their CLI paths, and
 * configuring the model-provider API keys the Anita agent uses. Self-loading so
 * it can drop into the settings page without the page wiring its data.
 */
export function AgentsSection({
  worktreeContext,
}: {
  worktreeContext?: AgentsSectionWorktreeContext;
} = {}) {
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);

  const load = () => {
    fetchAgents().then(setAgents).catch(() => {});
    fetchProviders().then(setProviders).catch(() => {});
  };

  useEffect(load, []);

  const handleToggleAgent = async (agent: AgentStatus) => {
    // Optimistic toggle; reconcile with the server response.
    setAgents((prev) =>
      prev.map((a) => (a.id === agent.id ? { ...a, enabled: !a.enabled } : a))
    );
    const updated = await updateAgent(agent.id, { enabled: !agent.enabled });
    setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  };

  const handleSaveAgentPath = async (agentId: string, path: string | null) => {
    const updated = await updateAgent(agentId, { path });
    setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  };

  const handleSaveDefaultModel = async (agentId: string, defaultModel: string | null) => {
    const updated = await updateAgent(agentId, { defaultModel });
    setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  };

  const handleToggleAutoApprove = async (agent: AgentStatus) => {
    // Optimistic toggle; reconcile with the server response.
    setAgents((prev) =>
      prev.map((a) => (a.id === agent.id ? { ...a, autoApprove: !a.autoApprove } : a))
    );
    const updated = await updateAgent(agent.id, { autoApprove: !agent.autoApprove });
    setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  };

  const handleResetSessionPermissions = async (agent: AgentStatus) => {
    if (!worktreeContext) return;
    try {
      const result = await resetAgentSessionPermissions(
        agent.id,
        worktreeContext.projectId,
        worktreeContext.worktreeId
      );
      const total = result.droppedRuntimes + result.killedRuntimes;
      toast.success(
        total > 0
          ? `Reset session permissions for ${agent.name} (cleared ${total}).`
          : `Reset session permissions for ${agent.name}.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Failed to reset: ${message}`);
    }
  };

  return (
    <div className="space-y-3">
      {agents.map((agent) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          onToggle={() => handleToggleAgent(agent)}
          onSavePath={(path) => handleSaveAgentPath(agent.id, path)}
          onSaveDefaultModel={(defaultModel) => handleSaveDefaultModel(agent.id, defaultModel)}
          onToggleAutoApprove={() => handleToggleAutoApprove(agent)}
          onResetSessionPermissions={
            worktreeContext
              ? () => handleResetSessionPermissions(agent)
              : undefined
          }
        >
          {agent.id === ANITA_AGENT_ID && (
            <ApiKeysSection providers={providers} onChange={load} />
          )}
        </AgentRow>
      ))}
    </div>
  );
}

interface AgentRowProps {
  agent: AgentStatus;
  onToggle: () => void;
  onSavePath: (path: string | null) => Promise<void>;
  onSaveDefaultModel: (defaultModel: string | null) => Promise<void>;
  onToggleAutoApprove: () => void;
  /**
   * Open the confirmation dialog for resetting this agent's session
   * permissions. `undefined` when the surrounding page has no
   * worktree context (e.g. Settings opened from the empty landing),
   * in which case the row hides the action entirely.
   */
  onResetSessionPermissions?: () => void;
  children?: ReactNode;
}

interface ModelGroup {
  label: string;
  models: Model[];
}

/**
 * Group a flat list of models by their provider label so the default-model
 * picker can render them inside `<optgroup>`s. The provider label comes
 * from `modelProviderLabel` (group name first, then id prefix). When every
 * model ends up in the same group, callers can still iterate over a single
 * "Other" group so the rendering stays uniform.
 */
function groupModelsByProvider(models: Model[]): ModelGroup[] {
  const groups = new Map<string, Model[]>();
  for (const model of models) {
    const label = modelProviderLabel(model) || "Other";
    const bucket = groups.get(label);
    if (bucket) bucket.push(model);
    else groups.set(label, [model]);
  }
  return Array.from(groups.entries()).map(([label, models]) => ({ label, models }));
}

function AgentRow({
  agent,
  onToggle,
  onSavePath,
  onSaveDefaultModel,
  onToggleAutoApprove,
  onResetSessionPermissions,
  children,
}: AgentRowProps) {
  const [showPath, setShowPath] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [savingPath, setSavingPath] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [savingDefaultModel, setSavingDefaultModel] = useState(false);

  useEffect(() => {
    if (!agent.enabled) return;
    let cancelled = false;
    setModelsLoading(true);
    fetchModels(agent.id)
      .then((list) => {
        if (!cancelled) setModels(list);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id, agent.enabled]);

  const openPathEditor = () => {
    setPathInput(agent.resolvedPath ?? "");
    setShowPath((value) => !value);
  };

  const savePath = async () => {
    setSavingPath(true);
    await onSavePath(pathInput.trim() || null);
    setSavingPath(false);
    setShowPath(false);
  };

  const handleDefaultModelChange = async (
    event: React.ChangeEvent<HTMLSelectElement>
  ) => {
    const value = event.target.value;
    const defaultModel = value === "" ? null : value;
    setSavingDefaultModel(true);
    try {
      await onSaveDefaultModel(defaultModel);
    } finally {
      setSavingDefaultModel(false);
    }
  };

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{agent.name}</span>
            {agent.installed ? (
              <Badge variant="secondary" className="font-mono">
                {agent.version ?? "installed"}
              </Badge>
            ) : (
              <Badge variant="destructive">Not found</Badge>
            )}
          </div>
          {agent.resolvedPath && (
            <div className="mt-0.5 truncate text-xs text-muted-foreground font-mono">
              {agent.resolvedPath}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button size="icon-sm" variant="ghost" onClick={openPathEditor} title="Set CLI path">
            <Settings2 className="h-3.5 w-3.5" />
          </Button>
          <Switch
            checked={agent.enabled}
            onCheckedChange={onToggle}
            disabled={!agent.installed}
            title={
              agent.installed
                ? agent.enabled
                  ? "Disable agent"
                  : "Enable agent"
                : "Install the CLI to enable this agent"
            }
          />
        </div>
      </div>

      {showPath && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            savePath();
          }}
          className="mt-2 flex items-center gap-1.5"
        >
          <input
            type="text"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder="Leave empty to resolve on PATH"
            autoFocus
            className="flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <Button type="submit" size="icon-sm" variant="ghost" disabled={savingPath}>
            {savingPath ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
          </Button>
        </form>
      )}

      {agent.enabled && (
        <div className="mt-3">
          <label className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Default model
          </label>
          <div className="mt-1.5 flex items-center gap-2">
            <select
              value={agent.defaultModel ?? ""}
              onChange={handleDefaultModelChange}
              disabled={modelsLoading || savingDefaultModel || models.length === 0}
              className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
            >
              <option value="">{modelsLoading ? "Loading..." : "(none)"}</option>
              {(() => {
                const groups = groupModelsByProvider(models);
                // When more than one provider is available, prefix each
                // option with the provider name so the choice stays
                // unambiguous even on platforms where optgroup labels are
                // easy to miss (e.g., native select menus on small screens).
                const prefixProvider = groups.length > 1;
                return groups.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {prefixProvider
                          ? `${group.label} - ${model.name}`
                          : model.name}
                      </option>
                    ))}
                  </optgroup>
                ));
              })()}
            </select>
            {savingDefaultModel && (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            )}
          </div>

          <div className="mt-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">Auto-approve</div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {agent.autoApprove
                  ? "Runs without asking for permission. Turn off to approve each action."
                  : agent.id === ANITA_AGENT_ID
                    ? "Asks before each action. Note: approval prompts aren't shown in the UI yet for this agent."
                    : "Asks before each action; approve or deny from the session view."}
              </p>
            </div>
            <Switch
              checked={agent.autoApprove}
              onCheckedChange={onToggleAutoApprove}
              title={agent.autoApprove ? "Require manual approval" : "Auto-approve actions"}
            />
          </div>

          {onResetSessionPermissions ? (
            <ResetSessionPermissionsRow
              agent={agent}
              onConfirm={onResetSessionPermissions}
            />
          ) : null}
        </div>
      )}

      {children && <div className="mt-3 border-t border-border pt-3">{children}</div>}
    </div>
  );
}

/*
 * "Reset session permissions" row + confirmation dialog (issue #259).
 *
 * The dialog copy explains the destructive scope per agent:
 *   - Codex: tears down the live app-server child (next turn re-spawns).
 *   - Claude: ends any in-flight Claude child and forces the next turn
 *     to start a fresh session id, losing session-scoped "always allow"
 *     rules but keeping the conversation out of the conversation history
 *     scope. (Claude's control protocol has no public rule-removal
 *     message — this is the only revocation path.)
 *   - Anita: no-op (Anita doesn't expose permission prompts yet).
 */
function ResetSessionPermissionsRow({
  agent,
  onConfirm,
}: {
  agent: AgentStatus;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);

  const description =
    agent.id === "codex"
      ? `This ends every active Codex app-server thread for this worktree. The next turn will spawn a fresh one and start prompting for actions that were previously auto-approved. The current Codex session may end mid-turn.`
      : agent.id === "claude"
        ? `This ends the active Claude child for this worktree and forces the next turn to start a fresh session id, so any "Always allow" decisions granted during the current session no longer apply. The conversation context for that session is reset.`
        : `Anita doesn't expose approval prompts yet, so there's nothing to reset for this agent.`;

  return (
    <div className="mt-3 flex items-start justify-between gap-3 border-t border-border pt-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">Session permissions</div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Clear every "Always allow" decision made in the current session.
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        title={`Reset session permissions for ${agent.name}`}
      >
        <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
        Reset
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Reset {agent.name} session permissions?
            </AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface ApiKeysSectionProps {
  providers: ProviderStatus[];
  onChange: () => void;
}

function ApiKeysSection({ providers, onChange }: ApiKeysSectionProps) {
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async (providerId: string) => {
    if (!keyInput.trim()) return;
    setSaving(true);
    await setProviderKey(providerId, keyInput.trim());
    setKeyInput("");
    setEditingProvider(null);
    setSaving(false);
    onChange();
  };

  const handleDelete = async (providerId: string) => {
    await deleteProviderKey(providerId);
    onChange();
  };

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        API Keys
      </h4>
      {providers.map((provider) => (
        <div key={provider.id} className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Key className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="text-sm">{provider.name}</div>
              {provider.configured && provider.hint && (
                <div className="text-xs text-muted-foreground font-mono">{provider.hint}</div>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {editingProvider === provider.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSave(provider.id);
                }}
                className="flex items-center gap-1.5"
              >
                <input
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder="Paste key..."
                  autoFocus
                  className="w-32 rounded-md border border-border bg-transparent px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <Button type="submit" size="icon-sm" variant="ghost" disabled={saving || !keyInput.trim()}>
                  {saving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                </Button>
              </form>
            ) : (
              <>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => {
                    setEditingProvider(provider.id);
                    setKeyInput("");
                  }}
                  title={provider.configured ? "Update key" : "Add key"}
                >
                  {provider.configured ? (
                    <Pencil className="h-3.5 w-3.5" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" />
                  )}
                </Button>
                {provider.configured && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => handleDelete(provider.id)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

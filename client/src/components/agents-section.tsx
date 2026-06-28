import { useState, useEffect, type ReactNode } from "react";
import { Key, Trash2, Check, Loader2, Settings2, Pencil, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  fetchProviders,
  setProviderKey,
  deleteProviderKey,
  fetchAgents,
  updateAgent,
  fetchModels,
  type ProviderStatus,
  type AgentStatus,
  type Model,
} from "../api.ts";
import { modelProviderLabel } from "../lib/model-labels.ts";

// API-key providers are model backends consumed by the Anita agent, so they are
// rendered nested under the Anita row rather than as a top-level section.
const ANITA_AGENT_ID = "anita";

/*
 * Settings section for enabling agents, setting their CLI paths, and
 * configuring the model-provider API keys the Anita agent uses. Self-loading so
 * it can drop into the settings page without the page wiring its data.
 */
export function AgentsSection() {
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
    try {
      const updated = await updateAgent(agent.id, { enabled: !agent.enabled });
      setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      toast.success(`${agent.name} settings updated`);
    } catch (err) {
      setAgents((prev) =>
        prev.map((a) => (a.id === agent.id ? { ...a, enabled: agent.enabled } : a))
      );
      toast.error(err instanceof Error ? err.message : `Failed to update ${agent.name}`);
    }
  };

  const handleSaveAgentPath = async (agent: AgentStatus, path: string | null) => {
    try {
      const updated = await updateAgent(agent.id, { path });
      setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      toast.success(`${agent.name} path updated`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to update ${agent.name} path`);
      throw err;
    }
  };

  const handleSaveDefaultModel = async (agent: AgentStatus, defaultModel: string | null) => {
    try {
      const updated = await updateAgent(agent.id, { defaultModel });
      setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      toast.success(`${agent.name} settings updated`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to update ${agent.name}`);
      throw err;
    }
  };

  const handleToggleAutoApprove = async (agent: AgentStatus) => {
    // Optimistic toggle; reconcile with the server response.
    setAgents((prev) =>
      prev.map((a) => (a.id === agent.id ? { ...a, autoApprove: !a.autoApprove } : a))
    );
    try {
      const updated = await updateAgent(agent.id, { autoApprove: !agent.autoApprove });
      setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      toast.success(`${agent.name} settings updated`);
    } catch (err) {
      setAgents((prev) =>
        prev.map((a) =>
          a.id === agent.id ? { ...a, autoApprove: agent.autoApprove } : a
        )
      );
      toast.error(err instanceof Error ? err.message : `Failed to update ${agent.name}`);
    }
  };

  return (
    <div className="space-y-3">
      {agents.map((agent) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          onToggle={() => handleToggleAgent(agent)}
          onSavePath={(path) => handleSaveAgentPath(agent, path)}
          onSaveDefaultModel={(defaultModel) => handleSaveDefaultModel(agent, defaultModel)}
          onToggleAutoApprove={() => handleToggleAutoApprove(agent)}
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
  children?: ReactNode;
  initialSettingsOpen?: boolean;
  initialPathEditing?: boolean;
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

export function AgentRow({
  agent,
  onToggle,
  onSavePath,
  onSaveDefaultModel,
  onToggleAutoApprove,
  children,
  initialSettingsOpen = false,
  initialPathEditing = false,
}: AgentRowProps) {
  const [settingsOpen, setSettingsOpen] = useState(initialSettingsOpen);
  const [editingPath, setEditingPath] = useState(initialPathEditing);
  const [pathInput, setPathInput] = useState(agent.resolvedPath ?? "");
  const [savingPath, setSavingPath] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [savingDefaultModel, setSavingDefaultModel] = useState(false);

  useEffect(() => {
    if (!settingsOpen || !agent.enabled) return;
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
  }, [agent.id, agent.enabled, settingsOpen]);

  useEffect(() => {
    setPathInput(agent.resolvedPath ?? "");
    setEditingPath(false);
  }, [agent.id, agent.resolvedPath]);

  const toggleSettings = () => {
    setSettingsOpen((open) => {
      const nextOpen = !open;
      setEditingPath(false);
      setPathInput(agent.resolvedPath ?? "");
      return nextOpen;
    });
  };

  const openPathEditor = () => {
    setPathInput(agent.resolvedPath ?? "");
    setEditingPath(true);
  };

  const cancelPathEdit = () => {
    setPathInput(agent.resolvedPath ?? "");
    setEditingPath(false);
  };

  const savePath = async () => {
    setSavingPath(true);
    try {
      await onSavePath(pathInput.trim() || null);
      setEditingPath(false);
    } catch {
      // Parent mutation handler owns the error toast; keep the editor open.
    } finally {
      setSavingPath(false);
    }
  };

  const handleDefaultModelChange = async (
    event: React.ChangeEvent<HTMLSelectElement>
  ) => {
    const value = event.target.value;
    const defaultModel = value === "" ? null : value;
    setSavingDefaultModel(true);
    try {
      await onSaveDefaultModel(defaultModel);
    } catch {
      // Parent mutation handler owns the error toast.
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
                {agent.command} {agent.version ?? "installed"}
              </Badge>
            ) : (
              <Badge variant="destructive">Not found</Badge>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={toggleSettings}
            title={settingsOpen ? "Close settings" : "Open settings"}
            aria-label={settingsOpen ? "Close settings" : "Open settings"}
          >
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

      {settingsOpen && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          <div>
            <label className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
              CLI path
            </label>
            {editingPath ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  savePath();
                }}
                className="mt-1.5 flex items-center gap-1.5"
              >
                <input
                  type="text"
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                  placeholder="Leave empty to resolve on PATH"
                  autoFocus
                  className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <Button
                  type="submit"
                  size="icon-sm"
                  variant="ghost"
                  disabled={savingPath}
                  title="Confirm path"
                  aria-label="Confirm path"
                >
                  {savingPath ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  onClick={cancelPathEdit}
                  disabled={savingPath}
                  title="Cancel path edit"
                  aria-label="Cancel path edit"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </form>
            ) : (
              <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
                <div className="min-w-0 flex-1 truncate rounded-md border border-border px-2 py-1 text-xs font-mono text-muted-foreground">
                  {agent.resolvedPath ?? "Not found on PATH"}
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={openPathEditor}
                  title="Edit CLI path"
                  aria-label="Edit CLI path"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>

          {agent.enabled && (
            <div>
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
                      : "Asks before each action; approve or deny from the session view."}
                  </p>
                </div>
                <Switch
                  checked={agent.autoApprove}
                  onCheckedChange={onToggleAutoApprove}
                  title={agent.autoApprove ? "Require manual approval" : "Auto-approve actions"}
                />
              </div>
            </div>
          )}

          {children}
        </div>
      )}
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
    try {
      await setProviderKey(providerId, keyInput.trim());
      setKeyInput("");
      setEditingProvider(null);
      onChange();
      toast.success("Anita API key updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save Anita API key");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (providerId: string) => {
    try {
      await deleteProviderKey(providerId);
      onChange();
      toast.success("Anita API key deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete Anita API key");
    }
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
                <Button
                  type="submit"
                  size="icon-sm"
                  variant="ghost"
                  disabled={saving || !keyInput.trim()}
                  title="Confirm API key"
                  aria-label="Confirm API key"
                >
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
                  aria-label={provider.configured ? "Update key" : "Add key"}
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
                    title="Delete key"
                    aria-label="Delete key"
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

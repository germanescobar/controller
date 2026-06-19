import { useState, useEffect, type ReactNode } from "react";
import { Key, Trash2, Check, Loader2, Settings2, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  fetchProviders,
  setProviderKey,
  deleteProviderKey,
  fetchAgents,
  updateAgent,
  type ProviderStatus,
  type AgentStatus,
} from "../api.ts";

// API-key providers are model backends consumed by the Ada agent, so they are
// rendered nested under the Ada row rather than as a top-level section.
const ADA_AGENT_ID = "ada";

/*
 * Settings section for enabling agents, setting their CLI paths, and
 * configuring the model-provider API keys the Ada agent uses. Self-loading so
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
    const updated = await updateAgent(agent.id, { enabled: !agent.enabled });
    setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  };

  const handleSaveAgentPath = async (agentId: string, path: string | null) => {
    const updated = await updateAgent(agentId, { path });
    setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  };

  return (
    <div className="space-y-3">
      {agents.map((agent) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          onToggle={() => handleToggleAgent(agent)}
          onSavePath={(path) => handleSaveAgentPath(agent.id, path)}
        >
          {agent.id === ADA_AGENT_ID && (
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
  children?: ReactNode;
}

function AgentRow({ agent, onToggle, onSavePath, children }: AgentRowProps) {
  const [showPath, setShowPath] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [savingPath, setSavingPath] = useState(false);

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

      {children && <div className="mt-3 border-t border-border pt-3">{children}</div>}
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

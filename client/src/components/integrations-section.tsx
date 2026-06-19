import { useState, useEffect } from "react";
import { Plug, Pencil, Trash2, Plus, Check, Loader2, X, Search, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  fetchConnections,
  createConnection,
  updateConnection,
  deleteConnection,
  inspectOpenApiSpec,
  type IntegrationConnection,
  type ConnectionMode,
  type AcquiredState,
  type Attachment,
  type AuthSchemeInput,
  type DerivedScheme,
  type SchemeAlternative,
} from "../api.ts";
import {
  CONNECTION_MODES,
  AUTH_PRESETS,
  connectionModeSpec,
  authPreset,
  presetForScheme,
  type FieldSpec,
  type AuthPreset,
} from "../lib/integration-modes.ts";

/*
 * Lists configured integration connections and hosts the add/edit form. The
 * form keeps the two axes separate: a connection mode (how we reach the
 * backend) and an auth scheme set. Each scheme is chosen via a friendly preset
 * (Bearer, API key, OAuth, …) over the (acquisition × attachment) model.
 * OpenAPI connections can derive their schemes from the spec; CLI connections
 * manage their own auth. Secret values are write-only. Self-loading.
 */
export function IntegrationsSection() {
  const [connections, setConnections] = useState<IntegrationConnection[]>([]);
  const [editing, setEditing] = useState<IntegrationConnection | "new" | null>(null);

  const load = () => {
    fetchConnections().then(setConnections).catch(() => {});
  };

  useEffect(load, []);

  const handleDelete = async (id: string) => {
    await deleteConnection(id);
    load();
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => setEditing("new")}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add connection
        </Button>
      </div>

      {connections.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No connections yet. Add one to let agents reach a third-party service.
        </p>
      )}

      {connections.map((connection) => (
          <div
            key={connection.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
          >
            <div className="flex min-w-0 items-center gap-2">
              <Plug className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{connection.name}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1">
                  <Badge variant="secondary">
                    {connectionModeSpec(connection.transport.mode).label}
                  </Badge>
                  {connection.auth.schemes.length === 0 ? (
                    <Badge variant="outline">No auth</Badge>
                  ) : (
                    connection.auth.schemes.map((s) => (
                      <Badge key={s.id} variant="outline">
                        {presetForScheme(s).label}
                      </Badge>
                    ))
                  )}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => setEditing(connection)}
                title="Edit connection"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => handleDelete(connection.id)}
                className="text-muted-foreground hover:text-destructive"
                title="Delete connection"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ))}

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing !== null && (
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{editing === "new" ? "Add connection" : "Edit connection"}</DialogTitle>
              <DialogDescription>
                Configure how agents reach this service.
              </DialogDescription>
            </DialogHeader>
            <ConnectionForm
              key={editing === "new" ? "new" : editing.id}
              connection={editing === "new" ? null : editing}
              onCancel={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                load();
              }}
            />
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

/** A scheme as edited in the form, identified by its UI preset. */
interface FormScheme {
  id?: string;
  presetId: string;
  /** Attachment name when the preset lets the user edit it (API key header/query). */
  attachmentName: string;
  config: Record<string, string>;
  secret: string;
  hasSecret: boolean;
  acquired?: AcquiredState;
}

interface ConnectionFormProps {
  connection: IntegrationConnection | null;
  onCancel: () => void;
  onSaved: () => void;
}

function ConnectionForm({ connection, onCancel, onSaved }: ConnectionFormProps) {
  const [name, setName] = useState(connection?.name ?? "");
  const [transportMode, setTransportMode] = useState<ConnectionMode>(
    connection?.transport.mode ?? "rest"
  );
  const [transportConfig, setTransportConfig] = useState<Record<string, string>>(
    connection?.transport.config ?? {}
  );
  const [headerRows, setHeaderRows] = useState<KeyValueRow[]>(() =>
    initialKeyValueRows(connection?.transport.headers)
  );
  const [queryParamRows, setQueryParamRows] = useState<KeyValueRow[]>(() =>
    initialKeyValueRows(connection?.transport.query)
  );
  // Advanced (additional headers/query params) starts open only if there's
  // already something to show.
  const [advancedOpen, setAdvancedOpen] = useState(
    () =>
      hasEntries(connection?.transport.headers) || hasEntries(connection?.transport.query)
  );
  const [schemes, setSchemes] = useState<FormScheme[]>(() => initialSchemes(connection));
  // OpenAPI connections gate the rest of the form behind a spec import, so a
  // new one starts un-imported; an existing one already has its data.
  const [imported, setImported] = useState(connection?.transport.mode === "openapi");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Spec-import state (OpenAPI only).
  const [importing, setImporting] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);
  const [alternatives, setAlternatives] = useState<SchemeAlternative[] | null>(null);
  const [specMeta, setSpecMeta] = useState<{ baseUrl?: string; title?: string }>({});

  const transportSpec = connectionModeSpec(transportMode);
  // While gated, only the spec URL + Import button show; everything the import
  // fills in (base URL, headers, auth, name) appears afterward.
  const gated = transportSpec.derivesAuth === true && !imported;

  const changeMode = (mode: ConnectionMode) => {
    setTransportMode(mode);
    setError(null);
    setImportNote(null);
    setAlternatives(null);
    // Re-gate when switching into OpenAPI unless we're editing one already.
    if (mode === "openapi") setImported(connection?.transport.mode === "openapi");
  };

  const setScheme = (i: number, patch: Partial<FormScheme>) =>
    setSchemes((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const renderField = (field: FieldSpec) => (
    <TextField
      key={field.key}
      field={field}
      value={transportConfig[field.key] ?? ""}
      onChange={(v) => setTransportConfig((p) => ({ ...p, [field.key]: v }))}
    />
  );

  // Apply a chosen scheme set + spec metadata, then reveal the rest of the form.
  const applyDerived = (derived: DerivedScheme[], meta: { baseUrl?: string; title?: string }) => {
    setSchemes(derived.map(derivedToFormScheme));
    if (meta.baseUrl && !transportConfig.baseUrl) {
      setTransportConfig((p) => ({ ...p, baseUrl: meta.baseUrl! }));
    }
    if (meta.title && !name.trim()) setName(meta.title);
    setAlternatives(null);
    setImported(true);
  };

  const runImport = async () => {
    const specUrl = (transportConfig.specUrl ?? "").trim();
    if (!specUrl) return setError("Enter the spec URL first.");
    setImporting(true);
    setError(null);
    setImportNote(null);
    setAlternatives(null);
    try {
      const info = await inspectOpenApiSpec(specUrl);
      const meta = { baseUrl: info.baseUrl, title: info.title };
      setSpecMeta(meta);
      const warn = info.unsupported.length
        ? ` Skipped unsupported schemes: ${info.unsupported.join(", ")}.`
        : "";
      if (info.alternatives.length <= 1) {
        applyDerived(info.alternatives[0]?.schemes ?? [], meta);
        const n = info.alternatives[0]?.schemes.length ?? 0;
        setImportNote(
          (n > 0 ? `Imported base URL and ${n} auth scheme(s).` : "Imported base URL; no auth declared — add it below.") +
            warn
        );
      } else {
        // Multiple OR alternatives: let the user pick which auth to use.
        setAlternatives(info.alternatives);
        setImportNote(`The spec offers multiple auth options — choose one.${warn}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import spec.");
    } finally {
      setImporting(false);
    }
  };

  const handleSubmit = async () => {
    if (!name.trim()) return setError("Name is required.");

    if (transportSpec.supportsHeaders) {
      const badHeader = headerRows.find((r) => r.name.trim() && !r.value.trim());
      if (badHeader) return setError(`Enter a value for header "${badHeader.name.trim()}".`);
      const badParam = queryParamRows.find((r) => r.name.trim() && !r.value.trim());
      if (badParam) return setError(`Enter a value for parameter "${badParam.name.trim()}".`);
    }

    if (!transportSpec.managesOwnAuth) {
      const problem = validateSchemes(schemes);
      if (problem) return setError(problem);
    }

    setSaving(true);
    setError(null);
    try {
      await save(connection, {
        name: name.trim(),
        transport: {
          mode: transportMode,
          config: pruneEmpty(pick(transportConfig, transportSpec.fields.map((f) => f.key))),
          headers: transportSpec.supportsHeaders ? rowsToMap(headerRows) : {},
          query: transportSpec.supportsHeaders ? rowsToMap(queryParamRows) : {},
        },
        auth: {
          schemes: transportSpec.managesOwnAuth ? [] : schemes.map(toSchemeInput),
        },
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save connection.");
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        // While gated, the form's primary action is importing the spec (so
        // Enter in the spec URL imports rather than trying to save).
        if (gated) runImport();
        else handleSubmit();
      }}
      className="space-y-4"
    >
      <Field label="Name">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My API"
          className={INPUT_CLASS}
        />
      </Field>

      <Axis title="Connection">
        <Field label="Connection mode">
          <select
            value={transportMode}
            onChange={(e) => changeMode(e.target.value as ConnectionMode)}
            className={INPUT_CLASS}
          >
            {CONNECTION_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted-foreground">{transportSpec.description}</p>
        </Field>

        {transportSpec.derivesAuth ? (
          <>
            {/* Spec URL, then the import controls directly beneath it. */}
            {transportSpec.fields.filter((f) => f.key === "specUrl").map(renderField)}

            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1.5">
                {importNote && (
                  <p className="mr-auto text-xs text-muted-foreground">{importNote}</p>
                )}
                {!gated && (
                  <Button type="button" size="sm" variant="outline" onClick={runImport} disabled={importing}>
                    {importing ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Search className="mr-1 h-3.5 w-3.5" />
                    )}
                    Re-import from spec
                  </Button>
                )}
              </div>

              {gated && !alternatives && (
                <p className="text-xs text-muted-foreground">
                  Import the spec to fill in the base URL, authentication, and name — or{" "}
                  <button
                    type="button"
                    className="underline hover:text-foreground"
                    onClick={() => setImported(true)}
                  >
                    configure manually
                  </button>
                  .
                </p>
              )}

              {alternatives && (
                <div className="space-y-1.5">
                  {alternatives.map((alt, i) => (
                    <Button
                      key={i}
                      type="button"
                      size="sm"
                      variant="outline"
                      className="w-full justify-start"
                      onClick={() => applyDerived(alt.schemes, specMeta)}
                    >
                      {alt.schemes.map((s) => s.label).join(" + ")}
                    </Button>
                  ))}
                </div>
              )}
            </div>

            {/* Remaining fields (base URL) appear once imported. */}
            {!gated && transportSpec.fields.filter((f) => f.key !== "specUrl").map(renderField)}
          </>
        ) : (
          transportSpec.fields.map(renderField)
        )}
      </Axis>

      {!gated && (
        <Axis title="Authentication">
          {transportSpec.managesOwnAuth ? (
            <p className="text-xs text-muted-foreground">
              CLI-native integrations manage their own authentication. Install the binary and run
              its sign-in yourself (e.g. <code className="font-mono">ntn login</code>). Controller
              verifies it is installed and authenticated and points the agent at the binary — it
              does not proxy it or attach credentials.
            </p>
          ) : (
            <>
              {schemes.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No auth schemes — this connection sends no credentials.
                </p>
              )}

              {schemes.map((scheme, i) => (
                <SchemeEditor
                  key={scheme.id ?? `new-${i}`}
                  scheme={scheme}
                  onChange={(patch) => setScheme(i, patch)}
                  onRemove={() => setSchemes((prev) => prev.filter((_, idx) => idx !== i))}
                />
              ))}

              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setSchemes((prev) => [...prev, newScheme()])}
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                Add scheme
              </Button>
            </>
          )}
        </Axis>
      )}

      {!gated && transportSpec.supportsHeaders && (
        <div className="rounded-md border border-border">
          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            <span>Advanced</span>
            <ChevronDown
              className={`h-4 w-4 transition-transform ${advancedOpen ? "rotate-180" : ""}`}
            />
          </button>
          {advancedOpen && (
            <div className="space-y-4 border-t border-border p-3">
              <div>
                <span className="mb-1 block text-xs font-medium text-muted-foreground">
                  Additional headers
                </span>
                <p className="mb-2 text-xs text-muted-foreground">
                  Constant non-secret headers sent on every request (e.g. an API version).
                </p>
                <KeyValueRows
                  rows={headerRows}
                  onChange={setHeaderRows}
                  addLabel="Add header"
                  namePlaceholder="Header"
                />
              </div>
              <div>
                <span className="mb-1 block text-xs font-medium text-muted-foreground">
                  Additional query params
                </span>
                <p className="mb-2 text-xs text-muted-foreground">
                  Constant non-secret query params on every request (e.g. <code>api-version</code>).
                </p>
                <KeyValueRows
                  rows={queryParamRows}
                  onChange={setQueryParamRows}
                  addLabel="Add parameter"
                  namePlaceholder="Parameter"
                />
              </div>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          <X className="mr-1 h-3.5 w-3.5" />
          Cancel
        </Button>
        {gated ? (
          <Button type="submit" size="sm" disabled={importing}>
            {importing ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="mr-1 h-3.5 w-3.5" />
            )}
            Import spec
          </Button>
        ) : (
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="mr-1 h-3.5 w-3.5" />
            )}
            {connection ? "Save" : "Create"}
          </Button>
        )}
      </div>
    </form>
  );
}

/* One auth scheme: a preset selector, its config fields, and a single secret. */
function SchemeEditor({
  scheme,
  onChange,
  onRemove,
}: {
  scheme: FormScheme;
  onChange: (patch: Partial<FormScheme>) => void;
  onRemove: () => void;
}) {
  const preset = authPreset(scheme.presetId);
  // Hidden presets (not yet usable) aren't offered as new choices, but keep the
  // current one selectable so an existing/derived scheme of that kind still shows.
  const options = AUTH_PRESETS.filter((p) => !p.hidden || p.id === scheme.presetId);
  return (
    <div className="space-y-3 rounded-md border border-border p-2.5">
      <div className="flex items-start gap-1.5">
        <div className="flex-1">
          <select
            value={scheme.presetId}
            // Switching preset starts a fresh scheme so stale config/secret don't carry over.
            onChange={(e) =>
              onChange({ presetId: e.target.value, attachmentName: "", config: {}, secret: "", hasSecret: false })
            }
            className={INPUT_CLASS}
          >
            {options.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          title="Remove scheme"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{preset.description}</p>

      {preset.attachmentNameField && (
        <Field label={preset.attachmentNameField.label}>
          <input
            type="text"
            value={scheme.attachmentName}
            onChange={(e) => onChange({ attachmentName: e.target.value })}
            placeholder={preset.attachmentNameField.placeholder}
            className={INPUT_CLASS}
          />
        </Field>
      )}

      {preset.fields.map((field) => (
        <TextField
          key={field.key}
          field={field}
          value={scheme.config[field.key] ?? ""}
          onChange={(v) => onChange({ config: { ...scheme.config, [field.key]: v } })}
        />
      ))}

      {preset.secret && (
        <Field label={preset.secret.optional ? `${preset.secret.label} (optional)` : preset.secret.label}>
          <input
            type="password"
            value={scheme.secret}
            onChange={(e) => onChange({ secret: e.target.value })}
            placeholder={scheme.hasSecret ? "Configured — leave blank to keep" : undefined}
            className={INPUT_CLASS}
          />
        </Field>
      )}

      {preset.acquisitionNote && <AcquisitionPanel preset={preset} acquired={scheme.acquired} />}
    </div>
  );
}

/*
 * Affordance for acquired-credential presets (OAuth). Both are disabled here —
 * acquisition lands with the outbound-execution layer.
 */
function AcquisitionPanel({ preset, acquired }: { preset: AuthPreset; acquired?: AcquiredState }) {
  const status = acquired?.status ?? "none";
  return (
    <div className="rounded-md border border-dashed border-border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">Connection status</span>
        <Badge variant={status === "connected" ? "secondary" : "outline"}>
          {status === "connected" ? "Connected" : status === "expired" ? "Expired" : "Not connected"}
        </Badge>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">{preset.acquisitionNote?.note}</p>
      {preset.acquisitionNote?.interactive && (
        <Button type="button" size="sm" variant="outline" className="mt-2" disabled title="Coming soon">
          Connect
        </Button>
      )}
    </div>
  );
}

interface KeyValueRow {
  name: string;
  value: string;
}

/* Editable non-secret name→value rows, used for constant transport headers. */
function KeyValueRows({
  rows,
  onChange,
  addLabel,
  namePlaceholder,
}: {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  addLabel: string;
  namePlaceholder: string;
}) {
  const update = (i: number, patch: Partial<KeyValueRow>) =>
    onChange(rows.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div key={i} className="flex items-start gap-1.5">
          <input
            type="text"
            value={row.name}
            onChange={(e) => update(i, { name: e.target.value })}
            placeholder={namePlaceholder}
            className={`${INPUT_CLASS} flex-1`}
          />
          <input
            type="text"
            value={row.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder="Value"
            className={`${INPUT_CLASS} flex-1`}
          />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
            title="Remove"
            disabled={rows.length === 1}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => onChange([...rows, { name: "", value: "" }])}
      >
        <Plus className="mr-1 h-3.5 w-3.5" />
        {addLabel}
      </Button>
    </div>
  );
}

/* A non-collapsible bordered card matching the Advanced section's framing. */
function Axis({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border">
      <div className="px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="space-y-3 border-t border-border p-3">{children}</div>
    </div>
  );
}

function TextField({
  field,
  value,
  onChange,
}: {
  field: FieldSpec;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={field.optional ? `${field.label} (optional)` : field.label}>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        className={INPUT_CLASS}
      />
    </Field>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

const INPUT_CLASS =
  "w-full rounded-md border border-border bg-transparent px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring";

// --- form <-> model helpers ---

function newScheme(): FormScheme {
  return { presetId: "bearer", attachmentName: "", config: {}, secret: "", hasSecret: false };
}

function initialKeyValueRows(map: Record<string, string> | undefined): KeyValueRow[] {
  const entries = Object.entries(map ?? {});
  if (entries.length === 0) return [{ name: "", value: "" }];
  return entries.map(([name, value]) => ({ name, value }));
}

function hasEntries(map: Record<string, string> | undefined): boolean {
  return !!map && Object.keys(map).length > 0;
}

function initialSchemes(connection: IntegrationConnection | null): FormScheme[] {
  return (connection?.auth.schemes ?? []).map((s) => ({
    id: s.id,
    presetId: presetForScheme(s).id,
    attachmentName: s.attachment?.name ?? "",
    config: s.config,
    secret: "",
    hasSecret: s.hasSecret,
    acquired: s.acquired,
  }));
}

function derivedToFormScheme(d: DerivedScheme): FormScheme {
  return {
    presetId: presetForScheme(d).id,
    attachmentName: d.attachment?.name ?? "",
    config: d.config,
    secret: "",
    hasSecret: false,
  };
}

function toSchemeInput(scheme: FormScheme): AuthSchemeInput {
  const preset = authPreset(scheme.presetId);
  let attachment: Attachment | undefined;
  if (preset.attachment) {
    attachment = preset.attachmentNameField
      ? { ...preset.attachment, name: scheme.attachmentName.trim() }
      : { ...preset.attachment };
  }
  const typed = scheme.secret.trim();
  return {
    id: scheme.id,
    acquisition: preset.acquisition,
    attachment,
    config: pruneEmpty(pick(scheme.config, preset.fields.map((f) => f.key))),
    // Omit when blank so a configured secret is kept untouched.
    secret: typed === "" ? undefined : typed,
  };
}

/* Return the first validation problem across the scheme set, or null. */
function validateSchemes(schemes: FormScheme[]): string | null {
  for (const scheme of schemes) {
    const preset = authPreset(scheme.presetId);
    if (preset.attachmentNameField && !scheme.attachmentName.trim()) {
      return `${preset.label}: enter ${preset.attachmentNameField.label.toLowerCase()}.`;
    }
    const missing = preset.fields.find((f) => !f.optional && !scheme.config[f.key]?.trim());
    if (missing) return `${preset.label}: enter ${missing.label.toLowerCase()}.`;
    const needsSecret = preset.secret && !preset.secret.optional && !preset.acquisitionNote;
    if (needsSecret && !scheme.secret.trim() && !scheme.hasSecret) {
      return `${preset.label}: enter ${preset.secret!.label.toLowerCase()}.`;
    }
  }
  return null;
}

async function save(
  connection: IntegrationConnection | null,
  input: Parameters<typeof createConnection>[0]
): Promise<void> {
  if (connection) await updateConnection(connection.id, input);
  else await createConnection(input);
}

function pruneEmpty(record: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value.trim() !== "") result[key] = value.trim();
  }
  return result;
}

function pick(record: Record<string, string>, keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    if (record[key] !== undefined) result[key] = record[key];
  }
  return result;
}

function rowsToMap(rows: KeyValueRow[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name && row.value.trim()) result[name] = row.value.trim();
  }
  return result;
}

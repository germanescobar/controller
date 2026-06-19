import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentsSection } from "../components/agents-section.tsx";
import { IntegrationsSection } from "../components/integrations-section.tsx";

export type SettingsSection = "agents" | "integrations";

interface SectionSpec {
  id: SettingsSection;
  label: string;
  description: string;
}

const SECTIONS: SectionSpec[] = [
  {
    id: "agents",
    label: "Agents & Models",
    description: "Enable agents, set their CLI paths, and configure model-provider API keys.",
  },
  {
    id: "integrations",
    label: "Integrations",
    description: "Connect third-party services for agents to use at runtime.",
  },
];

interface SettingsPageProps {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onClose: () => void;
}

/*
 * Full-page settings with an inner sidebar of sections. Sections are
 * self-contained components, so adding a new one is just an entry in SECTIONS
 * plus a case in the content switch.
 */
export function SettingsPage({ section, onSectionChange, onClose }: SettingsPageProps) {
  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  return (
    <div className="flex min-h-0 flex-1">
      <nav className="flex w-48 shrink-0 flex-col gap-1 border-r border-border p-3 md:w-56">
        <h1 className="mb-2 px-2 text-sm font-semibold">Settings</h1>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onSectionChange(s.id)}
            className={`rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
              s.id === active.id
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            }`}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-lg font-medium">{active.label}</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">{active.description}</p>
            </div>
            <Button size="icon-sm" variant="ghost" onClick={onClose} title="Close settings">
              <X className="h-4 w-4" />
            </Button>
          </div>

          {active.id === "agents" && <AgentsSection />}
          {active.id === "integrations" && <IntegrationsSection />}
        </div>
      </div>
    </div>
  );
}

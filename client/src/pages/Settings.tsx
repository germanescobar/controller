import { ChevronLeft, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentsSection } from "../components/agents-section.tsx";
import { IntegrationsSection } from "../components/integrations-section.tsx";
import { SkillsSection } from "../components/skills-section.tsx";
import { ShortcutsSection } from "../components/shortcuts-section.tsx";

export type SettingsSection = "agents" | "integrations" | "skills" | "shortcuts";

interface SectionSpec {
  id: SettingsSection;
  label: string;
  shortLabel: string;
  description: string;
}

const SECTIONS: SectionSpec[] = [
  {
    id: "agents",
    label: "Agents & Models",
    shortLabel: "Agents",
    description: "Enable agents, set their CLI paths, and configure model-provider API keys.",
  },
  {
    id: "integrations",
    label: "Integrations",
    shortLabel: "Integrations",
    description: "Connect third-party services for agents to use at runtime.",
  },
  {
    id: "skills",
    label: "Skills",
    shortLabel: "Skills",
    description: "Create and edit app-owned skills available to all agents.",
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    shortLabel: "Shortcuts",
    description: "Customise Controller Mode keyboard shortcuts.",
  },
];

interface SettingsPageProps {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onClose: () => void;
  /**
   * Worktree context captured when the user opened Settings. The reset
   * session permissions button needs this so the server knows which
   * worktree to revoke. `undefined` when Settings was opened from a
   * view that doesn't carry a project/worktree (e.g. the empty
   * landing page) — in that case the reset button is disabled.
   */
  worktreeContext?: { projectId: string; worktreeId: string };
}

/*
 * Full-page settings with an inner sidebar of sections. Sections are
 * self-contained components, so adding a new one is just an entry in SECTIONS
 * plus a case in the content switch.
 *
 * Responsive layout: on mobile (<md) the section nav collapses into a sticky
 * top bar of horizontally-scrollable tabs and a dedicated close/back control
 * appears next to the page title. On desktop (≥md) we keep the original
 * two-column layout with the section nav on the left.
 */
export function SettingsPage({
  section,
  onSectionChange,
  onClose,
  worktreeContext,
}: SettingsPageProps) {
  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      {/* Mobile-only top bar with back control and section title */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-2 md:hidden">
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onClose}
          title="Back"
          aria-label="Back"
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          Settings
        </span>
      </div>

      {/* Mobile-only section tabs (horizontally scrollable) */}
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-background px-2 py-2 md:hidden">
        {SECTIONS.map((s) => {
          const isActive = s.id === active.id;
          return (
            <button
              key={s.id}
              type="button"
              data-testid={`settings-nav-${s.id}`}
              onClick={() => onSectionChange(s.id)}
              aria-current={isActive ? "page" : undefined}
              className={`shrink-0 whitespace-nowrap rounded-md px-3 text-sm transition-colors min-h-[40px] ${
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              }`}
            >
              {s.shortLabel}
            </button>
          );
        })}
      </div>

      {/* Desktop side nav */}
      <nav className="hidden w-48 shrink-0 flex-col gap-1 border-r border-border p-3 md:flex md:w-56">
        <h1 className="mb-2 px-2 text-sm font-semibold">Settings</h1>
        {SECTIONS.map((s) => {
          const isActive = s.id === active.id;
          return (
            <button
              key={s.id}
              type="button"
              data-testid={`settings-nav-${s.id}`}
              onClick={() => onSectionChange(s.id)}
              aria-current={isActive ? "page" : undefined}
              className={`rounded-md px-2 py-2.5 text-left text-sm transition-colors min-h-[40px] ${
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl p-4 sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-lg font-medium">{active.label}</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">{active.description}</p>
            </div>
            {/* Desktop close affordance — on mobile the dedicated back button in the top bar covers this. */}
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={onClose}
              title="Close settings"
              aria-label="Close settings"
              className="hidden md:inline-flex"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {active.id === "agents" && (
            <AgentsSection worktreeContext={worktreeContext} />
          )}
          {active.id === "integrations" && <IntegrationsSection />}
          {active.id === "skills" && <SkillsSection />}
          {active.id === "shortcuts" && <ShortcutsSection />}
        </div>
      </div>
    </div>
  );
}

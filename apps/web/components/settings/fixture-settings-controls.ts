// The fixtures' Settings form: the controls of the panes whose values only
// this browser keeps (SETTINGS_STORAGE_KEY), which nothing reads (#487), so
// fixture mode alone offers them. Each pane's title and description are the
// Settings table's (lib/modules/settings-panes.ts); these are its groups.
import type { SettingsPaneId } from "@/lib/modules/settings-panes"

type ControlBase = {
  id: string
  label: string
  description: string
  scope: "Personal" | "Company" | "Project" | "Platform"
}

export type SettingControl = ControlBase &
  (
    | { type: "input"; value: string; inputType?: "email" }
    | { type: "select"; value: string; options: Array<{ value: string; label: string }> }
    | { type: "switch"; checked: boolean }
    | { type: "status"; value: string; tone: "healthy" | "warning" | "danger" | "neutral" }
    /** A line read, not set: what the API holds and no control here writes. */
    | { type: "text"; value: string }
  )

export type SettingsGroup = { id?: string; title: string; controls: SettingControl[] }

const ACCOUNT: SettingsGroup[] = [
  {
    id: "profile",
    title: "Profile",
    controls: [
      {
        id: "account-name",
        label: "Full name",
        description: "Shown in assignments, approvals, comments, and audit history.",
        scope: "Personal",
        type: "input",
        value: "Olivia Larsen",
      },
      {
        id: "account-email",
        label: "Email address",
        description: "Used for authentication and configured notification delivery.",
        scope: "Personal",
        type: "input",
        inputType: "email",
        value: "olivia.larsen@kystbyen.example",
      },
      {
        id: "account-role",
        label: "Primary role",
        description: "Your effective permissions still depend on explicit project grants.",
        scope: "Personal",
        type: "status",
        value: "Operations Manager · 3 projects",
        tone: "healthy",
      },
    ],
  },
  {
    id: "defaults",
    title: "Defaults",
    controls: [
      {
        id: "account-project",
        label: "Default project",
        description: "Opened after sign-in; this does not change your permitted project scope.",
        scope: "Personal",
        type: "select",
        value: "copenhagen",
        options: [
          { value: "copenhagen", label: "Copenhagen Central" },
          { value: "harbor", label: "Harbor Commercial" },
          { value: "last", label: "Last opened project" },
        ],
      },
      {
        id: "account-layout",
        label: "Default operations view",
        description: "Choose the first view used in Operate.",
        scope: "Personal",
        type: "select",
        value: "live",
        options: [
          { value: "live", label: "Live Operations" },
          { value: "routes", label: "Routes" },
          { value: "tickets", label: "Tickets" },
        ],
      },
      {
        id: "account-saved",
        label: "Remember filters and layouts",
        description: "Save project-specific filters, table columns, and map layout.",
        scope: "Personal",
        type: "switch",
        checked: true,
      },
    ],
  },
]

/** The groups of the one pane the browser draws from its own state: Account & appearance. */
export const FIXTURE_SETTINGS_GROUPS: Partial<Record<SettingsPaneId, readonly SettingsGroup[]>> = {
  account: ACCOUNT,
}

/** What the search finds a fixture pane by beyond its table entry: its groups' and controls' words. */
export function fixtureSettingsTerms(paneId: SettingsPaneId): readonly string[] {
  return (FIXTURE_SETTINGS_GROUPS[paneId] ?? []).flatMap((group) => [group.title, ...group.controls.flatMap((control) => [control.label, control.description])])
}

/** Every control's value as the fixtures set it, before this browser saved any. */
export function fixtureSettingDefaults(): Record<string, string | boolean> {
  return Object.fromEntries(
    Object.values(FIXTURE_SETTINGS_GROUPS).flatMap((groups) =>
      (groups ?? []).flatMap((group) => group.controls.flatMap((control): Array<[string, string | boolean]> => (control.type === "switch" ? [[control.id, control.checked]] : control.type === "status" ? [] : [[control.id, control.value]]))),
    ),
  )
}

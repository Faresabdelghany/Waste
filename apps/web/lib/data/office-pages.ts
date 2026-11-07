// The office shell's workspace pages that show fewer modules than their
// workspace holds: the rest are another surface's — the Driver App, the
// citizen portal, a provider's own team. WorkspacePageShell narrows a page to
// these, and the landing (lib/api/landing.ts) asks whether a role views any.
import type { WorkspaceId } from "./business-modules"

export const PAGE_MODULE_IDS: Partial<Record<WorkspaceId, readonly string[]>> = {
  // O11 of #290: a customer's bulky items booked onto a collection day; #393: the recycling centres' visit ledger; M16a of #293: the scale house; M23 of #293: the field inspections.
  operate: ["tickets", "bulky-bookings", "exceptions", "site-visits", "scale-house", "inspections"],
  customers: [
    "properties",
    "groups",
    "shared",
    "contacts",
    "agreements",
    // M7 of #293: a customer's requests and the office's decisions on them.
    "applications",
    // #393: the plates and cards a project's recycling centres admit by.
    "site-access",
    // M23b of #293: the right-sizing proposals.
    "right-sizing",
  ],
  "service-providers": ["service-providers", "service-areas", "activities"],
}

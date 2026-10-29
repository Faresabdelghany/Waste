// Settings › Portals & branding on the Pilot (#487): what residents and
// drivers are given today. A project is published under its `publicSlug`
// (ADR-0010), and its public pages are the collection days, the drop-off
// points and the sorting guide; the Driver App is a driver's with a login.
// The customer portal (C20–C22, #382–#384) and a project's branding (M22,
// #410) have no API yet, so nothing here stands for them. Pure; the pane
// reads it.
import type { BusinessRecord } from "@/lib/data/business-modules"
import { sortingGuidePathOf } from "@/lib/data/sorting-guide"
import { calendarHrefOf } from "@/lib/public/collection-days"
import { dropOffHrefOf } from "@/lib/public/drop-off-points"
import { isSoftDeleted } from "@waste/domain/record-visibility"

/** One public page of a published project. */
export type PublicPage = { label: string; href: string }

/** The slug a project is published under, or null while it is not. */
export function publicSlugOf(project: BusinessRecord): string | null {
  const slug = project.submittedValues?.publicSlug
  return typeof slug === "string" && slug !== "" ? slug : null
}

/** A published project's public pages, in a resident's order: when the bins are emptied, where to bring things, what goes where. */
export function publicPagesOf(slug: string): PublicPage[] {
  return [
    { label: "Collection days", href: calendarHrefOf(slug) },
    { label: "Drop-off points", href: dropOffHrefOf(slug) },
    { label: "Sorting guide", href: sortingGuidePathOf(slug) },
  ]
}

/** How many of a project's drivers may sign in to the Driver App, of how many it has, as a person reads it. */
export function driverAppReadingOf(drivers: readonly BusinessRecord[], projectId: string): string {
  const own = drivers.filter((driver) => !isSoftDeleted(driver) && driver.submittedValues?.projectId === projectId)
  if (own.length === 0) return "No drivers"
  const signedIn = own.filter((driver) => driver.submittedValues?.driverAppAccess === true).length
  return `${signedIn} of ${own.length} driver${own.length === 1 ? "" : "s"} with app access`
}

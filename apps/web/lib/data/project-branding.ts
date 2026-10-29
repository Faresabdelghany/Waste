// A project's branding as Settings › Portals & branding reads and writes it
// on the Pilot (M22 of #293): one colour drawn behind white text on its
// public pages, a logo and an accessibility statement it serves itself over
// https. The project record carries the wire's branding as JSON under
// `BRANDING_KEY` (lib/api/records/organisation.ts); the pane writes it whole
// through `PUT /projects/:id/branding`, never the project's patch. The
// colour's contrast and the addresses' shapes are the domain's
// (`@waste/domain/access/branding`), judged here before the API is asked.
// Pure.
import type { ProjectBranding } from "@waste/contracts/organisation"
import { AA_CONTRAST, BRAND_TEXT_COLOR, brandColorReadable, brandColorRefusal, contrastRatio, isBrandColor, isHttpsAddress } from "@waste/domain/access/branding"

import type { BusinessRecord } from "./business-modules"

/** Where a project record carries its branding, as the wire's JSON. */
export const BRANDING_KEY = "branding"

export const NO_BRANDING: ProjectBranding = { brandColor: null, logoUrl: null, accessibilityStatementUrl: null }

const textOrNull = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)

/** The project's branding as its record carries it; none where it carries none or a value that is not one. */
export function brandingOf(project: BusinessRecord): ProjectBranding {
  const raw = project.submittedValues?.[BRANDING_KEY]
  if (typeof raw !== "string") return NO_BRANDING
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof ProjectBranding, unknown>>
    return { brandColor: textOrNull(parsed.brandColor), logoUrl: textOrNull(parsed.logoUrl), accessibilityStatementUrl: textOrNull(parsed.accessibilityStatementUrl) }
  } catch {
    return NO_BRANDING
  }
}

/** What the form holds: each part as typed, empty being none. */
export type BrandingForm = { brandColor: string; logoUrl: string; accessibilityStatementUrl: string }

export const brandingFormOf = (branding: ProjectBranding): BrandingForm => ({
  brandColor: branding.brandColor ?? "",
  logoUrl: branding.logoUrl ?? "",
  accessibilityStatementUrl: branding.accessibilityStatementUrl ?? "",
})

/** Why the typed colour will not do, or null: empty, or `#RRGGBB` that white text reads on at AA. */
export function brandColorRefusalOf(typed: string): string | null {
  const color = typed.trim()
  if (color === "") return null
  if (!isBrandColor(color)) return "A colour is a hash and six hex digits, as #1f6f3f"
  return brandColorReadable(color) ? null : brandColorRefusal(color.toLowerCase())
}

/** Why a typed address will not do, or null: empty, or https. */
export function addressRefusalOf(typed: string): string | null {
  const address = typed.trim()
  if (address === "") return null
  return isHttpsAddress(address) ? null : "An address is https, as https://kk.dk/logo.svg"
}

/** White text's contrast on a typed colour, as a person reads it, or null while the colour is not one. */
export function contrastLabelOf(typed: string): string | null {
  const color = typed.trim()
  if (!isBrandColor(color)) return null
  const ratio = contrastRatio(color, BRAND_TEXT_COLOR)
  return `Contrast with white text ${ratio.toFixed(2)} to 1 — ${ratio >= AA_CONTRAST ? "meets" : "fails"} WCAG 2.1 AA`
}

/** The body the form makes, or null while a part will not do. */
export function brandingFromForm(form: BrandingForm): ProjectBranding | null {
  if (brandColorRefusalOf(form.brandColor) !== null || addressRefusalOf(form.logoUrl) !== null || addressRefusalOf(form.accessibilityStatementUrl) !== null) return null
  const part = (typed: string) => (typed.trim() === "" ? null : typed.trim())
  const color = part(form.brandColor)
  return { brandColor: color === null ? null : color.toLowerCase(), logoUrl: part(form.logoUrl), accessibilityStatementUrl: part(form.accessibilityStatementUrl) }
}

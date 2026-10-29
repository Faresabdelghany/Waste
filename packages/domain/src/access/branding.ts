// A project's branding on its public pages (M22 of #293, #410): one brand
// colour, a logo the project hosts itself, and a link to its accessibility
// statement. The colour is drawn behind white text in the pages' header, so a
// colour that would fail WCAG 2.1 AA's contrast for normal text (4.5 to 1)
// against white is refused: a project may not brand its pages out of
// accessibility. The logo and the statement are addresses the project serves
// itself — its municipality's own site, and the statement Digitaliseringsstyrelsen's
// WAS tool publishes — over https alone, since a public page served over
// https may not pull an image over http. The database's CHECKs and the
// contracts' shapes read the spellings here.

/** A colour as `#RRGGBB`, six hex digits, as a regular expression's source. */
export const BRAND_COLOR_PATTERN = "^#[0-9a-fA-F]{6}$"

/** The text drawn on the brand colour. */
export const BRAND_TEXT_COLOR = "#ffffff"

/** WCAG 2.1 AA's least contrast for normal text (success criterion 1.4.3). */
export const AA_CONTRAST = 4.5

/** An address the project serves itself, as a regular expression's source: https, a host, and no whitespace. */
export const HTTPS_ADDRESS_PATTERN = "^https://[^\\s/?#]+[^\\s]*$"

/** The longest address taken: a browser's practical limit, far past any logo's or statement's. */
export const HTTPS_ADDRESS_MAX = 2048

/** Whether a text is a colour as `#RRGGBB`. */
export const isBrandColor = (text: string): boolean => new RegExp(BRAND_COLOR_PATTERN).test(text)

/** Whether a text is an https address a page may link or load. */
export const isHttpsAddress = (text: string): boolean => text.length <= HTTPS_ADDRESS_MAX && new RegExp(HTTPS_ADDRESS_PATTERN).test(text)

/** A channel's linear value (WCAG 2.1's relative luminance). */
function linear(channel: number): number {
  const value = channel / 255
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

/** A `#RRGGBB` colour's relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(color: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16))
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/** The contrast ratio of two `#RRGGBB` colours, 1 to 21, whichever is lighter. */
export function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a)
  return (lighter + 0.05) / (darker + 0.05)
}

/** Whether white text on the colour meets AA for normal text. */
export const brandColorReadable = (color: string): boolean => contrastRatio(color, BRAND_TEXT_COLOR) >= AA_CONTRAST

/** What a colour white text cannot be read on is told, with the ratio it has. */
export const brandColorRefusal = (color: string): string =>
  `White text on ${color} has a contrast of ${contrastRatio(color, BRAND_TEXT_COLOR).toFixed(2)} to 1; WCAG 2.1 AA needs ${AA_CONTRAST} to 1. Choose a darker colour`

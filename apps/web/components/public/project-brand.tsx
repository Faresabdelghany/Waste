// A published project's branding on its public pages (M22 of #293): the
// project's name at the top of each page, on its brand colour with its logo
// where it set them, and its accessibility statement linked at the foot where
// it set one. The colour is one the API refused unless white text on it meets
// WCAG 2.1 AA, so the name is white on it; on paper, black on white whatever
// the colour. The logo sits beside the name, so it is decorative (`alt=""`),
// and it is fetched with no referrer: the office's server is not told which
// page a resident read.
import type { PublishedProject } from "@waste/contracts/public"
import type { ReactNode } from "react"

import { PUBLIC_BRANDING_COPY as COPY } from "@/lib/public/branding-copy"
import { cn } from "@/lib/utils"

/** The project's name, branded; `children` follow it on the same line. */
export function ProjectMark({ project, children }: { project: PublishedProject; children?: ReactNode }) {
  const { brandColor, logoUrl } = project.branding
  return (
    <p
      data-testid="project-mark"
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium",
        brandColor === null ? "text-muted-foreground" : "rounded-md px-3 py-2 text-white print:bg-transparent! print:px-0 print:text-black",
      )}
      style={brandColor === null ? undefined : { backgroundColor: brandColor }}
    >
      {logoUrl !== null && (
        // An address the office chose on its own site, so not Next's optimised image.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt="" referrerPolicy="no-referrer" className="h-8 w-auto max-w-40 object-contain" />
      )}
      <span lang={project.language}>{project.name}</span>
      {children}
    </p>
  )
}

/** The foot of a published page: the project's accessibility statement, or nothing where it set none. In the widget, the link leaves the frame. */
export function ProjectFooter({ project, embed = false }: { project: PublishedProject; embed?: boolean }) {
  const statement = project.branding.accessibilityStatementUrl
  if (statement === null) return null
  return (
    <footer className={cn("border-t border-border pt-4 text-sm print:hidden", embed ? "mt-4" : "mt-12")}>
      <a href={statement} target={embed ? "_blank" : undefined} rel="noopener" className="text-muted-foreground underline underline-offset-4 hover:text-foreground">
        {COPY.accessibilityStatement}
      </a>
    </footer>
  )
}

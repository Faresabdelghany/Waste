import type { ReactNode } from "react"
import { Star, User, PencilSimpleLine } from "@phosphor-icons/react/dist/ssr"
import { ArrowsClockwise, Globe, Timer } from "@phosphor-icons/react/dist/ssr"

import type { ProjectDetails } from "@/lib/data/project-details"
import { Separator } from "@/components/ui/separator"
import { MetaChipsRow } from "@/components/projects/MetaChipsRow"
import { Badge } from "@/components/ui/badge"
import { PriorityBadge, type PriorityLevel } from "@/components/priority-badge"
import { Button } from "@/components/ui/button"
import { PageActions } from "@/components/page-layout"

type ProjectHeaderProps = {
  project: ProjectDetails
  onEditProject?: () => void
  /** The page's own actions, set beside the title rather than in the top bar. */
  actions?: ReactNode
}

export function ProjectHeader({ project, onEditProject, actions }: ProjectHeaderProps) {
  const metaItems = [
    { label: "ID", value: `#${project.id}`, icon: null },
    { label: "", value: <PriorityBadge level={project.meta.priorityLabel.toLowerCase() as PriorityLevel} appearance="inline" size="sm" />, icon: null },
    { label: "", value: project.meta.locationLabel, icon: <Globe className="h-4 w-4" /> },
    { label: "Schedule", value: project.meta.sprintLabel, icon: <Timer className="h-4 w-4" /> },
    { label: "Last sync", value: project.meta.lastSyncLabel, icon: <ArrowsClockwise className="h-4 w-4" /> },
  ]

  return (
    <section className="mt-4 space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold text-foreground leading-tight">{project.name}</h1>
          <div className="flex items-center gap-2">
            <Badge
              variant="secondary"
              className="bg-info/10 text-info-foreground border-none flex items-center gap-1"
            >
              <Star className="h-3 w-3" />
              Active
            </Badge>
            <Badge
              variant="outline"
              className="flex items-center gap-1 text-warning-foreground bg-warning/10 border-none"
            >
              <User className="h-3 w-3" />
              Assigned to me
            </Badge>
          </div>
        </div>

        <PageActions>
          {actions}
          {onEditProject && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Edit route"
              className="text-muted-foreground hover:text-foreground"
              onClick={onEditProject}
            >
              <PencilSimpleLine className="h-4 w-4" />
            </Button>
          )}
        </PageActions>
      </div>

      <div className="mt-3">
        <MetaChipsRow items={metaItems} />
      </div>

    </section>
  )
}

import Link from "next/link"
import { ArrowsLeftRight, ShieldCheck } from "@phosphor-icons/react/dist/ssr"

import {
  blueprintModuleCatalog,
  getPublicModuleDomain,
  type BlueprintModuleId,
  type PublicBusinessWorkspaceId,
} from "@/lib/data/business-domain"
import type { WorkspaceId } from "@/lib/data/business-modules"
import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"

const publicWorkspaceIds = new Set<WorkspaceId>([
  "operate",
  "plan",
  "route-studio",
  "fleet",
  "customers",
  "resources",
  "service-providers",
  "commercial",
  "improve",
  "control-center",
])

function CapabilityLinks({ moduleIds }: { moduleIds: BlueprintModuleId[] }) {
  return (
    <span className="text-sm text-muted-foreground">
      {moduleIds.map((moduleId, index) => {
        const capability = blueprintModuleCatalog[moduleId]
        return (
          <span key={moduleId}>
            {index > 0 && <span aria-hidden="true"> · </span>}
            <Link
              href={capability.primaryHref}
              className="underline-offset-4 hover:text-foreground hover:underline"
            >
              {moduleId} {capability.name}
            </Link>
          </span>
        )
      })}
    </span>
  )
}

export function ModuleAssignment({
  workspaceId,
  moduleId,
}: {
  workspaceId: WorkspaceId
  moduleId: string
}) {
  if (!publicWorkspaceIds.has(workspaceId) || workspaceId === "configure") return null

  const assignment = getPublicModuleDomain(
    workspaceId as PublicBusinessWorkspaceId,
    moduleId,
  )
  if (!assignment) return null

  const primaryCapability = blueprintModuleCatalog[assignment.primaryBlueprintModule]

  return (
    <AccordionItem value="module-assignment" className="border-b-0">
      <AccordionTrigger className="px-1 py-3 hover:no-underline">
        <span className="flex items-center gap-2 text-sm font-medium">
          <ArrowsLeftRight className="h-4 w-4 text-muted-foreground" />
          Business assignment
          <Badge variant="outline" className="rounded-full text-[10px] font-normal">
            {assignment.primaryBlueprintModule}
          </Badge>
        </span>
      </AccordionTrigger>
      <AccordionContent>
        <div className="divide-y divide-border/60 border-t border-border/60">
          <div className="grid gap-1 py-3 sm:grid-cols-[170px_minmax(0,1fr)]">
            <span className="text-xs font-medium text-foreground">Canonical owner</span>
            <span className="text-sm text-muted-foreground">
              {assignment.canonicalOwner}
            </span>
          </div>
          <div className="grid gap-1 py-3 sm:grid-cols-[170px_minmax(0,1fr)]">
            <span className="text-xs font-medium text-foreground">Primary capability</span>
            <CapabilityLinks moduleIds={[primaryCapability.id]} />
          </div>
          {assignment.supportingBlueprintModules.length > 0 && (
            <div className="grid gap-1 py-3 sm:grid-cols-[170px_minmax(0,1fr)]">
              <span className="text-xs font-medium text-foreground">Supporting capabilities</span>
              <CapabilityLinks moduleIds={[...assignment.supportingBlueprintModules]} />
            </div>
          )}
          <div className="grid gap-1 py-3 sm:grid-cols-[170px_minmax(0,1fr)]">
            <span className="text-xs font-medium text-foreground">Receives from</span>
            <CapabilityLinks moduleIds={[...assignment.upstream]} />
          </div>
          <div className="grid gap-1 py-3 sm:grid-cols-[170px_minmax(0,1fr)]">
            <span className="text-xs font-medium text-foreground">Feeds</span>
            <CapabilityLinks moduleIds={[...assignment.downstream]} />
          </div>
          <div className="grid gap-1 py-3 sm:grid-cols-[170px_minmax(0,1fr)]">
            <span className="text-xs font-medium text-foreground">Responsible roles</span>
            <span className="text-sm text-muted-foreground">
              {assignment.personas.join(" · ")}
            </span>
          </div>
          {assignment.boundaryNote && (
            <div className="flex items-start gap-3 py-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <p className="text-xs leading-5 text-muted-foreground">
                {assignment.boundaryNote}
              </p>
            </div>
          )}
        </div>
      </AccordionContent>
    </AccordionItem>
  )
}

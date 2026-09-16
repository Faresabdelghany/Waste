"use client"

// Route Scheme create flow for the Route Schemes module (spec FR-1/FR-2/FR-5/
// FR-14/FR-15, tickets #5/#6; collection groups: SPEC area L, D33–D36). "New
// route scheme" opens a chooser between Quick create (the schema-driven
// dialog, opened via onQuickCreate) and Guided Setup — the five-step wizard
// in components/wastehero/scheme-wizard (2026-09-16 redesign): scheme &
// scope, recurrence, collection groups, route map, review & create. Guided
// completion hands the collected draft to onGuidedCreate, which owns record
// creation and the Validated/Draft decision.

import { useState } from "react"
import { Plus } from "@phosphor-icons/react/dist/ssr"

import { Button } from "@/components/ui/button"
import { StepMode } from "@/components/project-wizard/steps/StepMode"
import type { ProjectMode } from "@/components/project-wizard/types"
import { SchemeWizard } from "@/components/wastehero/scheme-wizard/scheme-wizard"
import {
  resolvedDraftGroups,
  resolvedDraftPlans,
  validateGuidedScheme,
} from "@/lib/route-schemes/draft"
import type { GuidedSchemeData } from "@/lib/route-schemes/quick-create"

// The wizard's draft shape lives in lib/route-schemes/quick-create (issue
// #31) so Quick Create's value mapping can share it without pulling in UI
// code; the draft readers live in lib/route-schemes/draft. Both are
// re-exported here for the existing import sites.
export type { GuidedSchemeData }
export { resolvedDraftGroups, resolvedDraftPlans, validateGuidedScheme }

interface SchemeCreateEntryProps {
  submitLabel: string
  onQuickCreate: () => void
  onGuidedCreate: (data: GuidedSchemeData) => void
}

export function SchemeCreateEntry({
  submitLabel,
  onQuickCreate,
  onGuidedCreate,
}: SchemeCreateEntryProps) {
  const [isChooserOpen, setIsChooserOpen] = useState(false)
  const [isGuidedOpen, setIsGuidedOpen] = useState(false)

  return (
    <>
      <Button size="sm" onClick={() => setIsChooserOpen(true)}>
        <Plus className="h-4 w-4" weight="bold" />
        <span className="hidden sm:inline">{submitLabel}</span>
        <span className="sm:hidden">Action</span>
      </Button>

      {isChooserOpen && (
        <SchemeModeChooserOverlay
          onClose={() => setIsChooserOpen(false)}
          onQuick={() => {
            setIsChooserOpen(false)
            onQuickCreate()
          }}
          onGuided={() => {
            setIsChooserOpen(false)
            setIsGuidedOpen(true)
          }}
        />
      )}
      {isGuidedOpen && (
        <SchemeWizard
          open
          onOpenChange={(open) => {
            if (!open) setIsGuidedOpen(false)
          }}
          onCreate={(data) => {
            setIsGuidedOpen(false)
            onGuidedCreate(data)
          }}
        />
      )}
    </>
  )
}

function SchemeModeChooserOverlay({
  onClose,
  onQuick,
  onGuided,
}: {
  onClose: () => void
  onQuick: () => void
  onGuided: () => void
}) {
  const [mode, setMode] = useState<ProjectMode | undefined>()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="flex w-full max-w-[900px] overflow-hidden rounded-[24px] bg-background shadow-2xl">
        <StepMode
          selected={mode}
          onSelect={setMode}
          onCancel={onClose}
          onClose={onClose}
          entityLabel="route scheme"
          onContinue={() => {
            if (mode === "quick") onQuick()
            if (mode === "guided") onGuided()
          }}
        />
      </div>
    </div>
  )
}

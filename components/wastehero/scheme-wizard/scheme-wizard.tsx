"use client"

// Route Studio › Route Schemes › Create route scheme › Guided setup
// (2026-09-16 redesign). A large shadcn Dialog with a five-step rail; every
// step derives what it shows from one model (wizard-model.ts) built over the
// draft and the live records. Completion hands the draft to onCreate, which
// owns record creation.

import { useCallback, useMemo, useState } from "react"
import { Check, ChevronLeft, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import type { GuidedSchemeData } from "@/lib/route-schemes/quick-create"
import { cn } from "@/lib/utils"

import { ConflictDialog } from "./conflict-dialog"
import { StepGroups } from "./step-groups"
import { StepRecurrence } from "./step-recurrence"
import { StepScope } from "./step-scope"
import { useWizardRecords } from "./use-wizard-records"
import { buildWizardModel } from "./wizard-model"
import {
  WIZARD_STEPS,
  WIZARD_STEP_TITLES,
  initialSchemeDraft,
  type WizardStepId,
} from "./wizard-options"

type RailState = "active" | "done" | "visited" | "todo"

export function SchemeWizard({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (data: GuidedSchemeData) => void
}) {
  const [step, setStepRaw] = useState<WizardStepId>(1)
  const [maxStep, setMaxStep] = useState<WizardStepId>(1)
  const [data, setData] = useState<GuidedSchemeData>(initialSchemeDraft)
  const [conflictOpen, setConflictOpen] = useState(false)

  const records = useWizardRecords()
  const model = useMemo(() => buildWizardModel(data, records), [data, records])

  const update = useCallback((patch: Partial<GuidedSchemeData>) => {
    setData((current) => ({ ...current, ...patch }))
  }, [])

  const setStep = (target: WizardStepId) => {
    setStepRaw(target)
    setMaxStep((reached) => (target > reached ? target : reached))
  }

  const gates: Record<WizardStepId, boolean> = {
    1: model.step1Ok,
    2: model.step2Ok,
    3: model.step3Ok,
    4: true,
    5: true,
  }
  // A step is reachable from the rail once visited and only while every
  // earlier gate still passes.
  const reachable = (target: WizardStepId) =>
    target <= maxStep && WIZARD_STEPS.every((s) => s.id >= target || gates[s.id])
  const canNext = step === 3 ? true : gates[step]

  const next = () => {
    if (step === 5) return
    if (step === 3 && model.issues.length > 0) {
      setConflictOpen(true)
      return
    }
    setStep((step + 1) as WizardStepId)
  }
  const back = () => {
    if (step === 1) return
    setStep((step - 1) as WizardStepId)
  }

  const railState = (id: WizardStepId): RailState =>
    id === step ? "active" : id < step ? "done" : reachable(id) ? "visited" : "todo"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-5/6 w-full max-w-6xl gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-6xl">
        <aside className="hidden w-64 shrink-0 flex-col border-r border-border p-6 md:flex">
          <DialogTitle className="mb-6 text-base font-semibold">New route scheme</DialogTitle>
          <DialogDescription className="sr-only">Guided setup for a new route scheme</DialogDescription>
          <ol className="space-y-2">
            {WIZARD_STEPS.map((s) => {
              const state = railState(s.id)
              const summary = s.id < 5 ? model.summaries[s.id as 1 | 2 | 3 | 4] : ""
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    disabled={state === "todo"}
                    onClick={() => setStep(s.id)}
                    aria-current={state === "active" ? "step" : undefined}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors",
                      state === "active" && "bg-muted font-medium",
                      state === "todo" && "cursor-default text-muted-foreground/60",
                      (state === "done" || state === "visited") && "hover:bg-muted/60",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-px inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs",
                        state === "active" && "bg-primary text-primary-foreground",
                        state === "done" && "bg-emerald-50 text-emerald-600",
                        state === "visited" && "border border-foreground/40 text-foreground",
                        state === "todo" && "border border-border text-muted-foreground/60",
                      )}
                    >
                      {state === "done" ? <Check className="size-3.5" /> : s.id}
                    </span>
                    <span className="min-w-0">
                      <span className="block leading-6">{s.label}</span>
                      {state === "done" && summary ? (
                        <span className="block truncate text-xs font-normal text-muted-foreground">
                          {summary}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <header className="px-8 pb-4 pr-16 pt-7">
            <div className="mb-1 text-xs text-muted-foreground md:hidden">
              Step {step} of 5 · {WIZARD_STEPS[step - 1].label}
            </div>
            <h2 className="text-xl font-semibold tracking-tight">{WIZARD_STEP_TITLES[step]}</h2>
          </header>
          <div className="flex-1 overflow-y-auto px-8 pb-6">
            {step === 1 && <StepScope data={data} update={update} records={records} />}
            {step === 2 && <StepRecurrence data={data} update={update} model={model} />}
            {step === 3 && (
              <StepGroups data={data} update={update} model={model} records={records} />
            )}
          </div>
          <footer className="flex items-center justify-between gap-3 border-t border-border px-8 py-5">
            {step === 1 ? (
              <Button variant="outline" className="rounded-xl" onClick={() => onOpenChange(false)}>
                <ChevronLeft /> Cancel
              </Button>
            ) : (
              <Button variant="outline" className="rounded-xl" onClick={back}>
                <ChevronLeft /> Back
              </Button>
            )}
            {step < 5 ? (
              <Button className="rounded-xl" disabled={!canNext} onClick={next}>
                Next <ChevronRight />
              </Button>
            ) : (
              <Button className="rounded-xl" onClick={() => onCreate(data)}>
                Create route scheme <ChevronRight />
              </Button>
            )}
          </footer>
        </section>

        <ConflictDialog open={conflictOpen} onOpenChange={setConflictOpen} issues={model.issues} />
      </DialogContent>
    </Dialog>
  )
}

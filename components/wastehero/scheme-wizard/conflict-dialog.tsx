"use client"

// "N issues block route generation" — the blocking dialog Next opens on
// Step 3 while coverage, vehicle, or driver issues remain.

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

import type { WizardIssue } from "./wizard-model"

export function ConflictDialog({
  open,
  onOpenChange,
  issues,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  issues: readonly WizardIssue[]
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-2xl">
        <DialogHeader className="text-left">
          <DialogTitle>
            {issues.length} issue{issues.length === 1 ? "" : "s"} block route generation
          </DialogTitle>
          <DialogDescription className="sr-only">
            Resolve the listed issues before continuing
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-amber-800">
          {issues.map((issue) => (
            <li key={issue.text}>{issue.text}</li>
          ))}
        </ul>
        <DialogFooter>
          <Button className="rounded-xl" onClick={() => onOpenChange(false)}>
            Review groups
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

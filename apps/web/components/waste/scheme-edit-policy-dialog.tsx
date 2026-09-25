"use client"

// "How should this change apply?" — the question a scheme under "Ask each
// time" puts to the person when an edit shapes a collection and future
// routes can still follow it (issue #38). The edit-save planner answers
// `outcome: "ask"` with the question and no writes; this dialog shows the
// two choices and the save runs again with the answer. Cancel returns to
// the edit, nothing saved.

import { useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { cn } from "@/lib/utils"
import type { SchemeEditApplication, SchemeEditQuestion } from "@waste/domain/route-schemes/edit"
import { formatServiceDate } from "@waste/domain/route-schemes/recurrence"
import { count } from "@waste/domain/text"

const CHOICES: readonly SchemeEditApplication[] = ["future", "single"]

export function SchemeEditPolicyDialog({
  schemeName,
  question,
  onClose,
  onChoose,
}: {
  /** The edited scheme's name; null closes the dialog. */
  schemeName: string | null
  question: SchemeEditQuestion | null
  onClose: () => void
  onChoose: (apply: SchemeEditApplication) => void
}) {
  const [choice, setChoice] = useState<SchemeEditApplication>("future")
  const open = schemeName !== null && question !== null

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {open && (
          <>
            <DialogHeader className="text-left">
              <DialogTitle>How should this change apply?</DialogTitle>
              <DialogDescription>
                {schemeName} is running: {count(question.futureRoutes, "future route")}{" "}
                {question.futureRoutes === 1 ? "is" : "are"} planned and can still follow this edit
                {question.nextCollectionDate
                  ? `; the next collection is ${formatServiceDate(question.nextCollectionDate)}.`
                  : "."}
              </DialogDescription>
            </DialogHeader>
            <RadioGroup
              value={choice}
              onValueChange={(value) => setChoice(value as SchemeEditApplication)}
              className="gap-3 py-2"
            >
              {CHOICES.map((value) => {
                const option = question.options[value]
                const id = `scheme-edit-apply-${value}`
                return (
                  <Label
                    key={value}
                    htmlFor={id}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-xl border border-border p-4 font-normal",
                      choice === value && "border-primary bg-primary/5",
                    )}
                  >
                    <RadioGroupItem value={value} id={id} className="mt-0.5" />
                    <span className="space-y-1">
                      <span className="block text-sm font-medium">{option.label}</span>
                      <span className="block text-xs leading-5 text-muted-foreground">
                        {option.description}
                      </span>
                    </span>
                  </Label>
                )
              })}
            </RadioGroup>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Back to the edit
              </Button>
              <Button onClick={() => onChoose(choice)}>Save changes</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

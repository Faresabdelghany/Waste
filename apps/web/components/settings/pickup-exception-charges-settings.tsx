"use client"

// Settings › Commercial › Exception charges (M5 of #293): one project's
// charge rules for Pickup Exceptions at a time — the outcome, reason and code
// a rule governs, how many in its window are free, and the products its
// ladder charges once they are spent — read from and written to the API's
// `/pickup-exception-rules` under the price rows' grants. The products a
// ladder names and the codes a rule narrows to are read beside them, each
// under its own grant; a role without one sees the id. A rule is never
// deleted: it ends on its last day in force, and another starts after it.
// The form and the bodies it becomes are lib/data/pickup-exception-rules.ts'.
// Offered on the Pilot alone.

import { useState, type FormEvent } from "react"
import { PencilSimple, Plus, Trash } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import type { Product } from "@waste/contracts/catalogue"
import type { ContaminantCode, PickupExceptionRule } from "@waste/contracts/pickup-exceptions"
import { useReport } from "@/components/insight/use-report"
import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/asset-management-settings"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useApiClient, useApiSession } from "@/components/waste/api-session-store"
import { create, listAll, patch } from "@/lib/api/client"
import { problemSentence } from "@/lib/api/problem"
import { dayIn, lastDayIn } from "@/lib/api/records/planning"
import { problemOfError } from "@/lib/api/records/server-records"
import {
  allowanceSentence,
  ANY,
  codeOffered,
  isRuleRefusal,
  LADDER_MAX,
  ladderProductOptions,
  ladderSentence,
  newRuleForm,
  RULE_OUTCOME_OPTIONS,
  RULE_REASON_OPTIONS,
  ruleAccessOf,
  ruleCodeOptions,
  ruleCreateBodyOf,
  ruleFormOf,
  ruleMatchSentence,
  rulePatchBodyOf,
  rulesInOrder,
  withPick,
  type RuleForm,
  type RuleRefusal,
} from "@/lib/data/pickup-exception-rules"

type Read = { rules: PickupExceptionRule[]; products: Product[]; codes: ContaminantCode[] }

/** The dialog open on a new rule or on one of the project's, with the form as edited. */
type Editing = { rule: PickupExceptionRule | null; form: RuleForm }

export function PickupExceptionChargesSettings() {
  const client = useApiClient()
  const { me } = useApiSession()
  const projects = me?.projects ?? []
  const access = ruleAccessOf(me?.role.grants)
  const [chosenProjectId, setChosenProjectId] = useState<string | null>(null)
  const project = projects.find((candidate) => candidate.id === chosenProjectId) ?? projects[0] ?? null
  // Bumped by a save, so the rules are read again as the API now holds them.
  const [version, setVersion] = useState(0)

  const read = useReport<Read>(project === null || !access.view ? null : `exception-charges:${project.id}:${version}`, async (asking) => {
    const projectId = project?.id ?? ""
    const [rules, products, codes] = await Promise.all([
      listAll<PickupExceptionRule>(asking, "/pickup-exception-rules", { projectId }),
      access.products ? listAll<Product>(asking, "/products", { projectId }) : Promise.resolve([]),
      access.codes ? listAll<ContaminantCode>(asking, "/contaminant-codes") : Promise.resolve([]),
    ])
    return { rules, products, codes }
  })
  const shown = read.shown
  const rules = shown === null ? [] : rulesInOrder(shown.rules)
  const productName = (id: string) => shown?.products.find((candidate) => candidate.id === id)?.name ?? id
  const codeName = (id: string) => shown?.codes.find((candidate) => candidate.id === id)?.name ?? id

  const [editing, setEditing] = useState<Editing | null>(null)
  const [refusal, setRefusal] = useState<RuleRefusal | null>(null)
  const [saving, setSaving] = useState(false)

  const open = (rule: PickupExceptionRule | null) => {
    setRefusal(null)
    setEditing({ rule, form: rule === null ? newRuleForm(dayIn(new Date(), undefined)) : ruleFormOf(rule) })
  }
  const change = (values: Partial<RuleForm>) => {
    if (editing === null) return
    setEditing({ ...editing, form: withPick(editing.form, values) })
    setRefusal(null)
  }
  const changeStep = (index: number, id: string) => editing !== null && change({ ladder: editing.form.ladder.map((step, at) => (at === index ? id : step)) })

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (client === null || project === null || editing === null) return
    const { rule, form } = editing
    const body = rule === null ? ruleCreateBodyOf(project.id, form) : rulePatchBodyOf(rule, form)
    if (body === null) {
      setEditing(null)
      return
    }
    if (isRuleRefusal(body)) {
      setRefusal(body)
      return
    }
    setSaving(true)
    const writing = rule === null ? create<PickupExceptionRule>(client, "/pickup-exception-rules", body).then((answer) => answer.body) : patch<PickupExceptionRule>(client, `/pickup-exception-rules/${rule.id}`, body)
    writing
      .then(
        (written) => {
          setEditing(null)
          setVersion((current) => current + 1)
          toast.success(rule === null ? "Rule added" : "Rule saved", { description: `${ruleMatchSentence(written, codeName)}: ${ladderSentence(written.ladder, productName)}.` })
        },
        (error: unknown) => toast.error(rule === null ? "The rule was not added" : "The rule was not saved", { description: problemSentence(problemOfError(error)) }),
      )
      .finally(() => setSaving(false))
  }

  const emptyMessage = !access.view
    ? "The exception charges are not shown to your role."
    : project === null
      ? "No project to charge exceptions in."
      : read.problem !== null
        ? `The rules could not be read from the API: ${problemSentence(read.problem)}`
        : shown === null
          ? "Reading the rules from the API…"
          : `${project.name} charges no exceptions: a missed or tagged collection costs the customer nothing.`

  return (
    <AssetPanelShell
      heading="Commercial"
      title="Exception charges"
      description="What a collection missed for the customer, or collected tagged with a contaminant code, costs them: how many are free over a window, then the products charged by occurrence."
      action={
        <Button size="sm" disabled={!access.create || project === null || shown === null} onClick={() => open(null)}>
          <Plus className="h-4 w-4" weight="bold" />
          Add rule
        </Button>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="exception-charges-project" className="text-sm text-muted-foreground">
            Project
          </Label>
          <Select value={project?.id ?? ""} onValueChange={setChosenProjectId} disabled={projects.length === 0}>
            <SelectTrigger id="exception-charges-project" className="w-64">
              <SelectValue placeholder="Pick a project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      }
    >
      <p className="border-b border-border px-4 py-3 text-sm text-muted-foreground">
        Each exception is counted against the earlier chargeable ones at the same property or shared point over the rule&apos;s window. The free ones cost nothing; after them each is charged the ladder&apos;s next product, the last repeating.
      </p>
      <RecordsSection shown={rules.length} total={rules.length}>
        <div className="overflow-x-auto">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Matches</TableHead>
                <TableHead>Free</TableHead>
                <TableHead>Charges</TableHead>
                <TableHead>In force</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.length === 0 ? (
                <EmptyRow colSpan={5} message={emptyMessage} hint={access.create && shown !== null ? "Add a rule for each exception your tariff charges." : ""} />
              ) : (
                rules.map((rule) => (
                  <TableRow key={rule.id} aria-label={ruleMatchSentence(rule, codeName)}>
                    <TableCell className="font-medium">{ruleMatchSentence(rule, codeName)}</TableCell>
                    <TableCell className="text-muted-foreground">{allowanceSentence(rule)}</TableCell>
                    <TableCell>{ladderSentence(rule.ladder, productName)}</TableCell>
                    <TableCell className="text-muted-foreground">{rule.validTo === null ? `From ${rule.validFrom}` : `${rule.validFrom} to ${lastDayIn(rule.validTo)}`}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${ruleMatchSentence(rule, codeName)}`} disabled={!access.edit} onClick={() => open(rule)}>
                        <PencilSimple className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </RecordsSection>

      <Dialog open={editing !== null} onOpenChange={(next) => !next && !saving && setEditing(null)}>
        <DialogContent className="sm:max-w-xl">
          {editing !== null && shown !== null && project !== null && (
            <RuleDialogForm
              editing={editing}
              refusal={refusal}
              saving={saving}
              products={ladderProductOptions(shown.products, project.id, editing.rule?.ladder ?? [])}
              codes={ruleCodeOptions(shown.codes, editing.rule?.contaminantCodeId ?? null)}
              productName={productName}
              onChange={change}
              onStep={changeStep}
              onCancel={() => setEditing(null)}
              onSubmit={save}
            />
          )}
        </DialogContent>
      </Dialog>
    </AssetPanelShell>
  )
}

function RuleDialogForm({
  editing,
  refusal,
  saving,
  products,
  codes,
  productName,
  onChange,
  onStep,
  onCancel,
  onSubmit,
}: {
  editing: Editing
  refusal: RuleRefusal | null
  saving: boolean
  products: readonly Product[]
  codes: readonly ContaminantCode[]
  productName: (id: string) => string
  onChange: (values: Partial<RuleForm>) => void
  onStep: (index: number, id: string) => void
  onCancel: () => void
  onSubmit: (event: FormEvent) => void
}) {
  const { rule, form } = editing
  // The outcome, reason, code and start are the rule's key: an edit moves the rest.
  const keyed = rule !== null
  const message = (field: keyof RuleForm) => (refusal?.field === field ? <p className="text-xs text-destructive">{refusal.message}</p> : null)
  // A step whose product is not among the options (a role that reads no products) still shows by its id.
  const stepOptions = (id: string) => (id === "" || products.some((candidate) => candidate.id === id) ? products : [...products, { id, name: productName(id) } as Product])

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{keyed ? "Edit rule" : "Add rule"}</DialogTitle>
        <DialogDescription>
          {keyed
            ? "Move the free count, the window, the ladder or the end. What the rule matches and its start are its own: end it and add another to change them."
            : "What the rule matches, how many are free over its window, and what each one after them is charged."}
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="rule-outcome">Outcome</Label>
          <Select value={form.outcome} onValueChange={(outcome) => onChange({ outcome })} disabled={keyed}>
            <SelectTrigger id="rule-outcome">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RULE_OUTCOME_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rule-reason">Reason</Label>
          <Select value={form.reason} onValueChange={(reason) => onChange({ reason })} disabled={keyed || form.outcome === "completed"}>
            <SelectTrigger id="rule-reason" aria-invalid={refusal?.field === "reason"}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RULE_REASON_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {message("reason")}
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="rule-code">Contaminant code</Label>
          <Select value={form.contaminantCodeId} onValueChange={(contaminantCodeId) => onChange({ contaminantCodeId })} disabled={keyed || !codeOffered(form)}>
            <SelectTrigger id="rule-code">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{form.outcome === "completed" ? "Any code" : "Any code, or none"}</SelectItem>
              {codes.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rule-free">Free in the window</Label>
          <Input id="rule-free" inputMode="numeric" value={form.freeCount} aria-invalid={refusal?.field === "freeCount"} onChange={(event) => onChange({ freeCount: event.target.value })} />
          {message("freeCount")}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rule-window">Window (days)</Label>
          <Input id="rule-window" inputMode="numeric" value={form.windowDays} aria-invalid={refusal?.field === "windowDays"} onChange={(event) => onChange({ windowDays: event.target.value })} />
          {message("windowDays")}
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Charges, by occurrence after the free ones</legend>
        {form.ladder.map((step, index) => (
          <div key={index} className="flex items-center gap-2">
            <span className="w-28 shrink-0 text-sm text-muted-foreground">{index === form.ladder.length - 1 ? (index === 0 ? "Each" : "Then each") : `${index + 1}${["st", "nd", "rd"][index] ?? "th"}`}</span>
            <Select value={step} onValueChange={(id) => onStep(index, id)}>
              <SelectTrigger aria-label={`Step ${index + 1}`} aria-invalid={refusal?.field === "ladder" && (refusal.step === undefined || refusal.step === index)}>
                <SelectValue placeholder="Pick a product" />
              </SelectTrigger>
              <SelectContent>
                {stepOptions(step).map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label={`Remove step ${index + 1}`} disabled={form.ladder.length === 1} onClick={() => onChange({ ladder: form.ladder.filter((_, at) => at !== index) })}>
              <Trash className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" disabled={form.ladder.length >= LADDER_MAX} onClick={() => onChange({ ladder: [...form.ladder, ""] })}>
          <Plus className="h-4 w-4" weight="bold" />
          Add step
        </Button>
        {products.length === 0 && <p className="text-xs text-muted-foreground">No product to charge: a step charges one of the project&apos;s active additional services sold per job.</p>}
        {message("ladder")}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="rule-from">First day in force</Label>
          <Input id="rule-from" type="date" value={form.validFrom} disabled={keyed} aria-invalid={refusal?.field === "validFrom"} onChange={(event) => onChange({ validFrom: event.target.value })} />
          {message("validFrom")}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rule-last-day">Last day in force</Label>
          <Input id="rule-last-day" type="date" value={form.lastDay} aria-invalid={refusal?.field === "lastDay"} onChange={(event) => onChange({ lastDay: event.target.value })} />
          {message("lastDay")}
        </div>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {keyed ? "Save rule" : "Add rule"}
        </Button>
      </DialogFooter>
    </form>
  )
}

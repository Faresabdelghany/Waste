"use client"

// Settings › Commercial › Recycling-centre charges (#393, M4 of #293): one
// project's Visit Rules at a time — a household's free visits a year and the
// ladder of per-visit products after them, the last step repeating; the free
// fractions whose visits are neither counted nor charged; a business's
// per-visit product and the annual-access product whose subscription
// includes its visits; and the threshold that flags a Property as a likely
// trade — read from and written to the API's `/visit-rules` under the
// products' grants. One rule is in force at a time: a rule ends on its last
// day in force, and another starts after it. The products and the fractions
// it names are read beside it, each under its own grant; a role without one
// sees the id. The form and the bodies it becomes are lib/data/site-visits.ts'.
// Offered on the Pilot alone.

import type { FormEvent } from "react"
import { ArrowDown, ArrowUp, PencilSimple, Plus, Trash } from "@phosphor-icons/react/dist/ssr"

import type { Product, WasteFraction } from "@waste/contracts/catalogue"
import type { VisitRule } from "@waste/contracts/visit-rules"
import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/asset-management-settings"
import { ProjectPicker, useProjectSetting } from "@/components/settings/use-project-setting"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useApiSession } from "@/components/waste/api-session-store"
import { create, listAll, patch } from "@/lib/api/client"
import { problemSentence } from "@/lib/api/problem"
import { dayIn } from "@/lib/api/records/clock"
import { periodSentence } from "@/lib/data/bulky"
import {
  ANNUAL_ACCESS_UNIT,
  householdSentence,
  isVisitRuleRefusal,
  newVisitRuleForm,
  NO_PRODUCT,
  rulesInOrder,
  tradeSentence,
  VISIT_UNIT,
  visitRuleAccessOf,
  visitRuleCreateBodyOf,
  visitRuleFormOf,
  visitRulePatchBodyOf,
  type VisitRuleForm,
  type VisitRuleRefusal,
} from "@/lib/data/site-visits"

type Read = { rules: VisitRule[]; products: Product[]; fractions: WasteFraction[] }

/** The dialog open on a new rule or on one of the project's, with the form as edited. */
type Editing = { rule: VisitRule | null; form: VisitRuleForm }

export function VisitRulesSettings() {
  const { me } = useApiSession()
  const access = visitRuleAccessOf(me?.role.grants)
  const setting = useProjectSetting<Read, Editing, VisitRuleRefusal>({
    name: "visit-rules",
    readable: access.view,
    read: async (asking, projectId) => {
      const [rules, products, fractions] = await Promise.all([
        listAll<VisitRule>(asking, "/visit-rules", { projectId }),
        listAll<Product>(asking, "/products", { projectId }),
        access.fractions ? listAll<WasteFraction>(asking, "/waste-fractions") : Promise.resolve([]),
      ])
      return { rules, products, fractions }
    },
  })
  const { project, shown, draft: editing, refusal, saving } = setting
  const productName = (id: string) => shown?.products.find((candidate) => candidate.id === id)?.name ?? id
  const fractionName = (id: string) => shown?.fractions.find((candidate) => candidate.id === id)?.name ?? id
  const rules = shown === null ? [] : rulesInOrder(shown.rules)

  const open = (rule: VisitRule | null) => setting.edit({ rule, form: rule === null ? newVisitRuleForm(dayIn(new Date(), undefined)) : visitRuleFormOf(rule) })
  const change = (values: Partial<VisitRuleForm>) => editing !== null && setting.edit({ ...editing, form: { ...editing.form, ...values } })

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (project === null || editing === null) return
    const { rule, form } = editing
    const body = rule === null ? visitRuleCreateBodyOf(project.id, form) : visitRulePatchBodyOf(rule, form)
    if (body === null) return setting.discard()
    if (isVisitRuleRefusal(body)) return setting.refuse(body)
    setting.save(
      (client) => (rule === null ? create<VisitRule>(client, "/visit-rules", body).then((answer) => answer.body) : patch<VisitRule>(client, `/visit-rules/${rule.id}`, body)),
      {
        saved: (written) => ({ title: rule === null ? "Visit Rule added" : "Visit Rule saved", description: `${project.name}: ${periodSentence(written)}.` }),
        failed: rule === null ? "The Visit Rule was not added" : "The Visit Rule was not saved",
      },
    )
  }

  const emptyMessage = !access.view
    ? "The Visit Rules are not shown to your role."
    : project === null
      ? "No project to charge recycling-centre visits in."
      : setting.problem !== null
        ? `The Visit Rules could not be read from the API: ${problemSentence(setting.problem)}`
        : shown === null
          ? "Reading the Visit Rules from the API…"
          : `${project.name} has no Visit Rule: its visits are logged and charged nothing.`

  // The products a rule may charge: the project's active ones sold in the unit asked, and any it charges now whatever they are.
  const productOptions = (unit: string, kept: readonly string[]) => (shown?.products ?? []).filter((candidate) => (candidate.unit === unit && candidate.status === "active") || kept.includes(candidate.id))

  return (
    <AssetPanelShell
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <ProjectPicker id="visit-rules-project" setting={setting} />
        </div>
      }
    >
      <RecordsSection
        shown={rules.length}
        total={rules.length}
        actions={
          <Button size="sm" disabled={!access.create || project === null || shown === null} onClick={() => open(null)}>
            <Plus className="h-4 w-4" weight="bold" />
            Add rule
          </Button>
        }
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>In force</TableHead>
                <TableHead>A household&apos;s year</TableHead>
                <TableHead>Free fractions</TableHead>
                <TableHead>A business&apos;s visit</TableHead>
                <TableHead>Likely trade</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.length === 0 ? (
                <EmptyRow colSpan={6} message={emptyMessage} hint={access.create && shown !== null ? "Add a rule to charge the project's visits." : ""} />
              ) : (
                rules.map((rule) => (
                  <TableRow key={rule.id} aria-label={`Visit Rule ${periodSentence(rule)}`}>
                    <TableCell className="font-medium">{periodSentence(rule)}</TableCell>
                    <TableCell>{householdSentence(rule, productName)}</TableCell>
                    <TableCell className="text-muted-foreground">{rule.freeFractionIds.length === 0 ? "None" : rule.freeFractionIds.map(fractionName).join(", ")}</TableCell>
                    <TableCell>
                      {rule.businessVisitProductId === null ? "Charged nothing" : productName(rule.businessVisitProductId)}
                      {rule.annualAccessProductId !== null && <span className="block text-xs text-muted-foreground">Included with {productName(rule.annualAccessProductId)}</span>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{tradeSentence(rule)}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit Visit Rule ${periodSentence(rule)}`} disabled={!access.edit} onClick={() => open(rule)}>
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

      <Dialog open={editing !== null} onOpenChange={(next) => !next && !saving && setting.discard()}>
        {/* An edit says why the start does not move; an add says nothing. */}
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" {...(editing === null || editing.rule === null ? { "aria-describedby": undefined } : {})}>
          {editing !== null && shown !== null && (
            <VisitRuleDialogForm
              editing={editing}
              refusal={refusal}
              saving={saving}
              visitProducts={productOptions(VISIT_UNIT, [...editing.form.ladder, editing.form.businessVisitProductId])}
              accessProducts={productOptions(ANNUAL_ACCESS_UNIT, [editing.form.annualAccessProductId])}
              fractions={shown.fractions}
              fractionsRead={access.fractions}
              onChange={change}
              onCancel={setting.discard}
              onSubmit={save}
            />
          )}
        </DialogContent>
      </Dialog>
    </AssetPanelShell>
  )
}

function ProductSelect({ id, value, products, none, invalid, onChange, label }: { id: string; value: string; products: readonly Product[]; none?: string; invalid?: boolean; onChange: (value: string) => void; label?: string }) {
  return (
    <Select value={value === "" ? undefined : value} onValueChange={onChange}>
      <SelectTrigger id={id} aria-label={label} aria-invalid={invalid}>
        <SelectValue placeholder="Pick a product" />
      </SelectTrigger>
      <SelectContent>
        {none !== undefined && <SelectItem value={NO_PRODUCT}>{none}</SelectItem>}
        {products.map((candidate) => (
          <SelectItem key={candidate.id} value={candidate.id}>
            {candidate.status === "active" ? candidate.name : `${candidate.name} · ${candidate.status}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function VisitRuleDialogForm({
  editing,
  refusal,
  saving,
  visitProducts,
  accessProducts,
  fractions,
  fractionsRead,
  onChange,
  onCancel,
  onSubmit,
}: {
  editing: Editing
  refusal: VisitRuleRefusal | null
  saving: boolean
  visitProducts: readonly Product[]
  accessProducts: readonly Product[]
  fractions: readonly WasteFraction[]
  fractionsRead: boolean
  onChange: (values: Partial<VisitRuleForm>) => void
  onCancel: () => void
  onSubmit: (event: FormEvent) => void
}) {
  const { rule, form } = editing
  // The start is the rule's own: an edit moves everything else, the ladder and the free fractions whole.
  const keyed = rule !== null
  const message = (field: keyof VisitRuleForm) => (refusal?.field === field ? <p className="text-xs text-destructive">{refusal.message}</p> : null)
  const setStep = (at: number, productId: string) => onChange({ ladder: form.ladder.map((step, index) => (index === at ? productId : step)) })
  const moveStep = (at: number, by: -1 | 1) => {
    const ladder = [...form.ladder]
    const [step] = ladder.splice(at, 1)
    ladder.splice(at + by, 0, step)
    onChange({ ladder })
  }
  const toggleFraction = (id: string, on: boolean) => onChange({ freeFractionIds: on ? [...form.freeFractionIds, id] : form.freeFractionIds.filter((candidate) => candidate !== id) })

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <DialogHeader>
        <DialogTitle>{keyed ? "Edit Visit Rule" : "Add Visit Rule"}</DialogTitle>
        {keyed && <DialogDescription>The start is the rule&apos;s own: end it and add another to change it.</DialogDescription>}
      </DialogHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="visit-rule-from">First day in force</Label>
          <Input id="visit-rule-from" type="date" value={form.validFrom} disabled={keyed} aria-invalid={refusal?.field === "validFrom"} onChange={(event) => onChange({ validFrom: event.target.value })} />
          {message("validFrom")}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="visit-rule-last-day">Last day in force</Label>
          <Input id="visit-rule-last-day" type="date" value={form.lastDay} aria-invalid={refusal?.field === "lastDay"} onChange={(event) => onChange({ lastDay: event.target.value })} />
          {message("lastDay")}
        </div>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">A household&apos;s year</legend>
        <div className="space-y-1.5 sm:w-1/2">
          <Label htmlFor="visit-rule-free">Free visits a year</Label>
          <Input id="visit-rule-free" inputMode="numeric" value={form.freeVisits} aria-invalid={refusal?.field === "freeVisits"} onChange={(event) => onChange({ freeVisits: event.target.value })} />
          {message("freeVisits")}
        </div>
        <div className="space-y-2">
          <p className="text-sm">Then each visit after them, the last step repeating</p>
          {form.ladder.length === 0 && <p className="text-xs text-muted-foreground">No step: every visit after the free ones is included.</p>}
          {form.ladder.map((step, at) => (
            <div key={at} className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-sm text-muted-foreground">Step {at + 1}</span>
              <div className="flex-1">
                <ProductSelect id={`visit-rule-step-${at}`} label={`Step ${at + 1}`} value={step} products={visitProducts} invalid={refusal?.field === "ladder"} onChange={(productId) => setStep(at, productId)} />
              </div>
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={`Move step ${at + 1} up`} disabled={at === 0} onClick={() => moveStep(at, -1)}>
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={`Move step ${at + 1} down`} disabled={at === form.ladder.length - 1} onClick={() => moveStep(at, 1)}>
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={`Remove step ${at + 1}`} onClick={() => onChange({ ladder: form.ladder.filter((_, index) => index !== at) })}>
                <Trash className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" disabled={form.ladder.length >= 10} onClick={() => onChange({ ladder: [...form.ladder, ""] })}>
            <Plus className="h-4 w-4" weight="bold" />
            Add step
          </Button>
          {visitProducts.length === 0 && <p className="text-xs text-muted-foreground">No product to charge a visit at: a step is one of the project&apos;s active products sold per visit, made in Settings › Commercial › Products.</p>}
          {message("ladder")}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Free fractions</legend>
        {!fractionsRead ? (
          <p className="text-xs text-muted-foreground">The waste fractions are not shown to your role; the rule keeps the {form.freeFractionIds.length} it names.</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {fractions.map((fraction) => (
              <label key={fraction.id} className="flex items-center gap-1.5 text-sm">
                <Checkbox checked={form.freeFractionIds.includes(fraction.id)} onCheckedChange={(checked) => toggleFraction(fraction.id, checked === true)} aria-label={fraction.name} />
                {fraction.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">A business&apos;s visit</legend>
        <div className="space-y-1.5">
          <Label htmlFor="visit-rule-business">Charged at</Label>
          <ProductSelect id="visit-rule-business" value={form.businessVisitProductId} products={visitProducts} none="Nothing" onChange={(businessVisitProductId) => onChange({ businessVisitProductId })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="visit-rule-annual">Included with annual access</Label>
          <ProductSelect id="visit-rule-annual" value={form.annualAccessProductId} products={accessProducts} none="No annual access" onChange={(annualAccessProductId) => onChange({ annualAccessProductId })} />
        </div>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Likely trade</legend>
        <div className="space-y-1.5">
          <Label htmlFor="visit-rule-threshold">Counted visits</Label>
          <Input id="visit-rule-threshold" inputMode="numeric" placeholder="Not flagged" value={form.tradeThreshold} aria-invalid={refusal?.field === "tradeThreshold"} onChange={(event) => onChange({ tradeThreshold: event.target.value })} />
          {message("tradeThreshold")}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="visit-rule-window">In a window of days</Label>
          <Input id="visit-rule-window" inputMode="numeric" value={form.tradeWindowDays} aria-invalid={refusal?.field === "tradeWindowDays"} onChange={(event) => onChange({ tradeWindowDays: event.target.value })} />
          {message("tradeWindowDays")}
        </div>
      </fieldset>

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

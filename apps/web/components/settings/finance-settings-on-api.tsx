"use client"

// Settings › Administration › Finance & invoicing on the Pilot (#291 C4): the
// company's invoice identity — the VAT number, the bank account and the FIK
// creditor number an invoice document prints, and its postal address (#291
// C5), the seller's address a Danish invoice must print — and each project's payment
// terms and reference scheme. Both are rows of `configure.organization`
// (lib/api/records/organisation.ts), written through the store; what is typed
// is judged by the domain's shapes (lib/data/finance-settings.ts) before the
// API is asked. A customer's own terms are its form's, under Customers.
// Fixture mode keeps the browser's Finance pane (`configure.finance`).

import { useState } from "react"
import { PencilSimple } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/asset-management-settings"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { useBusinessRecordStore, useModuleRecords, whenSaved } from "@/components/waste/business-record-store"
import { isCompanyRecord } from "@/lib/api/records/organisation"
import { getModuleDefinition, type BusinessRecord } from "@/lib/data/business-modules"
import {
  COMPANY_IDENTITY_FIELDS,
  identityRefusalOf,
  identityValueOf,
  paymentReferenceSchemeLabel,
  paymentTermsRefusalOf,
  type CompanyIdentityKey,
} from "@/lib/data/finance-settings"
import { PAYMENT_REFERENCE_SCHEMES, type PaymentReferenceScheme } from "@waste/domain/finance/vocabulary"
import { isSoftDeleted } from "@waste/domain/record-visibility"

const ORGANISATION_FIXTURES = getModuleDefinition({ workspaceId: "configure", moduleId: "organization" })?.records ?? []

const typedOf = (record: BusinessRecord, key: string): string => {
  const value = record.submittedValues?.[key]
  return typeof value === "string" ? value : ""
}

export function FinanceSettingsOnApi() {
  const organisation = useModuleRecords("configure", "organization", ORGANISATION_FIXTURES)
  const company = organisation.records.find(isCompanyRecord) ?? null
  const projects = organisation.records.filter((record) => !isSoftDeleted(record) && record.id.startsWith("project-")).sort((a, b) => a.name.localeCompare(b.name))
  const [editing, setEditing] = useState<BusinessRecord | null>(null)

  const emptyMessage = organisation.pending
    ? "Reading the projects from the API…"
    : organisation.notGranted
      ? "The projects are not shown to your role."
      : organisation.problem
        ? `The projects could not be read from the API: ${organisation.problem.detail ?? organisation.problem.title}`
        : "No projects yet."
  const hasCreditor = company !== null && typedOf(company, "fikCreditorNumber") !== ""

  return (
    <AssetPanelShell
      heading="Administration"
      title="Finance & invoicing"
      description="What the company's invoices print, and when each project's invoices are due and the payment reference they carry."
      toolbar={null}
    >
      {/* Keyed by what was read: a re-read the store answers starts the form from it. */}
      {company !== null && organisation.ready && <CompanyIdentity key={[...COMPANY_IDENTITY_FIELDS.map((field) => typedOf(company, field.key)), typedOf(company, "postalAddress")].join("|")} company={company} />}
      <RecordsSection shown={projects.length} total={projects.length}>
        <div className="overflow-x-auto">
          <Table className="min-w-[640px]">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Project</TableHead>
                <TableHead>Payment terms</TableHead>
                <TableHead>Payment reference</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {!organisation.ready || projects.length === 0 ? (
                <EmptyRow colSpan={4} message={emptyMessage} hint={organisation.notGranted ? organisation.problem?.detail : ""} />
              ) : (
                projects.map((project) => (
                  <TableRow key={project.id}>
                    <TableCell className="text-sm font-medium text-foreground">{project.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{project.facts["Payment terms"]}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{project.facts["Payment reference"]}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${project.name}'s terms`} onClick={() => setEditing(project)}>
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
      {editing !== null && <ProjectTermsDialog project={editing} hasCreditor={hasCreditor} onClose={() => setEditing(null)} />}
    </AssetPanelShell>
  )
}

/** The company's invoice identity, saved whole; a field left blank is none. */
function CompanyIdentity({ company }: { company: BusinessRecord }) {
  const { upsertRecord } = useBusinessRecordStore()
  const [values, setValues] = useState<Record<CompanyIdentityKey, string>>(() => Object.fromEntries(COMPANY_IDENTITY_FIELDS.map((field) => [field.key, typedOf(company, field.key)])) as Record<CompanyIdentityKey, string>)
  const [postalAddress, setPostalAddress] = useState(() => typedOf(company, "postalAddress"))
  const [saving, setSaving] = useState(false)
  const refusals = Object.fromEntries(COMPANY_IDENTITY_FIELDS.map((field) => [field.key, identityRefusalOf(field.key, values[field.key])]))
  const refused = Object.values(refusals).some((refusal) => refusal !== null)

  const save = () => {
    const submittedValues = { ...company.submittedValues }
    for (const field of COMPANY_IDENTITY_FIELDS) {
      const value = identityValueOf(values[field.key])
      if (value === null) delete submittedValues[field.key]
      else submittedValues[field.key] = value
    }
    // The address's lines as typed, each trimmed, the blank ones dropped; none at all clears it.
    const address = postalAddress
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .join("\n")
    if (address === "") delete submittedValues.postalAddress
    else submittedValues.postalAddress = address
    setSaving(true)
    whenSaved(
      upsertRecord("configure", "organization", { ...company, submittedValues }),
      () => toast.success("Invoice identity saved", { description: `${company.name}'s invoices print it from their next document.` }),
      () => setSaving(false),
    )
  }

  return (
    <section className="rounded-xl border border-border/60">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Invoice identity</h2>
        <p className="text-xs text-muted-foreground">Printed on every invoice and credit note issued from now on; an issued one keeps what it was issued with. A FI card needs the creditor number before a project can use it.</p>
      </div>
      <form
        className="grid gap-4 px-4 py-4 md:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (!refused) save()
        }}
      >
        {COMPANY_IDENTITY_FIELDS.map((field) => (
          <div key={field.key} className="grid gap-1.5">
            <Label htmlFor={`finance-${field.key}`}>{field.label}</Label>
            <Input
              id={`finance-${field.key}`}
              value={values[field.key]}
              placeholder={field.example}
              aria-invalid={refusals[field.key] !== null}
              onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
            />
            {refusals[field.key] !== null && <p className="text-xs text-destructive">{refusals[field.key]}</p>}
          </div>
        ))}
        <div className="grid gap-1.5 md:col-span-2">
          <Label htmlFor="finance-postalAddress">Postal address</Label>
          <Textarea id="finance-postalAddress" rows={3} value={postalAddress} placeholder={"Havnegade 4\n2100 København Ø"} onChange={(event) => setPostalAddress(event.target.value)} />
          <p className="text-xs text-muted-foreground">The seller&apos;s address the documents print, a line per row.</p>
        </div>
        <div className="md:col-span-2 flex justify-end">
          <Button type="submit" size="sm" disabled={saving || refused}>
            Save identity
          </Button>
        </div>
      </form>
    </section>
  )
}

/** One project's terms and reference scheme; a FIK scheme waits for the company's creditor number. */
function ProjectTermsDialog({ project, hasCreditor, onClose }: { project: BusinessRecord; hasCreditor: boolean; onClose: () => void }) {
  const { upsertRecord } = useBusinessRecordStore()
  const [terms, setTerms] = useState(() => typedOf(project, "paymentTermsDays"))
  const [scheme, setScheme] = useState<PaymentReferenceScheme>(() => PAYMENT_REFERENCE_SCHEMES.find((candidate) => candidate === typedOf(project, "paymentReferenceScheme")) ?? "none")
  const [saving, setSaving] = useState(false)
  const refusal = paymentTermsRefusalOf(terms)

  const save = () => {
    setSaving(true)
    whenSaved(
      upsertRecord("configure", "organization", { ...project, submittedValues: { ...project.submittedValues, paymentTermsDays: terms.trim(), paymentReferenceScheme: scheme } }),
      () => {
        onClose()
        toast.success("Terms saved", { description: `${project.name}'s next invoices follow them.` })
      },
      () => setSaving(false),
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{project.name}&apos;s terms</DialogTitle>
          <DialogDescription>An invoice issued from now on is due by these terms, unless its payer has terms of its own.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (refusal === null) save()
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="finance-project-terms">Payment terms (days)</Label>
            <Input id="finance-project-terms" inputMode="numeric" value={terms} aria-invalid={refusal !== null} onChange={(event) => setTerms(event.target.value)} />
            {refusal !== null && <p className="text-xs text-destructive">{refusal}</p>}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="finance-project-scheme">Payment reference</Label>
            <Select value={scheme} onValueChange={(value) => setScheme(value as PaymentReferenceScheme)}>
              <SelectTrigger id="finance-project-scheme">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_REFERENCE_SCHEMES.map((candidate) => (
                  <SelectItem key={candidate} value={candidate} disabled={candidate !== "none" && !hasCreditor}>
                    {paymentReferenceSchemeLabel(candidate)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {hasCreditor ? "Under FIK each invoice carries a reference its payment is matched by." : "Set the company's FIK creditor number above to use a FIK scheme."}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || refusal !== null}>
              Save terms
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

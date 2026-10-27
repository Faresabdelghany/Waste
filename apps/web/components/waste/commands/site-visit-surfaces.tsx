"use client"
// Recycling-centre visits on the Pilot (#393, M4 of #293).
//
// Customers › Site access: Register a plate or card is the module's own
// dialog — the kind, the number, and its holder, a household's property or a
// business's customer with the agreement its visits are charged to (the
// customer's, signed), the project being the holder's — and a credential's
// details offer Edit, its label and its last day in force, and Block, with
// why, or Unblock.
//
// Operate › Site visits: the module's primary is the attendant's check-in,
// `/check-in`, with Likely trades beside it, the project's Properties at or
// past its Visit Rule's threshold, read from the API (a reading, never
// stored); a visit's details offer Void, with why, while it stands. The API's
// refusal is the store's toast in its own words. The words are
// lib/data/site-visits.ts', the adapters lib/api/records/site-access.ts and
// site-visits.ts.
import Link from "next/link"
import { useState, type FormEvent } from "react"
import { Plus, Storefront } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import type { FrequentVisitors } from "@waste/contracts/site-visits"
import type { AccessCredentialKind } from "@waste/domain/visits/vocabulary"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { useApiClient } from "@/components/waste/api-session-store"
import { useBusinessRecordStore, useModuleRecords, useServerResolver, whenSaved } from "@/components/waste/business-record-store"
import type { PrimarySurfaceProps, RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { useCommandRunner, useModuleReady, useOpenRecord, useRelationPickers, useServerNames } from "@/components/waste/commands/use-command-support"
import { problemSentence } from "@/lib/api/problem"
import { dayIn } from "@/lib/api/records/planning"
import { problemOfError } from "@/lib/api/records/server-records"
import { BLOCK_CREDENTIAL, CREDENTIAL_LAST_DAY_KEY, CREDENTIAL_RECORD_KIND, UNBLOCK_CREDENTIAL } from "@/lib/api/records/site-access"
import { VOID_VISIT } from "@/lib/api/records/site-visits"
import { readFrequentVisitors } from "@/lib/api/site-visits"
import { AGREEMENTS_MODULE, isAgreementRecord } from "@/lib/data/agreements"
import { agreementsOfCustomer } from "@/lib/data/bulky"
import { getModuleDefinition, type BusinessRecord, type ModuleLocation } from "@/lib/data/business-modules"
import { mintedRecord } from "@/lib/data/containers"
import { PROPERTIES_MODULE } from "@/lib/data/properties"
import { CHECK_IN_PATH, CREDENTIAL_BLOCKED_KEY, CREDENTIAL_KIND_KEY, CREDENTIAL_KIND_LABELS, CREDENTIAL_VALUE_KEY, SITE_ACCESS_MODULE, SITE_VISITS_MODULE, tradeSentence, VISIT_VOIDED_KEY } from "@/lib/data/site-visits"

const NO_RECORDS: readonly BusinessRecord[] = []
const fixturesOf = (location: ModuleLocation) => getModuleDefinition(location)?.records ?? NO_RECORDS

const field = (id: string, label: string, relation?: ModuleLocation) => ({ id, label, type: "select" as const, required: true, ...(relation === undefined ? {} : { relation }) })

/** Whose a credential is: a household's property, or a business's customer and agreement. */
type HolderKind = "household" | "business"

/** Register a plate or card: Customers › Site access's primary action. */
export function RegisterCredentialSurface({ label }: PrimarySurfaceProps) {
  const pickers = useRelationPickers()
  const { upsertRecord } = useBusinessRecordStore()
  const moduleReady = useModuleReady(SITE_ACCESS_MODULE)
  const openRecord = useOpenRecord(SITE_ACCESS_MODULE.moduleId)
  const agreements = useModuleRecords(AGREEMENTS_MODULE.workspaceId, AGREEMENTS_MODULE.moduleId, fixturesOf(AGREEMENTS_MODULE))
  const properties = useModuleRecords(PROPERTIES_MODULE.workspaceId, PROPERTIES_MODULE.moduleId, fixturesOf(PROPERTIES_MODULE))

  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<AccessCredentialKind>("plate")
  const [value, setValue] = useState("")
  const [credentialLabel, setCredentialLabel] = useState("")
  const [holder, setHolder] = useState<HolderKind>("household")
  const [propertyId, setPropertyId] = useState("")
  const [customerId, setCustomerId] = useState("")
  const [agreementId, setAgreementId] = useState("")
  const [validFrom, setValidFrom] = useState(() => dayIn(new Date(), undefined))
  const [lastDay, setLastDay] = useState("")
  const [refusal, setRefusal] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const customers = pickers.options(field("customerId", "Customer", { workspaceId: "customers", moduleId: "contacts" }), {})
  const customerAgreements = agreementsOfCustomer(agreements.records.filter(isAgreementRecord), customerId, (project) => dayIn(new Date(), pickers.timezoneOf(project)))
  const holderRecord = holder === "household" ? properties.records.find((record) => record.id === propertyId) : agreements.records.find((record) => record.id === agreementId)
  const projectId = holderRecord?.projectIds?.[0] ?? ""

  const reset = () => {
    setKind("plate")
    setValue("")
    setCredentialLabel("")
    setHolder("household")
    setPropertyId("")
    setCustomerId("")
    setAgreementId("")
    setValidFrom(dayIn(new Date(), undefined))
    setLastDay("")
    setRefusal(null)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    const missing =
      value.trim() === ""
        ? kind === "plate"
          ? "Type the plate"
          : "Type the card number"
        : holder === "household" && propertyId === ""
          ? "Pick the household's property"
          : holder === "business" && customerId === ""
            ? "Pick the business"
            : holder === "business" && agreementId === ""
              ? "Pick the agreement its visits are charged to"
              : validFrom === ""
                ? "Pick the first day in force"
                : null
    if (missing !== null) {
      setRefusal(missing)
      return
    }
    const now = Date.now()
    const record = mintedRecord({
      id: `site-access-credential-${now}`,
      name: value.trim().toUpperCase(),
      status: "In force",
      recordKind: CREDENTIAL_RECORD_KIND,
      values: {
        projectId,
        [CREDENTIAL_KIND_KEY]: kind,
        [CREDENTIAL_VALUE_KEY]: value,
        ...(credentialLabel.trim() === "" ? {} : { label: credentialLabel.trim() }),
        ...(holder === "household" ? { propertyId } : { customerId, agreementId }),
        validFrom,
        ...(lastDay === "" ? {} : { [CREDENTIAL_LAST_DAY_KEY]: lastDay }),
      },
    })
    setSaving(true)
    whenSaved(
      upsertRecord(SITE_ACCESS_MODULE.workspaceId, SITE_ACCESS_MODULE.moduleId, record),
      () => {
        setOpen(false)
        reset()
        openRecord(record.id)
        toast.success(`${CREDENTIAL_KIND_LABELS[kind]} registered`, { description: record.name })
      },
      () => setSaving(false),
    )
  }

  return (
    <>
      <Button size="sm" disabled={!moduleReady} onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" weight="bold" />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !saving && setOpen(next)}>
        <DialogContent className="sm:max-w-xl">
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Register a plate or card</DialogTitle>
              <DialogDescription>A household&apos;s under its property, its visits counted against the property&apos;s year; a business&apos;s under its customer, its visits charged to the agreement named.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="credential-kind">Kind</Label>
                <Select value={kind} onValueChange={(next) => setKind(next as AccessCredentialKind)}>
                  <SelectTrigger id="credential-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="plate">Plate</SelectItem>
                    <SelectItem value="card">Card</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="credential-value">{kind === "plate" ? "Plate" : "Card number"}</Label>
                <Input id="credential-value" className="uppercase" autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="credential-label">Label</Label>
                <Input id="credential-label" placeholder="Van 2, Garden card…" value={credentialLabel} onChange={(event) => setCredentialLabel(event.target.value)} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="credential-holder">Holder</Label>
                <Select
                  value={holder}
                  onValueChange={(next) => {
                    setHolder(next as HolderKind)
                    setPropertyId("")
                    setCustomerId("")
                    setAgreementId("")
                  }}
                >
                  <SelectTrigger id="credential-holder">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="household">A household, by its property</SelectItem>
                    <SelectItem value="business">A business, by its customer and agreement</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {holder === "household" ? (
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="credential-property">Property</Label>
                  <Select value={propertyId} onValueChange={setPropertyId}>
                    <SelectTrigger id="credential-property">
                      <SelectValue placeholder="Pick the household's property" />
                    </SelectTrigger>
                    <SelectContent>
                      {properties.records.map((record) => (
                        <SelectItem key={record.id} value={record.id}>
                          {record.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="credential-customer">Customer</Label>
                    <Select
                      value={customerId}
                      onValueChange={(next) => {
                        setCustomerId(next)
                        setAgreementId("")
                      }}
                    >
                      <SelectTrigger id="credential-customer">
                        <SelectValue placeholder="Pick the business" />
                      </SelectTrigger>
                      <SelectContent>
                        {customers.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="credential-agreement">Agreement</Label>
                    <Select value={agreementId} onValueChange={setAgreementId} disabled={customerId === ""}>
                      <SelectTrigger id="credential-agreement">
                        <SelectValue placeholder="Pick the agreement charged" />
                      </SelectTrigger>
                      <SelectContent>
                        {customerAgreements.map((record) => (
                          <SelectItem key={record.id} value={record.id}>
                            {record.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {customerId !== "" && customerAgreements.length === 0 && <p className="text-xs text-muted-foreground">The customer has no signed agreement in force to charge visits to.</p>}
                  </div>
                </>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="credential-from">First day in force</Label>
                <Input id="credential-from" type="date" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="credential-last-day">Last day in force</Label>
                <Input id="credential-last-day" type="date" value={lastDay} onChange={(event) => setLastDay(event.target.value)} />
              </div>
            </div>
            {refusal !== null && <p className="text-sm text-destructive">{refusal}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={saving} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                Register
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** A credential's details: Edit its label and end, and Block or Unblock. */
export function CredentialCommandsSurface({ record }: RowSurfaceProps) {
  const moduleReady = useModuleReady(SITE_ACCESS_MODULE)
  const { busy, run, save } = useCommandRunner(SITE_ACCESS_MODULE, record.id)
  const { upsertRecord } = useBusinessRecordStore()
  const blocked = record.submittedValues?.[CREDENTIAL_BLOCKED_KEY] === true
  const [editing, setEditing] = useState(false)
  const [blocking, setBlocking] = useState(false)
  const [credentialLabel, setCredentialLabel] = useState("")
  const [lastDay, setLastDay] = useState("")
  const [reason, setReason] = useState("")
  const valueOf = (key: string) => {
    const value = record.submittedValues?.[key]
    return typeof value === "string" ? value : ""
  }

  const openEdit = () => {
    setCredentialLabel(valueOf("label"))
    setLastDay(valueOf(CREDENTIAL_LAST_DAY_KEY))
    setEditing(true)
  }
  const edit = (event: FormEvent) => {
    event.preventDefault()
    const after: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, label: credentialLabel, [CREDENTIAL_LAST_DAY_KEY]: lastDay } }
    save(upsertRecord(SITE_ACCESS_MODULE.workspaceId, SITE_ACCESS_MODULE.moduleId, after), (saved) => {
      setEditing(false)
      if (saved !== undefined) toast.success("Credential saved", { description: record.name })
    })
  }
  const block = (event: FormEvent) => {
    event.preventDefault()
    run(BLOCK_CREDENTIAL, { reason }, (outcome) => {
      setBlocking(false)
      setReason("")
      toast.success("Credential blocked", { description: outcome.record.name })
    })
  }
  const unblock = () => run(UNBLOCK_CREDENTIAL, undefined, (outcome) => toast.success("Credential unblocked", { description: outcome.record.name }))

  return (
    <section className="space-y-3" data-testid="credential-commands">
      <h3 className="text-sm font-semibold">Access credential</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The register is being read from the API; its commands follow.</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={openEdit}>
          Edit label or end
        </Button>
        {blocked ? (
          <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={unblock}>
            Unblock
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => setBlocking(true)}>
            Block
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">The kind, the number and the holder are what a credential is: end it and register another to change them.</p>

      <Dialog open={editing} onOpenChange={(next) => !busy && setEditing(next)}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={edit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Edit credential</DialogTitle>
              <DialogDescription>What the office calls it, and its last day in force. Clear the day to reopen it.</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="credential-edit-label">Label</Label>
              <Input id="credential-edit-label" value={credentialLabel} onChange={(event) => setCredentialLabel(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="credential-edit-last-day">Last day in force</Label>
              <Input id="credential-edit-last-day" type="date" value={lastDay} onChange={(event) => setLastDay(event.target.value)} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={blocking} onOpenChange={(next) => !busy && setBlocking(next)}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={block} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Block credential</DialogTitle>
              <DialogDescription>A blocked plate or card is turned away at the check-in until it is unblocked. The attendant reads that it is blocked; the reason is the office&apos;s.</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="credential-block-reason">Why</Label>
              <Textarea id="credential-block-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setBlocking(false)}>
                Keep it in force
              </Button>
              <Button type="submit" disabled={busy || reason.trim() === ""}>
                Block
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  )
}

/** Operate › Site visits' primary: the attendant's check-in, and the Likely trades beside it. */
export function SiteVisitsPrimarySurface({ label }: PrimarySurfaceProps) {
  return (
    <div className="flex flex-wrap gap-2">
      <LikelyTradesSurface />
      <Button size="sm" asChild>
        <Link href={CHECK_IN_PATH}>
          <Storefront className="h-4 w-4" weight="bold" />
          {label}
        </Link>
      </Button>
    </div>
  )
}

/** The likely trades read for a project, or why they could not be. */
type TradesRead = { status: "idle" } | { status: "reading" } | { status: "read"; answer: FrequentVisitors } | { status: "refused"; sentence: string }

/** Likely trades: the project's Properties whose counted visits reach its Visit Rule's threshold, most visits first. */
function LikelyTradesSurface() {
  const client = useApiClient()
  const resolver = useServerResolver()
  const pickers = useRelationPickers()
  const propertyName = useServerNames(PROPERTIES_MODULE, "property")
  const openProperty = useOpenRecord(PROPERTIES_MODULE.moduleId)
  const projects = pickers.options(field("projectId", "Project"), {})
  const [open, setOpen] = useState(false)
  const [projectId, setProjectId] = useState("")
  const [read, setRead] = useState<TradesRead>({ status: "idle" })

  const ask = (webId: string) => {
    setProjectId(webId)
    const serverId = resolver.serverIdOf(webId)
    if (client === null || serverId === undefined) {
      setRead({ status: "refused", sentence: "The project is not one the API holds yet." })
      return
    }
    setRead({ status: "reading" })
    readFrequentVisitors(client, serverId).then(
      (answer) => setRead({ status: "read", answer }),
      (error: unknown) => setRead({ status: "refused", sentence: problemSentence(problemOfError(error)) }),
    )
  }
  const openDialog = () => {
    setOpen(true)
    if (projectId === "" && projects.length > 0) ask(projects[0].value)
  }

  const answer = read.status === "read" ? read.answer : null
  return (
    <>
      <Button size="sm" variant="outline" onClick={openDialog}>
        Likely trades
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Likely trades</DialogTitle>
            <DialogDescription>Households whose counted visits reach the Visit Rule&apos;s threshold, so their visits may be a business&apos;s. A reading of the ledger today, never stored.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="likely-trades-project">Project</Label>
            <Select value={projectId} onValueChange={ask}>
              <SelectTrigger id="likely-trades-project">
                <SelectValue placeholder="Pick a project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {read.status === "reading" && <p className="text-sm text-muted-foreground">Reading the ledger…</p>}
          {read.status === "refused" && <p className="text-sm text-destructive">{read.sentence}</p>}
          {answer !== null &&
            (answer.ruleId === null ? (
              <p className="text-sm text-muted-foreground">No Visit Rule is in force on {answer.on}: set one in Settings › Commercial › Recycling-centre charges.</p>
            ) : answer.threshold === null ? (
              <p className="text-sm text-muted-foreground">The Visit Rule in force flags no likely trade: it names no threshold.</p>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Flagged at {tradeSentence({ tradeThreshold: answer.threshold, tradeWindowDays: answer.windowDays })}, up to {answer.on}.</p>
                <Table data-testid="likely-trades">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Property</TableHead>
                      <TableHead className="text-right">Counted visits</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {answer.items.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={2} className="text-sm text-muted-foreground">
                          No household reaches the threshold.
                        </TableCell>
                      </TableRow>
                    ) : (
                      answer.items.map((item) => {
                        const webId = resolver.byServerId(item.propertyId)?.id
                        return (
                          <TableRow key={item.propertyId}>
                            <TableCell>
                              {webId === undefined ? (
                                propertyName(item.propertyId)
                              ) : (
                                <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => openProperty(webId)}>
                                  {propertyName(item.propertyId)}
                                </button>
                              )}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{item.visits}</TableCell>
                          </TableRow>
                        )
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            ))}
        </DialogContent>
      </Dialog>
    </>
  )
}

/** A visit's details: Void, with why, while it stands. */
export function SiteVisitCommandsSurface({ record }: RowSurfaceProps) {
  const moduleReady = useModuleReady(SITE_VISITS_MODULE)
  const { busy, run } = useCommandRunner(SITE_VISITS_MODULE, record.id)
  const voided = record.submittedValues?.[VISIT_VOIDED_KEY] === true
  const [voiding, setVoiding] = useState(false)
  const [reason, setReason] = useState("")

  const voidVisit = (event: FormEvent) => {
    event.preventDefault()
    run(VOID_VISIT, { reason }, (outcome) => {
      setVoiding(false)
      setReason("")
      toast.success("Visit voided", { description: outcome.record.name })
    })
  }

  return (
    <section className="space-y-3" data-testid="site-visit-commands">
      <h3 className="text-sm font-semibold">Site visit</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The ledger is being read from the API; its commands follow.</p>}
      {voided ? (
        <p className="text-sm text-muted-foreground">Voided: the visit stays on the ledger with why, and its charge is cancelled, or reversed once invoiced.</p>
      ) : (
        <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => setVoiding(true)}>
          Void visit
        </Button>
      )}
      <Dialog open={voiding} onOpenChange={(next) => !busy && setVoiding(next)}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={voidVisit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Void visit</DialogTitle>
              <DialogDescription>A mistake is voided, never deleted: the visit stays on the ledger with why. Its charge is cancelled, or reversed once a line names it; a later visit keeps the step it was charged at.</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="visit-void-reason">Why</Label>
              <Textarea id="visit-void-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setVoiding(false)}>
                Keep the visit
              </Button>
              <Button type="submit" disabled={busy || reason.trim() === ""}>
                Void visit
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  )
}

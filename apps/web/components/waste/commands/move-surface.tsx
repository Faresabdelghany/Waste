"use client"
// A property's move in its details on the Pilot (#374, #291 C11): Move
// occupant opens a short wizard — the day, who moves out (a customer the
// property names today), who moves in, the payer and the incoming agreement's
// number — whose Review asks the API's dry run and says, in
// lib/data/property-moves.ts' sentences, what ends, what begins, what stays in
// service and which charges the move leaves past its day for the office to
// credit or cancel. Move sends the same body; a body changed after its review
// is reviewed again first. Once it lands the properties, the agreements and
// the containers are read again. A customer not yet registered is added in
// Contacts first, since a dry run names customers the API holds.
import { useState } from "react"
import { ArrowsLeftRight } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"
import type { MoveOutcome } from "@waste/contracts/moves"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useApiClient, useApiSession } from "@/components/waste/api-session-store"
import { useBusinessRecordStore, useServerModuleState } from "@/components/waste/business-record-store"
import { useModuleReady, useProjectRecords, useServerNames } from "@/components/waste/commands/use-command-support"
import { isLocalRefusal, typed } from "@/lib/api/records/adapter"
import { CONTAINERS_MODULE } from "@/lib/api/records/containers"
import { dayIn } from "@/lib/api/records/planning"
import { problemSentence } from "@/lib/api/problem"
import { customerKindOf } from "@/lib/api/records/registry"
import { problemOfError } from "@/lib/api/records/server-records"
import { AGREEMENTS_MODULE } from "@/lib/data/agreements"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { CONTACTS_MODULE, PROPERTIES_MODULE } from "@/lib/data/properties"
import { moveBodyOf, moveOffered, moveProperty, moveReview, movingOutOf, type MoveTyped } from "@/lib/data/property-moves"

/** The select's token for the incoming customer as the payer: a select holds no empty value. */
const INCOMING_PAYS = "incoming"

/** Move occupant, on a property's details: offered to a role that edits both the properties and the agreements. */
export function MovePropertySection({ record }: { record: BusinessRecord }) {
  const { me } = useApiSession()
  const [open, setOpen] = useState(false)
  if (!moveOffered(me?.role.grants)) return null
  return (
    <section className="space-y-2" data-testid="property-move" aria-label="Move">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Move</h3>
      <p className="text-sm text-muted-foreground">A tenant moving out and another in, or the property sold: the roles, the subscriptions and the bins handed on from a day.</p>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <ArrowsLeftRight className="h-4 w-4" />
        Move occupant…
      </Button>
      {open && <MoveDialog record={record} onClose={() => setOpen(false)} />}
    </section>
  )
}

function MoveDialog({ record, onClose }: { record: BusinessRecord; onClose: () => void }) {
  const client = useApiClient()
  const { refreshModule } = useBusinessRecordStore()
  const properties = useServerModuleState(PROPERTIES_MODULE.workspaceId, PROPERTIES_MODULE.moduleId)
  const contacts = useServerModuleState(CONTACTS_MODULE.workspaceId, CONTACTS_MODULE.moduleId)
  const contactsReady = useModuleReady(CONTACTS_MODULE)
  const projectOf = useProjectRecords()
  const project = projectOf(record.projectIds?.[0])
  const today = dayIn(new Date(), project === undefined ? undefined : typed(project, "timezone"))

  const [day, setDay] = useState<string | null>(null)
  const [outgoing, setOutgoing] = useState("")
  const [incoming, setIncoming] = useState("")
  const [payer, setPayer] = useState(INCOMING_PAYS)
  const [agreementNumber, setAgreementNumber] = useState("")
  const [review, setReview] = useState<{ of: string; outcome: MoveOutcome } | null>(null)
  const [busy, setBusy] = useState(false)

  const customers = (contacts?.records ?? []).filter((candidate) => customerKindOf(candidate) !== undefined && contacts?.serverIds.has(candidate.id))
  const nameOfWebId = (webId: string) => customers.find((candidate) => candidate.id === webId)?.name ?? webId
  const nameOfServerId = useServerNames(CONTACTS_MODULE, "customer")
  const leaving = movingOutOf(record)
  const typedMove: MoveTyped = { on: day ?? today, outgoing, incoming, payer: payer === INCOMING_PAYS ? "" : payer, agreementNumber }
  const serverIdOf = (webId: string) => contacts?.serverIds.get(webId)
  const propertyServerId = properties?.serverIds.get(record.id)
  // The review shown is of exactly this body; anything typed since asks again.
  const key = JSON.stringify(typedMove)
  const reviewed = review !== null && review.of === key ? review.outcome : null
  const told = reviewed === null || outgoing === "" ? null : moveReview(reviewed, nameOfServerId, serverIdOf(outgoing) ?? "")

  const ask = (dryRun: boolean) => {
    if (busy || client === null) return
    const body = moveBodyOf(typedMove, serverIdOf, dryRun)
    if (isLocalRefusal(body)) {
      toast.error("The move was not asked", { description: body.message })
      return
    }
    if (propertyServerId === undefined) {
      toast.error("The move was not asked", { description: "This property is not one the API holds yet" })
      return
    }
    setBusy(true)
    moveProperty(client, propertyServerId, body)
      .then(
        (outcome) => {
          if (dryRun) {
            setReview({ of: key, outcome })
            return
          }
          toast.success("Moved", { description: moveReview(outcome, nameOfServerId, body.outgoingCustomerId).lines[0] })
          for (const module of [PROPERTIES_MODULE, AGREEMENTS_MODULE, CONTAINERS_MODULE]) void refreshModule(module.workspaceId, module.moduleId)
          onClose()
        },
        (error: unknown) => toast.error(dryRun ? "The move was not reviewed" : "The move was not made", { description: problemSentence(problemOfError(error)) }),
      )
      .finally(() => setBusy(false))
  }

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-2xl" data-testid="move-dialog">
        <DialogHeader>
          <DialogTitle>Move occupant of {record.name}</DialogTitle>
          <DialogDescription>
            From the day, the customer moving out holds none of their roles here and their subscriptions here end; the customer moving in holds the same roles under a new agreement with the same products, and the bins stay in service. Review first; nothing is written until Move.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="move-on">Moves in on</Label>
            <Input id="move-on" type="date" value={day ?? today} onChange={(event) => setDay(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="move-outgoing">Moving out</Label>
            <Select value={outgoing === "" ? undefined : outgoing} onValueChange={setOutgoing}>
              <SelectTrigger id="move-outgoing" aria-label="Moving out">
                <SelectValue placeholder={leaving.length === 0 ? "Nobody is a party of this property today" : "A party of this property"} />
              </SelectTrigger>
              <SelectContent>
                {leaving.map((webId) => (
                  <SelectItem key={webId} value={webId}>
                    {nameOfWebId(webId)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="move-incoming">Moving in</Label>
            <Select value={incoming === "" ? undefined : incoming} onValueChange={setIncoming}>
              <SelectTrigger id="move-incoming" aria-label="Moving in">
                <SelectValue placeholder={contactsReady ? "A customer" : "The customers are being read from the API…"} />
              </SelectTrigger>
              <SelectContent>
                {customers
                  .filter((candidate) => candidate.id !== outgoing)
                  .map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Not listed? Add them in Contacts first.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="move-payer">Invoiced to</Label>
            <Select value={payer} onValueChange={setPayer}>
              <SelectTrigger id="move-payer" aria-label="Invoiced to">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INCOMING_PAYS}>The customer moving in</SelectItem>
                {customers
                  .filter((candidate) => candidate.id !== incoming)
                  .map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="move-number">New agreement number</Label>
            <Input id="move-number" value={agreementNumber} placeholder="AGR-3001" onChange={(event) => setAgreementNumber(event.target.value)} />
            <p className="text-xs text-muted-foreground">Needed when the customer moving out subscribes here; a property nobody subscribes at moves its parties alone.</p>
          </div>
        </div>
        {told !== null && (
          <div className="space-y-2 rounded-md border p-3" data-testid="move-review">
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {told.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {told.charges.length > 0 && (
              <div className="space-y-1">
                <p className="text-sm font-medium">Charges left past the day — the move reprices none:</p>
                <ul className="space-y-1 text-sm">
                  {told.charges.map((charge) => (
                    <li key={charge.id} className={charge.invoiced ? "text-destructive" : "text-muted-foreground"}>
                      {charge.label} — {charge.advice}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button variant="outline" onClick={() => ask(true)} disabled={busy || client === null}>
            Review
          </Button>
          <Button onClick={() => ask(false)} disabled={busy || reviewed === null}>
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

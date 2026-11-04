// A property's move on the Pilot (#374, #291 C11): the office picks the day,
// who moves out — a customer the property names today, in any role — who
// moves in, the incoming agreement's payer where it is not the incoming
// customer, and its number; Review asks `POST /properties/:id/moves` with
// `dryRun` and says what ends, what begins and what stays in service, and
// lists the charges the move leaves past its day for the office to credit or
// cancel (the API reprices nothing, the owner's decision on #374); Move sends
// the same body without it. Nothing is computed here: what the move does is
// the API's answer, read into sentences. A sale is a move of the owner.
import type { MoveCreate, MoveOutcome } from "@waste/contracts/moves"
import { PROPERTY_PARTY_ROLES } from "@waste/domain/registry/vocabulary"
import { splitList } from "@waste/domain/record-values"

import { command, type ApiClient } from "../api/client"
import { allows, type Grants } from "../api/grants"
import type { LocalRefusal } from "../api/records/adapter"
import { lastDayIn } from "../api/records/planning"
import { formatMinor } from "../commercial/money"
import type { BusinessRecord } from "./business-modules"
import { PARTY_FIELDS } from "./properties"

/** What the office typed: the day, and the customers by web id; an empty payer is the incoming customer, an empty number none. */
export type MoveTyped = { on: string; outgoing: string; incoming: string; payer: string; agreementNumber: string }

/** Whether the role may move a property's occupant: the move writes the parties and the agreements, so it asks edit on both, as the API does. */
export const moveOffered = (grants: Grants | undefined): boolean => allows(grants, "customers.properties", "edit") && allows(grants, "customers.agreements", "edit")

/** The move, or its dry run: the API's answer either way. */
export const moveProperty = (client: ApiClient, propertyServerId: string, body: MoveCreate): Promise<MoveOutcome> => command<MoveOutcome>(client, `/properties/${propertyServerId}/moves`, body)

/** Who may move out: every customer the record names today, in any role, each once, in the order the roles are listed. */
export function movingOutOf(record: Pick<BusinessRecord, "submittedValues">): string[] {
  const named = PROPERTY_PARTY_ROLES.flatMap((role) => {
    const value = record.submittedValues?.[PARTY_FIELDS[role]]
    return typeof value === "string" ? splitList(value) : []
  })
  return [...new Set(named)]
}

/** The body the API is asked, or the refusal at the field the office has to fix first. */
export function moveBodyOf(typed: MoveTyped, serverIdOf: (webId: string) => string | undefined, dryRun: boolean): MoveCreate | LocalRefusal {
  if (typed.on === "") return { path: "on", message: "Pick the day the incoming customer moves in" }
  if (typed.outgoing === "") return { path: "outgoing", message: "Pick who moves out" }
  if (typed.incoming === "") return { path: "incoming", message: "Pick who moves in" }
  if (typed.incoming === typed.outgoing) return { path: "incoming", message: "A customer does not move into the property they move out of" }
  const outgoingCustomerId = serverIdOf(typed.outgoing)
  if (outgoingCustomerId === undefined) return { path: "outgoing", message: "This customer is not one the API holds yet" }
  const incomingCustomerId = serverIdOf(typed.incoming)
  if (incomingCustomerId === undefined) return { path: "incoming", message: "This customer is not one the API holds yet" }
  const payer = typed.payer === "" || typed.payer === typed.incoming ? undefined : serverIdOf(typed.payer)
  if (typed.payer !== "" && typed.payer !== typed.incoming && payer === undefined) return { path: "payer", message: "This customer is not one the API holds yet" }
  const agreementNumber = typed.agreementNumber.trim()
  return {
    on: typed.on,
    outgoingCustomerId,
    incomingCustomerId,
    ...(payer === undefined ? {} : { payerCustomerId: payer }),
    ...(agreementNumber === "" ? {} : { agreementNumber }),
    dryRun,
  }
}

/** One charge the move leaves past its day, as the review lists it. */
export type ChargeLeft = { id: string; label: string; invoiced: boolean; advice: string }

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`

/** The roles in the order a person reads them: the wire's tokens as words. */
const ROLE_WORDS: Readonly<Record<string, string>> = { owner: "owner", payer: "payer", tenant: "tenant", administrator: "administrator", "service-contact": "service contact" }

/**
 * What the API answered, said in the office's words: who holds the property
 * from the day and as what, what of the outgoing agreement ends, the incoming
 * agreement, the containers that stay in service, and the charges left past
 * the day. `nameOf` names a customer by server id; `outgoingCustomerId` is
 * who moved out, which the answer names only through an agreement.
 */
export function moveReview(outcome: MoveOutcome, nameOf: (customerServerId: string) => string, outgoingCustomerId: string): { lines: string[]; charges: ChargeLeft[] } {
  const { on, outgoing, incoming } = outcome
  const lines: string[] = []
  const arriving = outcome.property.parties.filter((party) => party.validFrom === on && party.customerId !== outgoingCustomerId)
  const incomingId = incoming.agreement?.customerId ?? arriving[0]?.customerId
  if (incomingId !== undefined) {
    const roles = arriving.filter((party) => party.customerId === incomingId).map((party) => ROLE_WORDS[party.role] ?? party.role).sort()
    lines.push(`From ${on} ${nameOf(incomingId)} is the property's ${roles.join(" and ")}.`)
  }
  if (outgoing.agreement === null) {
    lines.push(`${nameOf(outgoingCustomerId)} subscribes at this property under no agreement, so only the parties move.`)
  } else {
    const here = count(outgoing.subscriptions.length, "subscription")
    lines.push(
      outgoing.agreement.validTo === on
        ? `${outgoing.agreement.number} of ${nameOf(outgoing.agreement.customerId)} ends on ${on}, its ${here} here with it.`
        : `${outgoing.agreement.number} of ${nameOf(outgoing.agreement.customerId)} goes on at its other places; its ${here} here end on ${on}.`,
    )
  }
  if (incoming.agreement !== null) {
    const payer = incoming.agreement.payerCustomerId === incoming.agreement.customerId ? "" : `, invoicing ${nameOf(incoming.agreement.payerCustomerId)}`
    lines.push(`${incoming.agreement.number} begins on ${on} for ${nameOf(incoming.agreement.customerId)}${payer}, with ${count(incoming.subscriptions.length, "subscription")}.`)
    if (outcome.containersCarried.length > 0) lines.push(`${count(outcome.containersCarried.length, "container")} ${outcome.containersCarried.length === 1 ? "stays" : "stay"} in service under ${incoming.agreement.number}.`)
  }
  const charges = outcome.chargesToCredit.map((charge): ChargeLeft => {
    const invoiced = charge.status === "invoiced"
    const period = charge.charge === null ? charge.serviceDate : `${charge.charge.periodFrom} – ${lastDayIn(charge.charge.periodTo)}`
    const amount = charge.netMinor === null || charge.currency === null ? "not priced" : formatMinor(charge.netMinor, charge.currency)
    return { id: charge.id, label: `${period} · ${amount}`, invoiced, advice: invoiced ? "Invoiced: credit it from its invoice" : "Not invoiced: cancel or reprice it before the next run" }
  })
  return { lines, charges }
}

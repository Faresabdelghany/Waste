import { type PriceRowModel, type PriceConditions } from "./price-model"

export type ResolveInput = {
  zone: string
  customerType: string
  containerType?: string
  wasteFraction?: string
  customer?: string
  date: string
}
export type RowVerdict = {
  row: PriceRowModel
  eligible: boolean
  reason?: string
  matched: string[]
  score: number
  winner: boolean
  amountOnDate: number
}
export type Resolution = {
  verdicts: RowVerdict[]
  winner?: RowVerdict
  surcharge?: { name: string; describe: string; amount: number }
  base: number
  vatRate: number
  vat: number
  total: number
}

export const SURCHARGE_RULES = [
  {
    id: "sur-weekend",
    name: "Weekend surcharge",
    kind: "percent" as const,
    value: 15,
    recurrence: "Every Saturday and Sunday",
    appliesTo: (date: string) => {
      const day = new Date(`${date}T12:00:00`).getDay()
      return day === 0 || day === 6
    },
    describe: "+15% on Saturdays and Sundays",
  },
  {
    id: "sur-holiday",
    name: "Public holiday surcharge",
    kind: "flat" as const,
    value: 25,
    recurrence: "Annual · 4 configured dates",
    appliesTo: (date: string) =>
      ["2026-12-24", "2026-12-25", "2026-12-31", "2027-01-01"].includes(date),
    describe: "+€25.00 on public holidays",
  },
]

function amountOnDate(row: PriceRowModel, date: string): number {
  if (row.scheduled && row.scheduled.from <= date) {
    if (!row.scheduled.revertOn || date < row.scheduled.revertOn) {
      return row.scheduled.newAmount
    }
  }
  return row.amount
}

export function resolvePrice(rows: readonly PriceRowModel[], vatRate: number, input: ResolveInput): Resolution {
  const inputValues: Record<keyof PriceConditions, string | undefined> = {
    zone: input.zone,
    customerType: input.customerType,
    containerType: input.containerType,
    wasteFraction: input.wasteFraction,
  }
  const conditionNames: Record<keyof PriceConditions, string> = {
    zone: "Zone",
    customerType: "Customer type",
    containerType: "Container type",
    wasteFraction: "Waste fraction",
  }

  const verdicts: RowVerdict[] = rows.map((row) => {
    const matched: string[] = []
    let reason: string | undefined

    if (row.negotiatedCustomer) {
      if (input.customer === row.negotiatedCustomer) {
        matched.push(`Negotiated · ${row.negotiatedCustomer}`)
      } else {
        reason = `Negotiated for ${row.negotiatedCustomer}, not this customer`
      }
    }
    if (!reason && row.effectiveFrom > input.date) {
      reason = `Not effective until ${row.effectiveFrom}`
    }
    if (!reason && row.effectiveTo && row.effectiveTo < input.date) {
      reason = `Expired on ${row.effectiveTo}`
    }
    if (!reason) {
      for (const key of Object.keys(row.conditions) as (keyof PriceConditions)[]) {
        const required = row.conditions[key]
        if (!required) continue
        const provided = inputValues[key]
        if (!provided) {
          reason = `Requires ${conditionNames[key].toLowerCase()} ${required}`
          break
        }
        if (provided !== required) {
          reason = `${conditionNames[key]} is ${required}, not ${provided}`
          break
        }
        matched.push(required)
      }
    }

    const eligible = !reason
    const score = eligible
      ? (row.negotiatedCustomer ? 100 : 0) + Object.keys(row.conditions).length
      : -1
    return {
      row,
      eligible,
      reason,
      matched,
      score,
      winner: false,
      amountOnDate: amountOnDate(row, input.date),
    }
  })

  const eligible = verdicts.filter((verdict) => verdict.eligible)
  eligible.sort(
    (a, b) =>
      b.score - a.score || b.row.effectiveFrom.localeCompare(a.row.effectiveFrom),
  )
  const winner = eligible[0]
  if (winner) winner.winner = true

  const base = winner ? winner.amountOnDate : 0
  const applicable = SURCHARGE_RULES.filter((rule) => rule.appliesTo(input.date)).map(
    (rule) => ({
      name: rule.name,
      describe: rule.describe,
      amount: rule.kind === "percent" ? (base * rule.value) / 100 : rule.value,
    }),
  )
  // Highest wins on overlap.
  applicable.sort((a, b) => b.amount - a.amount)
  const surcharge = applicable[0]
  const subtotal = base + (surcharge?.amount ?? 0)
  const vat = subtotal * vatRate
  return {
    verdicts: verdicts.sort((a, b) => b.score - a.score),
    winner,
    surcharge,
    base,
    vatRate,
    vat,
    total: subtotal + vat,
  }
}

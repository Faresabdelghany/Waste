"use client"

// PROTOTYPE — throwaway code, do not ship.
// Products & Prices flow dialogs (Adjust / Vary / Schedule / Negotiated / Quick create),
// restyled to the app's dialog recipes.

import { useState, type ReactNode } from "react"
import Link from "next/link"
import { toast } from "sonner"
import {
  ArrowLeft,
  CaretRight,
  Handshake,
  Plus,
  Warning,
} from "@phosphor-icons/react/dist/ssr"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { statusClasses } from "@/components/wastehero/business-record-views"

import {
  COMMERCIAL_DEFAULTS,
  CONTAINER_TYPES,
  CUSTOMER_TYPES,
  KNOWN_CUSTOMERS,
  PRICE_LIST_TAGS,
  PROTO_TODAY,
  WASTE_FRACTIONS,
  ZONES,
  money,
  unitSuffix,
  type PriceConditions,
  type PriceRow,
  type Product,
  type PrototypeDb,
} from "./prototype-data"
import {
  COMMERCIAL_SETTINGS_HREF,
  ConditionChips,
  ScheduledChip,
  computeAdjusted,
  protoId,
  rowLabel,
} from "./prototype-shared"

// --- Small shared bits ---

function CommercialDefaultsLink({ children }: { children: ReactNode }) {
  return (
    <Link
      href={COMMERCIAL_SETTINGS_HREF}
      className="underline underline-offset-2 hover:text-foreground"
    >
      {children}
    </Link>
  )
}

function ReviewRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 py-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-[60%] text-right font-medium">{children}</span>
    </div>
  )
}

function ReviewConfirm({
  id,
  checked,
  onCheckedChange,
  children,
}: {
  id: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  children: ReactNode
}) {
  return (
    <div className="mt-5 flex items-start gap-3 border-t border-border/70 pt-5">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
      <Label htmlFor={id} className="font-normal leading-5">
        {children}
      </Label>
    </div>
  )
}

// --- 2. Adjust prices (bulk, §4.2) ---

export function AdjustPricesDialog({
  open,
  onOpenChange,
  db,
  rows,
  onApply,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  db: PrototypeDb
  rows: PriceRow[]
  onApply: (
    rowIds: string[],
    opts: {
      kind: "percent" | "fixed" | "multiply"
      value: number
      from: string
      revertOn?: string
      round: boolean
    },
  ) => void
}) {
  const [step, setStep] = useState<"form" | "review">("form")
  const [kind, setKind] = useState<"percent" | "fixed" | "multiply">("percent")
  const [value, setValue] = useState("3")
  const [from, setFrom] = useState("2027-01-01")
  const [revertOn, setRevertOn] = useState("")
  const [round, setRound] = useState(true)
  const [includeNegotiated, setIncludeNegotiated] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  const negotiated = rows.filter((row) => row.negotiatedCustomer)
  const affected = includeNegotiated
    ? rows
    : rows.filter((row) => !row.negotiatedCustomer)
  const numericValue = Number(value) || 0
  const valueInvalid =
    kind === "multiply"
      ? !Number.isFinite(numericValue) || numericValue <= 0
      : numericValue === 0

  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setStep("form")
      setIncludeNegotiated(false)
      setConfirmed(false)
    }
  }

  const productName = (row: PriceRow) =>
    db.products.find((entry) => entry.id === row.productId)?.name ?? row.productId

  const valueLabel =
    kind === "percent" ? "Percent (+/−)" : kind === "fixed" ? "Amount (€, +/−)" : "Factor"
  const valuePlaceholder =
    kind === "multiply" ? "1.02" : kind === "percent" ? "3" : "0.50"

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b border-border px-6 py-5 pr-12">
          <DialogTitle>Adjust prices</DialogTitle>
          <DialogDescription>
            {step === "form"
              ? `Bulk change for ${rows.length} selected price row${rows.length === 1 ? "" : "s"}.`
              : "Review every change before it is scheduled."}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6">
          {step === "form" ? (
            <section className="py-5">
              <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
                <div className="grid content-start gap-2">
                  <Label htmlFor="adjust-kind">Change</Label>
                  <Select
                    value={kind}
                    onValueChange={(next) =>
                      setKind(next as "percent" | "fixed" | "multiply")
                    }
                  >
                    <SelectTrigger id="adjust-kind">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="percent">Percentage (+/−)</SelectItem>
                      <SelectItem value="fixed">Fixed amount (+/− €)</SelectItem>
                      <SelectItem value="multiply">Multiply by factor</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid content-start gap-2">
                  <Label htmlFor="adjust-value">{valueLabel}</Label>
                  <Input
                    id="adjust-value"
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    placeholder={valuePlaceholder}
                  />
                </div>
                <div className="grid content-start gap-2">
                  <Label htmlFor="adjust-from">Effective from</Label>
                  <Input
                    id="adjust-from"
                    type="date"
                    value={from}
                    onChange={(event) => setFrom(event.target.value)}
                  />
                </div>
                <div className="grid content-start gap-2">
                  <Label htmlFor="adjust-revert">Auto-revert on (optional)</Label>
                  <Input
                    id="adjust-revert"
                    type="date"
                    value={revertOn}
                    onChange={(event) => setRevertOn(event.target.value)}
                  />
                </div>
                <div className="flex items-start gap-3 sm:col-span-2">
                  <Checkbox
                    id="adjust-round"
                    checked={round}
                    onCheckedChange={(checked) => setRound(checked === true)}
                  />
                  <Label htmlFor="adjust-round" className="font-normal leading-5">
                    Round to nearest €0.05
                  </Label>
                </div>
              </div>

              {negotiated.length > 0 && (
                <div className="mt-5 rounded-lg border border-border bg-muted/50 px-4 py-3">
                  <div className="flex items-start gap-2">
                    <Warning className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="space-y-3 text-xs text-muted-foreground">
                      <div className="leading-5">
                        <Badge
                          variant="outline"
                          className={cn(
                            "mr-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
                            statusClasses("pending"),
                          )}
                        >
                          {negotiated.length} negotiated
                        </Badge>
                        deal{negotiated.length === 1 ? " is" : "s are"} in the
                        selection and{" "}
                        <strong className="font-medium text-foreground">
                          excluded by default
                        </strong>
                        .
                      </div>
                      <div className="flex items-start gap-3">
                        <Checkbox
                          id="adjust-include-negotiated"
                          checked={includeNegotiated}
                          onCheckedChange={(checked) =>
                            setIncludeNegotiated(checked === true)
                          }
                        />
                        <Label
                          htmlFor="adjust-include-negotiated"
                          className="font-normal leading-5"
                        >
                          Include negotiated deals anyway — this changes agreed
                          customer prices.
                        </Label>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </section>
          ) : (
            <section className="py-5">
              <p className="text-xs text-muted-foreground">
                {affected.length} row{affected.length === 1 ? "" : "s"} · effective{" "}
                {from}
                {revertOn ? ` · auto-reverts ${revertOn}` : ""}
              </p>
              <div className="mt-3 divide-y divide-border/70 border-y border-border/70">
                {affected.map((row) => (
                  <div
                    key={row.id}
                    className="flex items-start justify-between gap-6 py-3 text-sm"
                  >
                    <span className="min-w-0 text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {productName(row)}
                      </span>{" "}
                      · {rowLabel(db, row)}
                    </span>
                    <span className="shrink-0 text-right tabular-nums">
                      <span className="text-muted-foreground line-through">
                        {money(row.amount)}
                      </span>{" "}
                      <span className="font-medium">
                        {money(computeAdjusted(row.amount, kind, numericValue, round))}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
              <ReviewConfirm
                id="adjust-confirm"
                checked={confirmed}
                onCheckedChange={setConfirmed}
              >
                I have reviewed the old → new amounts for every affected row.
              </ReviewConfirm>
            </section>
          )}
        </div>

        <DialogFooter className="shrink-0 border-t border-border px-6 py-4">
          {step === "form" ? (
            <>
              <Button variant="outline" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button
                disabled={affected.length === 0 || valueInvalid}
                onClick={() => setStep("review")}
              >
                Review {affected.length} change{affected.length === 1 ? "" : "s"}
                <CaretRight className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep("form")}>
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
              <Button
                disabled={!confirmed}
                onClick={() => {
                  onApply(
                    affected.map((row) => row.id),
                    {
                      kind,
                      value: numericValue,
                      from,
                      revertOn: revertOn || undefined,
                      round,
                    },
                  )
                  toast.success("Price adjustment scheduled", {
                    description: `${affected.length} rows · effective ${from} · audit recorded`,
                  })
                  close(false)
                }}
              >
                Schedule for {from}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// --- 3. Vary this price (§4.2, inline condition creation) ---

const CREATE_VALUE = "__create__"

function ConditionSelect({
  id,
  label,
  options,
  value,
  custom,
  onValueChange,
  onCustomChange,
}: {
  id: string
  label: string
  options: readonly string[]
  value: string
  custom: string
  onValueChange: (value: string) => void
  onCustomChange: (value: string) => void
}) {
  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="any">Any</SelectItem>
          {options.map((entry) => (
            <SelectItem key={entry} value={entry}>
              {entry}
            </SelectItem>
          ))}
          <SelectItem value={CREATE_VALUE}>+ Create new…</SelectItem>
        </SelectContent>
      </Select>
      {value === CREATE_VALUE && (
        <Input
          autoFocus
          value={custom}
          onChange={(event) => onCustomChange(event.target.value)}
          placeholder={`New ${label.toLowerCase()}`}
        />
      )}
    </div>
  )
}

export function VaryPriceDialog({
  open,
  onOpenChange,
  product,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  product: Product
  onAdd: (row: PriceRow) => void
}) {
  const [zone, setZone] = useState("any")
  const [zoneCustom, setZoneCustom] = useState("")
  const [customerType, setCustomerType] = useState("any")
  const [customerTypeCustom, setCustomerTypeCustom] = useState("")
  const [containerType, setContainerType] = useState("any")
  const [containerTypeCustom, setContainerTypeCustom] = useState("")
  const [wasteFraction, setWasteFraction] = useState("any")
  const [wasteFractionCustom, setWasteFractionCustom] = useState("")
  const [amount, setAmount] = useState("")
  const [from, setFrom] = useState(PROTO_TODAY)
  const [tag, setTag] = useState<string>(PRICE_LIST_TAGS[0])

  const resolve = (value: string, custom: string) =>
    value === CREATE_VALUE
      ? custom.trim() || undefined
      : value === "any"
        ? undefined
        : value

  const resolvedZone = resolve(zone, zoneCustom)
  const resolvedCustomerType = resolve(customerType, customerTypeCustom)
  const resolvedContainerType = resolve(containerType, containerTypeCustom)
  const resolvedWasteFraction = resolve(wasteFraction, wasteFractionCustom)

  const conditions: PriceConditions = {
    ...(resolvedZone ? { zone: resolvedZone } : {}),
    ...(resolvedCustomerType ? { customerType: resolvedCustomerType } : {}),
    ...(resolvedContainerType ? { containerType: resolvedContainerType } : {}),
    ...(resolvedWasteFraction ? { wasteFraction: resolvedWasteFraction } : {}),
  }
  const hasCondition = Object.keys(conditions).length > 0
  const numericAmount = Number(amount)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 border-b border-border px-6 py-5 pr-12">
          <DialogTitle>Vary this price</DialogTitle>
          <DialogDescription>
            Add a condition row for {product.name}. The most specific row wins.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6">
          <section className="py-5">
            <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
              <ConditionSelect
                id="vary-zone"
                label="Zone"
                options={ZONES}
                value={zone}
                custom={zoneCustom}
                onValueChange={setZone}
                onCustomChange={setZoneCustom}
              />
              <ConditionSelect
                id="vary-customer-type"
                label="Customer type"
                options={CUSTOMER_TYPES}
                value={customerType}
                custom={customerTypeCustom}
                onValueChange={setCustomerType}
                onCustomChange={setCustomerTypeCustom}
              />
              <ConditionSelect
                id="vary-container-type"
                label="Container type"
                options={CONTAINER_TYPES}
                value={containerType}
                custom={containerTypeCustom}
                onValueChange={setContainerType}
                onCustomChange={setContainerTypeCustom}
              />
              <ConditionSelect
                id="vary-waste-fraction"
                label="Waste fraction"
                options={WASTE_FRACTIONS}
                value={wasteFraction}
                custom={wasteFractionCustom}
                onValueChange={setWasteFraction}
                onCustomChange={setWasteFractionCustom}
              />
              <div className="grid content-start gap-2">
                <Label htmlFor="vary-amount">
                  Amount (€ {unitSuffix(product.unit)})
                </Label>
                <Input
                  id="vary-amount"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="grid content-start gap-2">
                <Label htmlFor="vary-from">Effective from</Label>
                <Input
                  id="vary-from"
                  type="date"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </div>
              <div className="grid content-start gap-2">
                <Label htmlFor="vary-tag">Price list tag (optional)</Label>
                <Select value={tag} onValueChange={setTag}>
                  <SelectTrigger id="vary-tag">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No tag</SelectItem>
                    {PRICE_LIST_TAGS.map((entry) => (
                      <SelectItem key={entry} value={entry}>
                        {entry}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {!hasCondition && (
              <p className="mt-4 text-xs text-muted-foreground">
                Pick at least one condition — a row with no conditions is the
                default price.
              </p>
            )}
          </section>
        </div>
        <DialogFooter className="shrink-0 border-t border-border px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              !hasCondition || !Number.isFinite(numericAmount) || numericAmount <= 0
            }
            onClick={() => {
              onAdd({
                id: protoId("row"),
                productId: product.id,
                amount: numericAmount,
                conditions,
                effectiveFrom: from,
                tag: tag === "none" ? undefined : tag,
              })
              toast.success("Variation added")
              onOpenChange(false)
            }}
          >
            <Plus className="h-4 w-4" weight="bold" /> Add variation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// --- 4. Schedule a change ---

export function ScheduleChangeDialog({
  open,
  onOpenChange,
  db,
  row,
  onSchedule,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  db: PrototypeDb
  row: PriceRow
  onSchedule: (
    rowId: string,
    change: { newAmount: number; from: string; revertOn?: string; note: string },
  ) => void
}) {
  const [amount, setAmount] = useState("")
  const [from, setFrom] = useState("2027-01-01")
  const [revertOn, setRevertOn] = useState("")
  const numericAmount = Number(amount)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="shrink-0 border-b border-border px-6 py-5 pr-12">
          <DialogTitle>Schedule a change</DialogTitle>
          <DialogDescription>
            Schedule a future price for {rowLabel(db, row)}.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6">
          <section className="py-5">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <ConditionChips row={row} />
                <ScheduledChip row={row} />
              </div>
              <span className="shrink-0 text-sm text-muted-foreground">
                currently{" "}
                <span className="font-medium tabular-nums text-foreground">
                  {money(row.amount)}
                </span>
              </span>
            </div>
            <div className="mt-5 grid gap-x-4 gap-y-5 sm:grid-cols-2">
              <div className="grid content-start gap-2">
                <Label htmlFor="schedule-amount">New amount (€)</Label>
                <Input
                  id="schedule-amount"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder={String(row.amount)}
                />
              </div>
              <div className="grid content-start gap-2">
                <Label htmlFor="schedule-from">Effective from</Label>
                <Input
                  id="schedule-from"
                  type="date"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </div>
              <div className="grid content-start gap-2 sm:col-span-2">
                <Label htmlFor="schedule-revert">Auto-revert on (optional)</Label>
                <Input
                  id="schedule-revert"
                  type="date"
                  value={revertOn}
                  onChange={(event) => setRevertOn(event.target.value)}
                />
              </div>
            </div>
          </section>
        </div>
        <DialogFooter className="shrink-0 border-t border-border px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!Number.isFinite(numericAmount) || numericAmount <= 0}
            onClick={() => {
              onSchedule(row.id, {
                newAmount: numericAmount,
                from,
                revertOn: revertOn || undefined,
                note: "Scheduled change",
              })
              toast.success("Change scheduled", {
                description: `${money(numericAmount)} from ${from}`,
              })
              onOpenChange(false)
            }}
          >
            Schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// --- 5. Negotiated deal ---

export function NegotiatedDealDialog({
  open,
  onOpenChange,
  product,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  product: Product
  onAdd: (row: PriceRow) => void
}) {
  const [customer, setCustomer] = useState<string>(KNOWN_CUSTOMERS[0])
  const [amount, setAmount] = useState("")
  const [from, setFrom] = useState(PROTO_TODAY)
  const numericAmount = Number(amount)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="shrink-0 border-b border-border px-6 py-5 pr-12">
          <DialogTitle>Negotiated deal</DialogTitle>
          <DialogDescription>
            A customer-scoped override for {product.name}. It always wins for this
            customer and is locked against bulk adjustments by default. Also appears
            on the customer&apos;s Agreement.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6">
          <section className="py-5">
            <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
              <div className="grid content-start gap-2 sm:col-span-2">
                <Label htmlFor="deal-customer">Customer</Label>
                <Select value={customer} onValueChange={setCustomer}>
                  <SelectTrigger id="deal-customer">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KNOWN_CUSTOMERS.map((entry) => (
                      <SelectItem key={entry} value={entry}>
                        {entry}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid content-start gap-2">
                <Label htmlFor="deal-amount">
                  Amount (€ {unitSuffix(product.unit)})
                </Label>
                <Input
                  id="deal-amount"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="grid content-start gap-2">
                <Label htmlFor="deal-from">Effective from</Label>
                <Input
                  id="deal-from"
                  type="date"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </div>
            </div>
          </section>
        </div>
        <DialogFooter className="shrink-0 border-t border-border px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!Number.isFinite(numericAmount) || numericAmount <= 0}
            onClick={() => {
              onAdd({
                id: protoId("row"),
                productId: product.id,
                amount: numericAmount,
                conditions: {},
                negotiatedCustomer: customer,
                effectiveFrom: from,
                tag: `Negotiated · ${customer.split(" ")[0]}`,
              })
              toast.success("Negotiated deal added", { description: customer })
              onOpenChange(false)
            }}
          >
            <Handshake className="h-4 w-4" /> Add deal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// --- 6. Quick create product (§4.2, "born priced") ---

export function QuickCreateProductDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (product: Product, defaultRow: PriceRow) => void
}) {
  const [step, setStep] = useState<"form" | "review">("form")
  const [confirmed, setConfirmed] = useState(false)
  const [name, setName] = useState("")
  const [type, setType] = useState<Product["type"]>("Container collection")
  const [amount, setAmount] = useState("")
  const numericAmount = Number(amount)
  const unit: Product["unit"] =
    type === "Container collection"
      ? "pickup"
      : type === "Recurring service"
        ? "month"
        : "job"
  const derivedCode = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 12)
  const invoiceCode = derivedCode
    ? `${COMMERCIAL_DEFAULTS.invoiceCodePrefix}${derivedCode}`
    : ""
  const vatPercent = Math.round(COMMERCIAL_DEFAULTS.defaultVatRate * 100)

  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setStep("form")
      setConfirmed(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b border-border px-6 py-5 pr-12">
          <DialogTitle>New product</DialogTitle>
          <DialogDescription>
            {step === "form"
              ? "A product is born priced — no conditions means it applies to everyone."
              : "Review before creating."}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6">
          {step === "form" ? (
            <section className="py-5">
              <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
                <div className="grid content-start gap-2 sm:col-span-2">
                  <Label htmlFor="create-name">Name</Label>
                  <Input
                    id="create-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="e.g. Garden waste · 140L bin"
                  />
                </div>
                <div className="grid content-start gap-2">
                  <Label htmlFor="create-type">Type</Label>
                  <Select
                    value={type}
                    onValueChange={(next) => setType(next as Product["type"])}
                  >
                    <SelectTrigger id="create-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Container collection">
                        Container collection
                      </SelectItem>
                      <SelectItem value="Recurring service">
                        Recurring service
                      </SelectItem>
                      <SelectItem value="Additional service">
                        Additional service
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid content-start gap-2">
                  <Label htmlFor="create-amount">
                    Price (€{unitSuffix(unit)})
                  </Label>
                  <Input
                    id="create-amount"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    placeholder="0.00"
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <p className="text-xs leading-5 text-muted-foreground">
                    VAT {vatPercent}% · invoice name &ldquo;{name || "…"}&rdquo; ·
                    code {invoiceCode || "…"} — editable on the product afterwards.
                  </p>
                  <p className="text-xs leading-5 text-muted-foreground">
                    VAT and invoice defaults come from{" "}
                    <CommercialDefaultsLink>Commercial defaults</CommercialDefaultsLink>{" "}
                    — set once, used everywhere.
                  </p>
                </div>
              </div>
            </section>
          ) : (
            <section className="py-5">
              <div className="divide-y divide-border/70 border-y border-border/70">
                <ReviewRow label="Name">{name}</ReviewRow>
                <ReviewRow label="Type">{type}</ReviewRow>
                <ReviewRow label="Default price">
                  <span className="tabular-nums">
                    {money(numericAmount)}
                    {unitSuffix(unit)}
                  </span>{" "}
                  · everyone
                </ReviewRow>
                <ReviewRow label="VAT">{vatPercent}%</ReviewRow>
                <ReviewRow label="Invoice code">{invoiceCode}</ReviewRow>
              </div>
              <ReviewConfirm
                id="create-confirm"
                checked={confirmed}
                onCheckedChange={setConfirmed}
              >
                Create this product born priced — the default row applies to
                everyone.
              </ReviewConfirm>
            </section>
          )}
        </div>
        <DialogFooter className="shrink-0 border-t border-border px-6 py-4">
          {step === "form" ? (
            <>
              <Button variant="outline" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button
                disabled={
                  !name.trim() ||
                  !Number.isFinite(numericAmount) ||
                  numericAmount <= 0
                }
                onClick={() => setStep("review")}
              >
                Review <CaretRight className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep("form")}>
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
              <Button
                disabled={!confirmed}
                onClick={() => {
                  const productId = protoId("p")
                  onCreate(
                    {
                      id: productId,
                      name: name.trim(),
                      type,
                      unit,
                      vatRate: COMMERCIAL_DEFAULTS.defaultVatRate,
                      invoiceName: name.trim(),
                      invoiceCode,
                      status: "Active",
                      extras: { materials: [], services: [], serviceLevels: [] },
                      history: [
                        {
                          at: PROTO_TODAY,
                          who: "You",
                          what: "Product created (Quick create)",
                        },
                      ],
                    },
                    {
                      id: protoId("row"),
                      productId,
                      amount: numericAmount,
                      conditions: {},
                      effectiveFrom: PROTO_TODAY,
                      tag: PRICE_LIST_TAGS[0],
                    },
                  )
                  toast.success("Product created — born priced", {
                    description: `${name.trim()} · ${money(numericAmount)}${unitSuffix(unit)}`,
                  })
                  close(false)
                }}
              >
                Create product
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

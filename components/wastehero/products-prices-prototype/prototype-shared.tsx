"use client"

// PROTOTYPE — throwaway code, do not ship.
// Shared chrome, chips and the Contractor prices (PAY) lane for the Products &
// Prices redesign prototype, restyled to the app's BusinessWorkspace
// conventions per the spec §10 verdict (existing UI primitives only).
// Flow dialogs live in prototype-dialogs.tsx; the one-time-setup surface lives
// in /settings → Commercial defaults (settings-commercial-defaults.tsx).

import { useState, type ReactNode } from "react"
import { toast } from "sonner"
import {
  Clock,
  Handshake,
  Info,
  LockSimple,
  Plus,
} from "@phosphor-icons/react/dist/ssr"

import { cn } from "@/lib/utils"
import { statusClasses } from "@/components/wastehero/business-record-views"
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { SidebarTrigger } from "@/components/ui/sidebar"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Breadcrumbs } from "@/components/projects/Breadcrumbs"

import {
  PROTO_TODAY,
  RESOLUTION_RULE,
  conditionLabels,
  money,
  unitSuffix,
  type ContractorPrice,
  type PriceRow,
  type Product,
  type ProductStatus,
  type ProductType,
  type PrototypeDb,
} from "./prototype-data"

// Deep link into the one-time-setup pane (spec §4.1).
export const COMMERCIAL_SETTINGS_HREF = `/settings?pane=pricing&from=${encodeURIComponent(
  "/commercial?variant=a",
)}`

export type Lane = "products" | "contractor-prices" | "invoices"

export type PrototypeActions = {
  setDefaultPrice: (productId: string, amount: number) => void
  addPriceRow: (row: PriceRow) => void
  scheduleChange: (
    rowId: string,
    change: { newAmount: number; from: string; revertOn?: string; note: string },
  ) => void
  adjustPrices: (
    rowIds: string[],
    opts: {
      kind: "percent" | "fixed" | "multiply"
      value: number
      from: string
      revertOn?: string
      round: boolean
    },
  ) => void
  applyIndex: (
    rateIds: string[],
    opts: { label: string; percent: number; from: string; base: "bid" | "current fee" },
  ) => void
  createProduct: (product: Product, defaultRow: PriceRow) => void
}

let protoIdCounter = 0
export function protoId(prefix: string) {
  protoIdCounter += 1
  return `${prefix}-new-${protoIdCounter}`
}

// Engine math lives in prototype-data.ts (dependency-free for headless checks);
// re-exported here so UI code has one import surface.
export { computeAdjusted } from "./prototype-data"

export function rowLabel(_db: PrototypeDb, row: PriceRow) {
  if (row.negotiatedCustomer) return `Negotiated · ${row.negotiatedCustomer}`
  const labels = conditionLabels(row.conditions)
  return labels.length > 0 ? labels.join(" · ") : "Everyone"
}

// --- Workspace chrome (mirrors business-workspace.tsx) ---

export function WorkspaceFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col min-h-0 bg-background mx-2 my-2 border border-sidebar rounded-lg min-w-0">
      {children}
    </div>
  )
}

const LANES: { key: Lane; label: string }[] = [
  { key: "products", label: "Products" },
  { key: "contractor-prices", label: "Contractor prices" },
  { key: "invoices", label: "Invoices" },
]

export function PrototypeChrome({
  lane,
  onLaneChange,
  headerActions,
  toolbar,
  children,
}: {
  lane: Lane
  onLaneChange: (lane: Lane) => void
  headerActions?: ReactNode
  toolbar?: ReactNode
  children: ReactNode
}) {
  const activeLabel = LANES.find((entry) => entry.key === lane)?.label ?? "Products"
  return (
    <>
      <header className="flex flex-col border-b border-border/40">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
          <div className="flex items-center gap-3 min-w-0">
            <SidebarTrigger className="h-8 w-8 rounded-lg hover:bg-accent text-muted-foreground" />
            <Breadcrumbs items={[{ label: "Commercial" }, { label: activeLabel }]} />
            <Badge
              variant="outline"
              className="rounded-full px-2 py-0.5 text-[11px] font-normal text-muted-foreground"
            >
              Prototype
            </Badge>
          </div>
          <div className="flex items-center gap-2">{headerActions}</div>
        </div>
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="flex items-center gap-1 overflow-x-auto pb-1">
            <Tabs value={lane} onValueChange={(next) => onLaneChange(next as Lane)}>
              <TabsList className="inline-flex h-8 bg-muted rounded-full px-1 py-0.5 text-xs border border-border/50">
                {LANES.map((entry) => (
                  <TabsTrigger
                    key={entry.key}
                    value={entry.key}
                    className="rounded-full px-3 whitespace-nowrap"
                  >
                    {entry.label}
                  </TabsTrigger>
                ))}
                <TabsTrigger
                  value="settlements"
                  disabled
                  title="Unchanged by this redesign — out of prototype scope"
                  className="rounded-full px-3 whitespace-nowrap"
                >
                  Settlements
                </TabsTrigger>
                <TabsTrigger
                  value="events"
                  disabled
                  title="Unchanged by this redesign — out of prototype scope"
                  className="rounded-full px-3 whitespace-nowrap"
                >
                  Billable events
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          {toolbar}
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <div className="mx-auto max-w-[1500px] space-y-4">{children}</div>
      </div>
    </>
  )
}

// --- Chips (statusClasses + tokens only) ---

export function TypeBadge({ type }: { type: ProductType }) {
  return (
    <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[11px] font-normal">
      {type}
    </Badge>
  )
}

export function StatusBadge({ status }: { status: ProductStatus | string }) {
  return (
    <Badge
      variant="outline"
      className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", statusClasses(status))}
    >
      {status}
    </Badge>
  )
}

export function ConditionChips({ row }: { row: PriceRow }) {
  if (row.negotiatedCustomer) {
    return (
      <Badge variant="secondary" className="rounded-full px-2 py-0.5 text-[11px] font-medium">
        <Handshake className="mr-1 h-3.5 w-3.5" />
        Negotiated · {row.negotiatedCustomer}
        <LockSimple className="ml-1 h-3.5 w-3.5" />
      </Badge>
    )
  }
  const labels = conditionLabels(row.conditions)
  if (labels.length === 0) {
    return (
      <Badge
        variant="outline"
        className="rounded-full px-2 py-0.5 text-[11px] font-normal text-muted-foreground"
      >
        Everyone
      </Badge>
    )
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {labels.map((label) => (
        <Badge
          key={label}
          variant="outline"
          className="rounded-full px-2 py-0.5 text-[11px] font-normal"
        >
          {label}
        </Badge>
      ))}
    </span>
  )
}

export function ScheduledChip({ row }: { row: PriceRow }) {
  if (!row.scheduled) return null
  return (
    <Badge
      variant="outline"
      className={cn(
        "whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
        statusClasses("scheduled"),
      )}
      title={row.scheduled.note}
    >
      <Clock className="mr-1 h-3.5 w-3.5" />
      {money(row.scheduled.newAmount)} from {row.scheduled.from}
    </Badge>
  )
}

export function TagChip({ tag }: { tag?: string }) {
  if (!tag) return <span className="text-xs text-muted-foreground">—</span>
  return (
    <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[11px] font-normal">
      {tag}
    </Badge>
  )
}

export function RuleCallout() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <p className="text-xs leading-5 text-muted-foreground">{RESOLUTION_RULE}</p>
    </div>
  )
}

export function InlinePriceCell({
  amount,
  unit,
  onChange,
}: {
  amount: number
  unit: string
  onChange: (amount: number) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")

  const commit = () => {
    const parsed = Number.parseFloat(draft.replace(",", "."))
    setEditing(false)
    if (!Number.isNaN(parsed) && parsed >= 0 && parsed !== amount) {
      onChange(Math.round(parsed * 100) / 100)
    }
  }

  if (editing) {
    return (
      <Input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          // Swallow the key so the row (role="button") doesn't also activate.
          if (event.key === "Enter") {
            event.preventDefault()
            event.stopPropagation()
            commit()
          }
          if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            setEditing(false)
          }
        }}
        onClick={(event) => event.stopPropagation()}
        className="ml-auto h-8 w-24 text-right text-sm tabular-nums"
        aria-label="Default price"
      />
    )
  }

  return (
    <button
      type="button"
      title="Click to edit the default price"
      onClick={(event) => {
        event.stopPropagation()
        setDraft(String(amount))
        setEditing(true)
      }}
      className="rounded-md px-1.5 py-0.5 text-sm font-medium tabular-nums hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      {money(amount)}
      <span className="text-xs font-normal text-muted-foreground">{unit}</span>
    </button>
  )
}

// --- PAY lane: Contractor prices (spec §4.3) ---

export function ContractorPricesLane({
  db,
  rates,
  onApplyIndex,
}: {
  db: PrototypeDb
  rates: ContractorPrice[]
  onApplyIndex: PrototypeActions["applyIndex"]
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [applyOpen, setApplyOpen] = useState(false)
  const [openRateId, setOpenRateId] = useState<string | null>(null)

  const openRate = db.contractorPrices.find((rate) => rate.id === openRateId)
  const selectedRates = db.contractorPrices.filter((rate) => selected.has(rate.id))
  const allVisibleSelected = rates.length > 0 && rates.every((rate) => selected.has(rate.id))

  const toggle = (id: string, checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const toggleAll = (checked: boolean) => {
    setSelected(checked ? new Set(rates.map((rate) => rate.id)) : new Set())
  }

  const productName = (productId: string) =>
    db.products.find((product) => product.id === productId)?.name ?? productId

  return (
    <>
      <section className="overflow-hidden rounded-xl border border-border/60">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <p className="text-xs text-muted-foreground">
            {rates.length} contractor prices · the bid is contractually locked
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                toast.info("New contractor price", {
                  description: "Out of prototype scope — planned with a multi-product step.",
                })
              }
            >
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">New contractor price</span>
            </Button>
            <Button size="sm" disabled={selected.size === 0} onClick={() => setApplyOpen(true)}>
              Apply index{selected.size > 0 ? ` (${selected.size})` : ""}
            </Button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <Table className="min-w-[960px]">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="w-10">
                  <Checkbox
                    checked={allVisibleSelected}
                    onCheckedChange={(checked) => toggleAll(checked === true)}
                    aria-label="Select all contractor prices"
                  />
                </TableHead>
                <TableHead>Contractor</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Contract area</TableHead>
                <TableHead className="text-right">Bid</TableHead>
                <TableHead className="text-right">Current fee</TableHead>
                <TableHead>Valid</TableHead>
                <TableHead>Last indexed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rates.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="h-52 text-center">
                    <div className="flex flex-col items-center gap-2">
                      <LockSimple className="h-6 w-6 text-muted-foreground" />
                      <p className="text-sm font-medium">No matching contractor prices</p>
                      <p className="text-xs text-muted-foreground">
                        Try a different contractor or contract area filter.
                      </p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                rates.map((rate) => (
                  <TableRow
                    key={rate.id}
                    role="button"
                    tabIndex={0}
                    className="cursor-pointer hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
                    onClick={() => setOpenRateId(rate.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault()
                        setOpenRateId(rate.id)
                      }
                    }}
                  >
                    <TableCell className="w-10" onClick={(event) => event.stopPropagation()}>
                      <Checkbox
                        checked={selected.has(rate.id)}
                        onCheckedChange={(checked) => toggle(rate.id, checked === true)}
                        aria-label={`Select ${rate.contractor} · ${productName(rate.productId)}`}
                      />
                    </TableCell>
                    <TableCell className="text-sm font-medium text-foreground">
                      {rate.contractor}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {productName(rate.productId)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className="rounded-full px-2 py-0.5 text-[11px] font-normal"
                      >
                        {rate.contractArea}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right text-sm tabular-nums">
                      <span className="inline-flex items-center gap-1">
                        <LockSimple className="h-3.5 w-3.5 text-muted-foreground" />
                        {money(rate.bid)}
                        <span className="text-xs text-muted-foreground">
                          {unitSuffix(rate.unit)}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right text-sm font-medium tabular-nums">
                      {money(rate.currentFee)}
                      {rate.lastIndexNote ? (
                        <Badge
                          variant="outline"
                          className="ml-2 rounded-full px-2 py-0.5 text-[11px] font-normal text-muted-foreground"
                        >
                          {rate.lastIndexNote}
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {rate.validFrom} → {rate.validUntil}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {rate.lastIndexed ?? "—"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <ApplyIndexDialog
        open={applyOpen}
        onOpenChange={setApplyOpen}
        db={db}
        rates={selectedRates}
        onApply={(rateIds, opts) => {
          onApplyIndex(rateIds, opts)
          setSelected(new Set())
        }}
      />
      <RateDetailSheet
        rate={openRate}
        db={db}
        onClose={() => setOpenRateId(null)}
      />
    </>
  )
}

function RateDetailSheet({
  rate,
  db,
  onClose,
}: {
  rate?: ContractorPrice
  db: PrototypeDb
  onClose: () => void
}) {
  const productName = rate
    ? (db.products.find((product) => product.id === rate.productId)?.name ?? rate.productId)
    : ""
  const validityStatus = rate && rate.validUntil >= PROTO_TODAY ? "Active" : "Expired"

  return (
    <Sheet open={Boolean(rate)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        {rate ? (
          <>
            <SheetHeader className="border-b border-border px-5 py-4 pr-12 text-left">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px] font-medium",
                    statusClasses(validityStatus),
                  )}
                >
                  {validityStatus}
                </Badge>
                <Badge
                  variant="outline"
                  className="rounded-full px-2 py-0.5 text-[11px] font-normal"
                >
                  {rate.contractArea}
                </Badge>
              </div>
              <SheetTitle className="pt-1 text-xl">
                {rate.contractor} · {productName}
              </SheetTitle>
              <SheetDescription>
                Contractor price — the bid is contractually immutable; indexation moves the
                current fee only.
              </SheetDescription>
            </SheetHeader>
            <div className="flex-1 space-y-8 overflow-y-auto px-5 py-6">
              <section className="space-y-4">
                <h3 className="text-sm font-semibold">Fee</h3>
                <div className="divide-y divide-border/60 border-y border-border/60 py-1">
                  <div className="flex items-start justify-between gap-6 py-3 text-sm">
                    <span className="text-muted-foreground">Bid</span>
                    <span className="inline-flex items-center gap-1.5 font-medium tabular-nums">
                      <LockSimple className="h-3.5 w-3.5 text-muted-foreground" />
                      {money(rate.bid)}
                      {unitSuffix(rate.unit)}
                      <span className="text-xs font-normal text-muted-foreground">
                        · immutable
                      </span>
                    </span>
                  </div>
                  <div className="flex items-start justify-between gap-6 py-3 text-sm">
                    <span className="text-muted-foreground">Current fee</span>
                    <span className="font-medium tabular-nums">
                      {money(rate.currentFee)}
                      {unitSuffix(rate.unit)}
                      {rate.lastIndexNote ? (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {rate.lastIndexNote}
                        </span>
                      ) : null}
                    </span>
                  </div>
                  <div className="flex items-start justify-between gap-6 py-3 text-sm">
                    <span className="text-muted-foreground">Valid</span>
                    <span className="font-medium">
                      {rate.validFrom} → {rate.validUntil}
                    </span>
                  </div>
                  <div className="flex items-start justify-between gap-6 py-3 text-sm">
                    <span className="text-muted-foreground">Last indexed</span>
                    <span className="font-medium">{rate.lastIndexed ?? "Never"}</span>
                  </div>
                </div>
              </section>

              <section className="space-y-4">
                <h3 className="text-sm font-semibold">Fee components</h3>
                <div className="divide-y divide-border/60 border-y border-border/60 py-1">
                  {rate.components.map((component) => (
                    <div
                      key={component.label}
                      className="flex items-start justify-between gap-6 py-3 text-sm"
                    >
                      <span className="text-muted-foreground">{component.label}</span>
                      <span className="max-w-[60%] text-right font-medium">
                        {component.detail}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  Metered quantities are measured fixture values — quantity capture belongs to
                  Settlements.
                </p>
              </section>

              <section className="space-y-4">
                <h3 className="text-sm font-semibold">Indexation history</h3>
                {rate.indexation.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Never indexed — the current fee still equals the bid.
                  </p>
                ) : (
                  <div className="divide-y divide-border/60 border-y border-border/60 py-1">
                    {rate.indexation.map((entry, index) => (
                      <div
                        key={index}
                        className="flex items-start justify-between gap-6 py-3 text-sm"
                      >
                        <span className="text-muted-foreground">
                          {entry.at} · {entry.note}
                        </span>
                        <span className="whitespace-nowrap font-medium tabular-nums">
                          {money(entry.from)} → {money(entry.to)}
                          <span className="ml-1 text-xs font-normal text-muted-foreground">
                            (base: {entry.base})
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
            <SheetFooter className="flex-row items-center justify-between border-t border-border px-5 py-4">
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function ApplyIndexDialog({
  open,
  onOpenChange,
  db,
  rates,
  onApply,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  db: PrototypeDb
  rates: ContractorPrice[]
  onApply: PrototypeActions["applyIndex"]
}) {
  const [step, setStep] = useState<"form" | "review">("form")
  const [indexKind, setIndexKind] = useState("CPI")
  const [customLabel, setCustomLabel] = useState("")
  const [percent, setPercent] = useState("2.0")
  const [base, setBase] = useState<"bid" | "current fee">("current fee")
  const [from, setFrom] = useState("2027-01-01")

  const label = indexKind === "Custom" ? customLabel.trim() || "Custom index" : indexKind
  const parsedPercent = Number.parseFloat(percent.replace(",", "."))
  const valid = !Number.isNaN(parsedPercent) && parsedPercent !== 0 && from.length > 0

  const productName = (productId: string) =>
    db.products.find((product) => product.id === productId)?.name ?? productId

  const newFee = (rate: ContractorPrice) => {
    const baseAmount = base === "bid" ? rate.bid : rate.currentFee
    return Math.round(baseAmount * (1 + parsedPercent / 100) * 100) / 100
  }

  const reset = () => {
    setStep("form")
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) reset()
      }}
    >
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b border-border px-6 py-5 pr-12">
          <DialogTitle>Apply index</DialogTitle>
          <DialogDescription>
            {step === "form"
              ? `Index the current fee of ${rates.length} contractor price${
                  rates.length === 1 ? "" : "s"
                }. The bid never moves.`
              : "Review the computed fees before applying."}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6">
          {step === "form" ? (
            <section className="py-5">
              <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
                <div className="grid content-start gap-2">
                  <Label>Index</Label>
                  <Select value={indexKind} onValueChange={setIndexKind}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CPI">CPI</SelectItem>
                      <SelectItem value="Fuel">Fuel</SelectItem>
                      <SelectItem value="Custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid content-start gap-2">
                  <Label>Index change (%)</Label>
                  <Input
                    value={percent}
                    onChange={(event) => setPercent(event.target.value)}
                    inputMode="decimal"
                  />
                </div>
                {indexKind === "Custom" ? (
                  <div className="grid content-start gap-2 sm:col-span-2">
                    <Label>Custom index name</Label>
                    <Input
                      value={customLabel}
                      onChange={(event) => setCustomLabel(event.target.value)}
                      placeholder="e.g. Wage index"
                    />
                  </div>
                ) : null}
                <div className="grid content-start gap-2">
                  <Label>Effective from</Label>
                  <Input
                    type="date"
                    value={from}
                    onChange={(event) => setFrom(event.target.value)}
                  />
                </div>
                <div className="grid content-start gap-2 sm:col-span-2">
                  <Label>Base</Label>
                  <RadioGroup
                    value={base}
                    onValueChange={(next) => setBase(next as "bid" | "current fee")}
                    className="gap-3"
                  >
                    <div className="flex items-start gap-3">
                      <RadioGroupItem value="current fee" id="apply-index-base-current" />
                      <Label htmlFor="apply-index-base-current" className="font-normal leading-5">
                        Current fee
                        <span className="block text-xs text-muted-foreground">
                          Compounds on top of earlier index runs.
                        </span>
                      </Label>
                    </div>
                    <div className="flex items-start gap-3">
                      <RadioGroupItem value="bid" id="apply-index-base-bid" />
                      <Label htmlFor="apply-index-base-bid" className="font-normal leading-5">
                        Original bid
                        <span className="block text-xs text-muted-foreground">
                          Recomputes from the locked bid — earlier runs do not compound.
                        </span>
                      </Label>
                    </div>
                  </RadioGroup>
                </div>
              </div>
            </section>
          ) : (
            <section className="py-5">
              <div className="overflow-hidden rounded-xl border border-border/60">
                <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead>Contractor price</TableHead>
                      <TableHead className="text-right">Current fee</TableHead>
                      <TableHead className="text-right">New current fee</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rates.map((rate) => (
                      <TableRow key={rate.id} className="hover:bg-transparent">
                        <TableCell className="text-sm">
                          <span className="font-medium text-foreground">{rate.contractor}</span>
                          <span className="block text-xs text-muted-foreground">
                            {productName(rate.productId)} · {rate.contractArea}
                          </span>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right text-sm tabular-nums text-muted-foreground">
                          {money(rate.currentFee)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right text-sm font-medium tabular-nums">
                          {money(newFee(rate))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </div>
              </div>
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                {label} {parsedPercent > 0 ? "+" : ""}
                {parsedPercent}% on the {base}, effective {from}. Each run is appended to the
                row&apos;s indexation history.
              </p>
            </section>
          )}
        </div>

        <DialogFooter className="shrink-0 border-t border-border px-6 py-4">
          {step === "form" ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button disabled={!valid || rates.length === 0} onClick={() => setStep("review")}>
                Review
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep("form")}>
                Back
              </Button>
              <Button
                onClick={() => {
                  onApply(
                    rates.map((rate) => rate.id),
                    { label, percent: parsedPercent, from, base },
                  )
                  toast.success("Index applied", {
                    description: `${label} ${parsedPercent > 0 ? "+" : ""}${parsedPercent}% on ${
                      rates.length
                    } contractor price${rates.length === 1 ? "" : "s"}.`,
                  })
                  onOpenChange(false)
                  reset()
                }}
              >
                Apply index
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

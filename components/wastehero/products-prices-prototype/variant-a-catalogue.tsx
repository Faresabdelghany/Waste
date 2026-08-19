"use client"

// PROTOTYPE — throwaway code, do not ship.
// The chosen Variant A — "Catalogue + detail page" (spec §10 verdict): Products
// table with the default price inline; row click opens a full-page product
// detail (Route-details precedent). Recurring work lives here in Commercial;
// one-time setup lives in /settings → Commercial defaults.

import { useMemo, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import {
  CaretDown,
  Clock,
  GearSix,
  Handshake,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Receipt,
} from "@phosphor-icons/react/dist/ssr"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SidebarTrigger } from "@/components/ui/sidebar"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Breadcrumbs } from "@/components/projects/Breadcrumbs"

import {
  INVOICES,
  ZONES,
  defaultRowOf,
  explainPrice,
  money,
  rowsOf,
  unitSuffix,
  variationsOf,
  type ExplainInput,
  type PriceRow,
  type Product,
  type PrototypeDb,
} from "./prototype-data"
import {
  COMMERCIAL_SETTINGS_HREF,
  ConditionChips,
  ContractorPricesLane,
  InlinePriceCell,
  PrototypeChrome,
  RuleCallout,
  ScheduledChip,
  StatusBadge,
  TagChip,
  TypeBadge,
  WorkspaceFrame,
  type Lane,
  type PrototypeActions,
} from "./prototype-shared"
import {
  AdjustPricesDialog,
  ExplainPriceSheet,
  NegotiatedDealDialog,
  QuickCreateProductDialog,
  ScheduleChangeDialog,
  VaryPriceDialog,
} from "./prototype-dialogs"

type VariantProps = {
  db: PrototypeDb
  actions: PrototypeActions
  lane: Lane
  onLaneChange: (lane: Lane) => void
  initialTag?: string
}

const PRODUCT_TYPES = [
  "Container collection",
  "Recurring service",
  "Additional service",
] as const
const PRODUCT_STATUSES = ["Active", "Draft", "Inactive"] as const

export function VariantACatalogue({
  db,
  actions,
  lane,
  onLaneChange,
  initialTag,
}: VariantProps) {
  const [openProductId, setOpenProductId] = useState<string | null>(null)
  const [explain, setExplain] = useState<{
    seed: number
    initial?: Partial<ExplainInput>
  } | null>(null)
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Products lane filters (spec §4.2: type, status, price-list tag, zone).
  const allTags = useMemo(
    () =>
      [...new Set(db.priceRows.map((row) => row.tag).filter(Boolean))].sort() as string[],
    [db],
  )
  const [query, setQuery] = useState("")
  const [type, setType] = useState("all")
  const [tag, setTag] = useState(() =>
    initialTag && allTags.includes(initialTag) ? initialTag : "all",
  )
  const [zone, setZone] = useState("all")
  const [status, setStatus] = useState("all")

  // PAY lane filters (spec §4.3: by contractor or contract area).
  const [payContractor, setPayContractor] = useState("all")
  const [payArea, setPayArea] = useState("all")

  const filteredProducts = useMemo(
    () =>
      db.products.filter((product) => {
        if (query && !product.name.toLowerCase().includes(query.toLowerCase())) return false
        if (type !== "all" && product.type !== type) return false
        if (status !== "all" && product.status !== status) return false
        const rows = rowsOf(db, product.id)
        if (tag !== "all" && !rows.some((row) => row.tag === tag)) return false
        if (zone !== "all" && !rows.some((row) => row.conditions.zone === zone)) return false
        return true
      }),
    [db, query, type, tag, zone, status],
  )

  const contractors = useMemo(
    () => [...new Set(db.contractorPrices.map((rate) => rate.contractor))].sort(),
    [db],
  )
  const contractAreas = useMemo(
    () => [...new Set(db.contractorPrices.map((rate) => rate.contractArea))].sort(),
    [db],
  )
  const filteredRates = useMemo(
    () =>
      db.contractorPrices.filter((rate) => {
        if (payContractor !== "all" && rate.contractor !== payContractor) return false
        if (payArea !== "all" && rate.contractArea !== payArea) return false
        return true
      }),
    [db, payContractor, payArea],
  )

  const openProduct = db.products.find((entry) => entry.id === openProductId)
  const adjustRows = db.priceRows.filter((row) => selected.has(row.productId))

  const openExplain = (initial?: Partial<ExplainInput>) =>
    setExplain((previous) => ({ seed: (previous?.seed ?? 0) + 1, initial }))

  const settingsLink = (
    <Button variant="ghost" size="sm" asChild>
      <Link href={COMMERCIAL_SETTINGS_HREF}>
        <GearSix className="h-4 w-4" />
        <span className="hidden sm:inline">Commercial defaults</span>
      </Link>
    </Button>
  )

  const headerActions =
    lane === "products" ? (
      <>
        {settingsLink}
        <Button variant="ghost" size="sm" onClick={() => openExplain()}>
          <Receipt className="h-4 w-4" />
          <span className="hidden sm:inline">Explain a price</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={selected.size === 0}
          onClick={() => setAdjustOpen(true)}
        >
          Adjust prices{selected.size > 0 ? ` (${selected.size})` : ""}
        </Button>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" weight="bold" />
          <span className="hidden sm:inline">New product</span>
        </Button>
      </>
    ) : lane === "invoices" ? (
      <>
        {settingsLink}
        <Button variant="ghost" size="sm" onClick={() => openExplain()}>
          <Receipt className="h-4 w-4" />
          <span className="hidden sm:inline">Explain a price</span>
        </Button>
      </>
    ) : (
      settingsLink
    )

  const toolbar =
    lane === "products" ? (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-1 flex-wrap items-center gap-2 min-w-[260px]">
          <div className="relative min-w-[220px] max-w-sm flex-1">
            <MagnifyingGlass className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search products"
              className="h-8 pl-9 text-sm"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="h-8 w-[170px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {PRODUCT_TYPES.map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {entry}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="h-8 w-[130px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {PRODUCT_STATUSES.map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {entry}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={tag} onValueChange={setTag}>
            <SelectTrigger className="h-8 w-[190px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All price lists</SelectItem>
              {allTags.map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {entry}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={zone} onValueChange={setZone}>
            <SelectTrigger className="h-8 w-[140px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All zones</SelectItem>
              {ZONES.map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {entry}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    ) : lane === "contractor-prices" ? (
      <div className="flex flex-wrap items-center gap-2">
        <Select value={payContractor} onValueChange={setPayContractor}>
          <SelectTrigger className="h-8 w-[190px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All contractors</SelectItem>
            {contractors.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {entry}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={payArea} onValueChange={setPayArea}>
          <SelectTrigger className="h-8 w-[170px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All contract areas</SelectItem>
            {contractAreas.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {entry}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    ) : undefined

  return (
    <WorkspaceFrame>
      {openProduct ? (
        <ProductDetailPage
          db={db}
          actions={actions}
          product={openProduct}
          onBack={() => setOpenProductId(null)}
          onExplain={() => openExplain({ productId: openProduct.id })}
        />
      ) : (
        <PrototypeChrome
          lane={lane}
          onLaneChange={onLaneChange}
          headerActions={headerActions}
          toolbar={toolbar}
        >
          {lane === "products" ? (
            <>
              <section className="flex flex-col gap-1">
                <h1 className="text-lg font-semibold tracking-tight">Products</h1>
                <p className="text-sm text-muted-foreground">
                  The catalogue is the price list — the default price sits on the row,
                  variations live behind the product.
                </p>
              </section>
              <ProductsTable
                db={db}
                actions={actions}
                products={filteredProducts}
                selected={selected}
                onSelectedChange={setSelected}
                onOpen={setOpenProductId}
              />
            </>
          ) : lane === "contractor-prices" ? (
            <>
              <section className="flex flex-col gap-1">
                <h1 className="text-lg font-semibold tracking-tight">Contractor prices</h1>
                <p className="text-sm text-muted-foreground">
                  What we pay per contractor, product and contract area — separate from
                  customer pricing and from settlements.
                </p>
              </section>
              <ContractorPricesLane
                db={db}
                rates={filteredRates}
                onApplyIndex={actions.applyIndex}
              />
            </>
          ) : (
            <>
              <section className="flex flex-col gap-1">
                <h1 className="text-lg font-semibold tracking-tight">Invoices</h1>
                <p className="text-sm text-muted-foreground">
                  Unchanged by the redesign — except every line amount now explains itself.
                </p>
              </section>
              <InvoicesLane db={db} onExplainLine={openExplain} />
            </>
          )}
        </PrototypeChrome>
      )}

      {explain && (
        <ExplainPriceSheet
          key={explain.seed}
          open
          onOpenChange={(next) => !next && setExplain(null)}
          db={db}
          initial={explain.initial}
          onOpenProduct={(productId) => {
            setExplain(null)
            setOpenProductId(productId)
          }}
        />
      )}
      <AdjustPricesDialog
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
        db={db}
        rows={adjustRows}
        onApply={(rowIds, opts) => {
          actions.adjustPrices(rowIds, opts)
          setSelected(new Set())
        }}
      />
      <QuickCreateProductDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={actions.createProduct}
      />
    </WorkspaceFrame>
  )
}

function ProductsTable({
  db,
  actions,
  products,
  selected,
  onSelectedChange,
  onOpen,
}: {
  db: PrototypeDb
  actions: PrototypeActions
  products: Product[]
  selected: Set<string>
  onSelectedChange: (next: Set<string>) => void
  onOpen: (productId: string) => void
}) {
  const allVisibleSelected =
    products.length > 0 && products.every((product) => selected.has(product.id))

  const toggle = (id: string, checked: boolean) => {
    const next = new Set(selected)
    if (checked) next.add(id)
    else next.delete(id)
    onSelectedChange(next)
  }

  const toggleAll = (checked: boolean) => {
    onSelectedChange(checked ? new Set(products.map((product) => product.id)) : new Set())
  }

  return (
    <section className="overflow-hidden rounded-xl border border-border/60">
      <div className="border-b border-border px-4 py-2">
        <p className="text-xs text-muted-foreground">
          {products.length} products · select rows (or select all) to adjust prices in bulk
        </p>
      </div>
      <div className="overflow-x-auto">
        <Table className="min-w-[960px]">
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="w-10">
                <Checkbox
                  checked={allVisibleSelected}
                  onCheckedChange={(checked) => toggleAll(checked === true)}
                  aria-label="Select all products"
                />
              </TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">VAT</TableHead>
              <TableHead>Variations</TableHead>
              <TableHead>Price list</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-52 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <MagnifyingGlass className="h-6 w-6 text-muted-foreground" />
                    <p className="text-sm font-medium">No matching products</p>
                    <p className="text-xs text-muted-foreground">
                      Try a different search or filter.
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              products.map((product) => {
                const defaultRow = defaultRowOf(db, product.id)
                const variations = variationsOf(db, product.id)
                return (
                  <TableRow
                    key={product.id}
                    role="button"
                    tabIndex={0}
                    className="cursor-pointer hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
                    onClick={() => onOpen(product.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault()
                        onOpen(product.id)
                      }
                    }}
                  >
                    <TableCell className="w-10" onClick={(event) => event.stopPropagation()}>
                      <Checkbox
                        checked={selected.has(product.id)}
                        onCheckedChange={(checked) => toggle(product.id, checked === true)}
                        aria-label={`Select ${product.name}`}
                      />
                    </TableCell>
                    <TableCell className="min-w-[240px]">
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-foreground">{product.name}</p>
                        {defaultRow?.scheduled && <ScheduledChip row={defaultRow} />}
                      </div>
                    </TableCell>
                    <TableCell>
                      <TypeBadge type={product.type} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      {defaultRow ? (
                        <InlinePriceCell
                          amount={defaultRow.amount}
                          unit={unitSuffix(product.unit)}
                          onChange={(amount) => actions.setDefaultPrice(product.id, amount)}
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">Unpriced</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right text-sm text-muted-foreground">
                      {Math.round(product.vatRate * 100)}%
                    </TableCell>
                    <TableCell>
                      {variations.length > 0 ? (
                        <Badge
                          variant="outline"
                          className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                        >
                          {variations.length}
                          {variations.some((row) => row.negotiatedCustomer) && (
                            <Handshake className="ml-1 h-3.5 w-3.5" />
                          )}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <TagChip tag={defaultRow?.tag} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={product.status} />
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}

function InvoicesLane({
  db,
  onExplainLine,
}: {
  db: PrototypeDb
  onExplainLine: (initial: Partial<ExplainInput>) => void
}) {
  return (
    <>
      {INVOICES.map((invoice) => {
        const resolved = invoice.lines.map((line) => {
          const product = db.products.find((entry) => entry.id === line.productId)
          const explanation = explainPrice(db, {
            productId: line.productId,
            zone: invoice.zone,
            customerType: invoice.customerType,
            customer: invoice.customer,
            date: line.date,
          })
          const unitExVat = explanation.base + (explanation.surcharge?.amount ?? 0)
          const total = unitExVat * line.qty
          return {
            line,
            product,
            unitExVat,
            total,
            vat: total * (product?.vatRate ?? 0.25),
          }
        })
        const subtotal = resolved.reduce((sum, entry) => sum + entry.total, 0)
        const vat = resolved.reduce((sum, entry) => sum + entry.vat, 0)
        return (
          <section
            key={invoice.id}
            className="overflow-hidden rounded-xl border border-border/60"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-foreground">{invoice.number}</p>
                <StatusBadge status={invoice.status} />
              </div>
              <p className="text-xs text-muted-foreground">
                {invoice.customer} · {invoice.zone} · issued {invoice.issued}
              </p>
            </div>
            <div className="overflow-x-auto">
              <Table className="min-w-[720px]">
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead>Line</TableHead>
                    <TableHead>Service date</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Unit price</TableHead>
                    <TableHead className="text-right">Line total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {resolved.map(({ line, product, unitExVat, total }) => (
                    <TableRow key={`${line.productId}-${line.date}`} className="hover:bg-muted/40">
                      <TableCell className="text-sm font-medium text-foreground">
                        {product?.invoiceName ?? line.productId}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {line.date}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-sm tabular-nums text-muted-foreground">
                        {line.qty}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        <button
                          type="button"
                          title="Explain this price"
                          onClick={() =>
                            onExplainLine({
                              productId: line.productId,
                              zone: invoice.zone,
                              customerType: invoice.customerType,
                              customer: invoice.customer,
                              date: line.date,
                            })
                          }
                          className="rounded-md px-1.5 py-0.5 text-sm font-medium tabular-nums hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        >
                          {money(unitExVat)}
                        </button>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-sm font-medium tabular-nums">
                        {money(total)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-col items-end gap-1 border-t border-border px-4 py-2.5 text-sm">
              <p className="text-muted-foreground">
                Subtotal <span className="ml-4 inline-block w-24 text-right font-medium tabular-nums text-foreground">{money(subtotal)}</span>
              </p>
              <p className="text-muted-foreground">
                VAT <span className="ml-4 inline-block w-24 text-right font-medium tabular-nums text-foreground">{money(vat)}</span>
              </p>
              <p className="text-muted-foreground">
                Total <span className="ml-4 inline-block w-24 text-right font-semibold tabular-nums text-foreground">{money(subtotal + vat)}</span>
              </p>
            </div>
          </section>
        )
      })}
      <p className="text-xs text-muted-foreground">
        Click any unit price to explain it — the sheet shows the winning row, the surcharge and
        the VAT math (spec §4.5).
      </p>
    </>
  )
}

function ProductDetailPage({
  db,
  actions,
  product,
  onBack,
  onExplain,
}: {
  db: PrototypeDb
  actions: PrototypeActions
  product: Product
  onBack: () => void
  onExplain: () => void
}) {
  const [varyOpen, setVaryOpen] = useState(false)
  const [scheduleRow, setScheduleRow] = useState<PriceRow | null>(null)
  const [negotiatedOpen, setNegotiatedOpen] = useState(false)
  const [extrasOpen, setExtrasOpen] = useState(false)

  const rows = rowsOf(db, product.id)
  const defaultRow = defaultRowOf(db, product.id)
  const extrasCount =
    product.extras.materials.length +
    product.extras.services.length +
    product.extras.serviceLevels.length

  const isDefault = (row: PriceRow) =>
    !row.negotiatedCustomer && Object.keys(row.conditions).length === 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-border">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-accent" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Breadcrumbs
                  items={[
                    { label: "Commercial", onClick: onBack },
                    { label: "Products", onClick: onBack },
                    { label: product.name },
                  ]}
                />
                <TypeBadge type={product.type} />
                <StatusBadge status={product.status} />
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {product.invoiceCode} · {product.invoiceName}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onExplain}>
              <Receipt className="h-4 w-4" />
              <span className="hidden sm:inline">Explain a price</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                toast.info("Edit product", { description: "Prototype stub" })
              }
            >
              <PencilSimple className="h-4 w-4" />
              <span className="hidden sm:inline">Edit</span>
            </Button>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl space-y-8 px-5 py-6 sm:px-7">
          <section className="space-y-3">
            <h2 className="text-sm font-semibold">Price</h2>
            <RuleCallout />
            <div className="overflow-hidden rounded-xl border border-border/60">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
                <p className="text-xs text-muted-foreground">
                  {rows.length} price row{rows.length === 1 ? "" : "s"}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setVaryOpen(true)}>
                    <Plus className="h-4 w-4" />
                    Vary this price
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!defaultRow}
                    onClick={() => defaultRow && setScheduleRow(defaultRow)}
                  >
                    Schedule a change
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setNegotiatedOpen(true)}>
                    <Handshake className="h-4 w-4" />
                    Negotiated deal
                  </Button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <Table className="min-w-[760px]">
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead>Applies to</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Effective</TableHead>
                      <TableHead>Price list</TableHead>
                      <TableHead>Scheduled</TableHead>
                      <TableHead className="w-10">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow
                        key={row.id}
                        className={cn("hover:bg-muted/40", isDefault(row) && "bg-muted/40")}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <ConditionChips row={row} />
                            {isDefault(row) && (
                              <span className="text-xs text-muted-foreground">default</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right text-sm font-medium tabular-nums">
                          {money(row.amount)}
                          <span className="text-xs font-normal text-muted-foreground">
                            {unitSuffix(product.unit)}
                          </span>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {row.effectiveFrom}
                          {row.effectiveTo ? ` → ${row.effectiveTo}` : ""}
                        </TableCell>
                        <TableCell>
                          <TagChip tag={row.tag} />
                        </TableCell>
                        <TableCell>
                          <ScheduledChip row={row} />
                        </TableCell>
                        <TableCell className="w-10 pr-3 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            title="Schedule a change for this row"
                            onClick={() => setScheduleRow(row)}
                          >
                            <Clock className="h-4 w-4" />
                            <span className="sr-only">Schedule a change</span>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">Invoice &amp; tax</h2>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">Invoice name</dt>
                <dd className="mt-1 break-words text-sm font-medium text-foreground">
                  {product.invoiceName}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Invoice code</dt>
                <dd className="mt-1 text-sm font-medium text-foreground">
                  {product.invoiceCode}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">VAT rate</dt>
                <dd className="mt-1 text-sm font-medium text-foreground">
                  {Math.round(product.vatRate * 100)}%
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Incl. VAT (default)</dt>
                <dd className="mt-1 text-sm font-medium tabular-nums text-foreground">
                  {defaultRow ? money(defaultRow.amount * (1 + product.vatRate)) : "—"}
                </dd>
              </div>
            </dl>
            <p className="text-xs leading-5 text-muted-foreground">
              The only home of these fields — variation rows inherit them. Company-wide
              defaults are set once in{" "}
              <Link
                href={COMMERCIAL_SETTINGS_HREF}
                className="underline underline-offset-2 hover:text-foreground"
              >
                Settings → Commercial defaults
              </Link>
              .
            </p>
          </section>

          <section className="space-y-3">
            <Collapsible open={extrasOpen} onOpenChange={setExtrasOpen}>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 text-left"
                >
                  <h2 className="text-sm font-semibold">
                    Extras{" "}
                    <span className="font-normal text-muted-foreground">
                      · {extrasCount === 0 ? "none linked" : `${extrasCount} linked`}
                    </span>
                  </h2>
                  <CaretDown
                    className={cn(
                      "h-4 w-4 text-muted-foreground transition-transform",
                      extrasOpen && "rotate-180",
                    )}
                  />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <div className="grid gap-4 sm:grid-cols-3">
                  {(
                    [
                      ["Materials", product.extras.materials],
                      ["Additional services", product.extras.services],
                      ["Service levels", product.extras.serviceLevels],
                    ] as const
                  ).map(([label, items]) => (
                    <div key={label} className="space-y-1.5">
                      <p className="text-xs font-medium text-muted-foreground">{label}</p>
                      {items.length === 0 ? (
                        <p className="text-xs text-muted-foreground">None</p>
                      ) : (
                        items.map((item) => (
                          <Badge
                            key={item}
                            variant="outline"
                            className="mr-1 rounded-full px-2 py-0.5 text-[11px] font-normal"
                          >
                            {item}
                          </Badge>
                        ))
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-fit px-2 text-xs text-muted-foreground"
                        onClick={() =>
                          toast.info(`Create new ${label.toLowerCase()}`, {
                            description: "Inline creation — prototype stub",
                          })
                        }
                      >
                        <Plus className="h-4 w-4" />
                        Create new
                      </Button>
                    </div>
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">History</h2>
            <div className="divide-y divide-border/60 border-y border-border/60">
              {product.history.map((entry, index) => (
                <div key={index} className="py-3">
                  <div className="flex items-start justify-between gap-6">
                    <p className="text-sm font-medium text-foreground">{entry.what}</p>
                    <p className="whitespace-nowrap text-xs text-muted-foreground">
                      {entry.at} · {entry.who}
                    </p>
                  </div>
                  {entry.diffs?.map((diff) => (
                    <p key={diff.field} className="mt-1 text-xs text-muted-foreground">
                      {diff.field}:{" "}
                      <span className="line-through">{diff.from}</span> → {diff.to}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      <VaryPriceDialog
        open={varyOpen}
        onOpenChange={setVaryOpen}
        product={product}
        onAdd={actions.addPriceRow}
      />
      {scheduleRow && (
        <ScheduleChangeDialog
          open
          onOpenChange={(next) => !next && setScheduleRow(null)}
          db={db}
          row={scheduleRow}
          onSchedule={(rowId, change) => {
            actions.scheduleChange(rowId, change)
            setScheduleRow(null)
          }}
        />
      )}
      <NegotiatedDealDialog
        open={negotiatedOpen}
        onOpenChange={setNegotiatedOpen}
        product={product}
        onAdd={actions.addPriceRow}
      />
    </div>
  )
}

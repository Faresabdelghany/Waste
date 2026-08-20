"use client"

// Settings → Commercial: product management surface plus the read-mostly
// Commercial defaults extras (registries, surcharge rules, contractor
// performance, price-lists index). Ported from the throwaway prototype
// (retired at the 2026-08-20 cutover — see git history and the design spec)
// onto real store-backed records — see docs/superpowers/plans/2026-08-20-
// products-prices-implementation. `CommercialDefaultsExtras` and
// `CommercialSectionPane` are the two names SettingsDialog renders; keep
// their exported shape stable.

import { useMemo, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import {
  ArrowSquareOut,
  Handshake,
  PencilSimple,
  Plus,
} from "@phosphor-icons/react/dist/ssr"

import { cn } from "@/lib/utils"
import { businessWorkspaces, type BusinessRecord } from "@/lib/data/business-modules"
import { getBusinessFormSchema } from "@/lib/data/business-form-schemas"
import type { BusinessFormValues } from "@/lib/data/business-form-types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { statusClasses } from "@/components/wastehero/business-record-views"
import { BusinessRecordFormDialog } from "@/components/wastehero/business-record-form-dialog"
import { useBusinessRecordStore } from "@/components/wastehero/business-record-store"
import { SURCHARGE_RULES } from "@/lib/commercial/price-resolution"
import {
  COMMERCIAL_DEFAULTS,
  CONTRACTOR_PERFORMANCE,
  CUSTOMER_TYPES,
  PRICING_REFERENCE_DATE,
  PRODUCT_FACTS,
  ZONES,
  defaultRowOf,
  encodeHistory,
  money,
  negotiatedCustomersOf,
  priceListIndex,
  priceRowToRecord,
  recordToPriceRow,
  syncProductPricingFacts,
  unitSuffix,
  type PriceRowModel,
  type PriceUnit,
} from "@/lib/commercial/price-model"

function splitList(value?: string): string[] {
  return value
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : []
}

function text(values: BusinessFormValues, id: string): string {
  return typeof values[id] === "string" ? (values[id] as string).trim() : ""
}

// Reads the store the same way for the defaults extras and the section
// panes so both agree on the same product/price-row set.
function useCommercialCatalogue() {
  const { getRecords, upsertRecord } = useBusinessRecordStore()
  const commercial = businessWorkspaces.commercial
  const fixturesOf = (moduleId: string) =>
    commercial.modules.find((module) => module.id === moduleId)?.records ?? []
  const productRecords = getRecords("commercial", "products", fixturesOf("products"))
  const rowRecords = getRecords("commercial", "price-rows", fixturesOf("price-rows"))
  const rows = useMemo(
    () =>
      rowRecords
        .map(recordToPriceRow)
        .filter((row): row is PriceRowModel => row !== null),
    [rowRecords],
  )
  return { productRecords, rowRecords, rows, upsertRecord }
}

export function usageLabel(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function registryStubAction() {
  toast("Not in v1", { description: "Rename / merge / retire is deferred." })
}

export type RegistryEntry = { name: string; usage: string }
export type Registry = { title: string; entries: RegistryEntry[] }

// Shared registry card — also used by the section panes below.
export function RegistryCard({ registry }: { registry: Registry }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border/60">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
        <p className="text-xs font-medium text-foreground">{registry.title}</p>
        <p className="text-xs text-muted-foreground">
          {registry.entries.length} {registry.entries.length === 1 ? "entry" : "entries"}
        </p>
      </div>
      <div className="divide-y divide-border/60">
        {registry.entries.map((entry) => (
          <div
            key={entry.name}
            className="flex items-center justify-between gap-3 px-4 py-1.5"
          >
            <div className="flex min-w-0 items-baseline gap-2">
              <p className="truncate text-sm text-foreground">{entry.name}</p>
              <p className="shrink-0 text-xs text-muted-foreground">{entry.usage}</p>
            </div>
            <div className="flex shrink-0 items-center">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={registryStubAction}
              >
                Rename
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={registryStubAction}
              >
                Retire
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

export function CommercialDefaultsExtras() {
  const { productRecords, rows } = useCommercialCatalogue()

  const registries = useMemo<Registry[]>(() => {
    const materialCounts = new Map<string, number>()
    for (const product of productRecords) {
      for (const material of splitList(product.facts[PRODUCT_FACTS.materials])) {
        materialCounts.set(material, (materialCounts.get(material) ?? 0) + 1)
      }
    }
    const entries = [...materialCounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => ({ name, usage: usageLabel(count, "product") }))
    return [{ title: "Materials", entries }]
  }, [productRecords])

  const priceLists = useMemo(() => priceListIndex(rows), [rows])
  const negotiatedCount = priceLists.filter((list) => list.negotiated).length
  const annualTariffCount = priceLists.length - negotiatedCount

  const performanceRows: Array<[string, string]> = [
    ["a — performance weight", String(CONTRACTOR_PERFORMANCE.a)],
    ["b — target complaint share", CONTRACTOR_PERFORMANCE.targetComplaintShare],
    ["Reliability gate", CONTRACTOR_PERFORMANCE.reliabilityGate],
    ["Cap", `${CONTRACTOR_PERFORMANCE.cap}× — the coefficient never exceeds this`],
  ]

  return (
    <>
      {/* 1. Registries */}
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Registries</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Created inline where the work happens; renamed, merged and retired here.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {registries.map((registry) => (
            <RegistryCard key={registry.title} registry={registry} />
          ))}
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          Zones, service levels and customer types are managed in the Commercial
          section. Container types and waste fractions are Operations-owned
          registries — price rows can condition on them, but they are managed
          under Operations setup.
        </p>
      </div>

      {/* 2. Surcharge rules */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-foreground">Surcharge rules</h3>
        <section className="overflow-hidden rounded-xl border border-border/60">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>Rule</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Recurrence</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {SURCHARGE_RULES.map((rule) => (
                  <TableRow key={rule.id} className="hover:bg-transparent">
                    <TableCell className="min-w-[200px] text-sm font-medium text-foreground">
                      {rule.name}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {rule.kind === "percent" ? `+${rule.value}%` : `+${money(rule.value)}`}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {rule.recurrence}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="border-t border-border px-4 py-2">
            <p className="text-xs text-muted-foreground">
              Highest wins when rules overlap. Applied automatically to affected pickup
              dates.
            </p>
          </div>
        </section>
      </div>

      {/* 3. Contractor performance — read-only card (spec §6 cut: no editor) */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-foreground">Contractor performance</h3>
        <section className="overflow-hidden rounded-xl border border-border/60">
          <div className="border-b border-border bg-muted/40 px-4 py-3">
            <p className="font-mono text-sm text-foreground">
              {CONTRACTOR_PERFORMANCE.formula}
            </p>
          </div>
          <dl className="divide-y divide-border/60">
            {performanceRows.map(([term, definition]) => (
              <div
                key={term}
                className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-4 py-2.5"
              >
                <dt className="text-xs text-muted-foreground">{term}</dt>
                <dd className="text-sm font-medium text-foreground">{definition}</dd>
              </div>
            ))}
          </dl>
          <div className="border-t border-border px-4 py-2">
            <p className="text-xs text-muted-foreground">
              Fixture parameters — editing is out of scope.
            </p>
          </div>
        </section>
      </div>

      {/* 4. Price lists index (spec §4.6) */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-foreground">Price lists</h3>
        <section className="overflow-hidden rounded-xl border border-border/60">
          <div className="border-b border-border px-4 py-2">
            <p className="text-xs text-muted-foreground">
              {priceLists.length} price lists · {annualTariffCount} annual tariffs and{" "}
              {negotiatedCount} negotiated deals, derived from row tags as of{" "}
              {PRICING_REFERENCE_DATE}
            </p>
          </div>
          <div className="overflow-x-auto">
            <Table className="min-w-[640px]">
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>Name</TableHead>
                  <TableHead>Rows</TableHead>
                  <TableHead>Effective from</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-10">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {priceLists.map((list) => (
                  <TableRow key={list.tag} className="hover:bg-muted/60">
                    <TableCell className="min-w-[220px] text-sm font-medium text-foreground">
                      {list.tag}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {list.rows}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {list.effectiveFrom}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[11px] font-medium",
                          statusClasses(list.status),
                        )}
                      >
                        {list.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap pr-3 text-right">
                      <Button variant="ghost" size="sm" asChild>
                        <Link href="/commercial?module=products">
                          Open in Price Engine
                          <ArrowSquareOut className="h-3.5 w-3.5" />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="border-t border-border px-4 py-2">
            <p className="text-xs text-muted-foreground">
              A price list is a tag on price rows — the index is derived, there is no
              container object to manage.
            </p>
          </div>
        </section>
      </div>
    </>
  )
}

export function CommercialSectionPane({ paneId }: { paneId: string }) {
  const { productRecords, rows, upsertRecord } = useCommercialCatalogue()

  if (paneId === "commercial-products") {
    return <ProductsPane productRecords={productRecords} rows={rows} upsertRecord={upsertRecord} />
  }
  if (paneId === "commercial-zones") return <ZonesPane rows={rows} />
  if (paneId === "commercial-service") return <ServicePane productRecords={productRecords} />
  if (paneId === "commercial-customer-types") return <CustomerTypesPane rows={rows} />
  return null
}

// Reads submittedValues when present (a record created or previously edited
// through any form dialog carries its raw submission); otherwise derives
// form values from facts and the default price row, the same way the
// generic workspace edit path does for fixture records.
function productRecordToFormValues(
  record: BusinessRecord,
  rows: readonly PriceRowModel[],
): BusinessFormValues {
  if (record.submittedValues) return record.submittedValues
  const defaultRow = defaultRowOf(rows, record.id)
  return {
    productName: record.name,
    productType: record.facts[PRODUCT_FACTS.type] || "Additional service",
    status: record.status,
    defaultPrice: defaultRow ? String(defaultRow.amount) : "",
    priceUnit: record.facts[PRODUCT_FACTS.unit] || "pickup",
    priceListTag: defaultRow?.tag ?? "",
    effectiveFrom: defaultRow?.effectiveFrom ?? PRICING_REFERENCE_DATE,
    vatRate: (record.facts[PRODUCT_FACTS.vat] ?? "25%").replace("%", ""),
    invoiceName: record.facts[PRODUCT_FACTS.invoiceName] || record.name,
    invoiceCode: record.facts[PRODUCT_FACTS.invoiceCode] || "",
    container: record.facts[PRODUCT_FACTS.container] || "",
    containerType: record.facts[PRODUCT_FACTS.containerType] || "",
    wasteFraction: record.facts[PRODUCT_FACTS.wasteFraction] || "",
  }
}

function ProductsPane({
  productRecords,
  rows,
  upsertRecord,
}: {
  productRecords: BusinessRecord[]
  rows: PriceRowModel[]
  upsertRecord: ReturnType<typeof useBusinessRecordStore>["upsertRecord"]
}) {
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [editingProduct, setEditingProduct] = useState<BusinessRecord | null>(null)
  const productSchema = getBusinessFormSchema("commercial", "products")
  const editFormSchema = useMemo(
    () =>
      productSchema
        ? {
            ...productSchema,
            title: "Edit product",
            submitLabel: "Save changes",
            description: "Update this product. Changes apply immediately and extend its history.",
          }
        : undefined,
    [productSchema],
  )

  // New product (spec §4.2 / §10): born priced — creating the product also
  // creates its Everyone (no-conditions) default price row in one step.
  const handleCreateProduct = (values: BusinessFormValues) => {
    const name = text(values, "productName")
    const unit = (text(values, "priceUnit") || "pickup") as PriceUnit
    const amount = Number(text(values, "defaultPrice"))
    const productId = `product-${Date.now().toString(36)}`
    const facts: Record<string, string> = {
      [PRODUCT_FACTS.type]: text(values, "productType"),
      ...(text(values, "container") ? { [PRODUCT_FACTS.container]: text(values, "container") } : {}),
      ...(text(values, "containerType")
        ? { [PRODUCT_FACTS.containerType]: text(values, "containerType") }
        : {}),
      ...(text(values, "wasteFraction")
        ? { [PRODUCT_FACTS.wasteFraction]: text(values, "wasteFraction") }
        : {}),
      [PRODUCT_FACTS.vat]: `${text(values, "vatRate") || "25"}%`,
      ...(text(values, "priceListTag")
        ? { [PRODUCT_FACTS.priceList]: text(values, "priceListTag") }
        : {}),
      [PRODUCT_FACTS.unit]: unit,
      [PRODUCT_FACTS.invoiceName]: text(values, "invoiceName") || name,
      [PRODUCT_FACTS.invoiceCode]:
        text(values, "invoiceCode") ||
        `${COMMERCIAL_DEFAULTS.invoiceCodePrefix}${name.slice(0, 12).toUpperCase().replace(/[^A-Z0-9]+/g, "-")}`,
    }
    upsertRecord("commercial", "products", {
      id: productId,
      name,
      context: `${text(values, "productType")} · ${unitSuffix(unit)}`,
      status: text(values, "status") || "Active",
      owner: "Pricing",
      value: `${money(amount)}${unitSuffix(unit)}`,
      updated: "Now",
      description: `${text(values, "productType")} product created in Settings; born priced at ${money(amount)}${unitSuffix(unit)}.`,
      facts,
      related: [encodeHistory({ at: PRICING_REFERENCE_DATE, who: "You", what: "Product created (Quick create)" })],
      source: "Price Engine",
      freshness: "Now",
      recordKind: "Product",
      submittedValues: values,
    })
    upsertRecord(
      "commercial",
      "price-rows",
      priceRowToRecord(
        {
          id: `price-row-${Date.now().toString(36)}`,
          productId,
          amount,
          unit,
          conditions: {},
          effectiveFrom: text(values, "effectiveFrom") || PRICING_REFERENCE_DATE,
          tag: text(values, "priceListTag") || undefined,
        },
        { id: productId, name },
      ),
    )
    toast.success("Product created", { description: "Born priced — the default row applies to everyone." })
    setIsCreateOpen(false)
  }

  // Edit product: upserts over the same record id. When defaultPrice (or the
  // unit/price-list tag that travel with it) changed, the default row is
  // updated too so the product and its Everyone row never disagree.
  const handleEditProduct = (values: BusinessFormValues) => {
    if (!editingProduct) return
    const name = text(values, "productName") || editingProduct.name
    const productType = text(values, "productType") || editingProduct.facts[PRODUCT_FACTS.type] || ""
    const unit = (text(values, "priceUnit") || "pickup") as PriceUnit
    const status = text(values, "status") || editingProduct.status

    const nextFacts: Record<string, string> = { ...editingProduct.facts }
    nextFacts[PRODUCT_FACTS.type] = productType
    nextFacts[PRODUCT_FACTS.unit] = unit
    nextFacts[PRODUCT_FACTS.vat] = `${text(values, "vatRate") || "25"}%`
    nextFacts[PRODUCT_FACTS.invoiceName] = text(values, "invoiceName") || name
    nextFacts[PRODUCT_FACTS.invoiceCode] =
      text(values, "invoiceCode") || editingProduct.facts[PRODUCT_FACTS.invoiceCode] || ""
    if (text(values, "container")) nextFacts[PRODUCT_FACTS.container] = text(values, "container")
    else delete nextFacts[PRODUCT_FACTS.container]
    if (text(values, "containerType")) nextFacts[PRODUCT_FACTS.containerType] = text(values, "containerType")
    else delete nextFacts[PRODUCT_FACTS.containerType]
    if (text(values, "wasteFraction")) nextFacts[PRODUCT_FACTS.wasteFraction] = text(values, "wasteFraction")
    else delete nextFacts[PRODUCT_FACTS.wasteFraction]

    const updatedProduct: BusinessRecord = {
      ...editingProduct,
      name,
      status,
      context: `${productType} · ${unitSuffix(unit)}`,
      facts: nextFacts,
      updated: "Now",
      freshness: "Now",
      related: [
        encodeHistory({ at: PRICING_REFERENCE_DATE, who: "You", what: "Product edited in Settings" }),
        ...editingProduct.related,
      ],
      submittedValues: values,
    }

    const defaultPriceText = text(values, "defaultPrice")
    const newAmount = Number(defaultPriceText)
    const defaultRow = defaultRowOf(rows, editingProduct.id)
    const nextTag = text(values, "priceListTag") || undefined
    const hasNewAmount = defaultPriceText !== "" && Number.isFinite(newAmount)
    const priceChanged = Boolean(defaultRow && hasNewAmount && newAmount !== defaultRow.amount)

    let allRows = rows
    if (defaultRow) {
      const rowChanged =
        (hasNewAmount && newAmount !== defaultRow.amount) ||
        unit !== defaultRow.unit ||
        nextTag !== defaultRow.tag
      if (rowChanged) {
        const nextRow: PriceRowModel = {
          ...defaultRow,
          amount: hasNewAmount ? newAmount : defaultRow.amount,
          unit,
          tag: nextTag,
        }
        allRows = rows.map((row) => (row.id === nextRow.id ? nextRow : row))
        upsertRecord(
          "commercial",
          "price-rows",
          priceRowToRecord(nextRow, { id: editingProduct.id, name }),
        )
      }
    }

    const synced = syncProductPricingFacts(updatedProduct, allRows)
    upsertRecord("commercial", "products", synced)

    toast.success("Product updated", {
      description: priceChanged
        ? `${name} was updated — the default row now reads ${money(newAmount)}${unitSuffix(unit)}.`
        : `${name} was updated.`,
    })
    setEditingProduct(null)
  }

  return (
    <section className="overflow-hidden rounded-xl border border-border/60">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2">
        <p className="text-xs text-muted-foreground">
          {productRecords.length} products · manage prices in Price Engine
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/commercial">
              Open in Price Engine
              <ArrowSquareOut className="h-3.5 w-3.5" />
            </Link>
          </Button>
          {productSchema && (
            <Button size="sm" onClick={() => setIsCreateOpen(true)}>
              <Plus className="h-4 w-4" weight="bold" />
              New product
            </Button>
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        <Table className="min-w-[1120px]">
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Container</TableHead>
              <TableHead>Container type</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Waste fraction</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-16 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {productRecords.map((product) => {
              const defaultRow = defaultRowOf(rows, product.id)
              const negotiated = negotiatedCustomersOf(rows, product.id)
              const unit = (product.facts[PRODUCT_FACTS.unit] as PriceUnit) || "pickup"
              return (
                <TableRow key={product.id} className="hover:bg-muted/40">
                  <TableCell className="min-w-[220px] text-sm font-medium text-foreground">
                    {product.name}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[11px] font-normal">
                      {product.facts[PRODUCT_FACTS.type] ?? "—"}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {product.facts[PRODUCT_FACTS.container] ?? "—"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {product.facts[PRODUCT_FACTS.containerType] ?? "—"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {negotiated.length > 0 ? (
                      <span className="inline-flex items-center gap-1.5 text-foreground">
                        <Handshake className="h-3.5 w-3.5 shrink-0" />
                        {negotiated[0]}
                        {negotiated.length > 1 ? ` +${negotiated.length - 1}` : ""}
                      </span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {product.facts[PRODUCT_FACTS.wasteFraction] ?? "—"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right text-sm font-medium tabular-nums">
                    {defaultRow ? (
                      <>
                        {money(defaultRow.amount)}
                        <span className="text-xs font-normal text-muted-foreground">
                          {unitSuffix(unit)}
                        </span>
                      </>
                    ) : (
                      <span className="text-xs font-normal text-muted-foreground">Unpriced</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[11px] font-medium",
                        statusClasses(product.status),
                      )}
                    >
                      {product.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setEditingProduct(product)}
                      aria-label={`Edit ${product.name}`}
                    >
                      <PencilSimple className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      {productSchema && (
        <BusinessRecordFormDialog
          schema={productSchema}
          open={isCreateOpen}
          onOpenChange={setIsCreateOpen}
          onSubmit={handleCreateProduct}
          relationOptions={() => []}
        />
      )}
      {editFormSchema && editingProduct && (
        <BusinessRecordFormDialog
          schema={editFormSchema}
          open={Boolean(editingProduct)}
          onOpenChange={(open) => {
            if (!open) setEditingProduct(null)
          }}
          onSubmit={handleEditProduct}
          relationOptions={() => []}
          initialValueOverrides={productRecordToFormValues(editingProduct, rows)}
        />
      )}
    </section>
  )
}

function ZonesPane({ rows }: { rows: readonly PriceRowModel[] }) {
  const registry = useMemo<Registry>(
    () => ({
      title: "Zones",
      entries: ZONES.map((zone) => ({
        name: zone,
        usage: usageLabel(
          rows.filter((row) => row.conditions.zone === zone).length,
          "price row",
        ),
      })),
    }),
    [rows],
  )
  return <RegistryCard registry={registry} />
}

function ServicePane({ productRecords }: { productRecords: BusinessRecord[] }) {
  const registry = useMemo<Registry>(() => {
    const counts = new Map<string, number>()
    for (const product of productRecords) {
      for (const level of splitList(product.facts[PRODUCT_FACTS.serviceLevels])) {
        counts.set(level, (counts.get(level) ?? 0) + 1)
      }
    }
    return {
      title: "Service levels",
      entries: [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, count]) => ({ name, usage: usageLabel(count, "product") })),
    }
  }, [productRecords])
  return (
    <>
      <RegistryCard registry={registry} />
      <p className="text-xs leading-5 text-muted-foreground">
        Service levels are offered per product under its Extras section.
      </p>
    </>
  )
}

function CustomerTypesPane({ rows }: { rows: readonly PriceRowModel[] }) {
  const registry = useMemo<Registry>(
    () => ({
      title: "Customer types",
      entries: CUSTOMER_TYPES.map((type) => ({
        name: type,
        usage: usageLabel(
          rows.filter((row) => row.conditions.customerType === type).length,
          "price row",
        ),
      })),
    }),
    [rows],
  )
  return <RegistryCard registry={registry} />
}

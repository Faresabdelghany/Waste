"use client"

// Settings → Commercial: the management surface for the sellable catalogue
// and its registries, rendered in the same full-page panel style as Asset
// management (AssetPanelShell + toolbar + records table + dialogs).
//
// - Products stay business records ("commercial.products") so Price Engine
//   reads the same catalogue; in fixture mode the form here carries no
//   price/VAT/invoice fields — pricing happens in Price Engine via Add price.
//   On the Pilot the products are the API's, created and edited with their
//   invoice fields (commercial-catalogue-panes.tsx).
// - Price lists are records of both modes' own source: on the Pilot the kind
//   of `commercial.price-rows` the API holds them under, in fixture mode a
//   browser bucket seeded with the prototype's lists (#185). A fixture row's
//   price-list tag is a list's name. The zones, service levels, customer types
//   and surcharge rules the prototype kept in a browser store are gone (#127):
//   a zone is a planning area, a customer type a customer's kind, and a
//   service level and a surcharge have no home on the wire.
//
// - Ticket charges (#291 C3) are the API's alone: the product each ticket
//   kind's work is charged at, read and set through the client
//   (ticket-charges-settings.tsx), and so are the work order charges (M14 of
//   #293): the product each of the office's work orders is charged at
//   (work-order-charges-settings.tsx).
//
// `CommercialDefaultsExtras` and `CommercialSectionPane` are the two names
// SettingsDialog renders; keep their exported shape stable.

import { useMemo, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import {
  ArrowSquareOut,
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
import {
  TablePagination,
  useTablePagination,
} from "@/components/ui/table-pagination"
import { statusClasses } from "@/components/waste/business-record-views"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useApiConfigured } from "@/components/waste/api-session-store"
import { useBusinessRecordStore } from "@/components/waste/business-record-store"
import {
  AssetPanelShell,
  AssetToolbar,
  EmptyRow,
  RecordsSection,
  defaultAssetView,
  sortByView,
  type AssetView,
} from "@/components/settings/asset-management-settings"
import { PriceListsPane, ProductsOnApiPane } from "@/components/settings/commercial-catalogue-panes"
import { TicketChargesSettings } from "@/components/settings/ticket-charges-settings"
import { WorkOrderChargesSettings } from "@/components/settings/work-order-charges-settings"
import { AccountingSettingsPane } from "@/components/settings/accounting-settings"
import {
  SERVICE_PROVIDER_PERFORMANCE,
  PRICING_REFERENCE_DATE,
  PRODUCT_FACTS,
  defaultRowOf,
  encodeHistory,
  isSoftDeleted,
  money,
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
  const allProductRecords = getRecords("commercial", "products", fixturesOf("products"))
  const rowRecords = getRecords("commercial", "price-rows", fixturesOf("price-rows"))
  // Soft-deleted records stay in the store (marked, not removed), so both the
  // product list and every count derived from it must skip them. Price rows
  // get the same treatment for free — recordToPriceRow returns null for a
  // soft-deleted row.
  const productRecords = useMemo(
    () => allProductRecords.filter((record) => !isSoftDeleted(record)),
    [allProductRecords],
  )
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

// Read-only registry card — used by the Commercial defaults pane for the
// registries that are still derived (e.g. Materials from product facts).
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
  const { productRecords } = useCommercialCatalogue()

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

  const performanceRows: Array<[string, string]> = [
    ["a — performance weight", String(SERVICE_PROVIDER_PERFORMANCE.a)],
    ["b — target complaint share", SERVICE_PROVIDER_PERFORMANCE.targetComplaintShare],
    ["Reliability gate", SERVICE_PROVIDER_PERFORMANCE.reliabilityGate],
    ["Cap", `${SERVICE_PROVIDER_PERFORMANCE.cap}× — the coefficient never exceeds this`],
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
          Price lists are managed in the Commercial section. A price row&apos;s
          zone is a planning area and its customer type a customer&apos;s kind;
          container types and waste fractions are Operations-owned registries —
          price rows can condition on them, but they are managed under
          Operations setup.
        </p>
      </div>

      {/* 3. Service provider performance — read-only card (spec §6 cut: no editor) */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-foreground">Service provider performance</h3>
        <section className="overflow-hidden rounded-xl border border-border/60">
          <div className="border-b border-border bg-muted/40 px-4 py-3">
            <p className="font-mono text-sm text-foreground">
              {SERVICE_PROVIDER_PERFORMANCE.formula}
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

    </>
  )
}

export function CommercialSectionPane({ paneId }: { paneId: string }) {
  if (paneId === "commercial-products") return <ProductsByModePane />
  if (paneId === "commercial-price-lists") return <PriceListsPane />
  if (paneId === "commercial-ticket-charges") return <TicketChargesSettings />
  if (paneId === "commercial-work-order-charges") return <WorkOrderChargesSettings />
  if (paneId === "commercial-accounting") return <AccountingSettingsPane />
  return null
}

/** The products' pane: the API's on the Pilot, the fixtures' and the browser's in fixture mode. */
function ProductsByModePane() {
  return useApiConfigured() ? <ProductsOnApiPane /> : <ProductsPane />
}

// ---------------------------------------------------------------------------
// Products — Asset-management-style page over the commercial.products records.
// ---------------------------------------------------------------------------

const PRODUCT_TYPE_OPTIONS = [
  "Container collection",
  "Recurring service",
  "Additional service",
] as const

const PRODUCT_STATUS_OPTIONS = ["Active", "Draft", "Inactive"] as const

function productRecordToFormValues(record: BusinessRecord): BusinessFormValues {
  return {
    productName: record.name,
    productType: record.facts[PRODUCT_FACTS.type] || "Additional service",
    status: record.status,
    priceUnit: record.facts[PRODUCT_FACTS.unit] || "pickup",
    container: record.facts[PRODUCT_FACTS.container] || "",
    containerType: record.facts[PRODUCT_FACTS.containerType] || "",
    wasteFraction: record.facts[PRODUCT_FACTS.wasteFraction] || "",
  }
}

function ProductsPane() {
  const { productRecords, rows, upsertRecord } = useCommercialCatalogue()
  const [query, setQuery] = useState("")
  const [statuses, setStatuses] = useState<string[]>([])
  const [typeFilters, setTypeFilters] = useState<string[]>([])
  const [view, setView] = useState<AssetView>(defaultAssetView)
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

  const filtered = sortByView(
    productRecords
      .filter((record) =>
        [
          record.name,
          record.facts[PRODUCT_FACTS.type],
          record.facts[PRODUCT_FACTS.container],
          record.facts[PRODUCT_FACTS.containerType],
          record.facts[PRODUCT_FACTS.wasteFraction],
        ]
          .join(" ")
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
      .filter((record) => statuses.length === 0 || statuses.includes(record.status))
      .filter(
        (record) =>
          typeFilters.length === 0 ||
          typeFilters.includes(record.facts[PRODUCT_FACTS.type] ?? ""),
      ),
    view,
    (record) => record.name,
    // Records carry a fuzzy "updated" label, not a sortable timestamp — the
    // "Last updated" ordering keeps the store's order instead of inventing one.
    () => "",
  )

  const {
    page: productsPage,
    setPage: setProductsPage,
    pageCount: productsPageCount,
    pageRows: productsPageRows,
    totalCount: productsTotalCount,
  } = useTablePagination(filtered)

  const productFactsFromValues = (values: BusinessFormValues) => {
    const facts: Record<string, string> = {
      [PRODUCT_FACTS.type]: text(values, "productType"),
      [PRODUCT_FACTS.unit]: text(values, "priceUnit") || "pickup",
    }
    if (text(values, "container")) facts[PRODUCT_FACTS.container] = text(values, "container")
    if (text(values, "containerType")) facts[PRODUCT_FACTS.containerType] = text(values, "containerType")
    if (text(values, "wasteFraction")) facts[PRODUCT_FACTS.wasteFraction] = text(values, "wasteFraction")
    return facts
  }

  // New product: catalogue facts only — no price row is created. The product
  // stays Unpriced until Add price creates its no-conditions default row in
  // Price Engine.
  const handleCreateProduct = (values: BusinessFormValues) => {
    const name = text(values, "productName")
    const productType = text(values, "productType") || "Additional service"
    const unit = (text(values, "priceUnit") || "pickup") as PriceUnit
    upsertRecord("commercial", "products", {
      id: `product-${Date.now().toString(36)}`,
      name,
      context: `${productType} · ${unitSuffix(unit)}`,
      status: text(values, "status") || "Active",
      owner: "Pricing",
      value: "Unpriced",
      updated: "Now",
      description: `${productType} product created in Settings. Unpriced until Add price creates its default row in Price Engine.`,
      facts: productFactsFromValues(values),
      related: [
        encodeHistory({ at: PRICING_REFERENCE_DATE, who: "You", what: "Product created in Settings" }),
      ],
      source: "Price Engine",
      freshness: "Now",
      recordKind: "Product",
      submittedValues: values,
    })
    toast.success("Product created", {
      description: "Unpriced — add its price in Price Engine with Add price.",
    })
    setIsCreateOpen(false)
  }

  // Edit product: upserts over the same record id, touching only the facts
  // this form owns. Derived pricing facts (Price list / Variations /
  // Customer) and the headline value are recomputed from the live rows.
  const handleEditProduct = (values: BusinessFormValues) => {
    if (!editingProduct) return
    const name = text(values, "productName") || editingProduct.name
    const productType =
      text(values, "productType") || editingProduct.facts[PRODUCT_FACTS.type] || ""
    const unit = (text(values, "priceUnit") || "pickup") as PriceUnit
    const status = text(values, "status") || editingProduct.status

    const nextFacts: Record<string, string> = { ...editingProduct.facts }
    nextFacts[PRODUCT_FACTS.type] = productType
    nextFacts[PRODUCT_FACTS.unit] = unit
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
    upsertRecord("commercial", "products", syncProductPricingFacts(updatedProduct, rows))
    toast.success("Product updated", { description: `${name} was updated.` })
    setEditingProduct(null)
  }

  return (
    <AssetPanelShell
      heading="Commercial"
      title="Products"
      description="The sellable catalogue — add and edit products here. Prices are managed in Price Engine with Add price."
      action={
        <>
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
        </>
      }
      toolbar={
        <AssetToolbar
          searchPlaceholder="Search products"
          query={query}
          onQueryChange={setQuery}
          statuses={statuses}
          onStatusesChange={setStatuses}
          statusOptions={PRODUCT_STATUS_OPTIONS}
          extraFilters={[
            {
              label: "Type",
              options: PRODUCT_TYPE_OPTIONS,
              value: typeFilters,
              onChange: setTypeFilters,
            },
          ]}
          view={view}
          onViewChange={setView}
        />
      }
    >
      <RecordsSection shown={filtered.length} total={productRecords.length}>
        <div className="overflow-x-auto">
          <Table className="min-w-[1080px]">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Container</TableHead>
                <TableHead>Container type</TableHead>
                <TableHead>Waste fraction</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <EmptyRow colSpan={8} message="No products match this search." />
              ) : (
                productsPageRows.map((product) => {
                  const defaultRow = defaultRowOf(rows, product.id)
                  return (
                    <TableRow key={product.id}>
                      <TableCell className="min-w-[220px]">
                        <p className="text-sm font-medium text-foreground">{product.name}</p>
                        {view.showDetails && (
                          <p className="text-xs text-muted-foreground">{product.context}</p>
                        )}
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
                        {product.facts[PRODUCT_FACTS.wasteFraction] ?? "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-sm font-medium tabular-nums">
                        {defaultRow ? (
                          <>
                            {money(defaultRow.amount)}
                            <span className="text-xs font-normal text-muted-foreground">
                              {unitSuffix(defaultRow.unit)}
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
                })
              )}
            </TableBody>
          </Table>
        </div>
        <TablePagination
          page={productsPage}
          pageCount={productsPageCount}
          totalCount={productsTotalCount}
          onPageChange={setProductsPage}
        />
      </RecordsSection>

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
          initialValueOverrides={productRecordToFormValues(editingProduct)}
        />
      )}
    </AssetPanelShell>
  )
}

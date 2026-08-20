"use client"

// Settings → Commercial: the management surface for the sellable catalogue
// and its registries, rendered in the same full-page panel style as Asset
// management (AssetPanelShell + toolbar + records table + dialogs).
//
// - Products stay business records ("commercial.products") so Price Engine
//   reads the same catalogue; the form here carries no price/VAT/invoice
//   fields — pricing happens in Price Engine via Add price.
// - Zones, Service levels and Customer types are real CRUD entities in the
//   commercial-registries store; Price Engine consumes them as form options.
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
  Trash,
} from "@phosphor-icons/react/dist/ssr"

import { cn } from "@/lib/utils"
import { businessWorkspaces, type BusinessRecord } from "@/lib/data/business-modules"
import { getBusinessFormSchema } from "@/lib/data/business-form-schemas"
import type {
  BusinessFormOption,
  BusinessFormValues,
} from "@/lib/data/business-form-types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { statusClasses } from "@/components/wastehero/business-record-views"
import { BusinessRecordFormDialog } from "@/components/wastehero/business-record-form-dialog"
import { useBusinessRecordStore } from "@/components/wastehero/business-record-store"
import {
  AssetPanelShell,
  AssetToolbar,
  DialogSection,
  EmptyRow,
  Field,
  RecordsSection,
  StatusBadge,
  defaultAssetView,
  sortByView,
  type AssetView,
} from "@/components/settings/asset-management-settings"
import {
  registryEntityId,
  useCommercialRegistriesStore,
  type RegistryStatus,
} from "@/components/settings/commercial-registries-store"
import { SURCHARGE_RULES } from "@/lib/commercial/price-resolution"
import {
  CONTRACTOR_PERFORMANCE,
  PRICING_REFERENCE_DATE,
  PRODUCT_FACTS,
  defaultRowOf,
  encodeHistory,
  isSoftDeleted,
  money,
  priceListIndex,
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

function nowIso() {
  return new Date().toISOString()
}

function slug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
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
  if (paneId === "commercial-products") return <ProductsPane />
  if (paneId === "commercial-zones") return <ZonesPane />
  if (paneId === "commercial-service") return <ServicePane />
  if (paneId === "commercial-customer-types") return <CustomerTypesPane />
  return null
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
    serviceLevels: splitList(record.facts[PRODUCT_FACTS.serviceLevels]).join(", "),
  }
}

function ProductsPane() {
  const { productRecords, rows, upsertRecord } = useCommercialCatalogue()
  const { serviceLevels } = useCommercialRegistriesStore()
  const [query, setQuery] = useState("")
  const [statuses, setStatuses] = useState<string[]>([])
  const [typeFilters, setTypeFilters] = useState<string[]>([])
  const [view, setView] = useState<AssetView>(defaultAssetView)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [editingProduct, setEditingProduct] = useState<BusinessRecord | null>(null)

  // Same injection Price Engine applies: the Service levels field offers
  // whatever the Settings → Service registry currently holds.
  const productSchema = useMemo(() => {
    const schema = getBusinessFormSchema("commercial", "products")
    if (!schema) return undefined
    const options: BusinessFormOption[] = serviceLevels
      .filter((level) => level.status === "Active")
      .map((level) => ({ value: level.name, label: level.name }))
    return {
      ...schema,
      sections: schema.sections.map((section) => ({
        ...section,
        fields: section.fields.map((field) =>
          field.id === "serviceLevels" ? { ...field, options } : field,
        ),
      })),
    }
  }, [serviceLevels])
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
          record.facts[PRODUCT_FACTS.serviceLevels],
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

  const productFactsFromValues = (values: BusinessFormValues) => {
    const facts: Record<string, string> = {
      [PRODUCT_FACTS.type]: text(values, "productType"),
      [PRODUCT_FACTS.unit]: text(values, "priceUnit") || "pickup",
    }
    if (text(values, "container")) facts[PRODUCT_FACTS.container] = text(values, "container")
    if (text(values, "containerType")) facts[PRODUCT_FACTS.containerType] = text(values, "containerType")
    if (text(values, "wasteFraction")) facts[PRODUCT_FACTS.wasteFraction] = text(values, "wasteFraction")
    const levels = splitList(text(values, "serviceLevels")).join(", ")
    if (levels) facts[PRODUCT_FACTS.serviceLevels] = levels
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
    const levels = splitList(text(values, "serviceLevels")).join(", ")
    if (levels) nextFacts[PRODUCT_FACTS.serviceLevels] = levels
    else delete nextFacts[PRODUCT_FACTS.serviceLevels]

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
                <TableHead>Service levels</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <EmptyRow colSpan={9} message="No products match this search." />
              ) : (
                filtered.map((product) => {
                  const defaultRow = defaultRowOf(rows, product.id)
                  const levels = splitList(product.facts[PRODUCT_FACTS.serviceLevels])
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
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {levels.length > 0
                          ? `${levels[0]}${levels.length > 1 ? ` +${levels.length - 1}` : ""}`
                          : "—"}
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

// ---------------------------------------------------------------------------
// Zones / Service levels / Customer types — CRUD registry pages sharing one
// panel + dialog, differing only in the store slice and usage derivation.
// ---------------------------------------------------------------------------

type RegistryItem = {
  id: string
  name: string
  code?: string
  description: string
  status: RegistryStatus
  createdAt: string
  updatedAt: string
}

function blankRegistryItem(): RegistryItem {
  const createdAt = nowIso()
  return {
    id: "",
    name: "",
    code: "",
    description: "",
    status: "Active",
    createdAt,
    updatedAt: createdAt,
  }
}

function RegistryDialog({
  value,
  entityLabel,
  dialogDescription,
  withCode,
  onSave,
  onClose,
}: {
  value: RegistryItem | null
  entityLabel: string
  dialogDescription: string
  withCode?: boolean
  onSave: (item: RegistryItem) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<RegistryItem>(value ?? blankRegistryItem())
  if (!value) return null
  const isEditing = Boolean(value.id)
  const update = <K extends keyof RegistryItem>(key: K, next: RegistryItem[K]) =>
    setDraft((current) => ({ ...current, [key]: next }))
  const save = () => {
    if (!draft.name.trim()) return toast.error(`${entityLabel} name is required.`)
    onSave({
      ...draft,
      name: draft.name.trim(),
      code: draft.code?.trim() ?? "",
      description: draft.description.trim(),
    })
    onClose()
    toast.success(isEditing ? `${entityLabel} updated` : `${entityLabel} created`)
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b px-6 py-5 pr-12">
          <DialogTitle>
            {isEditing ? `Edit ${entityLabel.toLowerCase()}` : `New ${entityLabel.toLowerCase()}`}
          </DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <DialogSection title="Details">
            <Field label="Name" required>
              <Input
                value={draft.name}
                onChange={(event) => update("name", event.target.value)}
              />
            </Field>
            {withCode && (
              <Field label="Code" description="Short reference used on invoices and imports.">
                <Input
                  value={draft.code ?? ""}
                  onChange={(event) => update("code", event.target.value)}
                />
              </Field>
            )}
            <Field label="Status">
              <Select
                value={draft.status}
                onValueChange={(next: RegistryStatus) => update("status", next)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Active">Active</SelectItem>
                  <SelectItem value="Inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Description" wide>
              <Textarea
                rows={3}
                value={draft.description}
                onChange={(event) => update("description", event.target.value)}
              />
            </Field>
          </DialogSection>
        </div>
        <DialogFooter className="border-t px-6 py-4">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save}>Save {entityLabel.toLowerCase()}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RegistryPane({
  title,
  description,
  entityLabel,
  dialogDescription,
  searchPlaceholder,
  newLabel,
  idPrefix,
  withCode,
  items,
  usage,
  usageNoun,
  inUseHint,
  onSave,
  onDelete,
}: {
  title: string
  description: string
  entityLabel: string
  dialogDescription: string
  searchPlaceholder: string
  newLabel: string
  idPrefix: string
  withCode?: boolean
  items: readonly RegistryItem[]
  usage: (item: RegistryItem) => number
  usageNoun: string
  inUseHint: string
  onSave: (item: RegistryItem) => void
  onDelete: (id: string) => void
}) {
  const [query, setQuery] = useState("")
  const [statuses, setStatuses] = useState<string[]>([])
  const [view, setView] = useState<AssetView>(defaultAssetView)
  const [editing, setEditing] = useState<RegistryItem | null>(null)

  const filtered = sortByView(
    items
      .filter((item) =>
        [item.name, item.code ?? "", item.description]
          .join(" ")
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
      .filter((item) => statuses.length === 0 || statuses.includes(item.status)),
    view,
    (item) => item.name,
    (item) => item.updatedAt,
  )

  const handleDelete = (item: RegistryItem) => {
    const count = usage(item)
    if (count > 0) {
      toast.error(`${item.name} is in use`, {
        description: `${usageLabel(count, usageNoun)} ${inUseHint} — set it Inactive instead of deleting.`,
      })
      return
    }
    onDelete(item.id)
    toast.success(`${entityLabel} deleted`)
  }

  return (
    <AssetPanelShell
      heading="Commercial"
      title={title}
      description={description}
      action={
        <Button size="sm" onClick={() => setEditing(blankRegistryItem())}>
          <Plus className="h-4 w-4" weight="bold" />
          {newLabel}
        </Button>
      }
      toolbar={
        <AssetToolbar
          searchPlaceholder={searchPlaceholder}
          query={query}
          onQueryChange={setQuery}
          statuses={statuses}
          onStatusesChange={setStatuses}
          view={view}
          onViewChange={setView}
        />
      }
    >
      <RecordsSection shown={filtered.length} total={items.length}>
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead>Name</TableHead>
              {withCode && <TableHead>Code</TableHead>}
              <TableHead>Used by</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <EmptyRow
                colSpan={withCode ? 5 : 4}
                message={`No ${entityLabel.toLowerCase()}s match this search.`}
              />
            ) : (
              filtered.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="min-w-[200px]">
                    <p className="text-sm font-medium text-foreground">{item.name}</p>
                    {view.showDetails && (
                      <p className="line-clamp-1 text-xs text-muted-foreground">
                        {item.description || "No description"}
                      </p>
                    )}
                  </TableCell>
                  {withCode && (
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {item.code || "—"}
                    </TableCell>
                  )}
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {usageLabel(usage(item), usageNoun)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge active={item.status === "Active"} />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setEditing(item)}
                        aria-label={`Edit ${item.name}`}
                      >
                        <PencilSimple className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleDelete(item)}
                        aria-label={`Delete ${item.name}`}
                      >
                        <Trash className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </RecordsSection>
      <RegistryDialog
        key={editing ? editing.id || "new" : "closed"}
        value={editing}
        entityLabel={entityLabel}
        dialogDescription={dialogDescription}
        withCode={withCode}
        onSave={(item) =>
          onSave({
            ...item,
            id: item.id || registryEntityId(`${idPrefix}-${slug(item.name)}`),
            createdAt: item.createdAt || nowIso(),
            updatedAt: nowIso(),
          })
        }
        onClose={() => setEditing(null)}
      />
    </AssetPanelShell>
  )
}

function ZonesPane() {
  const registries = useCommercialRegistriesStore()
  const { rows } = useCommercialCatalogue()
  return (
    <RegistryPane
      title="Zones"
      description="Pricing zones that price rows can condition on. Price Engine's Add price form offers the active zones."
      entityLabel="Zone"
      dialogDescription="Zones narrow who pays a price — Add price offers them as a condition."
      searchPlaceholder="Search zones"
      newLabel="New zone"
      idPrefix="zone"
      items={registries.zones}
      usage={(item) => rows.filter((row) => row.conditions.zone === item.name).length}
      usageNoun="price row"
      inUseHint="condition on it"
      onSave={(item) =>
        registries.saveZone({
          id: item.id,
          name: item.name,
          description: item.description,
          status: item.status,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        })
      }
      onDelete={registries.deleteZone}
    />
  )
}

function ServicePane() {
  const registries = useCommercialRegistriesStore()
  const { productRecords } = useCommercialCatalogue()
  return (
    <RegistryPane
      title="Service"
      description="Service levels offered on products — collection tiers like backdoor or crane emptying. Products pick from the active levels."
      entityLabel="Service level"
      dialogDescription="Service levels are offered per product; the product form picks from the active ones."
      searchPlaceholder="Search service levels"
      newLabel="New service level"
      idPrefix="service"
      withCode
      items={registries.serviceLevels}
      usage={(item) =>
        productRecords.filter((product) =>
          splitList(product.facts[PRODUCT_FACTS.serviceLevels]).includes(item.name),
        ).length
      }
      usageNoun="product"
      inUseHint="offer it"
      onSave={(item) =>
        registries.saveServiceLevel({
          id: item.id,
          name: item.name,
          code: item.code ?? "",
          description: item.description,
          status: item.status,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        })
      }
      onDelete={registries.deleteServiceLevel}
    />
  )
}

function CustomerTypesPane() {
  const registries = useCommercialRegistriesStore()
  const { rows } = useCommercialCatalogue()
  return (
    <RegistryPane
      title="Customer types"
      description="Customer segments that price rows can condition on. Price Engine's Add price form offers the active types."
      entityLabel="Customer type"
      dialogDescription="Customer types narrow who pays a price — Add price offers them as a condition."
      searchPlaceholder="Search customer types"
      newLabel="New customer type"
      idPrefix="customer-type"
      items={registries.customerTypes}
      usage={(item) =>
        rows.filter((row) => row.conditions.customerType === item.name).length
      }
      usageNoun="price row"
      inUseHint="condition on it"
      onSave={(item) =>
        registries.saveCustomerType({
          id: item.id,
          name: item.name,
          description: item.description,
          status: item.status,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        })
      }
      onDelete={registries.deleteCustomerType}
    />
  )
}

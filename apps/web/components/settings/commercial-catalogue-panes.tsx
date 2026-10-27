"use client"
// Settings › Commercial on the Pilot, and its price lists in both modes
// (Issue #185, slice 10 of #81, for #148). The pane keeps two tabs: the
// products, which on the Pilot are `commercial.products` as the API holds them
// (fixture mode keeps its own pane, commercial-settings.tsx), and the price
// lists, the kind of `commercial.price-rows` the API grants `/price-lists`
// under — or, in fixture mode, a browser bucket of their own seeded with the
// prototype's four lists (`FIXTURE_PRICE_LISTS_BUCKET`): one source by mode,
// never both. The zones, service levels, customer types and surcharge rules
// the prototype kept beside them are gone with their browser store: a zone is
// a planning area, a customer type is a customer's kind, and a service level
// and a surcharge have no home on the wire (#127).
//
// On the Pilot nothing is shown until the module has answered — a fixture row
// shown there is a row that does not exist — and a write waits on the API's
// answer with the dialog open, its refusal the store's toast (`whenSaved`).
// The forms are lib/data/commercial-forms.ts', their fields the adapters'
// keys. A list is never deleted: it ends on its last day in force.
//
// On the Pilot a list's row offers Apply index (#291 C8): the dialog previews
// what each of its rows becomes from a day and applies it, and the rows and
// the products' default prices are read again once it lands.
import { useMemo, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { ArrowSquareOut, PencilSimple, Percent, Plus } from "@phosphor-icons/react/dist/ssr"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { TablePagination, useTablePagination } from "@/components/ui/table-pagination"
import { AssetPanelShell, AssetToolbar, EmptyRow, RecordsSection, defaultAssetView, sortByView, type AssetView } from "@/components/settings/asset-management-settings"
import { useApiClient, useApiConfigured } from "@/components/waste/api-session-store"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useBusinessRecordStore, useModuleRecords, useServerModuleState, whenSaved } from "@/components/waste/business-record-store"
import { statusClasses } from "@/components/waste/business-record-views"
import { ApplyIndexDialog } from "@/components/waste/commands/apply-index-dialog"
import { useCommercialPickers } from "@/components/waste/commands/commercial-pickers"
import { useProjectRecords, useRecordsByServerId, useServerNames } from "@/components/waste/commands/use-command-support"
import { typed } from "@/lib/api/records/adapter"
import { indexPriceList } from "@/lib/api/records/indexation"
import { dayIn } from "@/lib/api/records/planning"
import { PRICING_REFERENCE_DATE, recordToPriceRow } from "@/lib/commercial/price-model"
import type { BusinessFormSchema, BusinessFormValues } from "@/lib/data/business-form-types"
import { businessWorkspaces, type BusinessRecord } from "@/lib/data/business-modules"
import { FIXTURE_PRICE_LISTS, FIXTURE_PRICE_LISTS_BUCKET, isPriceListRecord, isPriceRowRecord, PRICE_ROWS_MODULE, PRODUCT_KIND_LABELS, PRODUCT_PREFIX, PRODUCTS_MODULE } from "@/lib/data/commercial"
import { createPriceListRecord, createProductRecord, formValuesOf, PRICE_LIST_FORM, priceListEditForm, PRODUCT_FORM, productEditForm, productFormValues, updatePriceListRecord, updateProductRecord } from "@/lib/data/commercial-forms"
import { cn } from "@/lib/utils"

const fixturesOf = (moduleId: string) => businessWorkspaces.commercial.modules.find((module) => module.id === moduleId)?.records ?? []

/** What a Pilot pane says in place of rows: still reading, not the role's to see, a read refused, or nothing to show. */
function emptyMessageOf(answer: ReturnType<typeof useModuleRecords>, noun: string, filtered: boolean): { message: string; hint?: string } {
  if (answer.pending) return { message: `Reading the ${noun} from the API…` }
  if (answer.notGranted) return { message: `The ${noun} are not shown to your role.`, hint: answer.problem?.detail }
  if (answer.problem) return { message: `The ${noun} could not be read from the API: ${answer.problem.detail ?? answer.problem.title}` }
  return { message: filtered ? `No ${noun} match this search.` : `No ${noun} yet.` }
}

/** A dialog open on a snapshot of the row, or on a new one. */
type Editing = { schema: BusinessFormSchema; values: BusinessFormValues; record: BusinessRecord | null }

const PRODUCT_STATUS_OPTIONS = ["Draft", "Active", "Inactive"] as const
const PRODUCT_TYPE_OPTIONS = Object.values(PRODUCT_KIND_LABELS)

// ---------------------------------------------------------------------------
// Products, on the Pilot
// ---------------------------------------------------------------------------

/** Settings › Commercial › Products on the Pilot: the catalogue as the API holds it, created and edited here. */
export function ProductsOnApiPane() {
  const { upsertRecord } = useBusinessRecordStore()
  const pickers = useCommercialPickers()
  const answer = useModuleRecords(PRODUCTS_MODULE.workspaceId, PRODUCTS_MODULE.moduleId, fixturesOf(PRODUCTS_MODULE.moduleId))
  const [query, setQuery] = useState("")
  const [statuses, setStatuses] = useState<string[]>([])
  const [types, setTypes] = useState<string[]>([])
  const [view, setView] = useState<AssetView>(defaultAssetView)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [saving, setSaving] = useState(false)

  const filtered = sortByView(
    answer.records
      .filter((record) => [record.name, record.facts.Type, record.facts["Invoice code"], record.facts["Waste fraction"]].join(" ").toLowerCase().includes(query.trim().toLowerCase()))
      .filter((record) => statuses.length === 0 || statuses.includes(record.status))
      .filter((record) => types.length === 0 || types.includes(record.facts.Type ?? "")),
    view,
    (record) => record.name,
    () => "",
  )
  const { page, setPage, pageCount, pageRows, totalCount } = useTablePagination(filtered)

  const save = (values: BusinessFormValues) => {
    if (saving || editing === null) return
    const record = editing.record === null ? createProductRecord(values, Date.now()) : updateProductRecord(editing.record, values)
    setSaving(true)
    whenSaved(
      upsertRecord(PRODUCTS_MODULE.workspaceId, PRODUCTS_MODULE.moduleId, record),
      () => {
        setEditing(null)
        toast.success(editing.record === null ? "Product created" : "Product updated", { description: editing.record === null ? `${record.name} is in the catalogue: add its price in Price Engine with Add price.` : `${record.name} was updated.` })
      },
      () => setSaving(false),
    )
  }

  const empty = emptyMessageOf(answer, "products", answer.records.length > 0)

  return (
    <AssetPanelShell
      heading="Commercial"
      title="Products"
      description="The sellable catalogue of each project, as the API holds it: what an invoice line calls a product, the code a ledger books it under, and its VAT rate. Prices are rows of a price list, added in Price Engine with Add price."
      action={
        <>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/commercial">
              Open in Price Engine
              <ArrowSquareOut className="h-3.5 w-3.5" />
            </Link>
          </Button>
          <Button size="sm" disabled={!answer.ready || saving || !pickers.readyFor(PRODUCT_FORM)} onClick={() => setEditing({ schema: PRODUCT_FORM, values: {}, record: null })}>
            <Plus className="h-4 w-4" weight="bold" />
            New product
          </Button>
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
          extraFilters={[{ label: "Type", options: PRODUCT_TYPE_OPTIONS, value: types, onChange: setTypes }]}
          view={view}
          onViewChange={setView}
        />
      }
    >
      <RecordsSection shown={filtered.length} total={answer.records.length}>
        <div className="overflow-x-auto">
          <Table className="min-w-[960px]" data-testid="products-on-api">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Container type</TableHead>
                <TableHead>Waste fraction</TableHead>
                <TableHead>VAT</TableHead>
                <TableHead>Invoice code</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <EmptyRow colSpan={8} message={empty.message} hint={empty.hint} />
              ) : (
                pageRows.map((product) => (
                  <TableRow key={product.id}>
                    <TableCell className="min-w-[220px]">
                      <p className="text-sm font-medium text-foreground">{product.name}</p>
                      {view.showDetails && <p className="text-xs text-muted-foreground">{product.facts.Project ?? product.context}</p>}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[11px] font-normal">
                        {product.facts.Type ?? "—"}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{product.facts["Container type"] ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{product.facts["Waste fraction"] ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{product.submittedValues?.vatPercent === undefined ? "Not set" : `${product.submittedValues.vatPercent}%`}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{product.facts["Invoice code"] ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", statusClasses(product.status))}>
                        {product.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <Button variant="ghost" size="icon" className="h-8 w-8" disabled={saving || !pickers.readyFor(PRODUCT_FORM)} onClick={() => setEditing({ schema: productEditForm(product), values: productFormValues(product), record: product })} aria-label={`Edit ${product.name}`}>
                        <PencilSimple className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <TablePagination page={page} pageCount={pageCount} totalCount={totalCount} onPageChange={setPage} />
      </RecordsSection>
      {editing !== null && (
        <BusinessRecordFormDialog schema={editing.schema} open onOpenChange={(isOpen) => !isOpen && setEditing(null)} onSubmit={save} relationOptions={(field, values) => pickers.options(field, values, undefined, editing.values)} initialValueOverrides={editing.values} />
      )}
    </AssetPanelShell>
  )
}

// ---------------------------------------------------------------------------
// Price lists, in both modes
// ---------------------------------------------------------------------------

const LIST_STATUS_OPTIONS = ["Scheduled", "Active", "Expired"] as const

/** Apply index over one list on the Pilot (#291 C8): each line named by its row — the product and its conditions — from today on the list's project's clock, and the rows and the products read again once it lands. */
function ApplyListIndex({ list, onClose }: { list: BusinessRecord; onClose: () => void }) {
  const client = useApiClient()
  const { refreshModule } = useBusinessRecordStore()
  const state = useServerModuleState(PRICE_ROWS_MODULE.workspaceId, PRICE_ROWS_MODULE.moduleId)
  const rowOf = useRecordsByServerId(PRICE_ROWS_MODULE)
  const productName = useServerNames(PRODUCTS_MODULE, PRODUCT_PREFIX)
  const projectOf = useProjectRecords()
  const project = projectOf(list.projectIds?.[0])
  const serverId = state?.serverIds.get(list.id)
  return (
    <ApplyIndexDialog
      title={`Apply index to ${list.name}`}
      description="Each row in force on the day ends on it, and its successor carries the indexed price, rounded to the minor unit. A row that starts on that day or later is left as it is. Preview first; nothing is written until Apply."
      defaultDay={dayIn(new Date(), project === undefined ? undefined : typed(project, "timezone"))}
      currencyOf={() => String(list.submittedValues?.currency ?? (project === undefined ? undefined : typed(project, "currency")) ?? "")}
      nameOf={(line) => {
        const row = rowOf(line.id)
        return row === undefined ? productName(line.productId) : `${row.context} · ${row.name}`
      }}
      send={(index, dryRun) => {
        if (client === null || serverId === undefined) return Promise.reject(new Error("The price list is not read from the API yet"))
        return indexPriceList(client, serverId, { label: index.label, basisPoints: index.basisPoints, appliedFrom: index.appliedFrom, dryRun })
      }}
      onApplied={() => {
        void refreshModule(PRICE_ROWS_MODULE.workspaceId, PRICE_ROWS_MODULE.moduleId)
        void refreshModule(PRODUCTS_MODULE.workspaceId, PRODUCTS_MODULE.moduleId)
        onClose()
      }}
      onClose={onClose}
    />
  )
}

/** Settings › Commercial › Price lists: the Pilot's from the API, fixture mode's from the browser's bucket; one form for both. */
export function PriceListsPane() {
  const configured = useApiConfigured()
  const { getRecords, upsertRecord } = useBusinessRecordStore()
  const pickers = useCommercialPickers()
  const location = configured ? PRICE_ROWS_MODULE : FIXTURE_PRICE_LISTS_BUCKET
  const answer = useModuleRecords(location.workspaceId, location.moduleId, configured ? fixturesOf(PRICE_ROWS_MODULE.moduleId) : FIXTURE_PRICE_LISTS)
  const fixtureRows = getRecords(PRICE_ROWS_MODULE.workspaceId, PRICE_ROWS_MODULE.moduleId, fixturesOf(PRICE_ROWS_MODULE.moduleId))
  const [query, setQuery] = useState("")
  const [statuses, setStatuses] = useState<string[]>([])
  const [view, setView] = useState<AssetView>(defaultAssetView)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [indexing, setIndexing] = useState<BusinessRecord | null>(null)
  const [saving, setSaving] = useState(false)
  // Fixture mode reads every period on the prototype's day; the Pilot's statuses are the adapter's, read on each project's.
  const day = configured ? dayIn(new Date(), undefined) : PRICING_REFERENCE_DATE

  const lists = answer.records.filter(isPriceListRecord)
  // How many rows each list holds: on the Pilot the rows that name it, in fixture mode the rows tagged with its name.
  const usage = useMemo(() => {
    const counts = new Map<string, number>()
    if (configured) {
      for (const row of answer.records.filter(isPriceRowRecord)) {
        const listId = row.submittedValues?.priceListId
        if (typeof listId === "string") counts.set(listId, (counts.get(listId) ?? 0) + 1)
      }
    } else {
      for (const row of fixtureRows.map(recordToPriceRow)) {
        const list = row === null ? undefined : FIXTURE_PRICE_LISTS.find((candidate) => candidate.name === row.tag)
        if (list !== undefined) counts.set(list.id, (counts.get(list.id) ?? 0) + 1)
      }
    }
    return counts
  }, [answer.records, configured, fixtureRows])

  const filtered = sortByView(
    lists
      .filter((list) => [list.name, list.facts.Code, list.description].join(" ").toLowerCase().includes(query.trim().toLowerCase()))
      .filter((list) => statuses.length === 0 || statuses.includes(list.status)),
    view,
    (list) => list.name,
    () => "",
  )
  const { page, setPage, pageCount, pageRows, totalCount } = useTablePagination(filtered)

  const save = (values: BusinessFormValues) => {
    if (saving || editing === null) return
    const record = editing.record === null ? createPriceListRecord(values, { now: Date.now(), day }) : updatePriceListRecord(editing.record, values, day)
    setSaving(true)
    whenSaved(
      upsertRecord(location.workspaceId, location.moduleId, record),
      () => {
        setEditing(null)
        toast.success(editing.record === null ? "Price list created" : "Price list updated", { description: `${record.name} ${editing.record === null ? "takes rows from Add price in Price Engine" : "was updated"}.` })
      },
      () => setSaving(false),
    )
  }

  const empty = configured ? emptyMessageOf(answer, "price lists", lists.length > 0) : { message: lists.length > 0 ? "No price lists match this search." : "No price lists yet." }

  return (
    <AssetPanelShell
      heading="Commercial"
      title="Price lists"
      description="Each project's tariff and the named lists an agreement is priced under. A list's code and currency are set once, since its rows are quoted in them; a list ends on its last day in force. Price Engine's Add price puts a row in one."
      action={
        <Button size="sm" disabled={!answer.ready || saving || !pickers.readyFor(PRICE_LIST_FORM)} onClick={() => setEditing({ schema: PRICE_LIST_FORM, values: {}, record: null })}>
          <Plus className="h-4 w-4" weight="bold" />
          New price list
        </Button>
      }
      toolbar={<AssetToolbar searchPlaceholder="Search price lists" query={query} onQueryChange={setQuery} statuses={statuses} onStatusesChange={setStatuses} statusOptions={LIST_STATUS_OPTIONS} view={view} onViewChange={setView} />}
    >
      <RecordsSection shown={filtered.length} total={lists.length}>
        <div className="overflow-x-auto">
          <Table className="min-w-[880px]" data-testid="price-lists">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Name</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Currency</TableHead>
                <TableHead>Default</TableHead>
                <TableHead>Rows</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <EmptyRow colSpan={8} message={empty.message} hint={empty.hint} />
              ) : (
                pageRows.map((list) => {
                  const values = list.submittedValues ?? {}
                  return (
                    <TableRow key={list.id}>
                      <TableCell className="min-w-[200px]">
                        <p className="text-sm font-medium text-foreground">{list.name}</p>
                        {view.showDetails && <p className="line-clamp-1 text-xs text-muted-foreground">{list.description || "No notes"}</p>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{String(values.code ?? "—")}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{String(values.currency || "The project's")}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{values.isDefault === true ? "Default" : "—"}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{usage.get(list.id) ?? 0}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{`${String(values.validFrom ?? "—")} – ${typeof values.validTo === "string" && values.validTo !== "" ? values.validTo : "open"}`}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", statusClasses(list.status))}>
                          {list.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        {/* An ended list has no price to index: the bulk index is offered while it runs or before it starts, as a price's own is (#281). */}
                        {configured && list.status !== "Expired" && (
                          <Button variant="ghost" size="icon" className="h-8 w-8" disabled={saving || !answer.ready} onClick={() => setIndexing(list)} aria-label={`Apply index to ${list.name}`} title="Apply index">
                            <Percent className="h-4 w-4" />
                          </Button>
                        )}
                        <Button variant="ghost" size="icon" className="h-8 w-8" disabled={saving} onClick={() => setEditing({ schema: priceListEditForm(list), values: formValuesOf(PRICE_LIST_FORM, list), record: list })} aria-label={`Edit ${list.name}`}>
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
        <TablePagination page={page} pageCount={pageCount} totalCount={totalCount} onPageChange={setPage} />
      </RecordsSection>
      {editing !== null && (
        <BusinessRecordFormDialog schema={editing.schema} open onOpenChange={(isOpen) => !isOpen && setEditing(null)} onSubmit={save} relationOptions={(field, values) => pickers.options(field, values, undefined, editing.values)} initialValueOverrides={editing.values} />
      )}
      {indexing !== null && <ApplyListIndex list={indexing} onClose={() => setIndexing(null)} />}
    </AssetPanelShell>
  )
}

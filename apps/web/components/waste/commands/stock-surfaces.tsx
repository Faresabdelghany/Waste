"use client"
// A warehouse's stock in its details, on the Pilot (O30 of #290, row 9.8):
// what stands in it by container type — in stock and in maintenance there —
// read from `GET /stock-balances?warehouseId=` (records/stock.ts), each type
// against the office's Stock Minimum and marked below it where fewer stand in
// stock. Edit minimums sets a count per container type of the master data and
// replaces the warehouse's set whole as its action; the stock is read again
// once it lands. Nothing is alerted or ordered from it. A role that may not
// read the inventory is told so in the API's words where the stock would be.
import { useState } from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useBusinessRecordStore, useModuleRecords, useServerModuleState } from "@/components/waste/business-record-store"
import type { RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { ReadRows } from "@/components/waste/commands/read-rows"
import { useCommandOffered } from "@/components/waste/provider-account"
import { useModuleReady, useRowHistory, useServerNames } from "@/components/waste/commands/use-command-support"
import { SET_STOCK_MINIMUMS, setStockMinimums, stockLine, warehouseStock, type MinimumDraft } from "@/lib/api/records/stock"
import { WAREHOUSES_MODULE } from "@/lib/data/containers"
import { MASTER_DATA_MODULE, masterDataKindOf } from "@/lib/data/master-data"

const NO_RECORDS = [] as const

/** A warehouse's stock by container type, against its minimums, and the editor of the minimums. */
export function WarehouseStockSurface({ record }: RowSurfaceProps) {
  const { sendAction } = useBusinessRecordStore()
  const moduleReady = useModuleReady(WAREHOUSES_MODULE)
  const offered = useCommandOffered(WAREHOUSES_MODULE)(SET_STOCK_MINIMUMS)
  const master = useModuleRecords(MASTER_DATA_MODULE.workspaceId, MASTER_DATA_MODULE.moduleId, NO_RECORDS)
  const masterIds = useServerModuleState(MASTER_DATA_MODULE.workspaceId, MASTER_DATA_MODULE.moduleId)?.serverIds
  const types = master.records.filter((row) => masterDataKindOf(row) === "container-type")
  const typeName = useServerNames(MASTER_DATA_MODULE, "container-type")
  const [version, setVersion] = useState(0)
  const stock = useRowHistory(WAREHOUSES_MODULE.workspaceId, WAREHOUSES_MODULE.moduleId, record, version, warehouseStock)
  const [drafts, setDrafts] = useState<MinimumDraft[] | null>(null)
  const [busy, setBusy] = useState(false)

  const edit = () =>
    setDrafts(
      types.map((type) => {
        const balance = stock.rows?.find((row) => row.containerTypeId === masterIds?.get(type.id))
        return { containerTypeId: type.id, minimum: balance?.minimum == null ? "" : String(balance.minimum) }
      }),
    )
  const save = () => {
    if (drafts === null || busy) return
    setBusy(true)
    void setStockMinimums(sendAction, record.id, drafts).then((outcome) => {
      setBusy(false)
      if (outcome.kind !== "done") return
      setDrafts(null)
      setVersion((count) => count + 1)
      toast.success("Stock minimums saved", { description: record.name })
    })
  }

  return (
    <section className="space-y-3" data-testid="warehouse-stock">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Stock</h3>
        {offered && (
          <Button variant="outline" size="sm" disabled={!moduleReady || !master.ready || stock.rows === null || busy} onClick={edit}>
            Edit minimums
          </Button>
        )}
      </div>
      <ReadRows
        read={stock}
        label="Reading the warehouse's stock…"
        empty="No containers stand here, and no minimum is set."
        testId="warehouse-stock-rows"
        line={(balance) => (
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium">{typeName(balance.containerTypeId)}</span>
            <span className="flex items-center gap-2 text-muted-foreground">
              {stockLine(balance)}
              {balance.belowMinimum && (
                <Badge variant="outline" className="rounded-full border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200">
                  Below minimum
                </Badge>
              )}
            </span>
          </div>
        )}
      />
      {drafts !== null && (
        <Dialog open onOpenChange={(open) => !open && setDrafts(null)}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Stock minimums of {record.name}</DialogTitle>
              <DialogDescription>The fewest containers of each type this warehouse should hold in stock; a container in maintenance does not count. Leave a type blank for no minimum.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {drafts.map((draft, index) => (
                <div key={draft.containerTypeId} className="grid grid-cols-[minmax(0,1fr)_120px] items-center gap-3">
                  <Label htmlFor={`minimum-${index}`}>{types.find((type) => type.id === draft.containerTypeId)?.name ?? draft.containerTypeId}</Label>
                  <Input
                    id={`minimum-${index}`}
                    inputMode="numeric"
                    value={draft.minimum}
                    onChange={(event) => setDrafts(drafts.map((each, at) => (at === index ? { ...each, minimum: event.target.value } : each)))}
                  />
                </div>
              ))}
              {drafts.length === 0 && <p className="text-sm text-muted-foreground">The master data holds no container type yet.</p>}
            </div>
            <DialogFooter>
              <Button variant="ghost" disabled={busy} onClick={() => setDrafts(null)}>
                Cancel
              </Button>
              <Button disabled={busy} onClick={save}>
                Save minimums
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}

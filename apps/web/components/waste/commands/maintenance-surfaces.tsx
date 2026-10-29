"use client"
// A vehicle's maintenance on the Pilot (O20 of #290): a section of the
// vehicle's details in Fleet. Its plans, the most due first, each with where
// it stands and Retire; and its Maintenance Orders, the open ones first, each
// with Complete and Cancel. Both are read from the API beside the row
// (`useRowHistory`), again after each action the API took, and written as the
// row's actions (lib/api/records/maintenance.ts); a refusal is the store's
// toast in the API's words, and a form stays open on it. A plan's order
// completed is its service, so the plans are read again with the orders.
// Nothing is offered until the module reads the API's rows.
import { useState } from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useBusinessRecordStore } from "@/components/waste/business-record-store"
import type { RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { ReadRows } from "@/components/waste/commands/read-rows"
import { useModuleReady, useRowHistory } from "@/components/waste/commands/use-command-support"
import {
  addMaintenancePlan,
  cancelMaintenanceOrder,
  completeMaintenanceOrder,
  DUE_LABELS,
  openMaintenanceOrder,
  orderLine,
  planLine,
  retireMaintenancePlan,
  vehicleOrders,
  vehiclePlans,
} from "@/lib/api/records/maintenance"
import type { ActionOutcome } from "@/lib/api/records/server-records"
import { VEHICLES_MODULE } from "@/lib/data/allocations"
import type { BusinessFormValues } from "@/lib/data/business-form-types"
import { COMPLETE_FORM, orderFormOf, PLAN_FORM } from "@/lib/data/maintenance"
import type { MaintenanceOrder } from "@waste/contracts/maintenance"

const text = (values: BusinessFormValues, key: string): string => (typeof values[key] === "string" ? (values[key] as string) : "")

const DUE_VARIANTS = { ok: "secondary", "due-soon": "outline", overdue: "default" } as const

export function VehicleMaintenanceSurface({ record }: RowSurfaceProps) {
  const { sendAction } = useBusinessRecordStore()
  const moduleReady = useModuleReady(VEHICLES_MODULE)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<"plan" | "order" | null>(null)
  const [completing, setCompleting] = useState<MaintenanceOrder | null>(null)
  const [cancelling, setCancelling] = useState<MaintenanceOrder | null>(null)
  const [note, setNote] = useState("")
  // Bumped after each action the API took: the plans and the orders are read again, whatever the row shows.
  const [version, setVersion] = useState(0)
  const plans = useRowHistory(VEHICLES_MODULE.workspaceId, VEHICLES_MODULE.moduleId, record, version, vehiclePlans)
  const orders = useRowHistory(VEHICLES_MODULE.workspaceId, VEHICLES_MODULE.moduleId, record, version, vehicleOrders)
  const offered = moduleReady && !busy

  const settle = (outcome: Promise<ActionOutcome<unknown>>, done: () => void) => {
    if (busy) return
    setBusy(true)
    void outcome.then((result) => {
      setBusy(false)
      if (result.kind !== "done") return
      setVersion((current) => current + 1)
      done()
    })
  }

  const addPlan = (values: BusinessFormValues) =>
    settle(
      addMaintenancePlan(sendAction, record.id, {
        name: text(values, "name"),
        intervalDays: text(values, "intervalDays"),
        intervalKm: text(values, "intervalKm"),
        intervalHours: text(values, "intervalHours"),
        lastDoneOn: text(values, "lastDoneOn"),
        lastDoneKm: text(values, "lastDoneKm"),
        lastDoneHours: text(values, "lastDoneHours"),
      }),
      () => {
        setForm(null)
        toast.success("Maintenance plan added", { description: `${record.name}: ${text(values, "name").trim()}` })
      },
    )

  const openOrder = (values: BusinessFormValues) =>
    settle(openMaintenanceOrder(sendAction, record.id, { planId: text(values, "planId"), title: text(values, "title"), dueOn: text(values, "dueOn"), note: text(values, "note") }), () => {
      setForm(null)
      toast.success("Maintenance order opened", { description: record.name })
    })

  const complete = (values: BusinessFormValues) => {
    if (completing === null) return
    const order = completing
    settle(
      completeMaintenanceOrder(sendAction, record.id, { orderId: order.id, completedOn: text(values, "completedOn"), odometerKm: text(values, "odometerKm"), engineHours: text(values, "engineHours"), note: text(values, "note") }),
      () => {
        setCompleting(null)
        toast.success("Maintenance order completed", { description: `${record.name}: ${order.title}` })
      },
    )
  }

  const cancel = () => {
    if (cancelling === null) return
    const order = cancelling
    settle(cancelMaintenanceOrder(sendAction, record.id, order.id, note.trim()), () => {
      setCancelling(null)
      setNote("")
      toast.success("Maintenance order cancelled", { description: `${record.name}: ${order.title}` })
    })
  }

  const retire = (planId: string, name: string) => settle(retireMaintenancePlan(sendAction, record.id, planId), () => toast.success("Maintenance plan retired", { description: `${record.name}: ${name}` }))

  return (
    <section className="space-y-4" data-testid="vehicle-maintenance">
      <h3 className="text-sm font-semibold">Maintenance plans</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The rows are being read from the API; the vehicle&apos;s maintenance follows.</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={!offered} onClick={() => setForm("plan")}>
          Add plan
        </Button>
        <Button variant="outline" size="sm" disabled={!offered || plans.rows === null} onClick={() => setForm("order")}>
          Open order
        </Button>
      </div>
      <ReadRows
        read={plans}
        label="Reading the plans…"
        empty="No maintenance plan."
        testId="vehicle-maintenance-plans"
        line={(plan) => (
          <div className="flex items-center justify-between gap-2">
            <span className={plan.status === "retired" ? "text-muted-foreground" : undefined}>{planLine(plan)}</span>
            {plan.status === "active" ? (
              <span className="flex shrink-0 items-center gap-1">
                <Badge variant={DUE_VARIANTS[plan.due.state]}>{DUE_LABELS[plan.due.state]}</Badge>
                <Button variant="ghost" size="sm" disabled={!offered} onClick={() => retire(plan.id, plan.name)}>
                  Retire
                </Button>
              </span>
            ) : (
              <Badge variant="secondary">Retired</Badge>
            )}
          </div>
        )}
      />
      <h3 className="text-sm font-semibold">Maintenance orders</h3>
      <ReadRows
        read={orders}
        label="Reading the orders…"
        empty="No maintenance order."
        testId="vehicle-maintenance-orders"
        line={(order) => (
          <div className="flex items-center justify-between gap-2">
            <span>{orderLine(order)}</span>
            {order.status === "open" ? (
              <span className="flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="sm" disabled={!offered} onClick={() => setCompleting(order)}>
                  Complete
                </Button>
                <Button variant="ghost" size="sm" disabled={!offered} onClick={() => setCancelling(order)}>
                  Cancel
                </Button>
              </span>
            ) : (
              <Badge variant="secondary">{order.status === "completed" ? "Completed" : "Cancelled"}</Badge>
            )}
          </div>
        )}
      />
      {form === "plan" && <BusinessRecordFormDialog schema={PLAN_FORM} open onOpenChange={(isOpen) => !isOpen && setForm(null)} onSubmit={addPlan} relationOptions={(field) => field.options ?? []} submitting={busy} />}
      {form === "order" && <BusinessRecordFormDialog schema={orderFormOf(plans.rows ?? [])} open onOpenChange={(isOpen) => !isOpen && setForm(null)} onSubmit={openOrder} relationOptions={(field) => field.options ?? []} submitting={busy} />}
      {completing !== null && <BusinessRecordFormDialog schema={{ ...COMPLETE_FORM, title: `Complete ${completing.title}` }} open onOpenChange={(isOpen) => !isOpen && setCompleting(null)} onSubmit={complete} relationOptions={(field) => field.options ?? []} submitting={busy} />}
      <Dialog open={cancelling !== null} onOpenChange={(open) => !open && setCancelling(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel {cancelling?.title}</DialogTitle>
            <DialogDescription>The order is closed as not done. A plan it served keeps its last service as it was.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="maintenance-cancel-note">Why (optional)</Label>
            <Textarea id="maintenance-cancel-note" value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelling(null)}>
              Keep it open
            </Button>
            <Button disabled={busy} onClick={cancel}>
              Cancel order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

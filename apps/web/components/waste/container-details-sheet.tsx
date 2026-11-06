"use client"

import { useState } from "react"
import { toast } from "sonner"
import { DotsThree, Printer, Ticket, Trash, Wrench } from "@phosphor-icons/react/dist/ssr"

import type { BusinessRecord } from "@/lib/data/business-modules"
import { serviceFrequencyOfRecord } from "@waste/domain/service-frequencies"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { canonicalCalendarName } from "@/components/waste/business-filter-popover"

type ContainerProfile = {
  id: string
  type: string
  fractions: string
  address: string
  property: string
  project: string
  pickupMethod: string
  serviceFrequency: string
  calendar: string
  routeScheme: string
  fillLevel: string
  sensor: string
  battery: string
  lastMeasurement: string
  ownership: string
  rfid: string
  group: string
}

const detailTabs = [
  ["configuration", "Configuration"],
  ["routes", "Routes"],
  ["collection-log", "Collection Log"],
  ["history", "History"],
  ["tickets", "Tickets"],
  ["property", "Property"],
  ["property-groups", "Property Groups"],
  ["invoices", "Invoices"],
  ["agreements", "Agreements"],
  ["temporary-changes", "Temporary changes"],
  ["stock-activity", "Stock activity"],
] as const

function fact(record: BusinessRecord, label: string, fallback = "—") {
  return record.facts[label] ?? fallback
}

function profileFor(record: BusinessRecord): ContainerProfile {
  const submitted = record.submittedValues ?? {}
  const text = (field: string): string => {
    const value = submitted[field]
    return typeof value === "string" ? value : ""
  }

  const primaryFraction = fact(
    record,
    "Primary waste fraction",
    text("wasteFraction") || "Not set",
  )
  const secondaryFraction = fact(
    record,
    "Additional waste fraction · order 2",
    text("secondaryWasteFraction") || "",
  )

  return {
    id: fact(record, "Container ID", record.name.split(" · ")[0]),
    type: fact(record, "Container type", text("containerType") || "Type pending"),
    fractions: fact(
      record,
      "Waste fractions",
      [primaryFraction, secondaryFraction].filter(Boolean).join(" · "),
    ),
    address: fact(
      record,
      "Address",
      fact(record, "Location or service address", text("serviceAddress") || record.context),
    ),
    property: fact(record, "Property"),
    project: fact(
      record,
      "Project",
      fact(
        record,
        "Operating project",
        record.context.includes("Harbor") ? "Harbor Commercial" : "Copenhagen Central",
      ),
    ),
    pickupMethod: fact(record, "Pickup method", text("pickupMethod") || "Disabled"),
    // Typed frequency reference first (issue #20); the legacy fallback chain
    // then covers pre-rename records (retired "Pickup setting" fact key) and
    // older form submissions that only have submittedValues (issue #13).
    serviceFrequency:
      serviceFrequencyOfRecord(record)?.name ??
      fact(record, "Service frequency", fact(record, "Pickup setting", text("pickupSetting"))),
    calendar: canonicalCalendarName(fact(record, "Collection calendar", text("collectionCalendar"))) ?? "—",
    routeScheme: fact(record, "Route scheme", text("routeScheme")),
    fillLevel: fact(record, "Fill level", record.value),
    sensor: fact(record, "Sensor", text("sensorIdentifier") || "None"),
    battery: fact(record, "Battery"),
    lastMeasurement: fact(record, "Last measurement", record.updated),
    ownership: fact(record, "Ownership", text("ownership")),
    rfid: fact(record, "RFID", text("rfid")),
    group: fact(record, "Group"),
  }
}

function statusClass(status: string) {
  const normalized = status.toLowerCase()
  if (normalized === "available") {
    return "border-transparent bg-success/10 text-success-foreground"
  }
  if (normalized === "defect" || normalized === "ended") {
    return "border-transparent bg-destructive/10 text-destructive-foreground"
  }
  if (normalized === "future" || normalized === "on hold" || normalized === "in transit") {
    return "border-transparent bg-warning/10 text-warning-foreground"
  }
  return "border-transparent bg-muted text-muted-foreground"
}

// Pre-rename user-created records keep facts under retired keys and drifted
// calendar names (issue #13).
const legacyFactKeys: Record<string, string> = {
  "Service frequency": "Pickup setting",
}

function factWithLegacyFallback(record: BusinessRecord, label: string) {
  // The typed frequency reference outranks any stored fact string (issue #20).
  if (label === "Service frequency") {
    const definition = serviceFrequencyOfRecord(record)
    if (definition) return definition.name
  }
  const value = legacyFactKeys[label]
    ? fact(record, label, fact(record, legacyFactKeys[label]))
    : fact(record, label)
  return label === "Collection calendar" ? canonicalCalendarName(value) ?? "—" : value
}

function FactGrid({ record, labels }: { record: BusinessRecord; labels: readonly string[] }) {
  return (
    <dl className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
      {labels.map((label) => (
        <div key={label} className="min-w-0 border-b border-border/60 pb-3">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-1 break-words text-sm font-medium">{factWithLegacyFallback(record, label)}</dd>
        </div>
      ))}
    </dl>
  )
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-border/60 p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  )
}

export function ContainerDetailsSheet({
  record,
  onClose,
  onAction,
}: {
  record: BusinessRecord | null
  onClose: () => void
  onAction: (action: string) => void
}) {
  const [activeTab, setActiveTab] = useState("configuration")
  const profile = record ? profileFor(record) : null
  const temporaryLocation = record ? fact(record, "Temporary location") : "None"
  const hasGroup = Boolean(profile && profile.group !== "—")

  return (
    <Sheet open={Boolean(record)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-5xl">
        {record && profile ? (
          <>
            <SheetHeader className="border-b border-border px-5 py-4 pr-12 text-left">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className={cn("rounded-full", statusClass(record.status))}>{record.status}</Badge>
                <Badge variant="outline" className="rounded-full font-normal">{profile.project}</Badge>
                {fact(record, "Warranty end") !== "—" ? <Badge variant="outline" className="rounded-full font-normal">Warranty to {fact(record, "Warranty end")}</Badge> : null}
                {temporaryLocation !== "None" && temporaryLocation !== "—" ? (
                  <Badge className="rounded-full bg-highlight/10 text-highlight-foreground hover:bg-highlight/10">
                    Temporary location · {temporaryLocation}
                  </Badge>
                ) : null}
              </div>
              <SheetTitle className="pt-1 text-xl">{profile.id}</SheetTitle>
              <SheetDescription>{profile.type} · {profile.fractions} · {profile.address}</SheetDescription>
            </SheetHeader>

            <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
              <div className="overflow-x-auto border-b border-border px-4 py-2">
                <TabsList className="inline-flex h-9 min-w-max bg-muted/70">
                  {detailTabs.map(([value, label]) => (
                    <TabsTrigger key={value} value={value} disabled={value === "property-groups" && !hasGroup} className="text-xs">
                      {label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
                <TabsContent value="configuration" className="mt-0 space-y-4">
                  <DetailSection title="Basic">
                    <FactGrid record={record} labels={["Container ID", "Barcode", "RFID", "Serial number", "Project", "Container type", "Waste fractions", "Ownership", "Warranty end", "Condition"]} />
                  </DetailSection>
                  <DetailSection title="Location">
                    <FactGrid record={record} labels={["Address", "Curb location", "Property", "Property number", "Property type", "Group", "Storage depot"]} />
                  </DetailSection>
                  <DetailSection title="Pickup">
                    <FactGrid record={record} labels={["Pickup method", "Service frequency", "Collection calendar", "Last collection", "Next collection"]} />
                  </DetailSection>
                  <DetailSection title="Route">
                    <FactGrid record={record} labels={["Route scheme", "Vehicle"]} />
                  </DetailSection>
                  <DetailSection title="Sensors">
                    <FactGrid record={record} labels={["Sensor", "Measurement setting", "Battery", "RSSI", "Fill level", "Last measurement", "Full threshold"]} />
                    {profile.sensor !== "None" && profile.sensor !== "Not fitted" ? (
                      <div className="rounded-lg border border-border/60 bg-muted/20 p-4">
                        <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
                          <span>Fill level · last 24 hours</span><span>{profile.lastMeasurement}</span>
                        </div>
                        <div className="flex h-24 items-end gap-2">
                          {[48, 54, 61, 68, 72, 79, Number(profile.fillLevel.match(/\d+/)?.[0] ?? 87)].map((height, index) => (
                            <div key={`${height}-${index}`} className="flex-1 rounded-t bg-primary/70" style={{ height: `${Math.max(8, height)}%` }} />
                          ))}
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-warning-foreground">No sensor is paired. Fill percentage defaults to 100% in backend calculations.</p>
                    )}
                  </DetailSection>
                  <DetailSection title="Others">
                    <p className="text-sm text-muted-foreground">{record.description}</p>
                    <FactGrid record={record} labels={["External reference", "Driver description"]} />
                  </DetailSection>
                </TabsContent>

                <TabsContent value="routes" className="mt-0 space-y-4">
                  <DetailSection title="Routes · last 7 days">
                    <FactGrid record={record} labels={["Route scheme", "Vehicle", "Last collection", "Next collection"]} />
                  </DetailSection>
                </TabsContent>

                <TabsContent value="collection-log" className="mt-0">
                  <DetailSection title="Pickup-order service log">
                    <FactGrid
                      record={record}
                      labels={["Last recorded weight", "Weight date"]}
                    />
                    {[fact(record, "Last collection"), "Previous service · completed", "Earlier service · completed"].map((entry, index) => (
                      <div key={`${entry}-${index}`} className="flex items-center justify-between border-b border-border/60 py-3 last:border-0">
                        <span className="text-sm">{entry}</span><Badge variant="outline">{index === 0 ? "Latest" : "Collected"}</Badge>
                      </div>
                    ))}
                  </DetailSection>
                </TabsContent>

                <TabsContent value="history" className="mt-0">
                  <DetailSection title="Audited event history">
                    {["Status synchronized from agreement", "Collection configuration updated", "Location confirmed", "Container created"].map((event, index) => (
                      <div key={event} className="grid grid-cols-[18px_1fr] gap-3 pb-5 last:pb-0">
                        <span className={cn("mt-1 h-2.5 w-2.5 rounded-full", index === 0 ? "bg-primary" : "bg-muted-foreground/35")} />
                        <div><p className="text-sm font-medium">{event}</p><p className="mt-1 text-xs text-muted-foreground">{index === 0 ? record.updated : `${index * 3 + 2} months ago`} · Olivia Larsen · before/after retained</p></div>
                      </div>
                    ))}
                    <Button variant="outline" size="sm" onClick={() => toast.success("Container history PDF queued")}>Download history PDF</Button>
                  </DetailSection>
                </TabsContent>

                <TabsContent value="tickets" className="mt-0">
                  <DetailSection title="Container tickets">
                    <p className="text-sm">{record.related.find((item) => item.startsWith("Ticket")) ?? "No open container tickets"}</p>
                    <Button size="sm" onClick={() => onAction("Create container ticket")}><Ticket className="h-4 w-4" /> Create ticket</Button>
                  </DetailSection>
                </TabsContent>

                <TabsContent value="property" className="mt-0">
                  <DetailSection title="Linked property">
                    <FactGrid record={record} labels={["Property", "Property number", "Property type", "Address", "Agreement"]} />
                  </DetailSection>
                </TabsContent>

                <TabsContent value="property-groups" className="mt-0">
                  <DetailSection title="Property groups"><p className="text-sm font-medium">{profile.group}</p></DetailSection>
                </TabsContent>

                <TabsContent value="invoices" className="mt-0">
                  <DetailSection title="Invoices"><p className="text-sm text-muted-foreground">Invoices are resolved through the container agreement and linked property payer.</p></DetailSection>
                </TabsContent>

                <TabsContent value="agreements" className="mt-0">
                  <DetailSection title="Agreements">
                    <FactGrid record={record} labels={["Agreement", "Property", "Waste fractions", "Container type"]} />
                  </DetailSection>
                </TabsContent>

                <TabsContent value="temporary-changes" className="mt-0">
                  <DetailSection title="Temporary location changes">
                    <p className="text-sm">{temporaryLocation === "None" ? "No scheduled or active temporary relocation." : temporaryLocation}</p>
                    <Button variant="outline" size="sm" onClick={() => toast.success("Temporary-change workflow opened")}>Create temporary change</Button>
                  </DetailSection>
                </TabsContent>

                <TabsContent value="stock-activity" className="mt-0 space-y-4">
                  <DetailSection title="Condition and maintenance">
                    <FactGrid record={record} labels={["Condition", "Storage depot"]} />
                    <Button variant="outline" size="sm" onClick={() => onAction("Defect")}><Wrench className="h-4 w-4" /> Record condition</Button>
                  </DetailSection>
                  <DetailSection title="Lifecycle stock activity">
                    <p className="text-sm">{record.related.find((item) => item.startsWith("Stock")) ?? "No stock movements linked"}</p>
                  </DetailSection>
                </TabsContent>
              </div>
            </Tabs>

            <SheetFooter className="flex-row items-center justify-between border-t border-border px-5 py-4">
              <Button variant="ghost" onClick={onClose}>Close</Button>
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="outline" onClick={() => toast.success("Label PDF generation queued", { description: profile.id })}>
                  <Printer className="h-4 w-4" /> Print label
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button>Actions <DotsThree className="h-4 w-4" /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setActiveTab("configuration")}>Edit configuration</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onAction("Create container ticket")}>Create container ticket</DropdownMenuItem>
                    {record.status !== "Defect" ? <DropdownMenuItem onSelect={() => onAction("Defect")}>Mark defect</DropdownMenuItem> : null}
                    {record.status !== "In storage" ? <DropdownMenuItem onSelect={() => onAction("In storage")}>Move to storage</DropdownMenuItem> : null}
                    {record.status !== "In transit" ? <DropdownMenuItem onSelect={() => onAction("In transit")}>Move in transit</DropdownMenuItem> : null}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive" onSelect={() => onAction("Delete container")}><Trash className="h-4 w-4" /> Delete container</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

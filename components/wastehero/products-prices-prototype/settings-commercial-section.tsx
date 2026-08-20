"use client"

// PROTOTYPE — throwaway code, do not ship.
// Dev-only Settings → Commercial section panes (Products / Zones / Service /
// Customer types), rendered below the pane header in SettingsDialog.

import { useMemo } from "react"
import Link from "next/link"
import { ArrowSquareOut, Handshake } from "@phosphor-icons/react/dist/ssr"

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
  CUSTOMER_TYPES,
  ZONES,
  defaultRowOf,
  makeFixtureDb,
  money,
  negotiatedCustomersOf,
  unitSuffix,
  type PrototypeDb,
} from "./prototype-data"
import { StatusBadge, TypeBadge } from "./prototype-shared"
import { RegistryCard, usageLabel, type Registry } from "./settings-commercial-defaults"

export function CommercialSectionPane({ paneId }: { paneId: string }) {
  const db = useMemo(() => makeFixtureDb(), [])

  if (paneId === "commercial-products") return <ProductsPane db={db} />
  if (paneId === "commercial-zones") return <ZonesPane db={db} />
  if (paneId === "commercial-service") return <ServicePane db={db} />
  if (paneId === "commercial-customer-types") return <CustomerTypesPane db={db} />
  return null
}

function ProductsPane({ db }: { db: PrototypeDb }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border/60">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2">
        <p className="text-xs text-muted-foreground">
          {db.products.length} products · prices are managed in the Commercial workspace
        </p>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/commercial?variant=a">
            Open in Commercial
            <ArrowSquareOut className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </div>
      <div className="overflow-x-auto">
        <Table className="min-w-[1080px]">
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
            </TableRow>
          </TableHeader>
          <TableBody>
            {db.products.map((product) => {
              const defaultRow = defaultRowOf(db, product.id)
              const negotiated = negotiatedCustomersOf(db, product.id)
              return (
                <TableRow key={product.id} className="hover:bg-muted/40">
                  <TableCell className="min-w-[220px] text-sm font-medium text-foreground">
                    {product.name}
                  </TableCell>
                  <TableCell>
                    <TypeBadge type={product.type} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {product.container ?? "—"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {product.containerType ?? "—"}
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
                    {product.wasteFraction ?? "—"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right text-sm font-medium tabular-nums">
                    {defaultRow ? (
                      <>
                        {money(defaultRow.amount)}
                        <span className="text-xs font-normal text-muted-foreground">
                          {unitSuffix(product.unit)}
                        </span>
                      </>
                    ) : (
                      <span className="text-xs font-normal text-muted-foreground">
                        Unpriced
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={product.status} />
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}

function ZonesPane({ db }: { db: PrototypeDb }) {
  const registry = useMemo<Registry>(
    () => ({
      title: "Zones",
      entries: ZONES.map((zone) => ({
        name: zone,
        usage: usageLabel(
          db.priceRows.filter((row) => row.conditions.zone === zone).length,
          "price row",
        ),
      })),
    }),
    [db],
  )
  return <RegistryCard registry={registry} />
}

function ServicePane({ db }: { db: PrototypeDb }) {
  const registry = useMemo<Registry>(() => {
    const counts = new Map<string, number>()
    for (const product of db.products) {
      for (const level of product.extras.serviceLevels) {
        counts.set(level, (counts.get(level) ?? 0) + 1)
      }
    }
    return {
      title: "Service levels",
      entries: [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, count]) => ({ name, usage: usageLabel(count, "product") })),
    }
  }, [db])
  return (
    <>
      <RegistryCard registry={registry} />
      <p className="text-xs leading-5 text-muted-foreground">
        Service levels are offered per product under its Extras section.
      </p>
    </>
  )
}

function CustomerTypesPane({ db }: { db: PrototypeDb }) {
  const registry = useMemo<Registry>(
    () => ({
      title: "Customer types",
      entries: CUSTOMER_TYPES.map((type) => ({
        name: type,
        usage: usageLabel(
          db.priceRows.filter((row) => row.conditions.customerType === type).length,
          "price row",
        ),
      })),
    }),
    [db],
  )
  return <RegistryCard registry={registry} />
}

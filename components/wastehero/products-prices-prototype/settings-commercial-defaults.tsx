"use client"

// PROTOTYPE — throwaway code, do not ship.
// Read-mostly half of the /settings → Commercial defaults pane (spec §4.1),
// rendered below the generic company-defaults controls in SettingsDialog.

import { useMemo } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { ArrowSquareOut } from "@phosphor-icons/react/dist/ssr"

import { cn } from "@/lib/utils"
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
import {
  CONTRACTOR_PERFORMANCE,
  PRICE_LIST_TAGS,
  PROTO_TODAY,
  SURCHARGE_RULES,
  WASTE_FRACTIONS,
  makeFixtureDb,
  money,
  priceListIndex,
} from "./prototype-data"

export function usageLabel(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function stubAction() {
  toast("Prototype stub", {
    description: "Rename / merge / retire is not wired in this prototype.",
  })
}

export type RegistryEntry = { name: string; usage: string }
export type Registry = { title: string; entries: RegistryEntry[] }

// Shared registry card — also used by the Settings → Commercial section panes.
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
                onClick={stubAction}
              >
                Rename
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={stubAction}
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
  const db = useMemo(() => makeFixtureDb(), [])

  const registries = useMemo<Registry[]>(() => {
    const materialCounts = new Map<string, number>()
    for (const product of db.products) {
      for (const material of product.extras.materials) {
        materialCounts.set(material, (materialCounts.get(material) ?? 0) + 1)
      }
    }
    const entries = [...materialCounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => ({ name, usage: usageLabel(count, "product") }))
    return [{ title: "Materials", entries }]
  }, [db])

  const priceLists = useMemo(() => priceListIndex(db), [db])
  const negotiatedCount = priceLists.filter((list) => list.negotiated).length

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
          section. Container types and the {WASTE_FRACTIONS.length} waste fractions are
          Operations-owned registries — price rows can condition on them, but they are
          managed under Operations setup.
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
              {priceLists.length} price lists · {PRICE_LIST_TAGS.length} annual tariffs and{" "}
              {negotiatedCount} negotiated deals, derived from row tags as of {PROTO_TODAY}
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
                        <Link
                          href={`/commercial?variant=a&tag=${encodeURIComponent(list.tag)}`}
                        >
                          Open in Products
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

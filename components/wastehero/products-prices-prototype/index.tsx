"use client"

// PROTOTYPE — throwaway code, do not ship.
// The chosen Variant A of the redesigned Commercial → Products & prices surfaces
// (spec: docs/superpowers/specs/2026-08-19-products-prices-redesign-design.md,
// verdict in §10), reachable via ?variant=a on the existing /commercial route.
// All state is in-memory fixture data — nothing touches the business-module
// registry or localStorage. The one-time-setup half lives in /settings →
// Commercial defaults (settings-commercial-defaults.tsx). Delete this folder
// once the real implementation lands.

import { useMemo, useState } from "react"

import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

import {
  PROTO_TODAY,
  applyIndexToDb,
  makeFixtureDb,
  money,
  type PriceRow,
  type PrototypeDb,
} from "./prototype-data"
import {
  computeAdjusted,
  rowLabel,
  type Lane,
  type PrototypeActions,
} from "./prototype-shared"
import { VariantACatalogue } from "./variant-a-catalogue"

export function ProductsPricesPrototype({ initialTag }: { initialTag?: string }) {
  const [db, setDb] = useState<PrototypeDb>(makeFixtureDb)
  const [lane, setLane] = useState<Lane>("products")

  const actions = useMemo<PrototypeActions>(() => {
    const withHistory = (
      previous: PrototypeDb,
      productId: string,
      what: string,
      diffs?: { field: string; from: string; to: string }[],
    ) => ({
      ...previous,
      products: previous.products.map((product) =>
        product.id === productId
          ? {
              ...product,
              history: [{ at: PROTO_TODAY, who: "You", what, diffs }, ...product.history],
            }
          : product,
      ),
    })

    return {
      setDefaultPrice: (productId, amount) =>
        setDb((previous) => {
          let old = 0
          const next = {
            ...previous,
            priceRows: previous.priceRows.map((row) => {
              const isDefault =
                row.productId === productId &&
                !row.negotiatedCustomer &&
                Object.keys(row.conditions).length === 0
              if (!isDefault) return row
              old = row.amount
              return { ...row, amount }
            }),
          }
          return withHistory(next, productId, "Default price edited inline", [
            { field: "Default price", from: money(old), to: money(amount) },
          ])
        }),

      addPriceRow: (row) =>
        setDb((previous) =>
          withHistory(
            { ...previous, priceRows: [...previous.priceRows, row] },
            row.productId,
            row.negotiatedCustomer
              ? `Negotiated deal added for ${row.negotiatedCustomer}`
              : "Variation added",
          ),
        ),

      scheduleChange: (rowId, change) =>
        setDb((previous) => {
          let productId = ""
          let label = ""
          const next = {
            ...previous,
            priceRows: previous.priceRows.map((row) => {
              if (row.id !== rowId) return row
              productId = row.productId
              label = rowLabel(previous, row)
              return { ...row, scheduled: change }
            }),
          }
          return withHistory(next, productId, `Change scheduled · ${label}`, [
            {
              field: label,
              from: "current",
              to: `${money(change.newAmount)} from ${change.from}`,
            },
          ])
        }),

      adjustPrices: (rowIds, opts) =>
        setDb((previous) => {
          const ids = new Set(rowIds)
          const note =
            opts.kind === "percent"
              ? `${opts.value > 0 ? "+" : ""}${opts.value}%`
              : opts.kind === "fixed"
                ? `${opts.value > 0 ? "+" : ""}€${opts.value}`
                : `×${opts.value}`
          const diffsByProduct = new Map<string, { field: string; from: string; to: string }[]>()
          const priceRows = previous.priceRows.map((row): PriceRow => {
            if (!ids.has(row.id)) return row
            const newAmount = computeAdjusted(row.amount, opts.kind, opts.value, opts.round)
            const diffs = diffsByProduct.get(row.productId) ?? []
            diffs.push({
              field: rowLabel(previous, row),
              from: money(row.amount),
              to: `${money(newAmount)} (scheduled)`,
            })
            diffsByProduct.set(row.productId, diffs)
            return {
              ...row,
              scheduled: {
                newAmount,
                from: opts.from,
                revertOn: opts.revertOn,
                note: `Adjust prices ${note}`,
              },
            }
          })
          let next = { ...previous, priceRows }
          for (const [productId, diffs] of diffsByProduct) {
            next = withHistory(
              next,
              productId,
              `Adjust prices · ${note} scheduled for ${opts.from}`,
              diffs,
            )
          }
          return next
        }),

      applyIndex: (rateIds, opts) =>
        setDb((previous) => applyIndexToDb(previous, rateIds, opts)),

      createProduct: (product, defaultRow) =>
        setDb((previous) => ({
          ...previous,
          products: [product, ...previous.products],
          priceRows: [defaultRow, ...previous.priceRows],
        })),
    }
  }, [])

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <VariantACatalogue
          db={db}
          actions={actions}
          lane={lane}
          onLaneChange={setLane}
          initialTag={initialTag}
        />
      </SidebarInset>
    </SidebarProvider>
  )
}

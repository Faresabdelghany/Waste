"use client"

import Link from "next/link"
import {
  ArrowLeft,
  Buildings,
  Plus,
} from "@phosphor-icons/react/dist/ssr"

import type {
  BusinessRecord,
  WorkspaceId,
} from "@/lib/data/business-modules"
import { getBusinessModuleHref } from "@/lib/data/business-links"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SidebarTrigger } from "@/components/ui/sidebar"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

function statusClasses(status: string) {
  if (/active|completed|approved/i.test(status)) {
    return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
  }
  if (/expiring|review|pending|upcoming/i.test(status)) {
    return "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300"
  }
  if (/terminated|expired|suspended|issue/i.test(status)) {
    return "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300"
  }
  return "border-border bg-muted/50 text-muted-foreground"
}

function InformationItem({
  label,
  value,
}: {
  label: string
  value: string
}) {
  return (
    <div className="min-w-0 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium text-foreground">
        {value || "Not provided"}
      </dd>
    </div>
  )
}

function ContractorInformation({
  record,
  users,
  vehicles,
  drivers,
  contractAreas,
}: {
  record: BusinessRecord
  users: readonly BusinessRecord[]
  vehicles: readonly BusinessRecord[]
  drivers: readonly BusinessRecord[]
  contractAreas: readonly BusinessRecord[]
}) {
  const submitted = record.submittedValues ?? {}
  const submittedText = (fieldId: string) => {
    const value = submitted[fieldId]
    return typeof value === "string" ? value : ""
  }
  const companyInformation = [
    ["Legal company name", submittedText("legalName") || record.name],
    [
      "Registration number",
      submittedText("registrationNumber") || record.facts.CVR || "Not provided",
    ],
    ["Country", submittedText("country") || "Not provided"],
    ["Primary contact", submittedText("contactName") || "Not provided"],
    ["Contact email", submittedText("contactEmail") || "Not provided"],
    [
      "Relationship owner",
      submittedText("relationshipOwner") || record.owner,
    ],
    ["Relationship state", record.status],
  ] as const
  const relationshipInformation = [
    ["Contract areas", String(contractAreas.length)],
    ["Users", String(users.length)],
    ["Vehicles", String(vehicles.length)],
    ["Drivers", String(drivers.length)],
  ] as const

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-5 py-6 sm:px-7">
        <section className="border-b border-border pb-6">
          <p className="text-sm leading-6 text-muted-foreground">
            {record.description}
          </p>
        </section>

        <div className="grid gap-x-12 lg:grid-cols-2">
          <section className="py-6">
            <h2 className="text-sm font-semibold">Company information</h2>
            <dl className="mt-3 grid grid-cols-1 divide-y divide-border/60 sm:grid-cols-2 sm:gap-x-8 sm:divide-y-0">
              {companyInformation.map(([label, value]) => (
                <InformationItem key={label} label={label} value={value} />
              ))}
            </dl>
          </section>

          <section className="border-t border-border py-6 lg:border-l lg:border-t-0 lg:pl-12">
            <h2 className="text-sm font-semibold">Contractor relationship</h2>
            <dl className="mt-3 grid grid-cols-1 divide-y divide-border/60 sm:grid-cols-2 sm:gap-x-8 sm:divide-y-0">
              {relationshipInformation.map(([label, value]) => (
                <InformationItem key={label} label={label} value={value} />
              ))}
            </dl>
          </section>
        </div>

      </div>
    </div>
  )
}

type RelatedRecordsTableProps = {
  records: readonly BusinessRecord[]
  entityLabel: string
  contextLabel: string
  valueLabel: string
  emptyLabel: string
  actionLabel: string
  onCreate: () => void
  workspaceId?: WorkspaceId
  moduleId?: string
}

function RelatedRecordsTable({
  records,
  entityLabel,
  contextLabel,
  valueLabel,
  emptyLabel,
  actionLabel,
  onCreate,
  workspaceId,
  moduleId,
}: RelatedRecordsTableProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="px-4 py-4 sm:px-5">
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
            <span className="text-xs text-muted-foreground">
              {records.length} {records.length === 1 ? entityLabel.toLowerCase() : `${entityLabel.toLowerCase()}s`}
            </span>
            <Button size="sm" onClick={onCreate}>
              <Plus className="h-4 w-4" weight="bold" />
              {actionLabel}
            </Button>
          </div>
          <div className="overflow-x-auto">
            <Table className="min-w-[860px]">
              <TableHeader className="bg-muted/30">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    {entityLabel}
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    {contextLabel}
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    Status
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    Owner
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    {valueLabel}
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    Updated
                  </TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-52 text-center">
                      <Buildings className="mx-auto h-6 w-6 text-muted-foreground" />
                      <p className="mt-2 text-sm font-medium">{emptyLabel}</p>
                    </TableCell>
                  </TableRow>
                ) : (
                  records.map((relatedRecord) => (
                    <TableRow key={relatedRecord.id} className="hover:bg-muted/60">
                      <TableCell className="min-w-[220px] py-3">
                        <p className="text-sm font-medium text-foreground">
                          {relatedRecord.name}
                        </p>
                      </TableCell>
                      <TableCell className="max-w-[280px] py-3 text-sm text-muted-foreground">
                        <span className="line-clamp-2">{relatedRecord.context}</span>
                      </TableCell>
                      <TableCell className="py-3">
                        <Badge
                          variant="outline"
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[11px] font-medium",
                            statusClasses(relatedRecord.status),
                          )}
                        >
                          {relatedRecord.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-3 text-sm text-muted-foreground">
                        {relatedRecord.owner}
                      </TableCell>
                      <TableCell className="py-3 text-sm">
                        {relatedRecord.value}
                      </TableCell>
                      <TableCell className="py-3 text-sm text-muted-foreground">
                        {relatedRecord.updated}
                      </TableCell>
                      <TableCell className="py-3 text-right">
                        {workspaceId && moduleId ? (
                          <Button variant="ghost" size="sm" asChild>
                            <Link
                              href={getBusinessModuleHref(
                                workspaceId,
                                moduleId,
                                relatedRecord.id,
                              )}
                            >
                              Open
                            </Link>
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
    </div>
  )
}

export function ContractorDetailsPage({
  record,
  users,
  vehicles,
  drivers,
  contractAreas,
  onBack,
  onCreate,
}: {
  record: BusinessRecord
  users: readonly BusinessRecord[]
  vehicles: readonly BusinessRecord[]
  drivers: readonly BusinessRecord[]
  contractAreas: readonly BusinessRecord[]
  onBack: () => void
  onCreate: (target: "user" | "vehicle" | "driver" | "contract-area") => void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-border">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-accent" />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label="Back to Contractors"
              onClick={onBack}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-base font-semibold">{record.name}</h1>
                <Badge
                  variant="outline"
                  className={cn(
                    "rounded-full text-[11px]",
                    statusClasses(record.status),
                  )}
                >
                  {record.status}
                </Badge>
              </div>
            </div>
          </div>

        </div>
      </header>

      <Tabs defaultValue="information" className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-border/40 px-4 py-3">
          <div className="overflow-x-auto">
            <TabsList className="inline-flex h-8 rounded-full border border-border/50 bg-muted px-1 py-0.5 text-xs">
              <TabsTrigger value="information" className="h-7 rounded-full px-3 text-xs data-[state=active]:bg-background">
                Contractor information
              </TabsTrigger>
              <TabsTrigger value="users" className="h-7 rounded-full px-3 text-xs data-[state=active]:bg-background">
                Users <span className="ml-1.5 text-[10px] text-muted-foreground">{users.length}</span>
              </TabsTrigger>
              <TabsTrigger value="vehicles" className="h-7 rounded-full px-3 text-xs data-[state=active]:bg-background">
                Vehicles <span className="ml-1.5 text-[10px] text-muted-foreground">{vehicles.length}</span>
              </TabsTrigger>
              <TabsTrigger value="drivers" className="h-7 rounded-full px-3 text-xs data-[state=active]:bg-background">
                Drivers <span className="ml-1.5 text-[10px] text-muted-foreground">{drivers.length}</span>
              </TabsTrigger>
              <TabsTrigger value="contract-areas" className="h-7 rounded-full px-3 text-xs data-[state=active]:bg-background">
                Contract Areas <span className="ml-1.5 text-[10px] text-muted-foreground">{contractAreas.length}</span>
              </TabsTrigger>
            </TabsList>
          </div>
        </div>

        <TabsContent value="information" className="mt-0 min-h-0 flex-1">
          <ContractorInformation
            record={record}
            users={users}
            vehicles={vehicles}
            drivers={drivers}
            contractAreas={contractAreas}
          />
        </TabsContent>
        <TabsContent value="users" className="mt-0 min-h-0 flex-1">
          <RelatedRecordsTable
            records={users}
            entityLabel="User"
            contextLabel="Role and scope"
            valueLabel="Access"
            emptyLabel="No contractor users"
            actionLabel="Add User"
            onCreate={() => onCreate("user")}
          />
        </TabsContent>
        <TabsContent value="vehicles" className="mt-0 min-h-0 flex-1">
          <RelatedRecordsTable
            records={vehicles}
            entityLabel="Vehicle"
            contextLabel="Type and assignment"
            valueLabel="Availability"
            emptyLabel="No contractor vehicles"
            actionLabel="Add Vehicle"
            onCreate={() => onCreate("vehicle")}
            workspaceId="fleet"
            moduleId="vehicles"
          />
        </TabsContent>
        <TabsContent value="drivers" className="mt-0 min-h-0 flex-1">
          <RelatedRecordsTable
            records={drivers}
            entityLabel="Driver"
            contextLabel="Employment and access"
            valueLabel="Availability"
            emptyLabel="No contractor drivers"
            actionLabel="Add Driver"
            onCreate={() => onCreate("driver")}
            workspaceId="fleet"
            moduleId="drivers"
          />
        </TabsContent>
        <TabsContent value="contract-areas" className="mt-0 min-h-0 flex-1">
          <RelatedRecordsTable
            records={contractAreas}
            entityLabel="Contract area"
            contextLabel="Service scope"
            valueLabel="Effective period"
            emptyLabel="No assigned contract areas"
            actionLabel="Assign Contract Area"
            onCreate={() => onCreate("contract-area")}
            workspaceId="contractors"
            moduleId="contract-areas"
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

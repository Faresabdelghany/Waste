"use client"

import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react"
import {
  ArrowLeft,
  Buildings,
  Funnel,
  Info,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Sliders,
} from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import {
  CompanyOnboardingDialog,
  ProjectDialog,
} from "@/components/settings/organization-structure-management"
import {
  useOrganizationStore,
  type Company,
  type OrganizationUser,
  type Project,
  type UpdateCompanyInput,
} from "@/components/settings/organization-store"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
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
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  FIXTURE_COMPANY_ID,
  fixtureRecordScopeById,
} from "@/lib/data/business-modules"
import { cn } from "@/lib/utils"

function statusClasses(status: string) {
  if (/active|completed|approved/i.test(status)) {
    return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
  }
  if (/onboarding|invited|pending|upcoming/i.test(status)) {
    return "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300"
  }
  if (/suspended|archived|issue/i.test(status)) {
    return "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300"
  }
  return "border-border bg-muted/50 text-muted-foreground"
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-medium",
        statusClasses(status),
      )}
    >
      {status}
    </Badge>
  )
}

function SectionTitle({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="text-muted-foreground transition-colors hover:text-foreground"
              aria-label={`About ${title}`}
            >
              <Info className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm text-xs">
            {description}
          </TooltipContent>
        </Tooltip>
      </div>
      {action}
    </div>
  )
}

function StatusFilter({
  options,
  value,
  onChange,
}: {
  options: string[]
  value: string[]
  onChange: (value: string[]) => void
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-2 rounded-lg border-border/60 bg-transparent px-3"
        >
          <Funnel className="h-4 w-4" />
          Filter
          {value.length > 0 ? (
            <span className="rounded-full bg-primary/10 px-1.5 text-[10px] font-medium text-primary">
              {value.length}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 rounded-xl p-4">
        <p className="text-sm font-semibold">Filter by status</p>
        <div className="mt-3 space-y-2">
          {options.map((option) => (
            <label key={option} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={value.includes(option)}
                onCheckedChange={(checked) =>
                  onChange(
                    checked
                      ? [...value, option]
                      : value.filter((status) => status !== option),
                  )
                }
              />
              {option}
            </label>
          ))}
        </div>
        {value.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-3 h-7 px-2 text-xs"
            onClick={() => onChange([])}
          >
            Clear filters
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

function TableViewPopover({
  ordering,
  onOrderingChange,
  showDetails,
  onShowDetailsChange,
  orderingOptions,
}: {
  ordering: string
  onOrderingChange: (value: string) => void
  showDetails: boolean
  onShowDetailsChange: (value: boolean) => void
  orderingOptions: Array<{ value: string; label: string }>
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-2 rounded-lg border-border/60 bg-transparent px-3"
        >
          <Sliders className="h-4 w-4" />
          View
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 rounded-xl p-4">
        <p className="text-sm font-semibold">Table view</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose the row order and level of detail.
        </p>
        <div className="mt-4 flex items-center justify-between gap-4">
          <span className="text-sm">Ordering</span>
          <Select value={ordering} onValueChange={onOrderingChange}>
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {orderingOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="mt-4 flex items-center justify-between gap-4 text-sm">
          Show details
          <Switch checked={showDetails} onCheckedChange={onShowDetailsChange} />
        </label>
      </PopoverContent>
    </Popover>
  )
}

function RecordsSection({
  shown,
  total,
  children,
}: {
  shown: number
  total: number
  children: ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border/60">
      <div className="border-b border-border px-4 py-2">
        <p className="text-xs text-muted-foreground">
          {shown === total ? `${shown} records` : `${shown} of ${total} records`}
        </p>
      </div>
      {children}
    </section>
  )
}

function editCompanyForm(company: Company): UpdateCompanyInput {
  return {
    companyId: company.id,
    companyName: company.name,
    legalName: company.legalName,
    registrationNumber: company.registrationNumber,
  }
}

function EditCompanyDialog({
  company,
  open,
  onOpenChange,
}: {
  company: Company | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { updateCompany } = useOrganizationStore()
  const [form, setForm] = useState<UpdateCompanyInput | null>(
    company ? editCompanyForm(company) : null,
  )
  const [error, setError] = useState("")

  useEffect(() => {
    if (open && company) {
      setForm(editCompanyForm(company))
      setError("")
    }
  }, [company, open])

  const updateField = (
    key: "companyName" | "legalName" | "registrationNumber",
    value: string,
  ) => {
    setForm((current) => (current ? { ...current, [key]: value } : current))
    setError("")
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form) return

    try {
      const updatedCompany = updateCompany(form)
      onOpenChange(false)
      toast.success("Company updated", {
        description: `${updatedCompany.name} was saved.`,
      })
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "The company could not be updated."
      setError(message)
      toast.error("Company could not be updated", { description: message })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Edit company</DialogTitle>
            <DialogDescription>
              Update the company identity shown across settings.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-5">
            <div className="space-y-2">
              <Label htmlFor="edit-company-name">Company name</Label>
              <Input
                id="edit-company-name"
                value={form?.companyName ?? ""}
                onChange={(event) =>
                  updateField("companyName", event.target.value)
                }
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-company-legal-name">Legal name</Label>
              <Input
                id="edit-company-legal-name"
                value={form?.legalName ?? ""}
                onChange={(event) =>
                  updateField("legalName", event.target.value)
                }
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-company-registration">
                Registration number{" "}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Input
                id="edit-company-registration"
                value={form?.registrationNumber ?? ""}
                onChange={(event) =>
                  updateField("registrationNumber", event.target.value)
                }
                placeholder="CVR, VAT, or local organization number"
              />
            </div>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!form}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function CompanyList({
  companies,
  totalCompanyCount,
  query,
  onQueryChange,
  onOpenCompany,
  onEditCompany,
  onAddCompany,
  projectsForCompany,
  primaryAdministratorForCompany,
  fixtureRecordCount,
}: {
  companies: Company[]
  totalCompanyCount: number
  query: string
  onQueryChange: (value: string) => void
  onOpenCompany: (companyId: string) => void
  onEditCompany: (companyId: string) => void
  onAddCompany: () => void
  projectsForCompany: (companyId: string) => Project[]
  primaryAdministratorForCompany: (
    companyId: string,
  ) => OrganizationUser | undefined
  fixtureRecordCount: number
}) {
  const [statuses, setStatuses] = useState<string[]>([])
  const [ordering, setOrdering] = useState("name")
  const [showDetails, setShowDetails] = useState(true)
  const statusOptions = useMemo(
    () => Array.from(new Set(companies.map((company) => company.status))),
    [companies],
  )
  const visibleCompanies = useMemo(() => {
    const filtered = statuses.length
      ? companies.filter((company) => statuses.includes(company.status))
      : companies

    return [...filtered].sort((left, right) => {
      if (ordering === "status") {
        return left.status.localeCompare(right.status) || left.name.localeCompare(right.name)
      }
      if (ordering === "projects") {
        return (
          projectsForCompany(right.id).length - projectsForCompany(left.id).length ||
          left.name.localeCompare(right.name)
        )
      }
      return left.name.localeCompare(right.name)
    })
  }, [companies, ordering, projectsForCompany, statuses])
  const { page, setPage, pageCount, pageRows, totalCount } =
    useTablePagination(visibleCompanies)

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex flex-col border-b border-border/40">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <p className="text-base font-medium text-foreground">Company &amp; projects</p>
          <Button size="sm" onClick={onAddCompany}>
            <Plus className="h-4 w-4" weight="bold" />
            Add company
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <div className="relative min-w-[240px] max-w-md flex-1">
            <MagnifyingGlass className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search companies"
              className="h-8 pl-9 text-sm"
            />
          </div>
          <StatusFilter options={statusOptions} value={statuses} onChange={setStatuses} />
          <TableViewPopover
            ordering={ordering}
            onOrderingChange={setOrdering}
            showDetails={showDetails}
            onShowDetailsChange={setShowDetails}
            orderingOptions={[
              { value: "name", label: "Company name" },
              { value: "status", label: "Status" },
              { value: "projects", label: "Project count" },
            ]}
          />
        </div>
      </header>

      <div className="flex-1 p-4">
        <div className="mx-auto max-w-[1500px] space-y-4">
          <SectionTitle
            title="Companies"
            description="Manage company identities, administrators, projects, and tenant-level operational data."
          />
          <RecordsSection shown={visibleCompanies.length} total={totalCompanyCount}>
            <div className="overflow-x-auto">
              <Table className="min-w-[1080px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-10">Company</TableHead>
                    <TableHead className="h-10">Registration</TableHead>
                    <TableHead className="h-10">Status</TableHead>
                    <TableHead className="h-10">Projects</TableHead>
                    <TableHead className="h-10">Primary administrator</TableHead>
                    <TableHead className="h-10">Data</TableHead>
                    <TableHead className="h-10 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleCompanies.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="h-52 text-center">
                        <MagnifyingGlass className="mx-auto h-6 w-6 text-muted-foreground" />
                        <p className="mt-2 text-sm font-medium">No matching companies</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Try a different search or filter.
                        </p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    pageRows.map((company) => {
                  const companyProjects = projectsForCompany(company.id)
                  const administrator =
                    primaryAdministratorForCompany(company.id)
                  const recordCount =
                    company.source === "fixture" ? fixtureRecordCount : 0

                  return (
                    <TableRow
                      key={company.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`Open ${company.name}`}
                      className="cursor-pointer hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
                      onClick={() => onOpenCompany(company.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault()
                          onOpenCompany(company.id)
                        }
                      }}
                    >
                      <TableCell className="min-w-[240px] py-3">
                        <p className="text-sm font-medium text-foreground">
                          {company.name}
                        </p>
                        {showDetails ? (
                          <p className="mt-0.5 max-w-[340px] truncate text-xs text-muted-foreground">
                            {company.legalName}
                            {company.source === "fixture" ? " · Sample data" : ""}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="min-w-[150px] text-sm text-muted-foreground">
                        {company.registrationNumber || "Not provided"}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={company.status} />
                      </TableCell>
                      <TableCell className="min-w-[120px] text-sm">
                        {companyProjects.length}
                      </TableCell>
                      <TableCell className="min-w-[220px] text-sm text-muted-foreground">
                        <p>{administrator?.fullName ?? "Missing"}</p>
                        {showDetails ? (
                          <p className="mt-0.5 truncate text-xs">
                            {administrator?.email ?? "Administrator required"}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {recordCount} records
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 gap-1.5 px-2.5"
                          aria-label={`Edit ${company.name}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            onEditCompany(company.id)
                          }}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          <PencilSimple className="h-4 w-4" />
                          Edit
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
              page={page}
              pageCount={pageCount}
              totalCount={totalCount}
              onPageChange={setPage}
            />
          </RecordsSection>
        </div>
      </div>
    </div>
  )
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

function CompanyInformation({
  company,
  projects,
  primaryAdministrator,
  recordCount,
}: {
  company: Company
  projects: Project[]
  primaryAdministrator: OrganizationUser | undefined
  recordCount: number
}) {
  const companyInformation = [
    ["Company name", company.name],
    ["Legal name", company.legalName],
    ["Registration number", company.registrationNumber || "Not provided"],
    ["Tenant ID", company.id],
    ["Lifecycle", company.status],
    ["Operational data", `${recordCount} records`],
  ] as const
  const administrationInformation = [
    ["Primary administrator", primaryAdministrator?.fullName ?? "Missing"],
    ["Email", primaryAdministrator?.email ?? "Administrator required"],
    ["Role", primaryAdministrator?.role ?? "Not assigned"],
    ["Access", "All current and future projects"],
    ["Invitation status", primaryAdministrator?.status ?? "Not invited"],
    ["Projects", String(projects.length)],
  ] as const

  return (
    <div className="py-6">
      <div className="grid gap-x-12 lg:grid-cols-2">
        <section>
          <h4 className="text-sm font-semibold">Company information</h4>
          <dl className="mt-3 grid grid-cols-1 divide-y divide-border/60 sm:grid-cols-2 sm:gap-x-8 sm:divide-y-0">
            {companyInformation.map(([label, value]) => (
              <InformationItem key={label} label={label} value={value} />
            ))}
          </dl>
        </section>

        <section className="mt-6 border-t border-border pt-6 lg:mt-0 lg:border-l lg:border-t-0 lg:pl-12 lg:pt-0">
          <h4 className="text-sm font-semibold">Administration</h4>
          <dl className="mt-3 grid grid-cols-1 divide-y divide-border/60 sm:grid-cols-2 sm:gap-x-8 sm:divide-y-0">
            {administrationInformation.map(([label, value]) => (
              <InformationItem key={label} label={label} value={value} />
            ))}
          </dl>
        </section>
      </div>
    </div>
  )
}

function ProjectsTable({
  projects,
  query,
  statuses,
  ordering,
  showDetails,
  onEditProject,
}: {
  projects: Project[]
  query: string
  statuses: string[]
  ordering: string
  showDetails: boolean
  onEditProject: (projectId: string) => void
}) {
  const normalizedQuery = query.trim().toLowerCase()
  const visibleProjects = useMemo(() => {
    const filtered = projects.filter((project) => {
      const matchesQuery =
        !normalizedQuery ||
        [
          project.name,
          project.id,
          project.kind,
          project.status,
          project.language,
          project.currency,
          project.timezone,
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery)
      const matchesStatus =
        statuses.length === 0 || statuses.includes(project.status)
      return matchesQuery && matchesStatus
    })

    return [...filtered].sort((left, right) => {
      if (ordering === "status") {
        return left.status.localeCompare(right.status) || left.name.localeCompare(right.name)
      }
      if (ordering === "scope") {
        return left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name)
      }
      return left.name.localeCompare(right.name)
    })
  }, [normalizedQuery, ordering, projects, statuses])
  const { page, setPage, pageCount, pageRows, totalCount } =
    useTablePagination(visibleProjects)

  return (
    <RecordsSection shown={visibleProjects.length} total={projects.length}>
        <div className="overflow-x-auto">
          <Table className="min-w-[960px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-10">Project</TableHead>
                <TableHead className="h-10">Scope</TableHead>
                <TableHead className="h-10">Status</TableHead>
                <TableHead className="h-10">Language</TableHead>
                <TableHead className="h-10">Currency</TableHead>
                <TableHead className="h-10">Timezone</TableHead>
                <TableHead className="h-10 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleProjects.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-52 text-center">
                    <Buildings className="mx-auto h-6 w-6 text-muted-foreground" />
                    <p className="mt-2 text-sm font-medium">No matching projects</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Try a different search or filter.
                    </p>
                  </TableCell>
                </TableRow>
              ) : (
                pageRows.map((project) => (
                  <TableRow key={project.id}>
                    <TableCell className="min-w-[220px] py-3">
                      <p className="text-sm font-medium text-foreground">
                        {project.name}
                      </p>
                      {showDetails ? (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {project.id}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="py-3 text-sm text-muted-foreground">
                      {project.kind}
                    </TableCell>
                    <TableCell className="py-3">
                      <StatusBadge status={project.status} />
                    </TableCell>
                    <TableCell className="py-3 text-sm text-muted-foreground">
                      {project.language}
                    </TableCell>
                    <TableCell className="py-3 text-sm">
                      {project.currency}
                    </TableCell>
                    <TableCell className="py-3 text-sm text-muted-foreground">
                      {project.timezone}
                    </TableCell>
                    <TableCell className="py-3 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 gap-1.5 px-2.5"
                        aria-label={`Edit ${project.name}`}
                        onClick={() => onEditProject(project.id)}
                      >
                        <PencilSimple className="h-4 w-4" />
                        Edit
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <TablePagination
          page={page}
          pageCount={pageCount}
          totalCount={totalCount}
          onPageChange={setPage}
        />
    </RecordsSection>
  )
}

function CompanyDetails({
  company,
  projects,
  primaryAdministrator,
  recordCount,
  onBack,
  onEditCompany,
  onAddProject,
  onEditProject,
}: {
  company: Company
  projects: Project[]
  primaryAdministrator: OrganizationUser | undefined
  recordCount: number
  onBack: () => void
  onEditCompany: () => void
  onAddProject: () => void
  onEditProject: (projectId: string) => void
}) {
  const [activeTab, setActiveTab] = useState("information")
  const [projectQuery, setProjectQuery] = useState("")
  const [projectStatuses, setProjectStatuses] = useState<string[]>([])
  const [projectOrdering, setProjectOrdering] = useState("name")
  const [showProjectDetails, setShowProjectDetails] = useState(true)
  const projectStatusOptions = useMemo(
    () => Array.from(new Set(projects.map((project) => project.status))),
    [projects],
  )

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex flex-col border-b border-border/40">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label="Back to Companies"
              onClick={onBack}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-base font-medium text-foreground">
                  {company.name}
                </p>
                <StatusBadge status={company.status} />
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {company.legalName}
              </p>
            </div>
          </div>
          {activeTab === "projects" ? (
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={onAddProject}>
                <Plus className="h-4 w-4" weight="bold" />
                Add project
              </Button>
            </div>
          ) : null}
        </div>
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="overflow-x-auto pb-0.5">
            <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="inline-flex h-8 rounded-full border border-border/50 bg-muted px-1 py-0.5 text-xs">
              <TabsTrigger
                value="information"
                className="h-7 rounded-full px-3 text-xs data-[state=active]:bg-background"
              >
                Company information
              </TabsTrigger>
              <TabsTrigger
                value="projects"
                className="h-7 rounded-full px-3 text-xs data-[state=active]:bg-background"
              >
                Projects
                <span className="ml-1.5 text-[10px] text-muted-foreground">
                  {projects.length}
                </span>
              </TabsTrigger>
            </TabsList>
            </Tabs>
          </div>
          {activeTab === "projects" ? (
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[240px] max-w-md flex-1">
                <MagnifyingGlass className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={projectQuery}
                  onChange={(event) => setProjectQuery(event.target.value)}
                  placeholder="Search projects"
                  className="h-8 pl-9 text-sm"
                />
              </div>
              <StatusFilter
                options={projectStatusOptions}
                value={projectStatuses}
                onChange={setProjectStatuses}
              />
              <TableViewPopover
                ordering={projectOrdering}
                onOrderingChange={setProjectOrdering}
                showDetails={showProjectDetails}
                onShowDetailsChange={setShowProjectDetails}
                orderingOptions={[
                  { value: "name", label: "Project name" },
                  { value: "status", label: "Status" },
                  { value: "scope", label: "Scope" },
                ]}
              />
            </div>
          ) : null}
        </div>
      </header>

      <div className="flex-1 p-4">
        <div className="mx-auto max-w-[1500px] space-y-4">
        {activeTab === "information" ? (
          <>
            <SectionTitle
              title="Company information"
              description="Company identity, tenant status, administration, access, and operational data."
              action={
                <Button size="sm" variant="outline" onClick={onEditCompany}>
                  <PencilSimple className="h-4 w-4" />
                  Edit company
                </Button>
              }
            />
          <CompanyInformation
            company={company}
            projects={projects}
            primaryAdministrator={primaryAdministrator}
            recordCount={recordCount}
          />
          </>
        ) : (
          <>
            <SectionTitle
              title="Projects"
              description="Operational scopes belonging to this company, including their locale, currency, and lifecycle status."
            />
          <ProjectsTable
            projects={projects}
            query={projectQuery}
            statuses={projectStatuses}
            ordering={projectOrdering}
            showDetails={showProjectDetails}
            onEditProject={onEditProject}
          />
          </>
        )}
        </div>
      </div>
    </div>
  )
}

export function CompanyProjectsManagement() {
  const {
    companies,
    projectsForCompany,
    primaryAdministratorForCompany,
  } = useOrganizationStore()
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(
    null,
  )
  const [query, setQuery] = useState("")
  const [companyDialogOpen, setCompanyDialogOpen] = useState(false)
  const [editCompanyDialogOpen, setEditCompanyDialogOpen] = useState(false)
  const [editingCompanyId, setEditingCompanyId] = useState<string | null>(null)
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null)

  const fixtureRecordCount = useMemo(
    () =>
      Object.values(fixtureRecordScopeById).filter(
        (scope) => scope.companyId === FIXTURE_COMPANY_ID,
      ).length,
    [],
  )
  const selectedCompany = companies.find(
    (company) => company.id === selectedCompanyId,
  )
  const editingCompany = companies.find(
    (company) => company.id === editingCompanyId,
  )
  const selectedProjects = selectedCompany
    ? projectsForCompany(selectedCompany.id)
    : []
  const editingProject = selectedProjects.find(
    (project) => project.id === editingProjectId,
  )
  const primaryAdministrator = selectedCompany
    ? primaryAdministratorForCompany(selectedCompany.id)
    : undefined
  const normalizedQuery = query.trim().toLowerCase()
  const filteredCompanies = useMemo(
    () =>
      normalizedQuery
        ? companies.filter((company) => {
            const administrator = primaryAdministratorForCompany(company.id)
            return [
              company.name,
              company.legalName,
              company.registrationNumber,
              company.status,
              administrator?.fullName,
              administrator?.email,
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
              .includes(normalizedQuery)
          })
        : companies,
    [companies, normalizedQuery, primaryAdministratorForCompany],
  )

  return (
    <>
      {selectedCompany ? (
        <CompanyDetails
          company={selectedCompany}
          projects={selectedProjects}
          primaryAdministrator={primaryAdministrator}
          recordCount={
            selectedCompany.source === "fixture" ? fixtureRecordCount : 0
          }
          onBack={() => setSelectedCompanyId(null)}
          onEditCompany={() => {
            setEditingCompanyId(selectedCompany.id)
            setEditCompanyDialogOpen(true)
          }}
          onAddProject={() => setProjectDialogOpen(true)}
          onEditProject={(projectId) => {
            setEditingProjectId(projectId)
            setProjectDialogOpen(true)
          }}
        />
      ) : (
        <CompanyList
          companies={filteredCompanies}
          totalCompanyCount={companies.length}
          query={query}
          onQueryChange={setQuery}
          onOpenCompany={setSelectedCompanyId}
          onEditCompany={(companyId) => {
            setEditingCompanyId(companyId)
            setEditCompanyDialogOpen(true)
          }}
          onAddCompany={() => setCompanyDialogOpen(true)}
          projectsForCompany={projectsForCompany}
          primaryAdministratorForCompany={primaryAdministratorForCompany}
          fixtureRecordCount={fixtureRecordCount}
        />
      )}

      <CompanyOnboardingDialog
        open={companyDialogOpen}
        onOpenChange={setCompanyDialogOpen}
        onCreated={(company) => setSelectedCompanyId(company.id)}
      />
      <EditCompanyDialog
        company={editingCompany}
        open={editCompanyDialogOpen}
        onOpenChange={(open) => {
          setEditCompanyDialogOpen(open)
          if (!open) setEditingCompanyId(null)
        }}
      />
      <ProjectDialog
        company={selectedCompany}
        project={editingProject}
        open={projectDialogOpen}
        onOpenChange={(open) => {
          setProjectDialogOpen(open)
          if (!open) setEditingProjectId(null)
        }}
      />
    </>
  )
}

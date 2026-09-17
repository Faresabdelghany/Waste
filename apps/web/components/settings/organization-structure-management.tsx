"use client"

import { useEffect, useMemo, useState, type FormEvent } from "react"
import {
  CheckCircle,
  Plus,
  ShieldCheck,
} from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import {
  useOrganizationStore,
  type Company,
  type CreateCompanyInput,
  type CreateProjectInput,
  type Project,
} from "@/components/settings/organization-store"
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
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
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
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import {
  FIXTURE_COMPANY_ID,
  fixtureRecordScopeById,
} from "@/lib/data/business-modules"
import { cn } from "@/lib/utils"

const initialCompanyForm: CreateCompanyInput = {
  companyName: "",
  legalName: "",
  registrationNumber: "",
  projectName: "",
  projectKind: "Municipality",
  projectLanguage: "English",
  projectCurrency: "EUR",
  projectTimezone: "Europe/Copenhagen",
  administratorName: "",
  administratorEmail: "",
}

const initialProjectForm: Omit<CreateProjectInput, "companyId"> = {
  name: "",
  kind: "Municipality",
  language: "English",
  currency: "EUR",
  timezone: "Europe/Copenhagen",
}

const languageOptions = ["English", "Danish", "Finnish", "Swedish", "Norwegian"]
const currencyOptions = ["DKK", "EUR", "SEK", "NOK"]
const timezoneOptions = [
  "Europe/Copenhagen",
  "Europe/Helsinki",
  "Europe/Stockholm",
  "Europe/Oslo",
  "Europe/London",
]
const projectKindOptions = [
  "Municipality",
  "Contract",
  "Region",
  "Business unit",
]

function statusClassName(status: string) {
  return status === "Active"
    ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    : "border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-300"
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The change could not be saved."
}

export function CompanyOnboardingDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (company: Company) => void
}) {
  const { createCompany } = useOrganizationStore()
  const [form, setForm] = useState(initialCompanyForm)
  const [error, setError] = useState("")

  const updateField = <Key extends keyof CreateCompanyInput>(
    key: Key,
    value: CreateCompanyInput[Key],
  ) => {
    setForm((current) => ({ ...current, [key]: value }))
    setError("")
  }

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen)
    if (!nextOpen) {
      setForm(initialCompanyForm)
      setError("")
    }
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    try {
      const company = createCompany(form)
      onCreated(company)
      handleOpenChange(false)
      toast.success("Company created", {
        description: `${company.name}, its first project, and its company administrator were created together.`,
      })
    } catch (caughtError) {
      const message = errorMessage(caughtError)
      setError(message)
      toast.error("Company could not be created", { description: message })
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Create company</DialogTitle>
            <DialogDescription>
              A company cannot be created on its own. Its first project and
              primary company administrator are created in the same action.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6 py-5">
            <fieldset className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                  1
                </div>
                <div>
                  <legend className="text-sm font-semibold">Company</legend>
                  <p className="text-xs leading-5 text-muted-foreground">
                    The tenant boundary for projects, users, and operational
                    data.
                  </p>
                </div>
              </div>
              <div className="grid gap-4 pl-11 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="new-company-name">Company name</Label>
                  <Input
                    id="new-company-name"
                    value={form.companyName}
                    onChange={(event) =>
                      updateField("companyName", event.target.value)
                    }
                    placeholder="North City Waste"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="new-company-legal-name">Legal name</Label>
                  <Input
                    id="new-company-legal-name"
                    value={form.legalName}
                    onChange={(event) =>
                      updateField("legalName", event.target.value)
                    }
                    placeholder="North City Waste A/S"
                    required
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="new-company-registration">
                    Registration number{" "}
                    <span className="font-normal text-muted-foreground">
                      (optional)
                    </span>
                  </Label>
                  <Input
                    id="new-company-registration"
                    value={form.registrationNumber}
                    onChange={(event) =>
                      updateField("registrationNumber", event.target.value)
                    }
                    placeholder="CVR, VAT, or local organization number"
                  />
                </div>
              </div>
            </fieldset>

            <Separator />

            <fieldset className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                  2
                </div>
                <div>
                  <legend className="text-sm font-semibold">First project</legend>
                  <p className="text-xs leading-5 text-muted-foreground">
                    Every company starts with one operating scope. The project
                    starts empty and in onboarding.
                  </p>
                </div>
              </div>
              <div className="grid gap-4 pl-11 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="new-company-project-name">Project name</Label>
                  <Input
                    id="new-company-project-name"
                    value={form.projectName}
                    onChange={(event) =>
                      updateField("projectName", event.target.value)
                    }
                    placeholder="North City Central"
                    required
                  />
                </div>
                <SelectField
                  id="new-company-project-kind"
                  label="Operating scope"
                  value={form.projectKind}
                  options={projectKindOptions}
                  onChange={(value) => updateField("projectKind", value)}
                />
                <SelectField
                  id="new-company-project-language"
                  label="Language"
                  value={form.projectLanguage}
                  options={languageOptions}
                  onChange={(value) => updateField("projectLanguage", value)}
                />
                <SelectField
                  id="new-company-project-currency"
                  label="Currency"
                  value={form.projectCurrency}
                  options={currencyOptions}
                  onChange={(value) => updateField("projectCurrency", value)}
                />
                <div className="sm:col-span-2">
                  <SelectField
                    id="new-company-project-timezone"
                    label="Timezone"
                    value={form.projectTimezone}
                    options={timezoneOptions}
                    onChange={(value) => updateField("projectTimezone", value)}
                  />
                </div>
              </div>
            </fieldset>

            <Separator />

            <fieldset className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                  3
                </div>
                <div>
                  <legend className="text-sm font-semibold">
                    Company administrator
                  </legend>
                  <p className="text-xs leading-5 text-muted-foreground">
                    This user receives company-wide control and access to all
                    current and future projects.
                  </p>
                </div>
              </div>
              <div className="grid gap-4 pl-11 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="new-company-admin-name">Full name</Label>
                  <Input
                    id="new-company-admin-name"
                    value={form.administratorName}
                    onChange={(event) =>
                      updateField("administratorName", event.target.value)
                    }
                    autoComplete="name"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="new-company-admin-email">Email</Label>
                  <Input
                    id="new-company-admin-email"
                    type="email"
                    value={form.administratorEmail}
                    onChange={(event) =>
                      updateField("administratorEmail", event.target.value)
                    }
                    autoComplete="email"
                    required
                  />
                </div>
                <div className="border-y border-border bg-muted/40 px-1 py-3 sm:col-span-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-primary" weight="fill" />
                    <span className="text-sm font-medium">
                      Company Administrator
                    </span>
                    <Badge variant="outline">All projects</Badge>
                  </div>
                  <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                    The invitation is part of company creation. No company is
                    left without a primary administrator if validation fails.
                  </p>
                </div>
              </div>
            </fieldset>

            {error && (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit">Create company</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function ProjectDialog({
  company,
  project,
  open,
  onOpenChange,
}: {
  company: Company | undefined
  project?: Project
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { createProject, updateProject } = useOrganizationStore()
  const [form, setForm] = useState(initialProjectForm)
  const [error, setError] = useState("")
  const isEditing = Boolean(project)

  useEffect(() => {
    if (!open) return
    setForm(
      project
        ? {
            name: project.name,
            kind: project.kind,
            language: project.language,
            currency: project.currency,
            timezone: project.timezone,
          }
        : initialProjectForm,
    )
    setError("")
  }, [open, project])

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen)
    if (!nextOpen) {
      setForm(initialProjectForm)
      setError("")
    }
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!company) return

    try {
      if (project) {
        const updatedProject = updateProject({ projectId: project.id, ...form })
        handleOpenChange(false)
        toast.success("Project updated", {
          description: `${updatedProject.name} was saved.`,
        })
        return
      }
      const createdProject = createProject({ companyId: company.id, ...form })
      handleOpenChange(false)
      toast.success("Project created", {
        description: `${createdProject.name} is ready for onboarding in ${company.name}.`,
      })
    } catch (caughtError) {
      const message = errorMessage(caughtError)
      setError(message)
      toast.error("Project could not be created", { description: message })
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{isEditing ? "Edit project" : "Add project"}</DialogTitle>
            <DialogDescription>
              {isEditing
                ? `Update this operating scope inside ${company?.name ?? "the company"}.`
                : `Create another operating scope inside ${company?.name ?? "the company"}. Company administrators receive access automatically.`}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="new-project-name">Project name</Label>
              <Input
                id="new-project-name"
                value={form.name}
                onChange={(event) => {
                  setForm((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                  setError("")
                }}
                required
              />
            </div>
            <SelectField
              id="new-project-kind"
              label="Operating scope"
              value={form.kind}
              options={projectKindOptions}
              onChange={(value) =>
                setForm((current) => ({ ...current, kind: value }))
              }
            />
            <SelectField
              id="new-project-language"
              label="Language"
              value={form.language}
              options={languageOptions}
              onChange={(value) =>
                setForm((current) => ({ ...current, language: value }))
              }
            />
            <SelectField
              id="new-project-currency"
              label="Currency"
              value={form.currency}
              options={currencyOptions}
              onChange={(value) =>
                setForm((current) => ({ ...current, currency: value }))
              }
            />
            <div className="sm:col-span-2">
              <SelectField
                id="new-project-timezone"
                label="Timezone"
                value={form.timezone}
                options={timezoneOptions}
                onChange={(value) =>
                  setForm((current) => ({ ...current, timezone: value }))
                }
              />
            </div>
            {error && (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive sm:col-span-2"
              >
                {error}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit">
              {isEditing ? "Save changes" : "Add project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function SelectField({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string
  label: string
  value: string
  options: string[]
  onChange: (value: string) => void
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export function OrganizationStructureManagement() {
  const {
    companies,
    projects,
    projectsForCompany,
    primaryAdministratorForCompany,
  } = useOrganizationStore()
  const [selectedCompanyId, setSelectedCompanyId] = useState(
    FIXTURE_COMPANY_ID,
  )
  const [companyDialogOpen, setCompanyDialogOpen] = useState(false)
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)

  const selectedCompany =
    companies.find((company) => company.id === selectedCompanyId) ??
    companies[0]
  const selectedProjects = selectedCompany
    ? projectsForCompany(selectedCompany.id)
    : []
  const primaryAdministrator = selectedCompany
    ? primaryAdministratorForCompany(selectedCompany.id)
    : undefined
  const fixtureRecordCount = useMemo(
    () =>
      Object.values(fixtureRecordScopeById).filter(
        (scope) => scope.companyId === FIXTURE_COMPANY_ID,
      ).length,
    [],
  )
  const {
    page: companiesPage,
    setPage: setCompaniesPage,
    pageCount: companiesPageCount,
    pageRows: companiesPageRows,
    totalCount: companiesTotalCount,
  } = useTablePagination(companies)
  const {
    page: projectsPage,
    setPage: setProjectsPage,
    pageCount: projectsPageCount,
    pageRows: projectsPageRows,
    totalCount: projectsTotalCount,
  } = useTablePagination(selectedProjects)

  useEffect(() => {
    setProjectsPage(1)
  }, [selectedCompanyId, setProjectsPage])

  return (
    <>
      <div className="space-y-6">
        <section className="min-w-0">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold">Companies</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {companies.length} compan{companies.length === 1 ? "y" : "ies"} ·{" "}
                {projects.length} project{projects.length === 1 ? "" : "s"}
              </p>
            </div>
          <Button
            size="sm"
            onClick={() => setCompanyDialogOpen(true)}
          >
            <Plus weight="bold" />
            Add company
          </Button>
          </div>
          <div className="overflow-hidden border-y border-border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Company</TableHead>
                  <TableHead>Registration</TableHead>
                  <TableHead>Projects</TableHead>
                  <TableHead>Primary administrator</TableHead>
                  <TableHead>Data</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
              {companiesPageRows.map((company) => {
                const companyProjects = projectsForCompany(company.id)
                const administrator =
                  primaryAdministratorForCompany(company.id)
                const isSelected = company.id === selectedCompany?.id
                const recordCount =
                  company.source === "fixture" ? fixtureRecordCount : 0
                return (
                  <TableRow
                    key={company.id}
                    onClick={() => setSelectedCompanyId(company.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault()
                        setSelectedCompanyId(company.id)
                      }
                    }}
                    tabIndex={0}
                    aria-selected={isSelected}
                    className={cn(
                      "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      isSelected && "bg-muted/60 hover:bg-muted/60",
                    )}
                  >
                    <TableCell className="min-w-56 py-3">
                      <div className="flex items-center gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                          {company.name}
                        </p>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {company.legalName}
                        </p>
                        </div>
                        {company.source === "fixture" && (
                          <Badge
                            variant="muted"
                            className="shrink-0 text-[10px]"
                          >
                            Sample data
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="min-w-36 text-muted-foreground">
                      {company.registrationNumber || "Not provided"}
                    </TableCell>
                    <TableCell>{companyProjects.length}</TableCell>
                    <TableCell className="min-w-48">
                      <div>{administrator?.fullName ?? "Missing"}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {administrator?.email ?? "Administrator required"}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {recordCount} records
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={statusClassName(company.status)}
                      >
                        {company.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                )
              })}
              </TableBody>
            </Table>
            <TablePagination
              page={companiesPage}
              pageCount={companiesPageCount}
              totalCount={companiesTotalCount}
              onPageChange={setCompaniesPage}
            />
          </div>
        </section>

        {selectedCompany && (
          <section className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold">
                {selectedCompany.name}
              </h3>
                      <Badge
                        variant="outline"
                        className={statusClassName(selectedCompany.status)}
                      >
                        {selectedCompany.status}
                      </Badge>
              {selectedCompany.source === "fixture" && (
                <Badge variant="muted">Sample data company</Badge>
              )}
            </div>

            <Tabs defaultValue="information" className="min-w-0">
              <TabsList className="w-full justify-start border-b border-border">
                <TabsTrigger value="information">
                  Company information
                </TabsTrigger>
                <TabsTrigger value="projects">
                  Projects
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {selectedProjects.length}
                  </span>
                </TabsTrigger>
              </TabsList>

              <TabsContent value="information" className="mt-5">
                <dl className="divide-y divide-border border-y border-border">
                  <InformationRow
                    label="Company name"
                    value={selectedCompany.name}
                  />
                  <InformationRow
                    label="Legal name"
                    value={selectedCompany.legalName}
                  />
                  <InformationRow
                    label="Registration number"
                    value={
                      selectedCompany.registrationNumber || "Not provided"
                    }
                  />
                  <InformationRow
                    label="Tenant ID"
                    value={selectedCompany.id}
                    mono
                  />
                  <div className="grid gap-2 px-4 py-4 md:grid-cols-[180px_minmax(0,1fr)]">
                    <dt className="text-sm text-muted-foreground">
                      Primary administrator
                    </dt>
                    <dd className="min-w-0">
                  {primaryAdministrator ? (
                    <>
                          <p className="text-sm font-medium">
                        {primaryAdministrator.fullName}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {primaryAdministrator.email}
                      </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                        <Badge variant="muted">
                          {primaryAdministrator.role}
                        </Badge>
                        <Badge variant="outline">
                          All current and future projects
                        </Badge>
                        <Badge
                          variant="outline"
                          className={statusClassName(
                            primaryAdministrator.status,
                          )}
                        >
                          {primaryAdministrator.status}
                        </Badge>
                      </div>
                    </>
                  ) : (
                        <p className="text-sm text-destructive">
                      This company has no primary administrator.
                    </p>
                  )}
                    </dd>
                  </div>
                  <div className="grid gap-2 px-4 py-4 md:grid-cols-[180px_minmax(0,1fr)]">
                    <dt className="text-sm text-muted-foreground">
                      Operational data
                    </dt>
                    <dd>
                      <p className="text-sm font-medium">
                        {selectedCompany.source === "fixture"
                          ? fixtureRecordCount
                          : 0}{" "}
                        records
                      </p>
                      <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    {selectedCompany.source === "fixture"
                      ? "Sample records are assigned only to this company and its explicit projects."
                      : "Operational records. New companies and projects start empty; data is never copied from another tenant."}
                      </p>
                    </dd>
                  </div>
                </dl>
              </TabsContent>

              <TabsContent value="projects" className="mt-5">
                <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <h4 className="text-sm font-semibold">Projects</h4>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Operating scopes owned by {selectedCompany.name}.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setProjectDialogOpen(true)}
                  >
                    <Plus weight="bold" />
                    Add project
                  </Button>
                </div>
                <div className="overflow-hidden border-y border-border">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Project</TableHead>
                        <TableHead>Scope</TableHead>
                        <TableHead>Locale</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {projectsPageRows.map((project) => (
                        <TableRow key={project.id}>
                          <TableCell className="min-w-48 py-3">
                            <div className="font-medium">{project.name}</div>
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              {project.id}
                            </div>
                          </TableCell>
                          <TableCell>{project.kind}</TableCell>
                          <TableCell className="min-w-44 text-muted-foreground">
                            {project.language} · {project.currency}
                            <div className="mt-0.5 text-xs">
                              {project.timezone}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={statusClassName(project.status)}
                            >
                              {project.status}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <TablePagination
                    page={projectsPage}
                    pageCount={projectsPageCount}
                    totalCount={projectsTotalCount}
                    onPageChange={setProjectsPage}
                  />
                </div>
              </TabsContent>
            </Tabs>

            <div className="mt-5 flex gap-3 border-y border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
                <CheckCircle
                  className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600"
                  weight="fill"
                />
                <p className="text-xs leading-5 text-muted-foreground">
                  Relationship checks are enforced on creation: every project
                  belongs to one company, every user belongs to one company,
                  project grants cannot cross companies, and every new company
                  starts with a primary administrator and at least one project.
                </p>
              </div>
          </section>
        )}
      </div>

      <CompanyOnboardingDialog
        open={companyDialogOpen}
        onOpenChange={setCompanyDialogOpen}
        onCreated={(company) => setSelectedCompanyId(company.id)}
      />
      <ProjectDialog
        company={selectedCompany}
        open={projectDialogOpen}
        onOpenChange={setProjectDialogOpen}
      />
    </>
  )
}

function InformationRow({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="grid gap-2 px-4 py-4 md:grid-cols-[180px_minmax(0,1fr)]">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className={cn("text-sm", mono && "font-mono text-xs")}>{value}</dd>
    </div>
  )
}

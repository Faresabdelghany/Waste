"use client"

import {
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react"
import { toast } from "sonner"
import {
  Funnel,
  Info,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Sliders,
  Trash,
} from "@phosphor-icons/react/dist/ssr"

import { cn } from "@/lib/utils"
import { getWorkspaceDefinition } from "@/lib/data/business-modules"
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useBusinessRecordStore } from "@/components/wastehero/business-record-store"
import { useOrganizationStore } from "@/components/settings/organization-store"
import {
  assetEntityId,
  useAssetManagementStore,
  type ContainerKind,
  type ContainerType,
  type KeyType,
  type PartType,
  type PropertyEquipment,
  type SparePart,
  type WasteFraction,
} from "@/components/settings/asset-management-store"

function nowIso() {
  return new Date().toISOString()
}

function slug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
}

function parseNumber(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function Field({
  label,
  description,
  required,
  wide,
  children,
}: {
  label: string
  description?: string
  required?: boolean
  wide?: boolean
  children: ReactNode
}) {
  return (
    <div className={cn("grid content-start gap-2", wide && "sm:col-span-2")}>
      <Label>
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </Label>
      {children}
      {description && (
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      )}
    </div>
  )
}

function DialogSection({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <section className="border-t border-border/70 py-5 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold">{title}</h3>
      {description && (
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
      )}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  )
}

type AssetView = {
  ordering: "updated" | "name"
  showDetails: boolean
}

const defaultAssetView: AssetView = { ordering: "updated", showDetails: true }

const assetStatusOptions = ["Active", "Inactive"] as const

function sortByView<T>(
  items: T[],
  view: AssetView,
  name: (item: T) => string,
  updated: (item: T) => string,
) {
  return [...items].sort((a, b) =>
    view.ordering === "name"
      ? name(a).localeCompare(name(b))
      : updated(b).localeCompare(updated(a)),
  )
}

type AssetFilterGroup = {
  label: string
  options: readonly string[]
  value: string[]
  onChange: (value: string[]) => void
}

function AssetFilterPopover({ groups }: { groups: AssetFilterGroup[] }) {
  const activeCount = groups.reduce((sum, group) => sum + group.value.length, 0)
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
          {activeCount > 0 && (
            <span className="rounded-full bg-primary/10 px-1.5 text-[10px] font-medium text-primary">
              {activeCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 rounded-xl p-0">
        <div className="space-y-3 p-4">
          <div>
            <p className="text-sm font-semibold">Filter</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Narrow the table by {groups.map((group) => group.label.toLowerCase()).join(" and ")}.
            </p>
          </div>
          {groups.map((group) => (
            <div key={group.label} className="space-y-2">
              {groups.length > 1 && (
                <p className="text-xs font-medium text-muted-foreground">{group.label}</p>
              )}
              {group.options.map((option) => (
                <label key={option} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={group.value.includes(option)}
                    onCheckedChange={(checked) =>
                      group.onChange(
                        checked
                          ? [...group.value, option]
                          : group.value.filter((item) => item !== option),
                      )
                    }
                  />
                  {option}
                </label>
              ))}
            </div>
          ))}
          {activeCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => groups.forEach((group) => group.onChange([]))}
            >
              Clear filters
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function AssetViewPopover({
  value,
  onChange,
}: {
  value: AssetView
  onChange: (value: AssetView) => void
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
      <PopoverContent align="start" className="w-80 rounded-xl p-0">
        <div className="space-y-4 p-4">
          <div>
            <p className="text-sm font-semibold">Table view</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Choose ordering and visible details.
            </p>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm">Ordering</span>
            <Select
              value={value.ordering}
              onValueChange={(ordering: AssetView["ordering"]) =>
                onChange({ ...value, ordering })
              }
            >
              <SelectTrigger className="h-8 w-44 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="updated">Recently updated</SelectItem>
                <SelectItem value="name">Name</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center justify-between gap-4 text-sm">
            Show details
            <Switch
              checked={value.showDetails}
              onCheckedChange={(showDetails) => onChange({ ...value, showDetails })}
            />
          </label>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function AssetToolbar({
  searchPlaceholder,
  query,
  onQueryChange,
  statuses,
  onStatusesChange,
  extraFilters,
  view,
  onViewChange,
}: {
  searchPlaceholder: string
  query: string
  onQueryChange: (value: string) => void
  statuses: string[]
  onStatusesChange: (value: string[]) => void
  extraFilters?: AssetFilterGroup[]
  view: AssetView
  onViewChange: (value: AssetView) => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-[260px] flex-1 flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] max-w-sm flex-1">
          <MagnifyingGlass className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={searchPlaceholder}
            className="h-8 pl-9 text-sm"
          />
        </div>
        <AssetFilterPopover
          groups={[
            {
              label: "Status",
              options: assetStatusOptions,
              value: statuses,
              onChange: onStatusesChange,
            },
            ...(extraFilters ?? []),
          ]}
        />
        <AssetViewPopover value={view} onChange={onViewChange} />
      </div>
    </div>
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

function EmptyRow({ colSpan, message }: { colSpan: number; message: string }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="h-52 text-center">
        <MagnifyingGlass className="mx-auto h-6 w-6 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium">{message}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Try a different search or status filter.
        </p>
      </TableCell>
    </TableRow>
  )
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-full text-[11px]",
        active
          ? "border-transparent bg-teal-50 text-teal-700 dark:bg-teal-500/15 dark:text-teal-100"
          : "border-transparent bg-muted text-muted-foreground",
      )}
    >
      {active ? "Active" : "Inactive"}
    </Badge>
  )
}

export function AssetManagementSettings() {
  const [companyTab, setCompanyTab] = useState("container-types")

  const tabs = (
    <div className="flex items-center gap-1 overflow-x-auto pb-1">
      <Tabs value={companyTab} onValueChange={setCompanyTab}>
        <TabsList className="inline-flex h-8 bg-muted rounded-full px-1 py-0.5 text-xs border border-border/50">
          <TabsTrigger value="container-types" className="rounded-full px-3 whitespace-nowrap">Container Types</TabsTrigger>
          <TabsTrigger value="waste-fractions" className="rounded-full px-3 whitespace-nowrap">Waste Fractions</TabsTrigger>
          <TabsTrigger value="spare-parts" className="rounded-full px-3 whitespace-nowrap">Spare Parts</TabsTrigger>
          <TabsTrigger value="part-types" className="rounded-full px-3 whitespace-nowrap">Part Types</TabsTrigger>
          <TabsTrigger value="property-equipment" className="rounded-full px-3 whitespace-nowrap">Property equipment</TabsTrigger>
          <TabsTrigger value="key-types" className="rounded-full px-3 whitespace-nowrap">Key Types</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  )

  return (
    <>
      {companyTab === "container-types" && <ContainerTypesPanel tabs={tabs} />}
      {companyTab === "waste-fractions" && <WasteFractionsPanel tabs={tabs} />}
      {companyTab === "spare-parts" && <SparePartsPanel tabs={tabs} />}
      {companyTab === "part-types" && <PartTypesPanel tabs={tabs} />}
      {companyTab === "property-equipment" && <PropertyEquipmentPanel tabs={tabs} />}
      {companyTab === "key-types" && <KeyTypesPanel tabs={tabs} />}
    </>
  )
}

function AssetPanelShell({
  tabs,
  action,
  toolbar,
  title,
  description,
  children,
}: {
  tabs: ReactNode
  action?: ReactNode
  toolbar: ReactNode
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex flex-col border-b border-border/40">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <p className="text-base font-medium text-foreground">Asset management</p>
          {action && <div className="flex items-center gap-2">{action}</div>}
        </div>
        <div className="flex flex-col gap-3 px-4 py-3">
          {tabs}
          {toolbar}
        </div>
      </header>
      <div className="flex-1 p-4">
        <div className="mx-auto max-w-[1500px] space-y-4">
          <section className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
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
          </section>
          {children}
        </div>
      </div>
    </div>
  )
}

function blankContainerType(): ContainerType {
  const createdAt = nowIso()
  return {
    id: "",
    name: "",
    kind: "waste-collection",
    projectIds: [],
    emplacement: "Surface",
    vehicleCoupling: "",
    emptyingTimeMinutes: 2,
    customizeEmptyingTime: false,
    emptyingTimeSeconds: 0,
    volumePreset: "Custom",
    volume: 240,
    volumeUnit: "L",
    cylinderShape: false,
    heightCm: 0,
    lengthCm: 0,
    widthCm: 0,
    diameterCm: 0,
    wasteFractionWeights: {},
    color: "#64748b",
    icon: "bin",
    lidType: "Hinged",
    loadingMethod: "Rear loader",
    warrantyMonths: 60,
    lifecycleStatus: "Active",
    createdAt,
    updatedAt: createdAt,
  }
}

const containerKindLabels: Record<ContainerKind, string> = {
  "waste-collection": "Waste collection",
  wastewater: "Wastewater tank",
}

function ContainerTypesPanel({ tabs }: { tabs: ReactNode }) {
  const assets = useAssetManagementStore()
  const recordsStore = useBusinessRecordStore()
  const [query, setQuery] = useState("")
  const [statuses, setStatuses] = useState<string[]>([])
  const [kinds, setKinds] = useState<string[]>([])
  const [view, setView] = useState<AssetView>(defaultAssetView)
  const [editing, setEditing] = useState<ContainerType | null>(null)
  const recordsModule = getWorkspaceDefinition("resources").modules.find(
    (module) => module.id === "containers",
  )!
  const allContainers = recordsStore.getRecords(
    "resources",
    "containers",
    recordsModule.records,
  )
  const filtered = sortByView(
    assets.containerTypes
      .filter((item) =>
        [item.name, containerKindLabels[item.kind], item.emplacement, item.loadingMethod]
          .join(" ")
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
      .filter(
        (item) =>
          statuses.length === 0 || statuses.includes(item.lifecycleStatus),
      )
      .filter(
        (item) =>
          kinds.length === 0 || kinds.includes(containerKindLabels[item.kind]),
      ),
    view,
    (item) => item.name,
    (item) => item.updatedAt,
  )

  const remove = (item: ContainerType) => {
    const inUse = allContainers.some(
      (record) =>
        record.submittedValues?.containerType === item.id ||
        record.facts["Container type"] === item.name,
    )
    if (inUse) {
      toast.error("Container type is still in use", {
        description:
          "Deactivate it to remove it from new-container pickers. Existing containers keep their historical type.",
      })
      return
    }
    assets.deleteContainerType(item.id)
    toast.success("Container type deleted")
  }

  return (
    <AssetPanelShell
      tabs={tabs}
      title="Container types"
      description="Catalogue of container models available to projects — dimensions, emptying characteristics and lifecycle. Deactivated types stay on existing containers but leave the pickers."
      action={
        <Button size="sm" onClick={() => setEditing(blankContainerType())}>
          <Plus className="h-4 w-4" weight="bold" /> New container type
        </Button>
      }
      toolbar={
        <AssetToolbar
          searchPlaceholder="Search container types"
          query={query}
          onQueryChange={setQuery}
          statuses={statuses}
          onStatusesChange={setStatuses}
          extraFilters={[
            {
              label: "Category",
              options: Object.values(containerKindLabels),
              value: kinds,
              onChange: setKinds,
            },
          ]}
          view={view}
          onViewChange={setView}
        />
      }
    >
      <RecordsSection shown={filtered.length} total={assets.containerTypes.length}>
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead>Name</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Volume</TableHead>
              <TableHead>Collection</TableHead>
              <TableHead>Loading method</TableHead>
              <TableHead>Lifecycle</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <EmptyRow colSpan={7} message="No container types match this search." />
            ) : (
              filtered.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <span
                        className="h-3 w-3 rounded-full border"
                        style={{ backgroundColor: item.color }}
                      />
                      <div>
                        <p className="font-medium">{item.name}</p>
                        {view.showDetails && (
                          <p className="text-xs text-muted-foreground">
                            {item.lidType}
                          </p>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{containerKindLabels[item.kind]}</Badge>
                  </TableCell>
                  <TableCell>{item.volume.toLocaleString()} {item.volumeUnit}</TableCell>
                  <TableCell>
                    <p>{item.emplacement}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.emptyingTimeMinutes} min emptying
                    </p>
                  </TableCell>
                  <TableCell>{item.loadingMethod || "—"}</TableCell>
                  <TableCell>
                    <StatusBadge active={item.lifecycleStatus === "Active"} />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setEditing(item)}
                        aria-label={`Edit ${item.name}`}
                      >
                        <PencilSimple className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => remove(item)}
                        aria-label={`Delete ${item.name}`}
                      >
                        <Trash className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </RecordsSection>
      <ContainerTypeDialog
        key={editing ? editing.id || "new" : "closed"}
        value={editing}
        onClose={() => setEditing(null)}
      />
    </AssetPanelShell>
  )
}

function ContainerTypeDialog({
  value,
  onClose,
}: {
  value: ContainerType | null
  onClose: () => void
}) {
  const assets = useAssetManagementStore()
  const organization = useOrganizationStore()
  const [draft, setDraft] = useState<ContainerType>(value ?? blankContainerType())
  const isEditing = Boolean(value?.id)

  if (!value) return null
  const update = <K extends keyof ContainerType>(key: K, next: ContainerType[K]) =>
    setDraft((current) => ({ ...current, [key]: next }))
  const save = () => {
    if (!draft.name.trim() || draft.volume <= 0) {
      toast.error("Name and a positive volume are required.")
      return
    }
    const timestamp = nowIso()
    assets.saveContainerType({
      ...draft,
      id: draft.id || assetEntityId(`container-type-${slug(draft.name) || "custom"}`),
      name: draft.name.trim(),
      updatedAt: timestamp,
      createdAt: draft.createdAt || timestamp,
    })
    onClose()
    toast.success(isEditing ? "Container type updated" : "Container type created")
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-6 py-5 pr-12">
          <DialogTitle>{isEditing ? "Edit container type" : "New container type"}</DialogTitle>
          <DialogDescription>
            Kind cannot be changed after creation. Volume and dimensions should describe the same physical container.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <DialogSection title="Configuration">
            <Field label="Kind" required>
              <Select
                value={draft.kind}
                disabled={isEditing}
                onValueChange={(next: ContainerType["kind"]) => update("kind", next)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="waste-collection">Waste collection container</SelectItem>
                  <SelectItem value="wastewater">Wastewater tank</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Name" required>
              <Input value={draft.name} onChange={(event) => update("name", event.target.value)} />
            </Field>
            <Field
              label="Project visibility"
              wide
              description="Leave every project unchecked to make this type available company-wide."
            >
              <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
                {organization.projects.map((project) => (
                  <label key={project.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={draft.projectIds.includes(project.id)}
                      onCheckedChange={(checked) =>
                        update(
                          "projectIds",
                          checked
                            ? [...draft.projectIds, project.id]
                            : draft.projectIds.filter((id) => id !== project.id),
                        )
                      }
                    />
                    {project.name}
                  </label>
                ))}
              </div>
            </Field>
          </DialogSection>
          <DialogSection title="Collection">
            <Field label="Emplacement">
              <Select value={draft.emplacement} onValueChange={(next) => update("emplacement", next)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Surface">Surface</SelectItem>
                  <SelectItem value="Underground">Underground</SelectItem>
                  <SelectItem value="Indoor">Indoor</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Vehicle coupling">
              <Input value={draft.vehicleCoupling} onChange={(event) => update("vehicleCoupling", event.target.value)} />
            </Field>
            <Field label="Emptying time" description="Default time used by route planning.">
              <div className="relative">
                <Input type="number" min={0} value={draft.emptyingTimeMinutes} onChange={(event) => update("emptyingTimeMinutes", parseNumber(event.target.value))} className="pr-12" />
                <span className="absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">min</span>
              </div>
            </Field>
            <Field label="Customize sub-minute time">
              <div className="flex h-10 items-center gap-3">
                <Switch checked={draft.customizeEmptyingTime} onCheckedChange={(checked) => update("customizeEmptyingTime", checked)} />
                <span className="text-sm text-muted-foreground">Use seconds override</span>
              </div>
            </Field>
            {draft.customizeEmptyingTime && (
              <Field label="Emptying time override">
                <div className="relative">
                  <Input type="number" min={0} value={draft.emptyingTimeSeconds} onChange={(event) => update("emptyingTimeSeconds", parseNumber(event.target.value))} className="pr-12" />
                  <span className="absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">sec</span>
                </div>
              </Field>
            )}
          </DialogSection>
          <DialogSection title="Internal dimensions" description="Volume must match the physical dimensions recorded for the asset type.">
            <Field label="Volume preset">
              <Select value={draft.volumePreset} onValueChange={(next) => update("volumePreset", next)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["120 L", "240 L", "660 L", "1,100 L", "3,000 L", "Custom"].map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Volume" required>
              <div className="flex gap-2">
                <Input type="number" min={1} value={draft.volume} onChange={(event) => update("volume", parseNumber(event.target.value))} />
                <Select value={draft.volumeUnit} onValueChange={(next: ContainerType["volumeUnit"]) => update("volumeUnit", next)}>
                  <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="L">L</SelectItem><SelectItem value="m³">m³</SelectItem></SelectContent>
                </Select>
              </div>
            </Field>
            <Field label="Cylinder shape">
              <div className="flex h-10 items-center gap-3"><Switch checked={draft.cylinderShape} onCheckedChange={(checked) => update("cylinderShape", checked)} /><span className="text-sm text-muted-foreground">Use height and diameter</span></div>
            </Field>
            <Field label="Height"><Input type="number" min={0} value={draft.heightCm} onChange={(event) => update("heightCm", parseNumber(event.target.value))} /></Field>
            {draft.cylinderShape ? (
              <Field label="Diameter (cm)"><Input type="number" min={0} value={draft.diameterCm} onChange={(event) => update("diameterCm", parseNumber(event.target.value))} /></Field>
            ) : (
              <>
                <Field label="Length (cm)"><Input type="number" min={0} value={draft.lengthCm} onChange={(event) => update("lengthCm", parseNumber(event.target.value))} /></Field>
                <Field label="Width (cm)"><Input type="number" min={0} value={draft.widthCm} onChange={(event) => update("widthCm", parseNumber(event.target.value))} /></Field>
              </>
            )}
          </DialogSection>
          <DialogSection title="Waste fraction weight table" description="Expected full weight by compatible waste fraction." >
            {assets.wasteFractions.filter((fraction) => fraction.status === "Active").map((fraction) => (
              <Field key={fraction.id} label={fraction.name}>
                <div className="relative">
                  <Input type="number" min={0} value={draft.wasteFractionWeights[fraction.id] ?? ""} onChange={(event) => update("wasteFractionWeights", { ...draft.wasteFractionWeights, [fraction.id]: parseNumber(event.target.value) })} className="pr-10" />
                  <span className="absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">kg</span>
                </div>
              </Field>
            ))}
          </DialogSection>
          <DialogSection title="Asset details">
            <Field label="Colour"><Input type="color" value={draft.color} onChange={(event) => update("color", event.target.value)} className="h-10 p-1" /></Field>
            <Field label="Icon"><Input value={draft.icon} onChange={(event) => update("icon", event.target.value)} /></Field>
            <Field label="Lid type"><Input value={draft.lidType} onChange={(event) => update("lidType", event.target.value)} /></Field>
            <Field label="Loading method"><Input value={draft.loadingMethod} onChange={(event) => update("loadingMethod", event.target.value)} /></Field>
            <Field label="Warranty period (months)"><Input type="number" min={0} value={draft.warrantyMonths} onChange={(event) => update("warrantyMonths", parseNumber(event.target.value))} /></Field>
            <Field label="Lifecycle status">
              <Select value={draft.lifecycleStatus} onValueChange={(next: ContainerType["lifecycleStatus"]) => update("lifecycleStatus", next)}>
                <SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="Active">Active</SelectItem><SelectItem value="Inactive">Inactive</SelectItem></SelectContent>
              </Select>
            </Field>
          </DialogSection>
        </div>
        <DialogFooter className="border-t px-6 py-4"><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save}>Save container type</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function blankWasteFraction(): WasteFraction {
  const createdAt = nowIso()
  return {
    id: "",
    name: "",
    projectIds: [],
    wasteSubstance: "",
    disposalMethod: "",
    wasteType: "",
    weightToVolumeRatio: 0,
    status: "Active",
    ewcCode: "",
    rdCode: "",
    hazardous: false,
    recyclable: false,
    mustIncludeVat: false,
    recyclingPercent: 0,
    energyRecoveryPercent: 0,
    materialRecoveryPercent: 0,
    emptyingIntervalMinDays: 0,
    emptyingIntervalMaxDays: 0,
    style: "Solid",
    color: "#64748b",
    createdAt,
    updatedAt: createdAt,
  }
}

function WasteFractionsPanel({ tabs }: { tabs: ReactNode }) {
  const assets = useAssetManagementStore()
  const [query, setQuery] = useState("")
  const [statuses, setStatuses] = useState<string[]>([])
  const [view, setView] = useState<AssetView>(defaultAssetView)
  const [editing, setEditing] = useState<WasteFraction | null>(null)
  const filtered = sortByView(
    assets.wasteFractions
      .filter((item) =>
        [item.name, item.ewcCode, item.wasteType, item.disposalMethod]
          .join(" ")
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
      .filter((item) => statuses.length === 0 || statuses.includes(item.status)),
    view,
    (item) => item.name,
    (item) => item.updatedAt,
  )
  return (
    <AssetPanelShell
      tabs={tabs}
      title="Waste fractions"
      description="The waste streams containers can hold, with compliance codes and recovery targets."
      action={<Button size="sm" onClick={() => setEditing(blankWasteFraction())}><Plus className="h-4 w-4" weight="bold" /> New waste fraction</Button>}
      toolbar={<AssetToolbar searchPlaceholder="Search waste fractions" query={query} onQueryChange={setQuery} statuses={statuses} onStatusesChange={setStatuses} view={view} onViewChange={setView} />}
    >
      <RecordsSection shown={filtered.length} total={assets.wasteFractions.length}>
        <Table>
          <TableHeader><TableRow className="bg-muted/40 hover:bg-muted/40"><TableHead>Name</TableHead><TableHead>Compliance</TableHead><TableHead>Recovery</TableHead><TableHead>Status</TableHead><TableHead className="w-16" /></TableRow></TableHeader>
          <TableBody>
            {filtered.length === 0 ? <EmptyRow colSpan={5} message="No waste fractions match this search." /> : filtered.map((item) => (
              <TableRow key={item.id}>
                <TableCell><div className="flex items-center gap-3"><span className="h-3 w-3 rounded-full border" style={{ backgroundColor: item.color }} /><div><p className="font-medium">{item.name}</p>{view.showDetails && <p className="text-xs text-muted-foreground">{item.wasteType}</p>}</div></div></TableCell>
                <TableCell><p>{item.ewcCode || "No EWC code"}</p><p className="text-xs text-muted-foreground">{item.rdCode || "No R/D code"}{item.hazardous ? " · Hazardous" : ""}</p></TableCell>
                <TableCell>{item.recyclingPercent}% recycling</TableCell>
                <TableCell><StatusBadge active={item.status === "Active"} /></TableCell>
                <TableCell><Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditing(item)} aria-label={`Edit ${item.name}`}><PencilSimple className="h-4 w-4" /></Button></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </RecordsSection>
      <WasteFractionDialog
        key={editing ? editing.id || "new" : "closed"}
        value={editing}
        onClose={() => setEditing(null)}
      />
    </AssetPanelShell>
  )
}

function WasteFractionDialog({ value, onClose }: { value: WasteFraction | null; onClose: () => void }) {
  const assets = useAssetManagementStore()
  const organization = useOrganizationStore()
  const [draft, setDraft] = useState<WasteFraction>(value ?? blankWasteFraction())
  if (!value) return null
  const isEditing = Boolean(value.id)
  const update = <K extends keyof WasteFraction>(key: K, next: WasteFraction[K]) => setDraft((current) => ({ ...current, [key]: next }))
  const numberField = (key: keyof WasteFraction) => (event: ChangeEvent<HTMLInputElement>) => update(key, parseNumber(event.target.value) as never)
  const save = () => {
    if (!draft.name.trim()) return toast.error("Waste fraction name is required.")
    if (draft.emptyingIntervalMaxDays && draft.emptyingIntervalMaxDays < draft.emptyingIntervalMinDays) return toast.error("Maximum emptying interval must be after the minimum.")
    const timestamp = nowIso()
    assets.saveWasteFraction({ ...draft, id: draft.id || assetEntityId(`fraction-${slug(draft.name)}`), name: draft.name.trim(), updatedAt: timestamp, createdAt: draft.createdAt || timestamp })
    onClose()
    toast.success(isEditing ? "Waste fraction updated" : "Waste fraction created")
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-6 py-5 pr-12"><DialogTitle>{isEditing ? "Edit waste fraction" : "New waste fraction"}</DialogTitle><DialogDescription>Configure operational classification, compliance, recovery outcomes, and display preferences.</DialogDescription></DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <DialogSection title="Configurations">
            <Field label="Name" required><Input value={draft.name} onChange={(event) => update("name", event.target.value)} /></Field>
            <Field label="Project visibility" description="Leave blank for company-wide availability."><Select value={draft.projectIds[0] ?? "company"} onValueChange={(next) => update("projectIds", next === "company" ? [] : [next])}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="company">All company projects</SelectItem>{organization.projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent></Select></Field>
            <Field label="Waste substance"><Input value={draft.wasteSubstance} onChange={(event) => update("wasteSubstance", event.target.value)} /></Field>
            <Field label="Waste disposal method"><Input value={draft.disposalMethod} onChange={(event) => update("disposalMethod", event.target.value)} /></Field>
            <Field label="Waste type"><Input value={draft.wasteType} onChange={(event) => update("wasteType", event.target.value)} /></Field>
            <Field label="Weight to volume ratio"><Input type="number" min={0} step="0.01" value={draft.weightToVolumeRatio} onChange={numberField("weightToVolumeRatio")} /></Field>
          </DialogSection>
          <DialogSection title="Compliance & recovery">
            <Field label="Status"><Select value={draft.status} onValueChange={(next: WasteFraction["status"]) => update("status", next)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="Active">Active</SelectItem><SelectItem value="Inactive">Inactive</SelectItem></SelectContent></Select></Field>
            <Field label="EWC code"><Input value={draft.ewcCode} onChange={(event) => update("ewcCode", event.target.value)} /></Field>
            <Field label="R/D code"><Input value={draft.rdCode} onChange={(event) => update("rdCode", event.target.value)} /></Field>
            <Field label="Hazardous"><div className="flex h-10 items-center"><Switch checked={draft.hazardous} onCheckedChange={(checked) => update("hazardous", checked)} /></div></Field>
            <Field label="Recyclable"><div className="flex h-10 items-center"><Switch checked={draft.recyclable} onCheckedChange={(checked) => update("recyclable", checked)} /></div></Field>
            <Field label="Must Include VAT" description="Every product and price row on this waste fraction must carry a VAT rate that resolves to a non-zero percentage."><div className="flex h-10 items-center"><Switch checked={draft.mustIncludeVat} onCheckedChange={(checked) => update("mustIncludeVat", checked)} /></div></Field>
            <Field label="Recycling %"><Input type="number" min={0} max={100} value={draft.recyclingPercent} onChange={numberField("recyclingPercent")} /></Field>
            <Field label="Energy recovery %"><Input type="number" min={0} max={100} value={draft.energyRecoveryPercent} onChange={numberField("energyRecoveryPercent")} /></Field>
            <Field label="Material recovery %"><Input type="number" min={0} max={100} value={draft.materialRecoveryPercent} onChange={numberField("materialRecoveryPercent")} /></Field>
            <Field label="Emptying interval min (days)"><Input type="number" min={0} value={draft.emptyingIntervalMinDays} onChange={numberField("emptyingIntervalMinDays")} /></Field>
            <Field label="Emptying interval max (days)"><Input type="number" min={0} value={draft.emptyingIntervalMaxDays} onChange={numberField("emptyingIntervalMaxDays")} /></Field>
          </DialogSection>
          <DialogSection title="Preferences">
            <Field label="Style"><Select value={draft.style} onValueChange={(next) => update("style", next)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="Solid">Solid</SelectItem><SelectItem value="Striped">Striped</SelectItem><SelectItem value="Outlined">Outlined</SelectItem></SelectContent></Select></Field>
            <Field label="Color"><Input type="color" value={draft.color} onChange={(event) => update("color", event.target.value)} className="h-10 p-1" /></Field>
          </DialogSection>
        </div>
        <DialogFooter className="border-t px-6 py-4"><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save}>Save waste fraction</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function blankSparePart(): SparePart {
  const createdAt = nowIso()
  return { id: "", name: "", containerTypeId: "", additionalContainerTypeIds: [], partTypeId: "", sku: "", description: "", active: true, createdAt, updatedAt: createdAt }
}

function SparePartsPanel({ tabs }: { tabs: ReactNode }) {
  const assets = useAssetManagementStore()
  const [query, setQuery] = useState("")
  const [statuses, setStatuses] = useState<string[]>([])
  const [partTypeFilters, setPartTypeFilters] = useState<string[]>([])
  const [view, setView] = useState<AssetView>(defaultAssetView)
  const [editing, setEditing] = useState<SparePart | null>(null)
  const partTypeName = (item: SparePart) =>
    assets.partTypes.find((type) => type.id === item.partTypeId)?.name ?? "No part type"
  const partTypeOptions = [
    ...assets.partTypes.filter((type) => type.active).map((type) => type.name),
    "No part type",
  ]
  const filtered = sortByView(
    assets.spareParts
      .filter((item) => [item.name, item.sku, item.description, partTypeName(item)].join(" ").toLowerCase().includes(query.trim().toLowerCase()))
      .filter((item) => statuses.length === 0 || statuses.includes(item.active ? "Active" : "Inactive"))
      .filter((item) => partTypeFilters.length === 0 || partTypeFilters.includes(partTypeName(item))),
    view,
    (item) => item.name,
    (item) => item.updatedAt,
  )
  return (
    <AssetPanelShell
      tabs={tabs}
      title="Spare parts"
      description="Replacement parts kept for containers, with the container types each part fits and inventory identity."
      action={<Button size="sm" onClick={() => setEditing(blankSparePart())}><Plus className="h-4 w-4" weight="bold" /> New spare part</Button>}
      toolbar={<AssetToolbar searchPlaceholder="Search spare parts" query={query} onQueryChange={setQuery} statuses={statuses} onStatusesChange={setStatuses} extraFilters={[{ label: "Part type", options: partTypeOptions, value: partTypeFilters, onChange: setPartTypeFilters }]} view={view} onViewChange={setView} />}
    >
      <RecordsSection shown={filtered.length} total={assets.spareParts.length}>
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead>Name</TableHead>
              <TableHead>Part type</TableHead>
              <TableHead>Fits container</TableHead>
              <TableHead>SKU / Part number</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <EmptyRow colSpan={6} message="No spare parts match this search." />
            ) : (
              filtered.map((item) => {
                const type = assets.containerTypes.find((candidate) => candidate.id === item.containerTypeId)
                return (
                  <TableRow key={item.id}>
                    <TableCell>
                      <p className="font-medium">{item.name}</p>
                      {view.showDetails && <p className="line-clamp-1 text-xs text-muted-foreground">{item.description || "No description"}</p>}
                    </TableCell>
                    <TableCell><Badge variant="outline">{partTypeName(item)}</Badge></TableCell>
                    <TableCell>{type?.name ?? "Not assigned"}{item.additionalContainerTypeIds.length > 0 && <p className="text-xs text-muted-foreground">+{item.additionalContainerTypeIds.length} compatible</p>}</TableCell>
                    <TableCell>{item.sku || "—"}</TableCell>
                    <TableCell><StatusBadge active={item.active} /></TableCell>
                    <TableCell>
                      <div className="flex">
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditing(item)}><PencilSimple className="h-4 w-4" /></Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { assets.deleteSparePart(item.id); toast.success("Spare part deleted") }}><Trash className="h-4 w-4" /></Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </RecordsSection>
      <SparePartDialog
        key={editing ? editing.id || "new" : "closed"}
        value={editing}
        onClose={() => setEditing(null)}
      />
    </AssetPanelShell>
  )
}

function SparePartDialog({ value, onClose }: { value: SparePart | null; onClose: () => void }) {
  const assets = useAssetManagementStore()
  const [draft, setDraft] = useState<SparePart>(value ?? blankSparePart())
  const [advanced, setAdvanced] = useState(Boolean(value?.sku || value?.description || value?.additionalContainerTypeIds.length))
  if (!value) return null
  const update = <K extends keyof SparePart>(key: K, next: SparePart[K]) => setDraft((current) => ({ ...current, [key]: next }))
  const save = () => {
    if (!draft.name.trim() || !draft.containerTypeId) return toast.error("Name and container type are required.")
    const timestamp = nowIso()
    assets.saveSparePart({ ...draft, id: draft.id || assetEntityId("spare-part"), name: draft.name.trim(), createdAt: draft.createdAt || timestamp, updatedAt: timestamp })
    onClose(); toast.success(value.id ? "Spare part updated" : "Spare part created")
  }
  return <Dialog open onOpenChange={(open) => !open && onClose()}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>{value.id ? "Edit spare part" : "New spare part"}</DialogTitle><DialogDescription>Define the primary container fit and optional compatibility and inventory identity.</DialogDescription></DialogHeader><div className="grid gap-4 sm:grid-cols-2"><Field label="Container type" required description="The container this part fits."><Select value={draft.containerTypeId} onValueChange={(next) => update("containerTypeId", next)}><SelectTrigger><SelectValue placeholder="Select container type" /></SelectTrigger><SelectContent>{assets.containerTypes.filter((item) => item.lifecycleStatus === "Active").map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select></Field><Field label="Part type"><Select value={draft.partTypeId || "none"} onValueChange={(next) => update("partTypeId", next === "none" ? "" : next)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No part type</SelectItem>{assets.partTypes.filter((item) => item.active).map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select></Field><Field label="Name" required wide><Input value={draft.name} onChange={(event) => update("name", event.target.value)} /></Field><div className="sm:col-span-2"><Button variant="ghost" size="sm" onClick={() => setAdvanced((current) => !current)}>{advanced ? "Hide advanced" : "Show advanced"}</Button></div>{advanced && <><Field label="Additional container types" wide description="Other containers this part also fits."><div className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">{assets.containerTypes.filter((item) => item.id !== draft.containerTypeId).map((item) => <label key={item.id} className="flex items-center gap-2 text-sm"><Checkbox checked={draft.additionalContainerTypeIds.includes(item.id)} onCheckedChange={(checked) => update("additionalContainerTypeIds", checked ? [...draft.additionalContainerTypeIds, item.id] : draft.additionalContainerTypeIds.filter((id) => id !== item.id))} />{item.name}</label>)}</div></Field><Field label="SKU / Part number"><Input value={draft.sku} onChange={(event) => update("sku", event.target.value)} /></Field><Field label="Active"><div className="flex h-10 items-center"><Switch checked={draft.active} onCheckedChange={(checked) => update("active", checked)} /></div></Field><Field label="Description" wide><Textarea value={draft.description} onChange={(event) => update("description", event.target.value)} /></Field></>}</div><DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save}>Save spare part</Button></DialogFooter></DialogContent></Dialog>
}

function PartTypesPanel({ tabs }: { tabs: ReactNode }) {
  const assets = useAssetManagementStore()
  const [query, setQuery] = useState("")
  const [statuses, setStatuses] = useState<string[]>([])
  const [view, setView] = useState<AssetView>(defaultAssetView)
  const [name, setName] = useState("")
  const filtered = sortByView(
    assets.partTypes
      .filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase()))
      .filter((item) => statuses.length === 0 || statuses.includes(item.active ? "Active" : "Inactive")),
    view,
    (item) => item.name,
    (item) => item.createdAt,
  )
  const create = () => {
    if (!name.trim()) return
    if (assets.partTypes.some((item) => item.name.toLowerCase() === name.trim().toLowerCase())) return toast.error("Part type already exists.")
    assets.savePartType({ id: assetEntityId("part-type"), name: name.trim(), seeded: false, active: true, createdAt: nowIso() }); setName(""); toast.success("Part type created")
  }
  return <AssetPanelShell
    tabs={tabs}
    title="Part types"
    description="Groupings for spare parts used in pickers and reporting. Deactivated types stay on existing spare parts."
    action={<div className="flex max-w-lg gap-2"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="New part type name" onKeyDown={(event) => event.key === "Enter" && create()} className="h-8 w-48 text-sm" /><Button size="sm" onClick={create}><Plus className="h-4 w-4" weight="bold" /> Create</Button></div>}
    toolbar={<AssetToolbar searchPlaceholder="Search part types" query={query} onQueryChange={setQuery} statuses={statuses} onStatusesChange={setStatuses} view={view} onViewChange={setView} />}
  ><RecordsSection shown={filtered.length} total={assets.partTypes.length}><Table><TableHeader><TableRow className="bg-muted/40 hover:bg-muted/40"><TableHead>Name</TableHead><TableHead>Kind</TableHead><TableHead>Status</TableHead><TableHead className="w-28" /></TableRow></TableHeader><TableBody>{filtered.length === 0 ? <EmptyRow colSpan={4} message="No part types match this search." /> : filtered.map((item) => <TableRow key={item.id}><TableCell className="font-medium">{item.name}</TableCell><TableCell><Badge variant="outline">{item.seeded ? "System" : "Custom"}</Badge></TableCell><TableCell><StatusBadge active={item.active} /></TableCell><TableCell><Button variant="outline" size="sm" disabled={!item.active} onClick={() => { assets.savePartType({ ...item, active: false }); toast.success("Part type deactivated", { description: "It no longer appears in pickers; existing spare parts keep it." }) }}>Deactivate</Button></TableCell></TableRow>)}</TableBody></Table></RecordsSection></AssetPanelShell>
}

function PropertyEquipmentPanel({ tabs }: { tabs: ReactNode }) {
  const assets = useAssetManagementStore()
  const [query, setQuery] = useState("")
  const [statuses, setStatuses] = useState<string[]>([])
  const [view, setView] = useState<AssetView>(defaultAssetView)
  const [editing, setEditing] = useState<PropertyEquipment | null>(null)
  const filtered = sortByView(
    assets.propertyEquipment
      .filter((item) => [item.name, item.description].join(" ").toLowerCase().includes(query.trim().toLowerCase()))
      .filter((item) => statuses.length === 0 || statuses.includes(item.active ? "Active" : "Inactive")),
    view,
    (item) => item.name,
    (item) => item.updatedAt,
  )
  return <AssetPanelShell
    tabs={tabs}
    title="Property equipment"
    description="Appliances that can be registered on a property alongside containers."
    action={<Button size="sm" onClick={() => setEditing({ id: "", name: "", system: false, active: true, description: "", createdAt: nowIso(), updatedAt: nowIso() })}><Plus className="h-4 w-4" weight="bold" /> New appliance</Button>}
    toolbar={<AssetToolbar searchPlaceholder="Search property equipment" query={query} onQueryChange={setQuery} statuses={statuses} onStatusesChange={setStatuses} view={view} onViewChange={setView} />}
  ><RecordsSection shown={filtered.length} total={assets.propertyEquipment.length}><Table><TableHeader><TableRow className="bg-muted/40 hover:bg-muted/40"><TableHead>Name</TableHead><TableHead>Description</TableHead><TableHead>Kind</TableHead><TableHead>Status</TableHead><TableHead className="w-16" /></TableRow></TableHeader><TableBody>{filtered.length === 0 ? <EmptyRow colSpan={5} message="No property equipment matches this search." /> : filtered.map((item) => <TableRow key={item.id}><TableCell className="font-medium">{item.name}</TableCell><TableCell className="text-muted-foreground">{item.description || "—"}</TableCell><TableCell><Badge variant="outline">{item.system ? "System" : "Custom"}</Badge></TableCell><TableCell><StatusBadge active={item.active} /></TableCell><TableCell><Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditing(item)}><PencilSimple className="h-4 w-4" /></Button></TableCell></TableRow>)}</TableBody></Table></RecordsSection><SimpleEquipmentDialog key={editing ? editing.id || "new" : "closed"} value={editing} onClose={() => setEditing(null)} /></AssetPanelShell>
}

function SimpleEquipmentDialog({ value, onClose }: { value: PropertyEquipment | null; onClose: () => void }) {
  const assets = useAssetManagementStore()
  const [draft, setDraft] = useState(value)
  if (!value || !draft) return null
  const save = () => { if (!draft.name.trim()) return toast.error("Equipment name is required."); const timestamp = nowIso(); assets.savePropertyEquipment({ ...draft, id: draft.id || assetEntityId("property-equipment"), name: draft.name.trim(), updatedAt: timestamp }); onClose(); toast.success(value.id ? "Property equipment updated" : "Property equipment created") }
  return <Dialog open onOpenChange={(open) => !open && onClose()}><DialogContent><DialogHeader><DialogTitle>{value.id ? "Edit property equipment" : "New property equipment"}</DialogTitle><DialogDescription>Custom appliances are company-owned library entries.</DialogDescription></DialogHeader><Field label="Name" required><Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field><Field label="Description"><Textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></Field><label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm"><span>Active in property pickers</span><Switch checked={draft.active} onCheckedChange={(active) => setDraft({ ...draft, active })} /></label><DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save}>Save appliance</Button></DialogFooter></DialogContent></Dialog>
}

function KeyTypesPanel({ tabs }: { tabs: ReactNode }) {
  const assets = useAssetManagementStore()
  const [query, setQuery] = useState("")
  const [statuses, setStatuses] = useState<string[]>([])
  const [view, setView] = useState<AssetView>(defaultAssetView)
  const [editing, setEditing] = useState<KeyType | null>(null)
  const filtered = sortByView(
    assets.keyTypes
      .filter((item) => [item.name, item.feeProduct, item.instructions].join(" ").toLowerCase().includes(query.trim().toLowerCase()))
      .filter((item) => statuses.length === 0 || statuses.includes(item.active ? "Active" : "Inactive")),
    view,
    (item) => item.name,
    (item) => item.updatedAt,
  )
  return <AssetPanelShell
    tabs={tabs}
    title="Key types"
    description="Key classifications with deposits, fee products and cutting instructions."
    action={<Button size="sm" onClick={() => setEditing({ id: "", name: "", system: false, active: true, chargeableByDefault: false, feeProduct: "", deposit: 0, instructions: "", createdAt: nowIso(), updatedAt: nowIso() })}><Plus className="h-4 w-4" weight="bold" /> New key type</Button>}
    toolbar={<AssetToolbar searchPlaceholder="Search key types" query={query} onQueryChange={setQuery} statuses={statuses} onStatusesChange={setStatuses} view={view} onViewChange={setView} />}
  ><RecordsSection shown={filtered.length} total={assets.keyTypes.length}><Table><TableHeader><TableRow className="bg-muted/40 hover:bg-muted/40"><TableHead>Name</TableHead><TableHead>Kind</TableHead><TableHead>Chargeable</TableHead><TableHead>Fee product</TableHead><TableHead>Deposit</TableHead><TableHead>Instructions</TableHead><TableHead className="w-16" /></TableRow></TableHeader><TableBody>{filtered.length === 0 ? <EmptyRow colSpan={7} message="No key types match this search." /> : filtered.map((item) => <TableRow key={item.id} className={!item.active ? "opacity-60" : undefined}><TableCell><p className="font-medium">{item.name}</p>{!item.active && <p className="text-xs text-muted-foreground">Inactive</p>}</TableCell><TableCell><Badge variant="outline">{item.system ? "System" : "Custom"}</Badge></TableCell><TableCell>{item.chargeableByDefault ? "Yes" : "No"}</TableCell><TableCell>{item.feeProduct || "—"}</TableCell><TableCell>{item.deposit ? `${item.deposit.toLocaleString()} DKK` : "—"}</TableCell><TableCell className="max-w-60 truncate">{item.instructions || "—"}</TableCell><TableCell><Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditing(item)}><PencilSimple className="h-4 w-4" /></Button></TableCell></TableRow>)}</TableBody></Table></RecordsSection><KeyTypeDialog key={editing ? editing.id || "new" : "closed"} value={editing} onClose={() => setEditing(null)} /></AssetPanelShell>
}

function KeyTypeDialog({ value, onClose }: { value: KeyType | null; onClose: () => void }) {
  const assets = useAssetManagementStore(); const [draft, setDraft] = useState(value); if (!value || !draft) return null
  const save = () => { if (!draft.name.trim()) return toast.error("Key type name is required."); const timestamp = nowIso(); assets.saveKeyType({ ...draft, id: draft.id || assetEntityId("key-type"), name: draft.name.trim(), updatedAt: timestamp }); onClose(); toast.success(value.id ? "Key type updated" : "Key type created") }
  return <Dialog open onOpenChange={(open) => !open && onClose()}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>{value.id ? "Edit key type" : "New key type"}</DialogTitle><DialogDescription>Deactivation removes a type from pickers while issued keys keep their historical classification.</DialogDescription></DialogHeader><div className="grid gap-4 sm:grid-cols-2"><Field label="Name" required><Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field><Field label="Active"><div className="flex h-10 items-center"><Switch checked={draft.active} onCheckedChange={(active) => setDraft({ ...draft, active })} /></div></Field><Field label="Chargeable by default"><div className="flex h-10 items-center"><Switch checked={draft.chargeableByDefault} onCheckedChange={(chargeableByDefault) => setDraft({ ...draft, chargeableByDefault })} /></div></Field><Field label="Fee product"><Input value={draft.feeProduct} onChange={(event) => setDraft({ ...draft, feeProduct: event.target.value })} /></Field><Field label="Deposit"><Input type="number" min={0} value={draft.deposit} onChange={(event) => setDraft({ ...draft, deposit: parseNumber(event.target.value) })} /></Field><Field label="Instructions" wide><Textarea value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} /></Field></div><DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save}>Save key type</Button></DialogFooter></DialogContent></Dialog>
}

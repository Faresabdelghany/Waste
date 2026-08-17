"use client"

import { Sliders } from "@phosphor-icons/react/dist/ssr"

import { Button } from "@/components/ui/button"
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

export type BusinessViewOptions = {
  density: "compact" | "comfortable"
  ordering: "updated" | "name" | "status"
  showDescription: boolean
  showContext: boolean
  showUpdated: boolean
  showContainerType: boolean
  showWasteFraction: boolean
  showAddress: boolean
  showFillLevel: boolean
  showNextCollection: boolean
  showProject: boolean
}

export const defaultBusinessViewOptions: BusinessViewOptions = {
  density: "comfortable",
  ordering: "updated",
  showDescription: true,
  showContext: true,
  showUpdated: true,
  showContainerType: true,
  showWasteFraction: true,
  showAddress: true,
  showFillLevel: true,
  showNextCollection: true,
  showProject: true,
}

type BooleanViewOption = Exclude<
  keyof BusinessViewOptions,
  "density" | "ordering"
>

const defaultFields: Array<{ key: BooleanViewOption; label: string }> = [
  { key: "showDescription", label: "Description" },
  { key: "showContext", label: "Business context" },
  { key: "showUpdated", label: "Updated time" },
]

const containerFields: Array<{ key: BooleanViewOption; label: string }> = [
  { key: "showDescription", label: "Description under ID" },
  { key: "showContainerType", label: "Container type" },
  { key: "showWasteFraction", label: "Waste fraction" },
  { key: "showAddress", label: "Address / location" },
  { key: "showFillLevel", label: "Fill level / sensor state" },
  { key: "showNextCollection", label: "Next collection" },
  { key: "showProject", label: "Project" },
]

export function BusinessViewOptionsPopover({
  value,
  onChange,
  variant = "default",
}: {
  value: BusinessViewOptions
  onChange: (options: BusinessViewOptions) => void
  variant?: "default" | "containers"
}) {
  const fields = variant === "containers" ? containerFields : defaultFields

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
              {variant === "containers"
                ? "Control row density, ordering, and visible registry columns."
                : "Control row density, ordering, and visible business context."}
            </p>
          </div>

          <div className="space-y-3 border-y border-border/60 py-3">
            <div className="flex items-center justify-between gap-4">
              <span className="text-xs font-medium">Density</span>
              <Select
                value={value.density}
                onValueChange={(density: BusinessViewOptions["density"]) =>
                  onChange({ ...value, density })
                }
              >
                <SelectTrigger className="h-8 w-36 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="comfortable">Comfortable</SelectItem>
                  <SelectItem value="compact">Compact</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between gap-4">
              <span className="text-xs font-medium">Order by</span>
              <Select
                value={value.ordering}
                onValueChange={(ordering: BusinessViewOptions["ordering"]) =>
                  onChange({ ...value, ordering })
                }
              >
                <SelectTrigger className="h-8 w-36 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="updated">Recently updated</SelectItem>
                  <SelectItem value="name">Name</SelectItem>
                  <SelectItem value="status">Status</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-3">
            {fields.map(({ key, label }) => (
              <div key={key} className="flex items-center justify-between gap-4">
                <span className="text-xs">{label}</span>
                <Switch
                  aria-label={`Show ${label}`}
                  checked={value[key]}
                  onCheckedChange={(checked) =>
                    onChange({ ...value, [key]: checked })
                  }
                />
              </div>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

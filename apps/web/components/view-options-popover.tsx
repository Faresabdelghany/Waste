"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import {
  Sliders,
  ListBullets,
  Kanban,
  ChartBar,
  TextIndent,
  CaretUpDown,
  ListDashes,
  Globe,
  Spinner,
  User,
  Tag,
  TextT,
  Calendar,
} from "@phosphor-icons/react/dist/ssr"
import { cn } from "@/lib/utils"

type Options = {
  viewType: "list" | "board" | "timeline"
  tasks: "indented" | "collapsed" | "flat"
  ordering: "manual" | "alphabetical" | "date"
  showAbsentParent: boolean
  showClosedProjects: boolean
  groupBy: "none" | "status" | "assignee" | "tags"
  properties: string[]
}

interface ViewOptionsPopoverProps {
  options: Options
  onChange: (options: Options) => void
  allowedViewTypes?: string[]
}

export function ViewOptionsPopover({ options, onChange, allowedViewTypes }: ViewOptionsPopoverProps) {
  const [tasksOpen, setTasksOpen] = useState(false)
  const [orderingOpen, setOrderingOpen] = useState(false)
  const [groupByOpen, setGroupByOpen] = useState(false)

  const viewTypes = [
    { id: "list", label: "List", icon: ListBullets },
    { id: "board", label: "Board", icon: Kanban },
    { id: "timeline", label: "Timeline", icon: ChartBar },
  ].filter((type) => !allowedViewTypes || allowedViewTypes.includes(type.id))

  const taskOptions = [
    { id: "indented", label: "Indented", icon: TextIndent },
    { id: "collapsed", label: "Collapsed", icon: CaretUpDown },
    { id: "flat", label: "Flat", icon: ListDashes },
  ]

  const orderingOptions = [
    { id: "manual", label: "Manual" },
    { id: "alphabetical", label: "Alphabetical" },
    { id: "date", label: "Date" },
  ]

  const groupByOptions = [
    { id: "none", label: "None", icon: Globe },
    { id: "status", label: "Status", icon: Spinner, count: "4 status" },
    { id: "assignee", label: "Assignee", icon: User, count: "1 active" },
    { id: "tags", label: "Tags", icon: Tag, count: "4 tags" },
  ]

  const propertyOptions = [
    { id: "title", label: "Title", icon: TextT },
    { id: "status", label: "Status", icon: Spinner },
    { id: "assignee", label: "Assignee", icon: User },
    { id: "dueDate", label: "Due date", icon: Calendar },
  ]

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-2 rounded-lg border-border/60 px-3 bg-transparent">
          <Sliders className="h-4 w-4" />
          View
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 rounded-xl p-0" align="end">
        <div className="p-4">
          {/* View Type Tabs */}
          <div className="flex rounded-xl p-1 bg-muted">
            {viewTypes.map((type) => (
              <Button
                variant="ghost"
                key={type.id}
                onClick={() => onChange({ ...options, viewType: type.id as Options['viewType'] })}
                className={cn("justify-start whitespace-normal shrink h-auto px-0 has-[>svg]:px-0 cursor-default hover:bg-transparent hover:text-inherit dark:hover:bg-transparent",
                  "flex flex-1 flex-col items-center gap-1 rounded-lg py-2.5 text-xs font-medium transition-colors shadow-none",
                  options.viewType === type.id
                    ? "bg-background shadow-sm hover:bg-background dark:hover:bg-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <type.icon className="size-5" />
                {type.label}
              </Button>
            ))}
          </div>

          <div className="mt-4 space-y-3">
            {/* Tasks Dropdown */}
            <div className="flex items-center justify-between">
              <span className="text-sm">Tasks</span>
              <Popover open={tasksOpen} onOpenChange={setTasksOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-2 rounded-lg border-border/60 px-3 bg-transparent"
                  >
                    {taskOptions.find((o) => o.id === options.tasks)?.icon && <TextIndent className="h-4 w-4" />}
                    {taskOptions.find((o) => o.id === options.tasks)?.label}
                    <CaretUpDown className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-40 rounded-xl p-1" align="end">
                  {taskOptions.map((option) => (
                    <Button
                      variant="ghost"
                      key={option.id}
                      onClick={() => {
                        onChange({ ...options, tasks: option.id as Options['tasks'] })
                        setTasksOpen(false)
                      }}
                      className={cn("justify-start whitespace-normal font-normal shrink h-auto has-[>svg]:px-3 cursor-default hover:text-inherit",
                        "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-accent dark:hover:bg-accent",
                        options.tasks === option.id && "bg-accent",
                      )}
                    >
                      <option.icon className="size-4" />
                      {option.label}
                    </Button>
                  ))}
                </PopoverContent>
              </Popover>
            </div>

            {/* Ordering Dropdown */}
            <div className="flex items-center justify-between">
              <span className="text-sm">Ordering</span>
              <Popover open={orderingOpen} onOpenChange={setOrderingOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-2 rounded-lg border-border/60 px-3 bg-transparent"
                  >
                    <Sliders className="h-4 w-4" />
                    {orderingOptions.find((o) => o.id === options.ordering)?.label}
                    <CaretUpDown className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-36 rounded-xl p-1" align="end">
                  {orderingOptions.map((option) => (
                    <Button
                      variant="ghost"
                      key={option.id}
                      onClick={() => {
                        onChange({ ...options, ordering: option.id as Options['ordering'] })
                        setOrderingOpen(false)
                      }}
                      className={cn("justify-start whitespace-normal font-normal shrink h-auto cursor-default hover:text-inherit",
                        "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-accent dark:hover:bg-accent",
                        options.ordering === option.id && "bg-accent",
                      )}
                    >
                      {option.label}
                    </Button>
                  ))}
                </PopoverContent>
              </Popover>
            </div>

            {/* Show absent parent */}
            <div className="flex items-center justify-between">
              <span className="text-sm">Show absent parent</span>
              <Switch
                checked={options.showAbsentParent}
                onCheckedChange={(checked) => onChange({ ...options, showAbsentParent: checked })}
              />
            </div>

            {/* Show closed projects */}
            <div className="flex items-center justify-between">
              <span className="text-sm">Show closed projects</span>
              <Switch
                checked={options.showClosedProjects}
                onCheckedChange={(checked) => onChange({ ...options, showClosedProjects: checked })}
              />
            </div>

            {/* Group by */}
            <div className="flex items-center justify-between">
              <span className="text-sm">Group by</span>
              <Popover open={groupByOpen} onOpenChange={setGroupByOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-2 rounded-lg border-border/60 px-3 bg-transparent"
                  >
                    <Globe className="h-4 w-4" />
                    {groupByOptions.find((o) => o.id === options.groupBy)?.label}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-44 rounded-xl p-1" align="end">
                  {groupByOptions.map((option) => (
                    <Button
                      variant="ghost"
                      key={option.id}
                      onClick={() => {
                        onChange({ ...options, groupBy: option.id as Options['groupBy'] })
                        setGroupByOpen(false)
                      }}
                      className={cn("justify-start whitespace-normal font-normal shrink h-auto has-[>svg]:px-3 cursor-default hover:text-inherit",
                        "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-accent dark:hover:bg-accent",
                        options.groupBy === option.id && "bg-accent",
                      )}
                    >
                      <option.icon className="size-4" />
                      <span className="flex-1 text-left">{option.label}</span>
                      {option.count && <span className="text-xs text-muted-foreground">{option.count}</span>}
                    </Button>
                  ))}
                </PopoverContent>
              </Popover>
            </div>

            {/* Properties */}
            <div className="pt-2">
              <span className="text-sm font-medium">Properties</span>
              <div className="mt-2 flex flex-wrap gap-2">
                {propertyOptions.map((prop) => (
                  <Button
                    variant="ghost"
                    key={prop.id}
                    onClick={() => {
                      const newProps = options.properties.includes(prop.id)
                        ? options.properties.filter((p) => p !== prop.id)
                        : [...options.properties, prop.id]
                      onChange({ ...options, properties: newProps })
                    }}
                    className={cn("justify-start whitespace-normal font-normal shrink h-auto has-[>svg]:px-3 cursor-default hover:bg-transparent hover:text-inherit dark:hover:bg-transparent",
                      "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors",
                      options.properties.includes(prop.id)
                        ? "border-border bg-background hover:bg-background dark:hover:bg-background"
                        : "border-border hover:bg-accent dark:hover:bg-accent",
                    )}
                  >
                    <prop.icon className="size-3.5" />
                    {prop.label}
                  </Button>
                ))}
                <Button variant="ghost" className="gap-0 whitespace-normal font-normal shrink h-auto transition-none cursor-default flex items-center justify-center rounded-md border border-dashed border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-muted-foreground dark:hover:bg-accent">
                  +
                </Button>
              </div>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between border-t border-border/40 pt-4">
            <div className="flex items-center gap-1">
              <Button variant="link" className="justify-start whitespace-normal rounded-none font-normal shrink h-auto p-0 has-[>svg]:px-0 transition-none cursor-default underline-offset-auto flex items-center gap-1.5 text-sm text-primary hover:underline">
                <Globe className="size-4" />
                Set default
              </Button>
              <span className="text-sm text-muted-foreground">for everyone</span>
            </div>
            <Button variant="link" className="inline-block whitespace-normal rounded-none font-normal shrink h-auto p-0 transition-none cursor-default underline-offset-auto text-sm text-primary hover:underline">Reset</Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

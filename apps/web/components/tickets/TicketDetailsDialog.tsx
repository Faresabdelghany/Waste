"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeft,
  At,
  ChatCircleText,
  Check,
  CheckCircle,
  ClockCounterClockwise,
  DownloadSimple,
  DotsThree,
  File,
  LinkSimple,
  LockKey,
  Paperclip,
  PaperPlaneTilt,
  Plus,
  Smiley,
  TextB,
  X,
} from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import type { BusinessRecord } from "@/lib/data/business-modules"
import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useOrganizationStore } from "@/components/settings/organization-store"

type TicketComment = {
  id: string
  author: string
  initials: string
  at: string
  body: string
  kind: ComposerMode
}

type ComposerMode = "reply" | "internal" | "sms"

type TicketActivity = {
  id: string
  title: string
  detail: string
  actor: string
  at: string
  tone?: "success" | "neutral"
}

type TicketInformation = {
  status: string
  priority: string
  type: string
  responseTarget: string
  assignee: string
  team: string
  source: string
  context: string
}

type TicketInformationField = keyof TicketInformation

type TicketInformationOption = {
  value: string
  label: string
  description?: string
  initials?: string
  dotClassName?: string
}

type TicketAttachment = {
  id: string
  name: string
  size: number
  type: string
  url: string
  uploadedAt: string
  uploadedBy: string
}

type TicketDetailsDialogProps = {
  record: BusinessRecord
  onClose: () => void
}

const quickEmojis = ["👍", "✅", "🙏", "👀", "🚛", "♻️", "⚠️", "📍", "📎", "🎉", "🙂", "❤️"]

const composerModeConfig: Record<
  ComposerMode,
  {
    label: string
    placeholder: string
    textareaLabel: string
    actionLabel: string
    activityTitle: string
    successMessage: string
  }
> = {
  reply: {
    label: "Reply",
    placeholder: "Reply to this ticket…",
    textareaLabel: "Reply to this ticket",
    actionLabel: "Send",
    activityTitle: "Reply added",
    successMessage: "Reply added to ticket",
  },
  internal: {
    label: "Internal note",
    placeholder: "Write an internal note…",
    textareaLabel: "Write an internal note",
    actionLabel: "Add note",
    activityTitle: "Internal note added",
    successMessage: "Internal note added to ticket",
  },
  sms: {
    label: "SMS to customer",
    placeholder: "Write an SMS to the customer…",
    textareaLabel: "Write an SMS to the customer",
    actionLabel: "Send SMS",
    activityTitle: "SMS sent",
    successMessage: "SMS sent to customer",
  },
}

const fallbackAssignees = [
  { value: "Mads Jensen", label: "Mads Jensen", description: "Dispatch coordinator" },
  { value: "Freja Nielsen", label: "Freja Nielsen", description: "Customer service" },
  { value: "Emil Hansen", label: "Emil Hansen", description: "Field operations" },
  { value: "Eva Sørensen", label: "Eva Sørensen", description: "Service recovery" },
  { value: "Jonas Holm", label: "Jonas Holm", description: "Fleet operations" },
]

const statusOptions: TicketInformationOption[] = [
  { value: "Open", label: "Open", dotClassName: "bg-blue-500" },
  { value: "In progress", label: "In progress", dotClassName: "bg-amber-500" },
  { value: "Waiting on customer", label: "Waiting on customer", dotClassName: "bg-violet-500" },
  { value: "Resolved", label: "Resolved", dotClassName: "bg-emerald-500" },
  { value: "Closed", label: "Closed", dotClassName: "bg-muted-foreground" },
]

const priorityOptions: TicketInformationOption[] = [
  { value: "Urgent", label: "Urgent", dotClassName: "bg-rose-600" },
  { value: "High", label: "High", dotClassName: "bg-rose-500" },
  { value: "Medium", label: "Medium", dotClassName: "bg-amber-500" },
  { value: "Low", label: "Low", dotClassName: "bg-blue-500" },
  { value: "No priority", label: "No priority", dotClassName: "bg-muted-foreground/50" },
]

const typeOptions: TicketInformationOption[] = [
  { value: "Missed collection", label: "Missed collection" },
  { value: "Blocked access", label: "Blocked access" },
  { value: "Container overflow", label: "Container overflow" },
  { value: "Container damage", label: "Container damage" },
  { value: "Customer request", label: "Customer request" },
  { value: "Other", label: "Other" },
]

const responseTargetOptions: TicketInformationOption[] = [
  { value: "15 min remaining", label: "15 min remaining" },
  { value: "30 min remaining", label: "30 min remaining" },
  { value: "1 hour remaining", label: "1 hour remaining" },
  { value: "4 hours remaining", label: "4 hours remaining" },
  { value: "Due today", label: "Due today" },
  { value: "No target", label: "No target" },
]

const teamOptions: TicketInformationOption[] = [
  { value: "Service recovery", label: "Service recovery" },
  { value: "Dispatch team", label: "Dispatch team" },
  { value: "Customer service", label: "Customer service" },
  { value: "Field operations", label: "Field operations" },
  { value: "Fleet operations", label: "Fleet operations" },
]

const sourceOptions: TicketInformationOption[] = [
  { value: "Driver app", label: "Driver app" },
  { value: "Customer portal", label: "Customer portal" },
  { value: "Customer service", label: "Customer service" },
  { value: "Operations", label: "Operations" },
]

const contextOptions: TicketInformationOption[] = [
  { value: "Østerbro Housing · Parkvej 18", label: "Østerbro Housing", description: "Parkvej 18" },
  { value: "Amager District · Sundbyvej 91", label: "Amager District", description: "Sundbyvej 91" },
  { value: "Copenhagen Central · Adelgade 12", label: "Copenhagen Central", description: "Adelgade 12" },
  { value: "Copenhagen Central · Borgergade 41", label: "Copenhagen Central", description: "Borgergade 41" },
]

function informationFromRecord(record: BusinessRecord): TicketInformation {
  return {
    status: record.status,
    priority: record.facts.Priority ?? "Normal",
    type: record.facts.Type ?? "Operational ticket",
    responseTarget: record.value,
    assignee: record.owner,
    team: record.facts.Team ?? "Customer service",
    source: record.facts.Source ?? record.source,
    context: record.context,
  }
}

function initials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("")
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function priorityClasses(priority: string): string {
  if (/critical|high/i.test(priority)) {
    return "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-200"
  }
  if (/medium/i.test(priority)) {
    return "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-200"
  }
  return "border-border bg-muted/60 text-muted-foreground"
}

function statusClasses(status: string): string {
  if (/completed|resolved/i.test(status)) {
    return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
  }
  if (/progress|open/i.test(status)) {
    return "border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-200"
  }
  return "border-border bg-muted/60 text-muted-foreground"
}

function withCurrentOption(
  options: TicketInformationOption[],
  currentValue: string,
): TicketInformationOption[] {
  if (options.some((option) => option.value === currentValue)) return options
  return [{ value: currentValue, label: currentValue }, ...options]
}

export function TicketDetailsDialog({
  record,
  onClose,
}: TicketDetailsDialogProps) {
  const { users } = useOrganizationStore()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const filePickerTargetRef = useRef<"composer" | "library">("composer")
  const attachmentUrlsRef = useRef(new Set<string>())
  const [message, setMessage] = useState("")
  const [composerMode, setComposerMode] = useState<ComposerMode>("reply")
  const [comments, setComments] = useState<TicketComment[]>([])
  const [attachments, setAttachments] = useState<TicketAttachment[]>([])
  const [ticketAttachments, setTicketAttachments] = useState<TicketAttachment[]>([])
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [emojiMenuOpen, setEmojiMenuOpen] = useState(false)
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false)
  const [information, setInformation] = useState<TicketInformation>(() =>
    informationFromRecord(record),
  )
  const [informationActivities, setInformationActivities] = useState<TicketActivity[]>([])
  const [selectedTab, setSelectedTab] = useState("details")

  useEffect(() => {
    setMessage("")
    setComposerMode("reply")
    setComments([])
    attachmentUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
    attachmentUrlsRef.current.clear()
    setAttachments([])
    setTicketAttachments([])
    setAddMenuOpen(false)
    setEmojiMenuOpen(false)
    setMentionMenuOpen(false)
    setInformation(informationFromRecord(record))
    setInformationActivities([])
    setSelectedTab("details")
  }, [record.id])

  useEffect(
    () => () => {
      attachmentUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      attachmentUrlsRef.current.clear()
    },
    [],
  )

  const activeComposer = composerModeConfig[composerMode]

  const assigneeOptions = useMemo<TicketInformationOption[]>(() => {
    const availableUsers: TicketInformationOption[] = users.map((user) => ({
      value: user.fullName,
      label: user.fullName,
      description: `${user.role} · ${user.status}`,
      initials: initials(user.fullName),
    }))
    const merged = [
      {
        value: information.assignee,
        label: information.assignee,
        description: "Current assignee",
        initials: initials(information.assignee),
      },
      ...availableUsers,
      ...fallbackAssignees.map((user) => ({ ...user, initials: initials(user.label) })),
    ]
    return merged.filter(
      (option, index) =>
        merged.findIndex((candidate) => candidate.value === option.value) === index,
    )
  }, [information.assignee, users])

  const activities = useMemo<TicketActivity[]>(
    () => [
      {
        id: `${record.id}-created`,
        title: "Ticket created",
        detail: `${information.source} created this ticket in ${information.team}.`,
        actor: information.source,
        at: record.updated,
      },
      {
        id: `${record.id}-assigned`,
        title: `Assigned to ${information.assignee}`,
        detail: `${information.team} owns the next response and resolution step.`,
        actor: "WasteHero",
        at: record.updated,
      },
      {
        id: `${record.id}-status`,
        title: `Status is ${information.status}`,
        detail: `${information.responseTarget} remains on the current response target.`,
        actor: information.assignee,
        at: "Now",
        tone: "success",
      },
      ...informationActivities,
      ...comments.map((comment) => ({
        id: `${comment.id}-activity`,
        title: composerModeConfig[comment.kind].activityTitle,
        detail: comment.body,
        actor: comment.author,
        at: comment.at,
      })),
    ],
    [comments, information, informationActivities, record.id, record.updated],
  )

  const updateInformation = (
    field: TicketInformationField,
    label: string,
    value: string,
  ) => {
    const previousValue = information[field]
    if (previousValue === value) return

    setInformation((current) => ({ ...current, [field]: value }))
    setInformationActivities((current) => [
      ...current,
      {
        id: `information-${field}-${Date.now()}`,
        title: `${label} changed`,
        detail: `${previousValue} → ${value}`,
        actor: "Olivia Larsen",
        at: "Now",
      },
    ])
    toast.success(`${label} updated`)
  }

  const focusComposerAt = (start: number, end = start) => {
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(start, end)
    })
  }

  const insertAtSelection = (value: string) => {
    const textarea = textareaRef.current
    const start = textarea?.selectionStart ?? message.length
    const end = textarea?.selectionEnd ?? message.length
    const nextMessage = `${message.slice(0, start)}${value}${message.slice(end)}`
    setMessage(nextMessage)
    focusComposerAt(start + value.length)
  }

  const applyBoldFormatting = () => {
    const textarea = textareaRef.current
    const start = textarea?.selectionStart ?? message.length
    const end = textarea?.selectionEnd ?? message.length
    const selectedText = message.slice(start, end)
    const replacement = `**${selectedText}**`
    setMessage(`${message.slice(0, start)}${replacement}${message.slice(end)}`)
    if (selectedText) {
      focusComposerAt(start + 2, start + 2 + selectedText.length)
    } else {
      focusComposerAt(start + 2)
    }
  }

  const addFiles = (files: FileList | null, target: "composer" | "library") => {
    if (!files?.length) return
    const nextAttachments = Array.from(files).map((file, index) => {
      const url = URL.createObjectURL(file)
      attachmentUrlsRef.current.add(url)
      return {
        id:
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${file.name}-${Date.now()}-${index}`,
        name: file.name,
        size: file.size,
        type: file.type || "File",
        url,
        uploadedAt: "Now",
        uploadedBy: "Olivia Larsen",
      }
    })
    setTicketAttachments((current) => [...current, ...nextAttachments])
    if (target === "composer") {
      setAttachments((current) => [...current, ...nextAttachments])
    }
    setInformationActivities((current) => [
      ...current,
      {
        id: `attachment-${Date.now()}`,
        title: files.length === 1 ? "Attachment uploaded" : "Attachments uploaded",
        detail: nextAttachments.map((attachment) => attachment.name).join(", "),
        actor: "Olivia Larsen",
        at: "Now",
      },
    ])
    toast.success(`${files.length} ${files.length === 1 ? "file" : "files"} uploaded`)
  }

  const openFilePicker = (target: "composer" | "library" = "composer") => {
    setAddMenuOpen(false)
    filePickerTargetRef.current = target
    fileInputRef.current?.click()
  }

  const removeAttachment = (attachment: TicketAttachment) => {
    setAttachments((current) => current.filter((item) => item.id !== attachment.id))
    setTicketAttachments((current) => current.filter((item) => item.id !== attachment.id))
    URL.revokeObjectURL(attachment.url)
    attachmentUrlsRef.current.delete(attachment.url)
  }

  const sendMessage = () => {
    const reply = message.trim()
    if (!reply && attachments.length === 0) return

    const attachmentSummary = attachments.length
      ? `Attachments: ${attachments
          .map((attachment) => `${attachment.name} (${formatFileSize(attachment.size)})`)
          .join(", ")}`
      : ""
    const body = [reply, attachmentSummary].filter(Boolean).join("\n\n")

    setComments((current) => [
      ...current,
      {
        id: `comment-${Date.now()}`,
        author: "Olivia Larsen",
        initials: "OL",
        at: "Now",
        body,
        kind: composerMode,
      },
    ])
    setMessage("")
    setAttachments([])
    setComposerMode("reply")
    toast.success(activeComposer.successMessage)
  }

  const copyTicketLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      toast.success("Ticket link copied")
    } catch {
      toast.error("Ticket link could not be copied")
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="h-[calc(100dvh-1rem)] max-h-[980px] w-[calc(100vw-1rem)] max-w-none gap-0 overflow-hidden rounded-2xl p-0 sm:h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)] sm:max-w-[1700px]"
      >
        <div className="flex h-full min-h-0 flex-col lg:flex-row">
          <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
            <header className="flex min-h-[76px] items-center justify-between gap-4 border-b border-border/60 px-4 py-3 sm:px-6">
              <div className="flex min-w-0 items-center gap-3">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={onClose}
                  aria-label="Back to tickets"
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <DialogTitle className="truncate text-lg font-semibold">
                      {record.name}
                    </DialogTitle>
                    <Badge
                      variant="outline"
                      className={cn("rounded-full text-[11px]", statusClasses(information.status))}
                    >
                      {information.status}
                    </Badge>
                  </div>
                  <DialogDescription className="mt-0.5 truncate text-xs sm:text-sm">
                    {record.id} · {information.context} · Updated {informationActivities.length > 0 ? "now" : record.updated.toLowerCase()}
                  </DialogDescription>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <Button type="button" variant="ghost" size="icon-sm" aria-label="More ticket actions">
                  <DotsThree className="h-4 w-4" weight="bold" />
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={copyTicketLink}>
                  <LinkSimple className="h-4 w-4" />
                  <span className="hidden sm:inline">Copy link</span>
                </Button>
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-7 sm:py-7">
              <div className="mx-auto max-w-4xl space-y-7">
                <article className="flex items-start gap-3">
                  <Avatar className="mt-0.5 h-9 w-9 border border-border">
                    <AvatarFallback className="text-xs">{initials(information.source)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="text-sm font-semibold text-foreground">{information.source}</p>
                      <span className="text-xs text-muted-foreground">{record.updated}</span>
                    </div>
                    <div className="mt-2 rounded-xl border border-border/70 bg-card px-4 py-3.5 shadow-sm">
                      <p className="text-sm leading-6 text-foreground">{record.description}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Badge variant="outline" className="rounded-full font-normal">
                          {information.type}
                        </Badge>
                        <Badge
                          variant="outline"
                          className={cn("rounded-full font-normal", priorityClasses(information.priority))}
                        >
                          {information.priority} priority
                        </Badge>
                      </div>
                    </div>
                  </div>
                </article>

                <div className="pl-12">
                  <div className="rounded-xl border border-border/60 bg-muted/25 px-4 py-4">
                    <div className="flex items-center gap-2">
                      <CheckCircle className="h-4 w-4 text-emerald-600" weight="fill" />
                      <h3 className="text-sm font-semibold">Resolution context</h3>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      {information.assignee} is coordinating the next response. The current target is {information.responseTarget.toLowerCase()}.
                    </p>
                    {record.related.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {record.related.map((item) => (
                          <span
                            key={item}
                            className="rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground"
                          >
                            {item}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {comments.map((comment) => (
                  <article key={comment.id} className="flex items-start gap-3">
                    <Avatar className="mt-0.5 h-9 w-9 border border-border">
                      <AvatarFallback className="bg-primary text-xs text-primary-foreground">
                        {comment.initials}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold">{comment.author}</p>
                        <span className="text-xs text-muted-foreground">{comment.at}</span>
                        {comment.kind !== "reply" && (
                          <Badge
                            variant="outline"
                            className={cn(
                              "rounded-full px-2 py-0 text-[10px] font-medium",
                              comment.kind === "internal"
                                ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200"
                                : "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-200",
                            )}
                          >
                            {composerModeConfig[comment.kind].label}
                          </Badge>
                        )}
                      </div>
                      <p
                        className={cn(
                          "mt-1 whitespace-pre-wrap text-sm leading-6 text-foreground",
                          comment.kind === "internal" &&
                            "rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2",
                          comment.kind === "sms" &&
                            "rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2",
                        )}
                      >
                        {comment.body}
                      </p>
                    </div>
                  </article>
                ))}
              </div>
            </div>

            <footer className="border-t border-border/60 bg-background px-4 py-3 sm:px-7 sm:py-4">
              <div className="mx-auto max-w-4xl overflow-hidden rounded-xl border border-border bg-background shadow-sm transition-shadow focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15">
                {composerMode !== "reply" && (
                  <div
                    className={cn(
                      "flex items-center justify-between gap-3 border-b px-3 py-2",
                      composerMode === "internal"
                        ? "border-amber-500/20 bg-amber-500/5"
                        : "border-blue-500/20 bg-blue-500/5",
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {composerMode === "internal" ? (
                        <LockKey className="h-4 w-4 shrink-0 text-amber-600" />
                      ) : (
                        <ChatCircleText className="h-4 w-4 shrink-0 text-blue-600" />
                      )}
                      <div className="min-w-0">
                        <p className="text-xs font-semibold">{activeComposer.label}</p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {composerMode === "internal"
                            ? "Only visible to your team"
                            : "Delivered to the customer by SMS"}
                        </p>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Return to reply"
                      onClick={() => setComposerMode("reply")}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
                <Textarea
                  ref={textareaRef}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      sendMessage()
                    }
                  }}
                  placeholder={activeComposer.placeholder}
                  aria-label={activeComposer.textareaLabel}
                  className="min-h-20 resize-none rounded-none border-0 px-4 py-3 shadow-none focus-visible:ring-0"
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  aria-label="Choose files to attach"
                  onChange={(event) => {
                    addFiles(event.currentTarget.files, filePickerTargetRef.current)
                    event.currentTarget.value = ""
                  }}
                />
                {attachments.length > 0 && (
                  <div className="flex flex-wrap gap-2 border-t border-border/60 px-3 py-2">
                    {attachments.map((attachment) => (
                      <span
                        key={attachment.id}
                        className="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs"
                      >
                        <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="max-w-44 truncate">{attachment.name}</span>
                        <span className="text-muted-foreground">{formatFileSize(attachment.size)}</span>
                        <button
                          type="button"
                          aria-label={`Remove ${attachment.name}`}
                          className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                          onClick={() => removeAttachment(attachment)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex items-center justify-between gap-3 border-t border-border/60 px-2 py-2">
                  <div className="flex items-center gap-0.5">
                    <Popover open={addMenuOpen} onOpenChange={setAddMenuOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Add"
                          title="Add"
                          className="text-muted-foreground"
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        side="top"
                        align="start"
                        sideOffset={8}
                        className="!z-[100] w-56 p-1"
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-auto min-h-10 w-full justify-start px-2 py-2 text-left"
                          onClick={() => {
                            setComposerMode("internal")
                            setAddMenuOpen(false)
                            focusComposerAt(message.length)
                          }}
                        >
                          <LockKey className="h-4 w-4 shrink-0 text-amber-600" />
                          <span>
                            <span className="block">Internal note</span>
                            <span className="block text-xs font-normal text-muted-foreground">
                              Only visible to your team
                            </span>
                          </span>
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-auto min-h-10 w-full justify-start px-2 py-2 text-left"
                          onClick={() => {
                            setComposerMode("sms")
                            setAddMenuOpen(false)
                            focusComposerAt(message.length)
                          }}
                        >
                          <ChatCircleText className="h-4 w-4 shrink-0 text-blue-600" />
                          <span>
                            <span className="block">SMS</span>
                            <span className="block text-xs font-normal text-muted-foreground">
                              Send a message to the customer
                            </span>
                          </span>
                        </Button>
                      </PopoverContent>
                    </Popover>

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Bold"
                      title="Bold"
                      className="text-muted-foreground"
                      onClick={applyBoldFormatting}
                    >
                      <TextB className="h-4 w-4" />
                    </Button>

                    <Popover open={emojiMenuOpen} onOpenChange={setEmojiMenuOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Emoji"
                          title="Emoji"
                          className="text-muted-foreground"
                        >
                          <Smiley className="h-4 w-4" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        side="top"
                        align="start"
                        sideOffset={8}
                        className="!z-[100] w-auto p-2"
                      >
                        <div className="grid grid-cols-6 gap-1">
                          {quickEmojis.map((emoji) => (
                            <button
                              key={emoji}
                              type="button"
                              aria-label={`Insert ${emoji}`}
                              className="flex h-8 w-8 items-center justify-center rounded-md text-base hover:bg-accent"
                              onClick={() => {
                                insertAtSelection(`${emoji} `)
                                setEmojiMenuOpen(false)
                              }}
                            >
                              {emoji}
                            </button>
                          ))}
                        </div>
                      </PopoverContent>
                    </Popover>

                    <Popover open={mentionMenuOpen} onOpenChange={setMentionMenuOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Mention"
                          title="Mention"
                          className="text-muted-foreground"
                        >
                          <At className="h-4 w-4" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        side="top"
                        align="start"
                        sideOffset={8}
                        className="!z-[100] w-72 overflow-hidden p-0"
                      >
                        <Command>
                          <CommandInput placeholder="Mention a teammate…" />
                          <CommandList>
                            <CommandEmpty>No teammates found.</CommandEmpty>
                            <CommandGroup heading="People">
                              {assigneeOptions.map((option) => (
                                <CommandItem
                                  key={option.value}
                                  value={`${option.label} ${option.description ?? ""}`}
                                  onSelect={() => {
                                    insertAtSelection(`@${option.label} `)
                                    setMentionMenuOpen(false)
                                  }}
                                >
                                  <Avatar className="h-6 w-6 border border-border">
                                    <AvatarFallback className="text-[9px]">
                                      {option.initials ?? initials(option.label)}
                                    </AvatarFallback>
                                  </Avatar>
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate font-medium">{option.label}</span>
                                    {option.description && (
                                      <span className="block truncate text-xs text-muted-foreground">
                                        {option.description}
                                      </span>
                                    )}
                                  </span>
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Attach file"
                      title="Attach file"
                      className="text-muted-foreground"
                      onClick={() => openFilePicker("composer")}
                    >
                      <Paperclip className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="hidden text-[11px] text-muted-foreground sm:inline">
                      ⌘ Enter to {composerMode === "internal" ? "add" : "send"}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      disabled={!message.trim() && attachments.length === 0}
                      onClick={sendMessage}
                    >
                      <PaperPlaneTilt className="h-4 w-4" weight="fill" />
                      {activeComposer.actionLabel}
                    </Button>
                  </div>
                </div>
              </div>
            </footer>
          </section>

          <aside className="flex min-h-0 h-[45%] w-full shrink-0 flex-col border-t border-border/60 bg-muted/20 lg:h-auto lg:w-[34%] lg:min-w-[440px] lg:border-l lg:border-t-0 xl:min-w-[500px]">
            <Tabs
              value={selectedTab}
              onValueChange={setSelectedTab}
              className="flex min-h-0 flex-1 flex-col gap-0"
            >
              <div className="flex min-h-[76px] items-end justify-between border-b border-border/60 px-4 sm:px-5">
                <TabsList className="h-auto justify-start gap-4 rounded-none bg-transparent p-0">
                  <TabsTrigger
                    value="details"
                    className="rounded-none border-b-2 border-transparent px-0 pb-4 pt-5 text-sm shadow-none data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  >
                    Details
                  </TabsTrigger>
                  <TabsTrigger
                    value="activities"
                    className="rounded-none border-b-2 border-transparent px-0 pb-4 pt-5 text-sm shadow-none data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  >
                    Activities
                  </TabsTrigger>
                  <TabsTrigger
                    value="attachments"
                    className="gap-1.5 rounded-none border-b-2 border-transparent px-0 pb-4 pt-5 text-sm shadow-none data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  >
                    Attachments
                    {ticketAttachments.length > 0 && (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                        {ticketAttachments.length}
                      </span>
                    )}
                  </TabsTrigger>
                </TabsList>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={onClose}
                  aria-label="Close ticket details"
                  className="mb-3 shrink-0"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              <TabsContent value="details" className="m-0 min-h-0 flex-1 overflow-y-auto p-5">
                <div className="space-y-6">
                  <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Ticket
                    </h3>
                    <div className="mt-3 divide-y divide-border/60 border-y border-border/60">
                      <EditableInformationRow
                        label="Status"
                        value={information.status}
                        options={withCurrentOption(statusOptions, information.status)}
                        onValueChange={(value) => updateInformation("status", "Status", value)}
                        renderValue={() => (
                          <Badge
                            variant="outline"
                            className={cn("rounded-full text-[11px]", statusClasses(information.status))}
                          >
                            {information.status}
                          </Badge>
                        )}
                      />
                      <EditableInformationRow
                        label="Priority"
                        value={information.priority}
                        options={withCurrentOption(priorityOptions, information.priority)}
                        onValueChange={(value) => updateInformation("priority", "Priority", value)}
                        renderValue={() => (
                          <Badge
                            variant="outline"
                            className={cn("rounded-full text-[11px]", priorityClasses(information.priority))}
                          >
                            {information.priority}
                          </Badge>
                        )}
                      />
                      <EditableInformationRow
                        label="Type"
                        value={information.type}
                        options={withCurrentOption(typeOptions, information.type)}
                        onValueChange={(value) => updateInformation("type", "Type", value)}
                      />
                      <EditableInformationRow
                        label="Response target"
                        value={information.responseTarget}
                        options={withCurrentOption(responseTargetOptions, information.responseTarget)}
                        onValueChange={(value) =>
                          updateInformation("responseTarget", "Response target", value)
                        }
                      />
                    </div>
                  </section>

                  <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Assignment
                    </h3>
                    <div className="mt-3 divide-y divide-border/60 border-y border-border/60">
                      <EditableInformationRow
                        label="Assignee"
                        value={information.assignee}
                        options={assigneeOptions}
                        onValueChange={(value) => updateInformation("assignee", "Assignee", value)}
                        renderValue={() => (
                          <span className="flex min-w-0 items-center justify-end gap-2">
                            <Avatar className="h-5 w-5 border border-border">
                              <AvatarFallback className="text-[9px]">
                                {initials(information.assignee)}
                              </AvatarFallback>
                            </Avatar>
                            <span className="truncate">{information.assignee}</span>
                          </span>
                        )}
                      />
                      <EditableInformationRow
                        label="Team"
                        value={information.team}
                        options={withCurrentOption(teamOptions, information.team)}
                        onValueChange={(value) => updateInformation("team", "Team", value)}
                      />
                      <EditableInformationRow
                        label="Source"
                        value={information.source}
                        options={withCurrentOption(sourceOptions, information.source)}
                        onValueChange={(value) => updateInformation("source", "Source", value)}
                      />
                    </div>
                  </section>

                  <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Customer and service
                    </h3>
                    <div className="mt-3 divide-y divide-border/60 border-y border-border/60">
                      <EditableInformationRow
                        label="Context"
                        value={information.context}
                        options={withCurrentOption(contextOptions, information.context)}
                        onValueChange={(value) => updateInformation("context", "Context", value)}
                      />
                      <InformationRow
                        label="Last updated"
                        value={informationActivities.length > 0 ? "Now" : record.updated}
                      />
                    </div>
                  </section>
                </div>
              </TabsContent>

              <TabsContent value="activities" className="m-0 min-h-0 flex-1 overflow-y-auto p-5">
                <div className="space-y-1">
                  {activities.map((activity, index) => (
                    <div key={activity.id} className="relative flex gap-3 pb-5">
                      {index < activities.length - 1 && (
                        <span className="absolute bottom-0 left-[15px] top-8 w-px bg-border" />
                      )}
                      <span
                        className={cn(
                          "relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-background",
                          activity.tone === "success" &&
                            "border-emerald-500/30 bg-emerald-500/10 text-emerald-600",
                        )}
                      >
                        {activity.tone === "success" ? (
                          <CheckCircle className="h-4 w-4" weight="fill" />
                        ) : (
                          <ClockCounterClockwise className="h-4 w-4" />
                        )}
                      </span>
                      <div className="min-w-0 pt-0.5">
                        <p className="text-sm font-medium">{activity.title}</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          {activity.detail}
                        </p>
                        <p className="mt-1.5 text-[11px] text-muted-foreground">
                          {activity.actor} · {activity.at}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="attachments" className="m-0 min-h-0 flex-1 overflow-y-auto p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold">Attachments</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Files shared on this ticket
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => openFilePicker("library")}
                  >
                    <Plus className="h-4 w-4" />
                    Upload
                  </Button>
                </div>

                {ticketAttachments.length === 0 ? (
                  <div className="mt-8 flex flex-col items-center rounded-xl border border-dashed border-border px-5 py-10 text-center">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <Paperclip className="h-5 w-5" />
                    </span>
                    <p className="mt-3 text-sm font-medium">No attachments yet</p>
                    <p className="mt-1 max-w-56 text-xs leading-5 text-muted-foreground">
                      Upload a file here or attach one from the ticket composer.
                    </p>
                  </div>
                ) : (
                  <div className="mt-5 divide-y divide-border/60 border-y border-border/60">
                    {ticketAttachments.map((attachment) => (
                      <div key={attachment.id} className="flex items-center gap-3 py-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground">
                          <File className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium" title={attachment.name}>
                            {attachment.name}
                          </p>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {formatFileSize(attachment.size)} · {attachment.uploadedBy} · {attachment.uploadedAt}
                          </p>
                        </div>
                        <Button asChild variant="ghost" size="icon-sm">
                          <a
                            href={attachment.url}
                            download={attachment.name}
                            aria-label={`Download ${attachment.name}`}
                            title={`Download ${attachment.name}`}
                          >
                            <DownloadSimple className="h-4 w-4" />
                          </a>
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function EditableInformationRow({
  label,
  value,
  options,
  onValueChange,
  renderValue,
}: {
  label: string
  value: string
  options: TicketInformationOption[]
  onValueChange: (value: string) => void
  renderValue?: () => React.ReactNode
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="group grid grid-cols-[120px_minmax(0,1fr)] items-center gap-3 py-1.5 text-sm">
      <span className="pl-0.5 text-muted-foreground">{label}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Change ${label}`}
            className="flex min-h-8 min-w-0 items-center justify-end gap-1.5 rounded-md px-2 py-1.5 text-right font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/30 data-[state=open]:bg-accent"
          >
            <span className="min-w-0 flex-1 truncate">{renderValue?.() ?? value}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={6}
          className="!z-[100] w-[min(320px,calc(100vw-2rem))] overflow-hidden p-0"
        >
          <Command>
            <CommandInput placeholder={`Search ${label.toLowerCase()}…`} />
            <CommandList>
              <CommandEmpty>No matching options.</CommandEmpty>
              <CommandGroup heading={label}>
                {options.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={`${option.label} ${option.description ?? ""}`}
                    onSelect={() => {
                      onValueChange(option.value)
                      setOpen(false)
                    }}
                    className="min-h-10"
                  >
                    {option.initials ? (
                      <Avatar className="h-6 w-6 border border-border">
                        <AvatarFallback className="text-[9px]">{option.initials}</AvatarFallback>
                      </Avatar>
                    ) : option.dotClassName ? (
                      <span className={cn("h-2.5 w-2.5 rounded-full", option.dotClassName)} />
                    ) : null}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{option.label}</span>
                      {option.description && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      )}
                    </span>
                    <Check
                      className={cn(
                        "ml-auto h-4 w-4",
                        option.value === value ? "opacity-100" : "opacity-0",
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}

function InformationRow({
  label,
  value,
  children,
}: {
  label: string
  value?: string
  children?: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-4 py-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0 text-right font-medium text-foreground">
        {children ?? value}
      </div>
    </div>
  )
}

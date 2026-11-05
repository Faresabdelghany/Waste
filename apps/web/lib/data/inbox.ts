// The Service Inbox's items: fixtures of the prototype. The API has no
// notification feed yet, so on the Pilot nothing reads them (the top bar's
// bell says it has none).
export type InboxItemType = "comment" | "task" | "client" | "project" | "system"

export type InboxItem = {
  id: string
  title: string
  preview: string
  createdAt: Date
  type: InboxItemType
  unread: boolean
  client?: string
  project?: string
}

export const INBOX_FIXTURE_ITEMS: InboxItem[] = [
  {
    id: "1",
    title: "Blocked access reported at stop 18",
    preview:
      "The driver could not access the organic-waste containers at Parkvej 18.\n\nEvidence\n- Gate was locked at 08:42.\n- Driver attached one photo and a location stamp.\n- The stop was marked failed with reason: blocked access.\n\nSuggested next steps\n- Contact the property manager.\n- Approve a recollection for the afternoon recovery route.",
    createdAt: new Date(Date.now() - 1000 * 60 * 10),
    type: "comment",
    unread: true,
    client: "Østerbro Housing",
    project: "RC-1048 · Østerbro Organic",
  },
  {
    id: "2",
    title: "You were assigned a new ticket",
    preview:
      "A service ticket has been assigned to you for a reported container overflow.\n\nScope\n- Review the customer photo and service history.\n- Confirm whether the scheduled collection was completed.\n- Decide between a recollection or a container-capacity adjustment.\n\nResponse target\n- First customer update is due within two hours.",
    createdAt: new Date(Date.now() - 1000 * 60 * 45),
    type: "task",
    unread: true,
    client: "Amager District",
    project: "RC-1051 · Amager Glass",
  },
  {
    id: "3",
    title: "Customer agreement moved to Active",
    preview:
      "The Copenhagen Central service agreement is now active.\n\nWhat this enables\n- Covered properties can be added to published route schemes.\n- Included waste fractions and service frequencies are billable.\n- Exceptions can now be tracked against the agreement SLA.",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 3),
    type: "client",
    unread: false,
    client: "Copenhagen Central",
  },
  {
    id: "4",
    title: "Route completed with all proof captured",
    preview:
      "RC-1044 has been completed and closed.\n\nCompletion summary\n- 42 of 42 planned stops were serviced.\n- Disposal weight was recorded at the transfer station.\n- Required proof was captured for every exception.\n\nThe route is ready for billing review.",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 6),
    type: "project",
    unread: false,
    project: "RC-1044 · Nørrebro Mixed",
  },
  {
    id: "5",
    title: "Daily operations summary is ready",
    preview:
      "Your Copenhagen operations summary is ready.\n\nRoutes\n- 4 routes are currently in progress.\n- 1 route is delayed by more than 20 minutes.\n- 87% of planned stops are complete.\n\nExceptions\n- 3 failed stops require review.\n- 1 recollection needs approval.\n\nSuggested focus\n- Resolve blocked-access tickets before the afternoon dispatch.",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24),
    type: "system",
    unread: true,
  },
  {
    id: "6",
    title: "New contract route is ready for planning",
    preview:
      "Harbor Commercial Cardboard has been created from a draft customer agreement.\n\nPlanning checklist\n- Confirm service points and access instructions.\n- Allocate containers from warehouse stock.\n- Assign a suitable vehicle and driver.\n- Publish the first collection date after commercial approval.",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 30),
    type: "project",
    unread: true,
    client: "Harbor Offices ApS",
    project: "Harbor Commercial Cardboard",
  },
  {
    id: "7",
    title: "Vehicle capacity warning on Amager route",
    preview:
      "The estimated glass volume is above the assigned vehicle's safe capacity.\n\nBefore dispatch\n- Review historical weights for the route.\n- Reassign a larger vehicle or add an unloading trip.\n- Confirm that the receiving facility remains within its opening window.",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 40),
    type: "task",
    unread: false,
    client: "Amager District",
    project: "RC-1051 · Amager Glass",
  },
  {
    id: "8",
    title: "New property contact added",
    preview:
      "Mikkel Sørensen has been added as the service contact for Parkvej 18.\n\nContact scope\n- Access-window coordination.\n- Locked-gate and container-location issues.\n- Approval of urgent recollections.\n\nThe contact is now available from the customer and property views.",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 60),
    type: "client",
    unread: false,
    client: "Østerbro Housing",
    project: "RC-1048 · Østerbro Organic",
  },
]

export function inboxTypeLabel(type: InboxItemType): string {
  if (type === "comment") return "Comment"
  if (type === "task") return "Ticket"
  if (type === "client") return "Customer"
  if (type === "project") return "Route"
  return "Update"
}

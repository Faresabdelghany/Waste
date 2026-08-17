import { projects } from "@/lib/data/projects"

export type ClientStatus = "prospect" | "active" | "on_hold" | "completed" | "archived"

export type Client = {
  id: string
  name: string
  status: ClientStatus
  industry?: string
  website?: string
  location?: string
  primaryContactName?: string
  primaryContactEmail?: string
  notes?: string
  segment?: string
  lastActivityLabel?: string
}

export const clients: Client[] = [
  {
    id: "copenhagen-central",
    name: "Copenhagen Central",
    status: "active",
    industry: "Municipality",
    website: "https://www.kk.dk",
    location: "Indre By, Copenhagen",
    primaryContactName: "Anna Nielsen",
    primaryContactEmail: "anna.nielsen@example.dk",
    notes: "Municipal collection agreement covering residual waste, route schemes, service exceptions, and documented recollections.",
    segment: "Municipal",
    lastActivityLabel: "10 min ago",
  },
  {
    id: "osterbro-housing",
    name: "Østerbro Housing",
    status: "active",
    industry: "Housing association",
    location: "Østerbro, Copenhagen",
    primaryContactName: "Mikkel Sørensen",
    primaryContactEmail: "mikkel.sorensen@example.dk",
    notes: "Multi-property organic-waste agreement with access windows and locked-yard service requirements.",
    segment: "Enterprise",
    lastActivityLabel: "45 min ago",
  },
  {
    id: "vesterbro-retail",
    name: "Vesterbro Retail Group",
    status: "active",
    industry: "Retail",
    location: "Vesterbro, Copenhagen",
    primaryContactName: "Sofie Madsen",
    primaryContactEmail: "sofie.madsen@example.dk",
    segment: "Commercial",
    lastActivityLabel: "3 hours ago",
  },
  {
    id: "amager-district",
    name: "Amager District",
    status: "active",
    industry: "Municipality",
    location: "Amager, Copenhagen",
    primaryContactName: "Emil Hansen",
    primaryContactEmail: "emil.hansen@example.dk",
    segment: "Municipal",
    lastActivityLabel: "Today",
  },
  {
    id: "norrebro-district",
    name: "Nørrebro District",
    status: "active",
    industry: "Municipality",
    location: "Nørrebro, Copenhagen",
    primaryContactName: "Freja Pedersen",
    primaryContactEmail: "freja.pedersen@example.dk",
    segment: "Municipal",
    lastActivityLabel: "Yesterday",
  },
  {
    id: "harbor-offices",
    name: "Harbor Offices ApS",
    status: "prospect",
    industry: "Commercial property",
    location: "Nordhavn, Copenhagen",
    primaryContactName: "Jonas Kristensen",
    primaryContactEmail: "jonas.kristensen@example.dk",
    notes: "Cardboard collection proposal awaiting capacity confirmation and agreement activation.",
    segment: "Commercial",
    lastActivityLabel: "2 days ago",
  },
  {
    id: "frederiksberg",
    name: "Frederiksberg Municipality",
    status: "active",
    industry: "Municipality",
    location: "Frederiksberg",
    primaryContactName: "Katrine Holm",
    primaryContactEmail: "katrine.holm@example.dk",
    segment: "Pilot",
    lastActivityLabel: "4 hours ago",
  },
  {
    id: "islands-brygge",
    name: "Islands Brygge Housing",
    status: "active",
    industry: "Housing association",
    location: "Islands Brygge, Copenhagen",
    primaryContactName: "Lucas Andersen",
    primaryContactEmail: "lucas.andersen@example.dk",
    segment: "Enterprise",
    lastActivityLabel: "5 days ago",
  },
  {
    id: "city-food-market",
    name: "City Food Market",
    status: "prospect",
    industry: "Food service",
    location: "Kødbyen, Copenhagen",
    primaryContactName: "Clara Jensen",
    primaryContactEmail: "clara.jensen@example.dk",
    segment: "Commercial",
    lastActivityLabel: "Yesterday",
  },
  {
    id: "metro-schools",
    name: "Metro Schools",
    status: "on_hold",
    industry: "Education",
    location: "Copenhagen",
    primaryContactName: "Noah Lund",
    primaryContactEmail: "noah.lund@example.dk",
    segment: "Public sector",
    lastActivityLabel: "3 weeks ago",
  },
  {
    id: "green-courtyard",
    name: "Green Courtyard Owners",
    status: "active",
    industry: "Property association",
    location: "Valby, Copenhagen",
    primaryContactName: "Ida Thomsen",
    primaryContactEmail: "ida.thomsen@example.dk",
    segment: "SMB",
    lastActivityLabel: "1 week ago",
  },
  {
    id: "old-town-hotel",
    name: "Old Town Hotel",
    status: "archived",
    industry: "Hospitality",
    location: "Indre By, Copenhagen",
    primaryContactName: "Oscar Møller",
    primaryContactEmail: "oscar.moeller@example.dk",
    segment: "Commercial",
    lastActivityLabel: "8 months ago",
  },
]

export function getClientById(id: string): Client | undefined {
  return clients.find((client) => client.id === id)
}

export function getProjectCountForClient(clientName: string): number {
  return projects.filter((project) => project.client === clientName).length
}

export function getClientByName(name: string): Client | undefined {
  const normalized = name.trim().toLowerCase()
  return clients.find((client) => client.name.trim().toLowerCase() === normalized)
}

export function upsertClient(input: Client): Client {
  const existingIndex = clients.findIndex((client) => client.id === input.id)
  if (existingIndex >= 0) {
    clients[existingIndex] = { ...clients[existingIndex], ...input }
    return clients[existingIndex]
  }

  clients.push(input)
  return input
}

// The columns of each kind of import (#291 slice 12): the header a file
// names a column by, whether a row must give it, what it holds and an
// example — the one spelling the API's template, its reading of a row and
// the web's column guide all read. A file's header is matched to these by
// `headerKey`: case, spacing, hyphens and underscores do not matter, so
// "Registration number", "registration_number" and "REGISTRATION-NUMBER"
// are one column, and a column the kind does not know is refused by name.
//
// A row names another record by the key a person knows it by, never by an
// id: a customer by its registration number (a CVR number) or its e-mail, a
// property by its address in the import's project, a container type by its
// name, a product by its name, a price list by its code (case aside), a
// shared collection point by its name. The catalogue (O30 of #290, row 1.18)
// is matched the same way: a waste fraction and a vehicle type by their key,
// the slug the rest of the system quotes, and a container type by its name;
// and the fleet: a vehicle by its registration, the company's, and a driver
// by the workforce reference, the company's where given, which the import
// therefore asks of every row. A depot is named by its name in the import's
// project, a service provider by its registration number in the company.
// An empty cell leaves a field as it stands
// when a row matches a record, and is no value when it makes one.

import type { ImportKind } from "./vocabulary"

/** One column of a kind's file. */
export type ImportColumn = {
  /** The header the template writes and a file names the column by. */
  header: string
  /** Whether every row must give it. */
  required: boolean
  /** What the column holds, for the column guide. */
  description: string
  /** A value it might hold. */
  example: string
}

const column = (header: string, required: boolean, description: string, example: string): ImportColumn => ({ header, required, description, example })

/** The columns of each kind, in the template's order. */
export const IMPORT_COLUMNS: Readonly<Record<ImportKind, readonly ImportColumn[]>> = {
  customers: [
    column("kind", true, "person or organisation", "organisation"),
    column("name", true, "A person's name or an organisation's", "Østerbro Housing Association"),
    column("registration number", false, "The CVR number, unique in the company; a customer is matched on it, else on the e-mail", "12345678"),
    column("email", false, "The e-mail; a customer with no registration number is matched on it", "admin@osterbro-housing.example"),
    column("phone", false, "A phone number", "+45 33 12 34 56"),
    column("billing address", false, "Where the invoice goes, when not the service address", "Box 12, 2100 København Ø"),
    column("service messages", false, "yes or no: whether the customer may be written to about their service; yes when empty", "yes"),
    column("status", false, "active or inactive; active when empty", "active"),
  ],
  properties: [
    column("address", true, "The service address; a property is matched on it in the import's project", "Parkvej 18, 2100 København Ø"),
    column("name", true, "The display name, unique in the project", "Parkvej 18"),
    column("kind", true, "residential, commercial, public, mixed or other", "residential"),
    column("registry id", false, "The property registry's identifier, a BFE number in Denmark", "100023456"),
    column("notes", false, "Notes for the office", "Gate code 1234"),
    column("status", false, "active or inactive; active when empty", "active"),
    column("parties", false, "Who the property's customers are, as role: customer, separated by semicolons; a customer by its registration number or e-mail. Replaces the property's parties when given", "owner: 12345678; payer: admin@osterbro-housing.example"),
  ],
  containers: [
    column("label", true, "The container's label, unique in the company; a container is matched on it", "BIN-1042"),
    column("container type", true, "The name of one of the company's container types", "240 L bin"),
    column("barcode", false, "A barcode", "5701234567890"),
    column("rfid", false, "An RFID tag", "E2003412012345678"),
    column("serial number", false, "The manufacturer's serial number", "SN-88123"),
    column("ownership", false, "company, customer or unrecorded; company when empty", "company"),
    column("notes", false, "Notes for the office", "Lid replaced 2026"),
  ],
  agreements: [
    column("number", true, "The agreement's number; an agreement is matched on it and its first day in the import's project", "AGR-2408"),
    column("customer", true, "The customer, by registration number or e-mail", "12345678"),
    column("payer", false, "Who is invoiced, by registration number or e-mail; the customer when empty", "admin@osterbro-housing.example"),
    column("billing cadence", true, "monthly, quarterly, annual or manual", "monthly"),
    column("valid from", true, "The agreement's first day, YYYY-MM-DD", "2026-01-01"),
    column("valid to", false, "The first day it is no longer in force, YYYY-MM-DD; open when empty", ""),
    column("status", false, "draft, active or cancelled; draft when empty", "active"),
    column("currency", false, "ISO 4217; the project's when empty", "DKK"),
    column("price list", false, "The code of one of the project's price lists in the agreement's currency; the project's default when empty", "cph-2026"),
    column("notes", false, "Notes for the office", ""),
    column("product", false, "A subscription's product, by name; a row without one writes the agreement alone", "Residual collection 240 L"),
    column("property", false, "The subscription's place, a property's address in the project", "Parkvej 18, 2100 København Ø"),
    column("shared collection point", false, "Or its place, a shared collection point's name", ""),
    column("quantity", false, "How many of the product; 1 when empty", "1"),
    column("subscription from", false, "The subscription's first day; the agreement's when empty. A subscription is matched on its product, its place and this day", "2026-01-01"),
    column("subscription to", false, "The first day it is no longer in force; open when empty", ""),
  ],
  "waste-fractions": [
    column("key", true, "The stable slug the rest of the system quotes, lowercase; a fraction is matched on it", "hard-plastic"),
    column("name", true, "What a person reads, unique in the company", "Hard plastic"),
    column("waste code", false, "The European List of Waste entry, six digits, with an asterisk after a hazardous one", "200139"),
    column("treatment", false, "reuse, recycling, energy-recovery or disposal", "recycling"),
    column("density", false, "Kilograms per cubic metre as it lies in a container, 1 to 2000", "45"),
  ],
  "container-types": [
    column("name", true, "The type's name, unique in the company; a container type is matched on it", "240 L bin"),
    column("volume", false, "Litres, a whole number", "240"),
    column("service seconds", false, "How long a stop at one takes, in seconds", "30"),
  ],
  "vehicle-types": [
    column("key", true, "The stable slug the rest of the system quotes, lowercase; a vehicle type is matched on it", "rear-loader"),
    column("name", true, "What a person reads, unique in the company", "Rear loader"),
    column("description", false, "What the type is", "Two-axle rear loader with a bin lift"),
    column("container types", false, "The container types a vehicle of the type services, by name, separated by semicolons. Replaces the type's set when given", "240 L bin; 660 L bin"),
  ],
  vehicles: [
    column("registration", true, "The plate, unique in the company; a vehicle is matched on it", "CN 42 018"),
    column("kind", true, "powered-vehicle or trailer; set once", "powered-vehicle"),
    column("vehicle type", true, "The key of one of the company's vehicle types", "rear-loader"),
    column("licence class", true, "The licence a driver needs to take it out: b, c or ce", "c"),
    column("compartments", false, "Its compartments in position order, separated by semicolons, each its waste fractions by key separated by commas, a name before a colon where it has one. A powered vehicle has at least one. Replaces its compartments when given", "Left: residual; Right: paper, cardboard"),
    column("callsign", false, "What the yard calls it, unique in the company", "WH-24"),
    column("ownership", false, "company, service-provider or leased; company when empty, service-provider with a service provider", "company"),
    column("service provider", false, "The registration number of the service provider that owns it, with service-provider ownership", ""),
    column("status", false, "active, unavailable, maintenance or retired; active when empty", "active"),
    column("capacity kg", false, "Its payload in kilograms", "11000"),
    column("fuel", false, "diesel, hvo, biogas, electric, hybrid or other", "hvo"),
    column("home depot", false, "The name of the project's depot it is based at", "Nordhavn depot"),
    column("notes", false, "Notes for the office", ""),
  ],
  drivers: [
    column("workforce reference", true, "The payroll or workforce system's reference, unique in the company; a driver is matched on it", "EMP-1042"),
    column("name", true, "The driver's name", "Mads Jensen"),
    column("employment", true, "employee, service-provider or temporary", "employee"),
    column("service provider", false, "The registration number of the service provider that employs them, with service-provider employment", ""),
    column("licence class", false, "b, c or ce", "c"),
    column("licence number", false, "The driving licence's number", "DK-12345678"),
    column("licence expiry", false, "The last day the licence is valid, YYYY-MM-DD", "2029-06-30"),
    column("home depot", false, "The name of the project's depot they start from", "Nordhavn depot"),
    column("status", false, "active, inactive or suspended; active when empty", "active"),
    column("notes", false, "Notes for the office", ""),
  ],
}

/** A header as it is compared: lowercase, its words single-spaced, a hyphen or an underscore a space. */
export function headerKey(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
}

/** The column a file's header names, or undefined for one the kind does not know. */
export function columnOf(kind: ImportKind, header: string): ImportColumn | undefined {
  const key = headerKey(header)
  return IMPORT_COLUMNS[kind].find((candidate) => headerKey(candidate.header) === key)
}

/** What a file's header row says about its columns: the headers the kind does not know, and the required ones it lacks. */
export function headerIssues(kind: ImportKind, headers: readonly string[]): { unknown: string[]; missing: string[]; repeated: string[] } {
  const keys = headers.map(headerKey)
  const unknown = headers.filter((header) => header.trim() !== "" && columnOf(kind, header) === undefined)
  const missing = IMPORT_COLUMNS[kind].filter((candidate) => candidate.required && !keys.includes(headerKey(candidate.header))).map((candidate) => candidate.header)
  const repeated = [...new Set(keys.filter((key, index) => key !== "" && keys.indexOf(key) !== index))]
  return { unknown, missing, repeated }
}

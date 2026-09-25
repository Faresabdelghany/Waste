// The one way the web reaches `apps/api` (Issue #81; ADR-0001: the API is the
// single data path). A client is a base URL and a token, and it speaks the
// API's conventions once so no module spells them again:
//
//   the token     — `Authorization: Bearer <token>`, a Supabase access token
//                   (apps/api/src/auth/verify.ts); credentials never travel,
//                   which is why the API's CORS runs with credentials off;
//   a list        — `Page(item)`: `{ items, nextCursor }`, and `listAll` walks
//                   the cursor until `nextCursor` is null, since the store
//                   holds a module's records whole and the prototype filters
//                   in the browser; the page size is the API's maximum;
//   a refusal     — every non-2xx body is an RFC 9457 problem (problem.ts),
//                   thrown as `ApiProblem` so a caller reads one shape whether
//                   the validator, a grant, a duplicate or the network said no;
//   a create      — answers 201 with the body and `Location`, the path of the
//                   row's own GET (Issue #74), which the browser may read only
//                   because the API's CORS exposes the header; `created` hands
//                   both back and the caller takes the id from the body, the
//                   `Location` being the address a client stores or follows;
//   the network   — a failed fetch (no connection, a refused port, the API not
//                   started) is a problem too: status 0 is not an HTTP status,
//                   so nothing upstream can mistake it for the API's answer.
//
// The functions take `fetch` from the environment (a test hands its own), and
// nothing here knows a resource: the modules under lib/api/records map the
// contracts' resources onto the prototype's records, and this only carries
// them.
import { ApiProblem, genericProblem, problemOf, type Problem } from "./problem"

export type ApiClient = {
  /** The API's origin, no trailing slash (`http://127.0.0.1:3001`). */
  baseUrl: string
  /** The Supabase access token the requests carry. */
  token: string
  fetch?: typeof fetch
}

export type Page<Item> = { items: Item[]; nextCursor: string | null }

/** What `POST` answers: the body, and where the row is now read (`Location`, root-relative; null when the API did not say). */
export type Created<Body> = { body: Body; location: string | null }

/** The API's page-size ceiling (`@waste/contracts/pagination`, PAGE_LIMIT_MAX). */
export const PAGE_LIMIT_MAX = 200

/** The status a request that never reached the API is reported under; not an HTTP status on purpose. */
export const UNREACHABLE_STATUS = 0

type Query = Readonly<Record<string, string | number | undefined>>

/** `/projects?limit=200&cursor=…`: undefined members are left out, nothing else is coerced. */
export function withQuery(path: string, query: Query = {}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const encoded = params.toString()
  return encoded === "" ? path : `${path}?${encoded}`
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text === "") return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/** The problem a refused response stands for: its body when it is one, else its status alone. */
export async function problemOfResponse(response: Response): Promise<Problem> {
  const body = await readBody(response)
  return problemOf(body) ?? genericProblem(response.status, typeof body === "string" && body !== "" ? body : undefined)
}

async function request(client: ApiClient, method: string, path: string, body?: unknown): Promise<Response> {
  const doFetch = client.fetch ?? fetch
  let response: Response
  try {
    response = await doFetch(`${client.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${client.token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (cause) {
    throw new ApiProblem(
      genericProblem(UNREACHABLE_STATUS, `The API at ${client.baseUrl} did not answer${cause instanceof Error && cause.message ? ` (${cause.message})` : ""}`),
    )
  }
  if (!response.ok) throw new ApiProblem(await problemOfResponse(response))
  return response
}

/** `GET path`, the body parsed. */
export async function get<Body>(client: ApiClient, path: string): Promise<Body> {
  const response = await request(client, "GET", path)
  return (await readBody(response)) as Body
}

/** One page of a list. */
export async function listPage<Item>(client: ApiClient, path: string, query: Query = {}): Promise<Page<Item>> {
  return get<Page<Item>>(client, withQuery(path, { limit: PAGE_LIMIT_MAX, ...query }))
}

/**
 * Every item of a list, page after page. The store holds a module's records
 * whole and filters, sorts and counts them in the browser as the prototype
 * always has; a module too large for that is a module that needs a
 * server-side list, and that is the point at which this stops being the
 * right read.
 */
export async function listAll<Item>(client: ApiClient, path: string, query: Query = {}): Promise<Item[]> {
  const items: Item[] = []
  let cursor: string | undefined
  do {
    const page = await listPage<Item>(client, path, { ...query, cursor })
    items.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  return items
}

/** `POST path` with a JSON body; answers the created body and its `Location`. */
export async function create<Body>(client: ApiClient, path: string, body: unknown): Promise<Created<Body>> {
  const response = await request(client, "POST", path, body)
  return { body: (await readBody(response)) as Body, location: response.headers.get("location") }
}

/** `PATCH path` with a JSON body; answers the row as it now stands. */
export async function patch<Body>(client: ApiClient, path: string, body: unknown): Promise<Body> {
  const response = await request(client, "PATCH", path, body)
  return (await readBody(response)) as Body
}

/** `PUT path` with a JSON body; answers what the route answers. */
export async function put<Body>(client: ApiClient, path: string, body: unknown): Promise<Body> {
  const response = await request(client, "PUT", path, body)
  return (await readBody(response)) as Body
}

/** `POST path` with no body: the API's commands (`/users/:id/deactivate`), which answer 200 and no `Location`. */
export async function command<Body>(client: ApiClient, path: string, body?: unknown): Promise<Body> {
  const response = await request(client, "POST", path, body)
  return (await readBody(response)) as Body
}

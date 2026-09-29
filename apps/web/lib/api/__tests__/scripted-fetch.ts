// A `fetch` that answers from a script and records what it was asked, for
// tests that drive the adapter through the real client (client.ts) and read
// the request the API would have seen.
import type { ApiClient } from "../client"
import { PROBLEM_MEDIA_TYPE } from "../problem"

export type Call = { url: string; init: RequestInit }

export function scripted(answers: Array<(call: Call) => Response | Promise<Response>>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(input), init }
    calls.push(call)
    const answer = answers.shift()
    if (!answer) throw new Error(`unexpected call to ${call.url}`)
    return answer(call)
  }) as typeof fetch
  return { fetch: fetchImpl, calls }
}

/** A JSON answer. */
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

/** An RFC 9457 problem, as apps/api answers one. */
export const problem = (status: number, detail: string, errors?: { path: string; message: string }[]) =>
  new Response(JSON.stringify({ type: "about:blank", title: "Refused", status, detail, ...(errors ? { errors } : {}) }), {
    status,
    headers: { "content-type": PROBLEM_MEDIA_TYPE },
  })

/** The body a scripted call was sent, parsed. */
export const bodyOf = (call: Call): unknown => (typeof call.init.body === "string" ? JSON.parse(call.init.body) : call.init.body)

export const clientOver = (fetchImpl: typeof fetch): ApiClient => ({ baseUrl: "http://api.test", token: "t0k3n", fetch: fetchImpl })

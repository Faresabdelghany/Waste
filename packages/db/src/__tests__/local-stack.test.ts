import assert from "node:assert/strict"
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { after, afterEach, describe, test } from "node:test"

import { DEFAULT_LOCAL_LOGIN_PASSWORD, E2E_TESTER_LOGIN, ensureLogins, parseExtraLogins, parseStatusEnv, planLocalLogins, type LocalLoginsPlan } from "../local-stack/logins"
import { ensureSigningKeys, generateSigningKey, renderSigningKeys } from "../local-stack/signing-keys"
import { startWithOneRetry, type SupabaseRunner } from "../local-stack/start"
import { DEMO_ACCOUNT_EMAILS } from "../seed/demo"
import { databaseVolume, minimumPasswordLength, postgresMajor, signingKeysPath, SUPABASE_CONFIG_FILE } from "../supabase-config"

describe("generateSigningKey", () => {
  test("is a private ES256 JWK in the shape GoTrue reads: kid, alg, use and key_ops beside the P-256 pair", () => {
    const key = generateSigningKey()
    assert.equal(key.kty, "EC")
    assert.equal(key.crv, "P-256")
    assert.equal(key.alg, "ES256")
    assert.equal(key.use, "sig")
    assert.deepEqual(key.key_ops, ["sign", "verify"])
    assert.match(key.kid, /^[0-9a-f-]{36}$/)
    for (const member of ["x", "y", "d"] as const) assert.equal(typeof key[member], "string")
  })

  test("signs and verifies: the private half signs, the public half read off the same JWK verifies", () => {
    const key = generateSigningKey()
    const message = new TextEncoder().encode("a token")
    const signature = new Uint8Array(sign("sha256", message, { key: createPrivateKey({ key, format: "jwk" }), dsaEncoding: "ieee-p1363" }))
    const { d: _private, ...publicJwk } = key
    assert.equal(verify("sha256", message, { key: createPublicKey({ key: publicJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, signature), true)
  })

  test("two keys differ", () => {
    assert.notEqual(generateSigningKey().d, generateSigningKey().d)
  })
})

describe("ensureSigningKeys", () => {
  const dirs: string[] = []
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), "waste-signing-keys-"))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test("writes one key as an array, owner-readable, creating the directory", () => {
    const path = join(scratch(), "supabase", "signing_keys.json")
    const outcome = ensureSigningKeys(path)
    assert.deepEqual(outcome, { path, written: true })
    assert.equal(existsSync(path), true)
    const keys = JSON.parse(readFileSync(path, "utf8")) as unknown
    assert.equal(Array.isArray(keys), true)
    assert.equal((keys as unknown[]).length, 1)
    assert.equal(statSync(path).mode & 0o777, 0o600)
  })

  test("leaves an existing file alone, whatever it holds", () => {
    const path = join(scratch(), "signing_keys.json")
    writeFileSync(path, "[]\n")
    assert.deepEqual(ensureSigningKeys(path), { path, written: false })
    assert.equal(readFileSync(path, "utf8"), "[]\n")
  })

  test("renders the set as JSON the CLI reads back", () => {
    const key = generateSigningKey()
    assert.deepEqual(JSON.parse(renderSigningKeys([key])), [key])
  })
})

const apiUrl = "http://127.0.0.1:54321"
const secretKey = "sb_secret_test"

describe("planLocalLogins", () => {
  test("every seeded address, the suite's tester and every extra one, lowercase, each once, the public default password", () => {
    const plan = planLocalLogins({ apiUrl: `${apiUrl}/`, secretKey, seeded: DEMO_ACCOUNT_EMAILS, extra: ["Tester@E2E.example", "tester@e2e.example", E2E_TESTER_LOGIN] })
    assert.deepEqual(plan, {
      apiUrl,
      secretKey,
      password: DEFAULT_LOCAL_LOGIN_PASSWORD,
      emails: [...DEMO_ACCOUNT_EMAILS, E2E_TESTER_LOGIN, "tester@e2e.example"],
    })
  })

  test("the tester is in the plan with nothing extra set, so a bare stack:start can run the suite", () => {
    assert.deepEqual(planLocalLogins({ apiUrl, secretKey, seeded: [] }).emails, [E2E_TESTER_LOGIN])
  })

  test("the seed's three accounts are the list the Pilot's Logins carry (#140)", () => {
    assert.deepEqual(DEMO_ACCOUNT_EMAILS, ["fares.abdelghany@kystbyen.example", "lars.mikkelsen@nordren.example", "mads.jensen@kystbyen.example"])
  })

  test("refuses a hosted API_URL, strictly: the Pilot's Logins are the owner's", () => {
    for (const hosted of ["https://ztmisreemxepvjxelbql.supabase.co", "http://127.0.0.1.nip.io:54321", "http://10.0.0.5:54321", "http://kong:8000"]) {
      assert.throws(() => planLocalLogins({ apiUrl: hosted, secretKey, seeded: DEMO_ACCOUNT_EMAILS }), /local stack.*owner's/)
    }
  })

  test("accepts loopback under any of its names", () => {
    for (const local of ["http://localhost:54321", "http://[::1]:54321", "https://127.0.0.1:54321"]) {
      assert.equal(planLocalLogins({ apiUrl: local, secretKey, seeded: [] }).apiUrl, local)
    }
  })

  test("refuses a URL that is not http(s), a missing URL and a missing secret key", () => {
    assert.throws(() => planLocalLogins({ apiUrl: "postgresql://127.0.0.1:54322/postgres", secretKey, seeded: [] }), /local stack/)
    assert.throws(() => planLocalLogins({ apiUrl: undefined, secretKey, seeded: [] }), /API_URL is not set/)
    assert.throws(() => planLocalLogins({ apiUrl: "not a url", secretKey, seeded: [] }), /not a URL/)
    assert.throws(() => planLocalLogins({ apiUrl, secretKey: undefined, seeded: [] }), /SECRET_KEY is not set/)
  })

  test("refuses a password shorter than local Auth's minimum", () => {
    assert.throws(() => planLocalLogins({ apiUrl, secretKey, password: "seven77", seeded: [] }), /7 characters.*at least 8/)
    assert.equal(planLocalLogins({ apiUrl, secretKey, password: "eight888", seeded: [] }).password, "eight888", "the config's bound, eight, as on the Pilot (#164)")
  })

  test("refuses an entry that is not an address", () => {
    assert.throws(() => planLocalLogins({ apiUrl, secretKey, seeded: [], extra: ["nobody"] }), /"nobody" is not an e-mail address/)
  })
})

describe("parseExtraLogins", () => {
  test("splits on commas and whitespace and drops empties", () => {
    assert.deepEqual(parseExtraLogins(" a@x.example, b@x.example\nc@x.example ,, "), ["a@x.example", "b@x.example", "c@x.example"])
    assert.deepEqual(parseExtraLogins(undefined), [])
    assert.deepEqual(parseExtraLogins(""), [])
  })
})

describe("ensureLogins", () => {
  const plan: LocalLoginsPlan = { apiUrl, secretKey, password: DEFAULT_LOCAL_LOGIN_PASSWORD, emails: ["one@x.example", "two@x.example", "three@x.example"] }

  type Call = { url: string; init: RequestInit }
  const scripted = (answers: Record<string, () => Response>) => {
    const calls: Call[] = []
    const doFetch: typeof fetch = async (input, init) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      const body = JSON.parse(String(init?.body)) as { email: string }
      return answers[body.email]()
    }
    return { calls, doFetch }
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

  test("creates each Login confirmed under the secret key and reports which existed already", async () => {
    const { calls, doFetch } = scripted({
      "one@x.example": () => json(200, { id: "1", email: "one@x.example" }),
      "two@x.example": () => json(422, { code: 422, error_code: "email_exists", msg: "A user with this email address has already been registered" }),
      "three@x.example": () => json(422, { code: 422, msg: "User already registered" }),
    })
    const report = await ensureLogins(plan, doFetch)
    assert.deepEqual(report, { created: ["one@x.example"], existing: ["two@x.example", "three@x.example"] })
    assert.equal(calls.length, 3)
    for (const { url, init } of calls) {
      assert.equal(url, `${apiUrl}/auth/v1/admin/users`)
      assert.equal(init.method, "POST")
      const headers = init.headers as Record<string, string>
      assert.equal(headers.apikey, secretKey)
      assert.equal(headers.authorization, `Bearer ${secretKey}`)
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      assert.equal(body.password, DEFAULT_LOCAL_LOGIN_PASSWORD)
      assert.equal(body.email_confirm, true)
    }
  })

  test("any other refusal stops the run with Auth's sentence", async () => {
    const { doFetch } = scripted({
      "one@x.example": () => json(401, { code: 401, msg: "Invalid API key" }),
    })
    await assert.rejects(ensureLogins({ ...plan, emails: ["one@x.example"] }, doFetch), /HTTP 401 — Invalid API key/)
  })
})

describe("parseStatusEnv", () => {
  test("reads NAME=\"value\" lines and skips everything else", () => {
    const output = ['Stopped services: [supabase_studio_waste]', 'API_URL="http://127.0.0.1:54321"', 'PUBLISHABLE_KEY="sb_publishable_abc"', "SECRET_KEY=sb_secret_def", "", "not a variable"].join("\n")
    assert.deepEqual(parseStatusEnv(output), { API_URL: "http://127.0.0.1:54321", PUBLISHABLE_KEY: "sb_publishable_abc", SECRET_KEY: "sb_secret_def" })
  })
})

describe("startWithOneRetry", () => {
  const scripted = (codes: number[]) => {
    const calls: string[] = []
    const run: SupabaseRunner = (args) => {
      calls.push(args.join(" "))
      return args[0] === "stop" ? 0 : (codes.shift() ?? 0)
    }
    return { calls, run }
  }
  const quiet = () => {}

  test("a start that succeeds runs once, and nothing else", () => {
    const { calls, run } = scripted([0])
    assert.equal(startWithOneRetry(run, ["db", "start"], { volumeExisted: false, log: quiet }), 0)
    assert.deepEqual(calls, ["db start"])
  })

  test("a failed start that created the volume drops it in the stop, so the retry sets the database up afresh", () => {
    const { calls, run } = scripted([1, 0])
    assert.equal(startWithOneRetry(run, ["start", "-x", "studio"], { volumeExisted: false, log: quiet }), 0)
    assert.deepEqual(calls, ["start -x studio", "stop --no-backup", "start -x studio"])
  })

  test("a volume there before the first attempt is kept by the stop", () => {
    const { calls, run } = scripted([1, 0])
    startWithOneRetry(run, ["db", "start"], { volumeExisted: true, log: quiet })
    assert.deepEqual(calls, ["db start", "stop", "db start"])
  })

  test("a second failure is the command's: its exit code, and no third start", () => {
    const { calls, run } = scripted([1, 3])
    assert.equal(startWithOneRetry(run, ["db", "start"], { volumeExisted: false, log: quiet }), 3)
    assert.equal(calls.filter((call) => call === "db start").length, 2)
  })
})

describe("supabase/config.toml's values", () => {
  const scratch = mkdtempSync(join(tmpdir(), "waste-supabase-config-"))
  after(() => rmSync(scratch, { recursive: true, force: true }))
  const written = (text: string) => {
    const file = join(scratch, "config.toml")
    writeFileSync(file, text)
    return file
  }

  test("reads project_id, [db] major_version, and [auth]'s signing key path, resolved beside the file, and shortest password", () => {
    const file = written(
      [
        "# a comment",
        'project_id = "harbour"',
        "[api]",
        'schemas = ["public", "graphql_public"]',
        "[db]",
        "port = 54322",
        "major_version = 18 # the hosted project's",
        "[auth]",
        'signing_keys_path = "./keys.json"',
        "minimum_password_length = 12",
        "[auth.hook.custom_access_token]",
        "enabled = true",
      ].join("\n"),
    )
    assert.deepEqual([databaseVolume(file), postgresMajor(file), signingKeysPath(file), minimumPasswordLength(file)], ["supabase_db_harbour", 18, join(scratch, "keys.json"), 12])
  })

  test("reads only the key asked for, and refuses one missing or not a whole number, naming it", () => {
    const file = written('[db]\nmajor_version = 17\n[auth]\nminimum_password_length = "eight"\n')
    assert.equal(postgresMajor(file), 17)
    assert.throws(() => minimumPasswordLength(file), /auth\.minimum_password_length is not a whole number/)
    assert.throws(() => signingKeysPath(file), /sets no auth\.signing_keys_path/)
  })

  test("the repository's own names the volume supabase_db_waste and keeps the signing key where .gitignore keeps it out of git", () => {
    const root = dirname(dirname(SUPABASE_CONFIG_FILE))
    assert.equal(databaseVolume(), "supabase_db_waste")
    assert.ok(readFileSync(join(root, ".gitignore"), "utf8").split("\n").includes(relative(root, signingKeysPath())))
  })
})

// Where the fixture streets are: the table lives in @waste/domain beside the
// generator of the seeded registry (issue #99), so the map here and
// `pnpm db:seed` place an address through one spelling; its header says what
// it mirrors and what it leaves out. Re-exported so the map's callers keep
// reading it from lib/data. lib/data/__tests__/street-gazetteer.test.ts holds
// it and the explicit fixture records together.
export { FIXTURE_GAZETTEER } from "@waste/domain/fixtures/gazetteer"

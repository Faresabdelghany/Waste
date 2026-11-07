// A closed list drawn from another: every value of its parent but the ones
// named out, or each value turned into another, in the parent's order, so a
// value the parent gains reaches the list unless it is named out. Typed as a
// non-empty tuple, which a database column (`text({ enum })`, its `oneOf`
// check) and a wire enum (`z.enum`) read alike.

/** Every value of `list` but `out`, in `list`'s order. */
export function without<const List extends readonly [string, ...string[]], const Out extends List[number] = never>(list: List, ...out: readonly Out[]): readonly [Exclude<List[number], Out>, ...Exclude<List[number], Out>[]] {
  const kept = list.filter((value) => !(out as readonly string[]).includes(value))
  if (kept.length === 0) throw new Error(`a subset of ${list.join(", ")} keeps no value`)
  return kept as unknown as readonly [Exclude<List[number], Out>, ...Exclude<List[number], Out>[]]
}

/** Whether `value` is one of `list`'s, narrowed to them: a value read against a closed list drawn from its own. */
export const isOneOf = <Value extends string, Of extends Value>(value: Value, list: readonly Of[]): value is Of => (list as readonly Value[]).includes(value)

/** Each value of `list` turned into another, in `list`'s order: as long as the parent, so still non-empty. */
export function mapped<const List extends readonly [string, ...string[]], const To extends string>(list: List, to: (value: List[number]) => To): readonly [To, ...To[]] {
  return list.map(to) as unknown as readonly [To, ...To[]]
}

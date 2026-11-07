// A closed list drawn from another: every value of its parent but the ones
// named out, in the parent's order, so a value the parent gains reaches the
// subset unless it is named out too. Typed as a non-empty tuple, which a
// database check (`oneOf`) and a wire enum (`z.enum`) read alike.

/** Every value of `list` but `out`, in `list`'s order. */
export function without<const List extends readonly [string, ...string[]], const Out extends List[number] = never>(list: List, ...out: readonly Out[]): readonly [Exclude<List[number], Out>, ...Exclude<List[number], Out>[]] {
  const kept = list.filter((value) => !(out as readonly string[]).includes(value))
  if (kept.length === 0) throw new Error(`a subset of ${list.join(", ")} keeps no value`)
  return kept as unknown as readonly [Exclude<List[number], Out>, ...Exclude<List[number], Out>[]]
}

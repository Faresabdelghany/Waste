// A process's environment as it arrives: strings, some of them empty.

export type Environment = Readonly<Record<string, string | undefined>>

/** Set-but-empty is how a shell, or a placeholder line in .env, says "not set". */
export const withoutEmpty = (source: Environment): Record<string, string> =>
  Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ""))

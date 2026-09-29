/** The browser `Storage` surface, in memory, so a test can read it back and two controllers can share one. */
export function memoryStorage(entries: Readonly<Record<string, string>> = {}): Storage {
  const map = new Map<string, string>(Object.entries(entries))
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key)
    },
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
  }
}

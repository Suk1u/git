type CacheEntry<T> = {
  value: T
  expiresAt: number
}

export class AsyncCache<T> {
  private values = new Map<string, CacheEntry<T>>()
  private pending = new Map<string, Promise<T>>()

  constructor(
    private maxEntries = 32,
    private ttlMs = 30 * 60 * 1000,
  ) {}

  peek(key: string): T | null {
    const entry = this.values.get(key)
    if (!entry) return null
    if (entry.expiresAt <= Date.now()) {
      this.values.delete(key)
      return null
    }
    this.values.delete(key)
    this.values.set(key, entry)
    return entry.value
  }

  set(key: string, value: T) {
    this.values.delete(key)
    this.values.set(key, { value, expiresAt: Date.now() + this.ttlMs })
    while (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next().value
      if (typeof oldest !== "string") break
      this.values.delete(oldest)
    }
  }

  async get(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.peek(key)
    if (cached !== null) return cached
    const running = this.pending.get(key)
    if (running) return running

    const task = loader()
      .then(value => {
        this.set(key, value)
        return value
      })
      .finally(() => this.pending.delete(key))
    this.pending.set(key, task)
    return task
  }
}

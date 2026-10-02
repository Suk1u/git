export const retryAsync = async <T,>(
  operation: (attempt: number) => Promise<T>,
  options: { attempts: number; delayMs?: number; shouldRetry?: (error: unknown) => boolean },
): Promise<T> => {
  const attempts = Math.max(1, Math.floor(options.attempts))
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error
      if (attempt >= attempts || options.shouldRetry?.(error) === false) break
      const delayMs = Math.max(0, options.delayMs ?? 250) * attempt
      if (delayMs > 0) await new Promise<void>(resolve => setTimeout(resolve, delayMs))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "操作失败"))
}

export const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  transform: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++
      if (index >= items.length) return
      results[index] = await transform(items[index], index)
    }
  }
  const workerCount = Math.min(Math.max(1, Math.floor(limit)), items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

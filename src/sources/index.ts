import type { AppSettings, MangaSource, SavedSourceConfig } from "../model"
import { GenericHtmlSource } from "./generic"
import { Copy3000Source } from "./copy3000"
import { GodamhSource } from "./godamh"
import { KomiicSource } from "./komiic"
import { PicaSource } from "./pica"
import { JMComicSource } from "./jmcomic"
import { MyComicSource } from "./mycomic"

function sourceFromConfig(config: SavedSourceConfig): MangaSource {
  const source: any = config.adapter === "copy3000"
    ? new Copy3000Source(config)
    : config.adapter === "godamh"
      ? new GodamhSource(config)
      : config.adapter === "komiic"
        ? new KomiicSource(config)
        : config.adapter === "pica"
          ? new PicaSource(config)
          : config.adapter === "jmcomic"
            ? new JMComicSource(config)
            : config.adapter === "mycomic"
              ? new MyComicSource(config)
              : new GenericHtmlSource(config)
  source.loginDiscovery = config.loginDiscovery ?? (config.adapter === "komiic" || config.adapter === "mycomic" ? "detected" : "none")
  source.loginURL = config.loginURL
  source.supportsLogin = source.supportsLogin || source.loginDiscovery !== "none"
  return source
}

export function availableSources(settings: AppSettings): MangaSource[] {
  const sources: MangaSource[] = []
  for (const config of settings.savedSources) {
    try {
      if (!sources.some(source => source.id === config.id)) sources.push(sourceFromConfig(config))
    } catch {
      // Skip malformed saved sources while keeping the app usable.
    }
  }
  if (settings.genericSource.baseURL.trim() && !sources.some(source => source.id === "generic")) {
    try { sources.push(new GenericHtmlSource(settings)) } catch { /* legacy source is incomplete */ }
  }
  const readKeys = settings.sourcePinnedAt && typeof settings.sourcePinnedAt === "object" ? settings.sourcePinnedAt : {}
  const savedOrder = new Map(settings.savedSources.map((source, index) => [source.id, index]))
  return sources.sort((left, right) => {
    const leftPinned = readKeys[left.id]
    const rightPinned = readKeys[right.id]
    if (leftPinned != null && rightPinned != null) return leftPinned - rightPinned
    if (leftPinned != null) return -1
    if (rightPinned != null) return 1
    return (savedOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (savedOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)
  })
}

export function sourceFor(settings: AppSettings, sourceId: string, mangaURL?: string) {
  const saved = settings.savedSources.find(item => item.id === sourceId)
  if (saved) {
    try { return sourceFromConfig(saved) } catch { /* continue with legacy fallbacks */ }
  }
  if (sourceId === "pica" && mangaURL) {
    try {
      const parsed = new URL(mangaURL)
      return new PicaSource({ baseURL: parsed.origin })
    } catch { /* use default source */ }
  }
  if (sourceId === "jmcomic") return new JMComicSource()
  if (sourceId === "godamh" && mangaURL) {
    try { return new GodamhSource({ id: sourceId, name: "G站漫画", baseURL: new URL(mangaURL).origin, categories: [] }) } catch { /* historic entry is malformed */ }
  }
  if (sourceId === "copy3000" && mangaURL) {
    try { return new Copy3000Source(new URL(mangaURL).origin) } catch { /* use default source */ }
  }
  if (sourceId === "mycomic") return new MyComicSource()
  if (sourceId === "generic" && mangaURL) {
    try {
      const parsed = new URL(mangaURL)
      return new GenericHtmlSource({
        ...settings,
        genericSource: {
          ...settings.genericSource,
          name: settings.genericSource.name || `网页源 · ${parsed.hostname}`,
          baseURL: parsed.origin,
        },
      })
    } catch { /* use configured source */ }
  }
  const sources = availableSources(settings)
  const selected = sources.find(source => source.id === sourceId)
  if (selected) return selected
  if (mangaURL) {
    try {
      const host = new URL(mangaURL).hostname
      const matched = sources.find(source => new URL(source.baseURL).hostname === host)
      if (matched) return matched
    } catch { /* invalid historic URL */ }
  }
  throw new Error("该漫画对应的图源已删除，请重新添加网站后再打开。")
}

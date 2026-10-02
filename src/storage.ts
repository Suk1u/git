import type { AppSettings, HistoryEntry, MangaDetail, MangaSummary, SavedSourceConfig } from "./model"
import { normalizeSourceDomains } from "./source-domains"

type StorageAPI = {
  get<T>(key: string): T | null
  set<T>(key: string, value: T): boolean | void
}

const memoryStorage = new Map<string, unknown>()

function storageAPI(): StorageAPI | null {
  const api = (globalThis as any).Storage as StorageAPI | undefined
  return api && typeof api.get === "function" && typeof api.set === "function" ? api : null
}

function readStored<T>(key: string): T | null {
  const api = storageAPI()
  if (api) return api.get<T>(key)
  return (memoryStorage.get(key) as T | undefined) ?? null
}

function writeStored<T>(key: string, value: T) {
  const api = storageAPI()
  if (api) {
    try {
      api.set(key, value)
      return
    } catch {
      // Fall through to the in-memory session cache if the host store is unavailable.
    }
  }
  memoryStorage.set(key, value)
}

const SETTINGS_KEY = "liquid_manga_settings_v1"
const BUILTIN_SOURCES_MIGRATION_KEY = "liquid_manga_builtin_sources_v1"
const FAVORITES_KEY = "liquid_manga_favorites_v1"
const HISTORY_KEY = "liquid_manga_history_v1"
const READ_KEY = "liquid_manga_read_v1"
const DETAIL_CACHE_KEY = "liquid_manga_detail_cache_v2"
const PAGE_CACHE_KEY = "liquid_manga_page_cache_v1"
const DETAIL_CACHE_TTL = 12 * 60 * 60 * 1000
const PAGE_CACHE_TTL = 24 * 60 * 60 * 1000

type DetailCacheEntry = {
  key: string
  cachedAt: number
  detail: MangaDetail
}

type PageCacheEntry = {
  key: string
  cachedAt: number
  urls: string[]
}

const BUILTIN_SOURCES: SavedSourceConfig[] = [
  {
    id: "pica",
    adapter: "pica",
    name: "嗶咔漫画",
    baseURL: "https://picaapi.go2778.com",
    catalogPath: "/",
    searchPath: "/",
    categories: [
      { id: "latest", title: "最新上架", path: "latest", systemImage: "clock.fill" },
      { id: "likes", title: "最多喜欢", path: "likes", systemImage: "heart.fill" },
      { id: "views", title: "最多观看", path: "views", systemImage: "eye.fill" },
    ],
  },
  {
    id: "jmcomic",
    adapter: "jmcomic",
    name: "JMComic",
    baseURL: "https://18comic.vip",
    catalogPath: "/",
    searchPath: "/",
    categories: [
      { id: "latest", title: "最新漫画", path: "", systemImage: "clock.fill" },
      { id: "likes", title: "最多爱心", path: "likes", systemImage: "heart.fill" },
      { id: "doujin", title: "同人", path: "doujin", systemImage: "tag.fill" },
      { id: "single", title: "单本", path: "single", systemImage: "tag.fill" },
      { id: "short", title: "短篇", path: "short", systemImage: "tag.fill" },
      { id: "meiman", title: "英文", path: "meiman", systemImage: "tag.fill" },
      { id: "hanmansfw", title: "一般向韩漫", path: "hanmansfw", systemImage: "tag.fill" },
      { id: "another_cosplay", title: "角色扮演", path: "another_cosplay", systemImage: "tag.fill" },
    ],
  },
  {
    id: "mycomic",
    adapter: "mycomic",
    name: "我的漫画 (MyComic)",
    baseURL: "https://mycomic.com",
    catalogPath: "/cn/comics?sort=-views",
    searchPath: "/cn/comics?q={query}",
    categories: [
      { id: "popular", title: "最高人气", path: "/cn/comics?sort=-views", systemImage: "flame.fill" },
      { id: "updated", title: "最近更新", path: "/cn/comics?sort=-update", systemImage: "clock.fill" },
      { id: "newest", title: "最新上架", path: "/cn/comics", systemImage: "sparkles" },
      { id: "rank", title: "排行榜", path: "/cn/rank", systemImage: "chart.bar.fill" },
      { id: "jp", title: "日漫", path: "/cn/comics?filter[country]=japan", systemImage: "globe.asia.australia" },
      { id: "kr", title: "韩漫", path: "/cn/comics?filter[country]=korea", systemImage: "flag.fill" },
      { id: "cn", title: "国漫", path: "/cn/comics?filter[country]=china", systemImage: "book.closed.fill" },
    ],
    loginDiscovery: "detected",
    loginURL: "https://mycomic.com/cn",
  },
]

export const DEFAULT_SETTINGS: AppSettings = {
  activeSourceId: "pica",
  categoryId: "latest",
  sort: "source",
  chapterAscending: false,
  readerMode: "webtoon",
  genericSource: {
    name: "通用网页源",
    baseURL: "",
    catalogPath: "/manga",
    searchPath: "/search?q={query}",
  },
  savedSources: BUILTIN_SOURCES,
  searchExcludedSourceIds: [],
  sourcePinnedAt: {},
  loginEnabledSourceIds: [],
  anime4kEnabled: false,
  upscalerEnabled: true,
  // Prefer the neural model for newly installed readers; Anime4K stays available as the fast option.
  upscalerEngine: "waifu2x",
  upscalerScope: "all",
  anime4kProfile: "quality",
  anime4kStrength: 1.25,
  anime4kDenoise: 0,
  anime4kScale: 2,
  waifu2xDenoise: 1,
  waifu2xScale: 2,
}

function readValue<T>(key: string, fallback: T): T {
  try {
    return readStored<T>(key) ?? fallback
  } catch {
    return fallback
  }
}

const VALID_ADAPTERS = new Set<string>(["copy3000", "godamh", "komiic", "pica", "jmcomic", "generic", "mycomic"])

export function loadSettings(): AppSettings {
  const stored = readStored<Partial<AppSettings>>(SETTINGS_KEY)
  const saved = stored ?? {}
  const configuredSources = Array.isArray(saved.savedSources) ? saved.savedSources : []
  const installBuiltins = !stored || readValue<number>(BUILTIN_SOURCES_MIGRATION_KEY, 0) < 1
  if (installBuiltins) writeStored(BUILTIN_SOURCES_MIGRATION_KEY, 1)
  const savedSources = [...(installBuiltins ? BUILTIN_SOURCES : []), ...configuredSources]
    .filter(source => VALID_ADAPTERS.has(source.adapter))
    .reduce<SavedSourceConfig[]>((sources, source) => sources.some(item => item.id === source.id) ? sources : [...sources, source], [])
    .map(source => normalizeSourceDomains(source as SavedSourceConfig))
  if (installBuiltins) writeStored(SETTINGS_KEY, { ...saved, savedSources })
  const activeExists = savedSources.some(source => source.id === saved.activeSourceId)
  const activeSourceId = activeExists ? saved.activeSourceId ?? "" : savedSources[0]?.id ?? ""
  const activeSource = savedSources.find(source => source.id === activeSourceId)
  const categoryExists = activeSource?.categories.some(category => category.id === saved.categoryId)
  // Upgrade only the untouched 4.7.0 Anime4K default to the more visible AI path.
  const legacyUpscalerDefaults = saved.upscalerEngine === "anime4k"
    && saved.anime4kProfile === "balanced"
    && Number(saved.anime4kStrength) === 0.72
    && Number(saved.anime4kDenoise) === 1
    && Number(saved.anime4kScale) === 2
  if (legacyUpscalerDefaults) writeStored(SETTINGS_KEY, { ...saved, savedSources, upscalerEngine: "waifu2x" })
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    activeSourceId,
    categoryId: categoryExists ? saved.categoryId ?? "" : activeSource?.categories[0]?.id ?? "",
    genericSource: {
      ...DEFAULT_SETTINGS.genericSource,
      ...(saved.genericSource ?? {}),
    },
    savedSources,
    searchExcludedSourceIds: Array.isArray(saved.searchExcludedSourceIds) ? saved.searchExcludedSourceIds : [],
    sourcePinnedAt: saved.sourcePinnedAt && typeof saved.sourcePinnedAt === "object" ? saved.sourcePinnedAt : {},
    loginEnabledSourceIds: Array.isArray(saved.loginEnabledSourceIds) ? saved.loginEnabledSourceIds : [],
    anime4kEnabled: Boolean(saved.anime4kEnabled),
    // Migrate from legacy anime4kEnabled: if anime4kEnabled is true, upscalerEnabled inherits it.
    // If anime4kEnabled is false (legacy default), default to true so Waifu2x works out of the box.
    upscalerEnabled: saved.anime4kEnabled === true ? true : typeof saved.upscalerEnabled === "boolean" ? saved.upscalerEnabled : true,
    upscalerEngine: legacyUpscalerDefaults ? "waifu2x" : saved.upscalerEngine === "waifu2x" ? "waifu2x" : "anime4k",
    upscalerScope: saved.upscalerScope === "window" ? "window" : "all",
    anime4kProfile: saved.anime4kProfile === "fast" || saved.anime4kProfile === "quality" ? saved.anime4kProfile : DEFAULT_SETTINGS.anime4kProfile,
    anime4kStrength: Math.max(0.4, Math.min(2.4, Number(saved.anime4kStrength ?? DEFAULT_SETTINGS.anime4kStrength))),
    anime4kDenoise: [0, 1, 2, 3].includes(Number(saved.anime4kDenoise)) ? Number(saved.anime4kDenoise) : DEFAULT_SETTINGS.anime4kDenoise,
    anime4kScale: [1.5, 2, 3].includes(Number(saved.anime4kScale)) ? Number(saved.anime4kScale) : DEFAULT_SETTINGS.anime4kScale,
    waifu2xDenoise: [0, 1, 2, 3].includes(Number(saved.waifu2xDenoise)) ? Number(saved.waifu2xDenoise) : DEFAULT_SETTINGS.waifu2xDenoise,
    waifu2xScale: [1, 2].includes(Number(saved.waifu2xScale)) ? Number(saved.waifu2xScale) : DEFAULT_SETTINGS.waifu2xScale,
  }
}

export function saveSettings(settings: AppSettings) {
  writeStored(SETTINGS_KEY, settings)
}

export function mangaKey(manga: Pick<MangaSummary, "sourceId" | "id">) {
  return `${manga.sourceId}:${manga.id}`
}

export function chapterKey(manga: Pick<MangaSummary, "sourceId" | "id">, chapterId: string) {
  return `${mangaKey(manga)}:${chapterId}`
}

export function loadCachedDetail(manga: MangaSummary): MangaDetail | null {
  const key = mangaKey(manga)
  const now = Date.now()
  const entries = readValue<DetailCacheEntry[]>(DETAIL_CACHE_KEY, [])
  return entries.find(entry => entry.key === key && now - entry.cachedAt < DETAIL_CACHE_TTL)?.detail ?? null
}

export function saveCachedDetail(detail: MangaDetail) {
  const key = mangaKey(detail)
  const entry: DetailCacheEntry = { key, cachedAt: Date.now(), detail }
  const next = [entry, ...readValue<DetailCacheEntry[]>(DETAIL_CACHE_KEY, []).filter(item => item.key !== key)]
  while (next.length > 2 || (next.length > 1 && JSON.stringify(next).length > 1_200_000)) next.pop()
  writeStored(DETAIL_CACHE_KEY, next)
}

export function loadCachedPages(manga: MangaSummary, chapterId: string): string[] | null {
  const key = chapterKey(manga, chapterId)
  const now = Date.now()
  const entries = readValue<PageCacheEntry[]>(PAGE_CACHE_KEY, [])
  return entries.find(entry => entry.key === key && now - entry.cachedAt < PAGE_CACHE_TTL)?.urls ?? null
}

export function saveCachedPages(manga: MangaSummary, chapterId: string, urls: string[]) {
  const key = chapterKey(manga, chapterId)
  const entry: PageCacheEntry = { key, cachedAt: Date.now(), urls }
  const next = [entry, ...readValue<PageCacheEntry[]>(PAGE_CACHE_KEY, []).filter(item => item.key !== key)].slice(0, 20)
  while (next.length > 1 && JSON.stringify(next).length > 300_000) next.pop()
  writeStored(PAGE_CACHE_KEY, next)
}

export function clearCachedSourceData(sourceId: string) {
  const prefix = `${sourceId}:`
  const details = readValue<DetailCacheEntry[]>(DETAIL_CACHE_KEY, []).filter(entry => !entry.key.startsWith(prefix))
  const pages = readValue<PageCacheEntry[]>(PAGE_CACHE_KEY, []).filter(entry => !entry.key.startsWith(prefix))
  writeStored(DETAIL_CACHE_KEY, details)
  writeStored(PAGE_CACHE_KEY, pages)
}

export function loadFavorites(): MangaSummary[] {
  return readValue<MangaSummary[]>(FAVORITES_KEY, [])
}

export function isFavorite(manga: MangaSummary) {
  const key = mangaKey(manga)
  return loadFavorites().some(item => mangaKey(item) === key)
}

export function toggleFavorite(manga: MangaSummary) {
  const key = mangaKey(manga)
  const current = loadFavorites()
  const exists = current.some(item => mangaKey(item) === key)
  const next = exists
    ? current.filter(item => mangaKey(item) !== key)
    : [manga, ...current].slice(0, 200)
  writeStored(FAVORITES_KEY, next)
  return !exists
}

export function loadHistory(): HistoryEntry[] {
  return readValue<HistoryEntry[]>(HISTORY_KEY, [])
}

export function saveHistory(entry: HistoryEntry) {
  const key = mangaKey(entry.manga)
  const next = [entry, ...loadHistory().filter(item => mangaKey(item.manga) !== key)]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 100)
  writeStored(HISTORY_KEY, next)
}

export function clearHistory() {
  writeStored(HISTORY_KEY, [])
}

export function removeHistory(keys: string[]) {
  if (!keys.length) return loadHistory()
  const selected = new Set(keys)
  const next = loadHistory().filter(entry => !selected.has(mangaKey(entry.manga)))
  writeStored(HISTORY_KEY, next)
  return next
}

export function lastHistoryFor(manga: MangaSummary) {
  const key = mangaKey(manga)
  return loadHistory().find(item => mangaKey(item.manga) === key) ?? null
}

export function loadReadSet() {
  return new Set(readValue<string[]>(READ_KEY, []))
}

export function markChapterRead(manga: MangaSummary, chapterId: string) {
  const set = loadReadSet()
  set.add(chapterKey(manga, chapterId))
  writeStored(READ_KEY, Array.from(set).slice(-5000))
}

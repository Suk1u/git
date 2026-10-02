export type SourceSort = "source" | "titleAsc" | "titleDesc"

export type ReaderMode = "webtoon" | "paged"
export type UpscalerEngine = "anime4k" | "waifu2x"
export type UpscalerScope = "window" | "all"
export type Anime4KProfile = "fast" | "balanced" | "quality"

export type SourceAccount = {
  label: string
  identifier: string
}

export type SourceCategory = {
  id: string
  title: string
  path: string
  systemImage: string
}

export type MangaSummary = {
  sourceId: string
  id: string
  title: string
  coverURL: string
  url: string
  subtitle?: string
}

export type MangaChapter = {
  id: string
  slug: string
  title: string
  order: number
  updatedAt?: string
  url?: string
}

export type MangaDetail = MangaSummary & {
  mid?: string
  description: string
  authors: string[]
  tags: string[]
  status: string
  chapters: MangaChapter[]
}

export type BrowsePage = {
  items: MangaSummary[]
  page: number
  hasNext: boolean
}

export type GenericSourceConfig = {
  name: string
  baseURL: string
  catalogPath: string
  searchPath: string
}

export type SavedSourceAdapter = "copy3000" | "godamh" | "komiic" | "pica" | "jmcomic" | "generic" | "mycomic"

export type LoginDiscovery = "none" | "detected" | "manual"

export type SavedSourceDomainConfig = GenericSourceConfig & {
  adapter: SavedSourceAdapter
  categories: SourceCategory[]
  loginDiscovery?: LoginDiscovery
  loginURL?: string
}

export type SavedSourceConfig = SavedSourceDomainConfig & {
  id: string
  domains?: SavedSourceDomainConfig[]
}

export type AppSettings = {
  activeSourceId: string
  categoryId: string
  sort: SourceSort
  chapterAscending: boolean
  readerMode: ReaderMode
  genericSource: GenericSourceConfig
  savedSources: SavedSourceConfig[]
  searchExcludedSourceIds: string[]
  sourcePinnedAt: Record<string, number>
  loginEnabledSourceIds: string[]
  anime4kEnabled: boolean
  upscalerEnabled: boolean
  upscalerEngine: UpscalerEngine
  upscalerScope: UpscalerScope
  anime4kProfile: Anime4KProfile
  anime4kStrength: number
  anime4kDenoise: number
  anime4kScale: number
  waifu2xDenoise: number
  waifu2xScale: number
}

export type HistoryEntry = {
  manga: MangaSummary
  chapterId: string
  chapterTitle: string
  page: number
  updatedAt: number
}

export interface MangaSource {
  id: string
  name: string
  baseURL: string
  categories: SourceCategory[]
  browse(category: SourceCategory, page: number, sort: SourceSort): Promise<BrowsePage>
  search(query: string, page: number, sort: SourceSort): Promise<BrowsePage>
  detail(manga: MangaSummary): Promise<MangaDetail>
  pages(manga: MangaSummary, chapter: MangaChapter): Promise<string[]>
  // Sources with signed or protected images can opt into the reader's native fetch queue.
  loadImage?(url: string, manga: MangaSummary, chapter: MangaChapter): Promise<any>
  supportsLogin?: boolean
  loginDiscovery?: LoginDiscovery
  loginURL?: string
  isLoggedIn?(): boolean
  savedLoginIdentifier?(): string
  loadAccount?(): Promise<SourceAccount>
  login?(identifier: string, password: string): Promise<SourceAccount>
  logout?(): Promise<void>
}

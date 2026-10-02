import type {
  AppSettings,
  BrowsePage,
  MangaChapter,
  MangaDetail,
  MangaSource,
  MangaSummary,
  SavedSourceConfig,
  SourceCategory,
  SourceSort,
} from "../model"
import { AsyncCache } from "../cache"
import {
  absoluteURL,
  jsonLDObjects,
  metaContent,
  parseGenericChapters,
  parseGenericImages,
  parseMangaCards,
  stripTags,
} from "../html"
import { requestText } from "../net"
import { loadCachedDetail, loadCachedPages, saveCachedDetail, saveCachedPages } from "../storage"

function normalizedBaseURL(value: string) {
  const trimmed = value.trim().replace(/\/$/, "")
  if (!/^https?:\/\//i.test(trimmed)) throw new Error("通用源地址必须以 http:// 或 https:// 开头")
  return trimmed
}

export async function genericSummaryFromURL(value: string): Promise<MangaSummary> {
  const url = new URL(value.trim())
  if (!/^https?:$/i.test(url.protocol)) throw new Error("漫画网址必须是有效的 http:// 或 https:// 地址")
  const page = await requestText(url.toString(), url.origin)
  const title = metaContent(page, "og:title")
    || stripTags(page.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
    || url.hostname
  const cover = metaContent(page, "og:image")
  return {
    sourceId: "generic",
    id: url.toString(),
    title: title.replace(/\s*[-|].*$/, "").trim(),
    coverURL: cover ? absoluteURL(url.toString(), cover) : "",
    url: url.toString(),
  }
}

function sourceSort(items: MangaSummary[], sort: SourceSort) {
  if (sort === "source") return items
  return [...items].sort((a, b) => {
    const result = a.title.localeCompare(b.title, "zh-Hans-CN")
    return sort === "titleAsc" ? result : -result
  })
}

export class GenericHtmlSource implements MangaSource {
  id: string
  name: string
  baseURL: string
  categories: SourceCategory[]
  private catalogPath: string
  private searchPath: string
  private detailCache = new AsyncCache<MangaDetail>(24, 30 * 60 * 1000)
  private pageCache = new AsyncCache<string[]>(80, 60 * 60 * 1000)

  constructor(settingsOrConfig: AppSettings | SavedSourceConfig) {
    let id = "generic"
    let categories: SourceCategory[] | undefined
    let config
    if ("adapter" in settingsOrConfig) {
      id = settingsOrConfig.id
      categories = settingsOrConfig.categories
      config = settingsOrConfig
    } else {
      config = settingsOrConfig.genericSource
    }
    this.id = id
    this.name = config.name.trim() || "通用网页源"
    this.baseURL = normalizedBaseURL(config.baseURL)
    this.catalogPath = config.catalogPath.trim() || "/"
    this.searchPath = config.searchPath.trim() || "/search?q={query}"
    this.categories = categories?.length
      ? categories
      : [{ id: "catalog", title: "目录", path: this.catalogPath, systemImage: "globe" }]
  }

  private pageURL(path: string, page: number) {
    const resolved = new URL(path, `${this.baseURL}/`).toString()
    if (page <= 1) return resolved
    if (resolved.includes("{page}")) return resolved.replace("{page}", String(page))
    const url = new URL(resolved)
    url.searchParams.set("page", String(page))
    return url.toString()
  }

  async browse(category: SourceCategory, page: number, sort: SourceSort): Promise<BrowsePage> {
    const url = this.pageURL(category.path, page)
    const html = await requestText(url, this.baseURL)
    const items = sourceSort(parseMangaCards(html, this.baseURL, this.id), sort)
    return { items, page, hasNext: items.length >= 20 }
  }

  async search(query: string, page: number, sort: SourceSort): Promise<BrowsePage> {
    const path = this.searchPath.replace("{query}", encodeURIComponent(query.trim()))
    const url = this.pageURL(path, page)
    const html = await requestText(url, this.baseURL)
    const items = sourceSort(parseMangaCards(html, this.baseURL, this.id), sort)
    return { items, page, hasNext: items.length >= 20 }
  }

  async detail(manga: MangaSummary): Promise<MangaDetail> {
    const key = `${manga.sourceId}:${manga.id}:${this.baseURL}`
    return this.detailCache.get(key, async () => {
      const stored = loadCachedDetail(manga)
      if (stored) return stored
      const original = new URL(manga.url)
      const detailURL = new URL(`${original.pathname}${original.search}${original.hash}`, `${this.baseURL}/`).toString()
      const html = await requestText(detailURL, this.baseURL)
      const objects = jsonLDObjects(html)
      const series = objects.find(item => /ComicSeries|Book|CreativeWork/i.test(String(item?.["@type"] ?? "")))
      const rawAuthors = Array.isArray(series?.author) ? series.author : series?.author ? [series.author] : []
      const rawGenres = Array.isArray(series?.genre) ? series.genre : series?.genre ? [series.genre] : []
      const detail: MangaDetail = {
        ...manga,
        title: metaContent(html, "og:title").replace(/\s*[-|].*$/, "") || series?.name || manga.title,
        coverURL: metaContent(html, "og:image") || series?.image || manga.coverURL,
        description: metaContent(html, "description") || series?.description || "通用解析未取得简介",
        authors: rawAuthors.map((item: any) => typeof item === "string" ? item : item?.name).filter(Boolean),
        tags: rawGenres.filter((item: unknown): item is string => typeof item === "string"),
        status: series?.creativeWorkStatus || "状态未知",
        url: detailURL,
        chapters: parseGenericChapters(html, detailURL),
      }
      setTimeout(() => saveCachedDetail(detail), 2000)
      return detail
    })
  }

  async pages(_manga: MangaSummary, chapter: MangaChapter): Promise<string[]> {
    const key = `${_manga.sourceId}:${_manga.id}:${chapter.id}:${this.baseURL}`
    return this.pageCache.get(key, async () => {
      const stored = loadCachedPages(_manga, chapter.id)
      if (stored?.length) return stored
      if (!chapter.url) throw new Error("通用源章节缺少网页地址")
      const html = await requestText(chapter.url, this.baseURL)
      const images = parseGenericImages(html, chapter.url)
      if (!images.length) {
        throw new Error("通用解析未找到正文图片；该网站需要新增专用适配器。")
      }
      setTimeout(() => saveCachedPages(_manga, chapter.id, images), 300)
      return images
    })
  }
}

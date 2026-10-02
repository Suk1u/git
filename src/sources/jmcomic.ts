import type {
  BrowsePage,
  MangaChapter,
  MangaDetail,
  MangaSource,
  MangaSummary,
  SourceCategory,
  SourceSort,
} from "../model"
import { AsyncCache } from "../cache"
import { retryAsync } from "../async-utils"
import { loadCachedDetail, loadCachedPages, saveCachedDetail, saveCachedPages } from "../storage"
import { JM_CATEGORY_OPTIONS } from "./jm-definitions"
import {
  ensureJMApiContext,
  jmAlbumPath,
  jmApiGet,
  jmChapterPath,
  jmCoverUrl,
  jmFilterPath,
  jmResolveAbsoluteUrl,
  jmSearchPath,
} from "./jm-request"
import { jmFetchPageImage } from "./jm-image"

export const JM_CATEGORIES: SourceCategory[] = [
  { id: "latest", title: "最新漫画", path: "", systemImage: "clock.fill" },
  { id: "likes", title: "最多爱心", path: "likes", systemImage: "heart.fill" },
  ...JM_CATEGORY_OPTIONS.map(item => ({ id: item.id, title: item.title, path: item.id, systemImage: "tag.fill" })),
]

type JMComic = {
  id?: string | number
  album_id?: string | number
  comic_id?: string | number
  name?: string
  author?: string
  image?: string
  description?: string
  category?: { title?: string }
  category_sub?: { title?: string }
}
type JMSearchResponse = { total?: number | string; list?: JMComic[]; content?: JMComic[] }
type JMSeries = { id?: string | number; name?: string; sort?: number | string }
type JMAlbum = {
  name?: string
  description?: string
  addtime?: string
  author?: string[]
  works?: string[]
  tags?: string[]
  series?: JMSeries[]
}
type JMChapter = { id?: string | number; series_id?: string | number; images?: string[] }

function numberValue(value: unknown, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function comicID(item: JMComic) {
  return String(item.id ?? item.album_id ?? item.comic_id ?? "").trim()
}

function coverURL(cdnBase: string, id: string) {
  return jmCoverUrl(cdnBase, id)
}

function summary(sourceId: string, item: JMComic, cdnBase: string): MangaSummary {
  const id = comicID(item)
  const directCover = jmResolveAbsoluteUrl(item.image)
  return {
    sourceId,
    id,
    title: String(item.name ?? "未命名漫画"),
    coverURL: directCover && /^https?:\/\//i.test(directCover) ? directCover : coverURL(cdnBase, id),
    url: `https://18comic.vip/album/${encodeURIComponent(id)}`,
    subtitle: String(item.author ?? "禁漫天堂"),
  }
}

function sortCode(category: SourceCategory, sort: SourceSort) {
  if (category.path === "likes") return "tf"
  if (sort === "titleAsc") return "md"
  return "mr"
}

function chapterTitle(series: JMSeries, index: number) {
  return String(series.name ?? "").trim() || `第 ${numberValue(series.sort, index + 1)} 話`
}

export class JMComicSource implements MangaSource {
  id: string
  name: string
  baseURL: string
  categories: SourceCategory[]
  private detailCache = new AsyncCache<MangaDetail>(20, 30 * 60 * 1000)
  private pagesCache = new AsyncCache<string[]>(80, 60 * 60 * 1000)

  constructor(config?: { id?: string; name?: string; baseURL?: string; categories?: SourceCategory[] }) {
    this.id = config?.id ?? "jmcomic"
    this.name = config?.name ?? "JMComic"
    this.baseURL = config?.baseURL ?? "https://18comic.vip"
    this.categories = config?.categories?.length ? config.categories : JM_CATEGORIES
  }

  async browse(category: SourceCategory, page: number, sort: SourceSort): Promise<BrowsePage> {
    const ctx = await ensureJMApiContext()
    const categoryID = category.path === "likes" || category.path === "latest" ? "" : category.path
    const response = await jmApiGet<JMSearchResponse>(ctx.domain, jmFilterPath(sortCode(category, sort), categoryID, page))
    const items = (Array.isArray(response.content) ? response.content : response.list ?? [])
      .map(item => summary(this.id, item, ctx.cdnBase)).filter(item => item.id)
    const total = Math.max(items.length, numberValue(response.total, items.length))
    return { items, page, hasNext: page * Math.max(1, items.length) < total }
  }

  async search(query: string, page: number, sort: SourceSort): Promise<BrowsePage> {
    const ctx = await ensureJMApiContext()
    const response = await jmApiGet<JMSearchResponse>(ctx.domain, jmSearchPath(query.trim(), sortCode(JM_CATEGORIES[0], sort), "", page))
    const items = (Array.isArray(response.content) ? response.content : response.list ?? [])
      .map(item => summary(this.id, item, ctx.cdnBase)).filter(item => item.id)
    const total = Math.max(items.length, numberValue(response.total, items.length))
    return { items, page, hasNext: page * Math.max(1, items.length) < total }
  }

  async detail(manga: MangaSummary): Promise<MangaDetail> {
    return this.detailCache.get(manga.id, async () => {
      const stored = loadCachedDetail(manga)
      if (stored) return stored
      const ctx = await ensureJMApiContext()
      const album = await jmApiGet<JMAlbum>(ctx.domain, jmAlbumPath(manga.id))
      const series = [...(album.series ?? [])].sort((left, right) => numberValue(left.sort) - numberValue(right.sort))
      const chapters = (series.length ? series : [{ id: manga.id, name: "第 1 話", sort: 1 }]).map((item, index) => ({
        id: String(item.id ?? manga.id),
        slug: String(item.id ?? manga.id),
        title: chapterTitle(item, index),
        order: numberValue(item.sort, index + 1),
        updatedAt: String(album.addtime ?? ""),
      }))
      const detail: MangaDetail = {
        ...manga,
        title: String(album.name ?? manga.title),
        coverURL: coverURL(ctx.cdnBase, manga.id),
        description: String(album.description ?? "暂无简介"),
        authors: (album.author ?? []).map(String).filter(Boolean),
        tags: [...(album.works ?? []), ...(album.tags ?? [])].map(String).filter(Boolean),
        status: (album.tags ?? []).some(tag => tag === "完结" || tag === "已完结") ? "已完结" : "连载中",
        chapters,
      }
      saveCachedDetail(detail)
      return detail
    })
  }

  async pages(manga: MangaSummary, chapter: MangaChapter): Promise<string[]> {
    return this.pagesCache.get(`${manga.id}:${chapter.id}`, async () => {
      const stored = loadCachedPages(manga, chapter.id)
      if (stored?.length) return stored
      const ctx = await ensureJMApiContext()
      const payload = await retryAsync(() => jmApiGet<JMChapter>(ctx.domain, jmChapterPath(chapter.id)), { attempts: 3, delayMs: 250 })
      const episodeID = String(payload.id ?? chapter.id)
      const images = (payload.images ?? []).map(String).filter(Boolean)
      if (!images.length) throw new Error("JMComic 章节图片为空")
      const urls = images.map(fileName => `${ctx.cdnBase}/media/photos/${encodeURIComponent(episodeID)}/${encodeURIComponent(fileName.replace(/^\//, ""))}`)
      saveCachedPages(manga, chapter.id, urls)
      return urls
    })
  }

  async loadImage(url: string, _manga: MangaSummary, chapter: MangaChapter) {
    const fileName = decodeURIComponent(url.split("/").pop()?.split(/[?#]/)[0] ?? "page.jpg")
    const episodeID = numberValue(url.match(/\/photos\/(\d+)\//)?.[1], numberValue(chapter.id, 0))
    return retryAsync(() => jmFetchPageImage(url, episodeID, fileName), { attempts: 3, delayMs: 250 })
  }
}

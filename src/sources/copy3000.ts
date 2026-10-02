import type {
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
import { decryptJSON } from "../crypto"
import {
  absoluteURL,
  decodeHTML,
  jsonLDObjects,
  metaContent,
  parseMangaCards,
  stripTags,
} from "../html"
import { requestJSON, requestText } from "../net"
import { loadCachedDetail, loadCachedPages, saveCachedDetail, saveCachedPages } from "../storage"

const COPY_KEY = "op0zzpvv.nmn.00p"
const COPY_ID = "copy3000"
const COPY_DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"

export const COPY3000_CATEGORIES: SourceCategory[] = [
  { id: "popular", title: "热门", path: "/", systemImage: "flame.fill" },
  { id: "updated", title: "热门更新", path: "/comics", systemImage: "clock.fill" },
  { id: "newest", title: "全新上架", path: "/newest", systemImage: "sparkles" },
]

type CopyChapterPayload = {
  build?: { path_word?: string }
  groups?: Record<string, {
    path_word?: string
    chapters?: Array<{
      name?: string
      uuid?: string
      id?: string
      type?: number
      datetime_created?: string
      comic_path_word?: string
    }>
  }>
}

type CopyPage = { url?: string }

type CopyResponse = { code?: number; message?: string; results?: string }

type CopySearchResponse = {
  code?: number
  results?: {
    total?: number
    list?: Array<{
      name?: string
      path_word?: string
      cover?: string
      author?: Array<{ name?: string }>
    }>
  }
}

function copyCatalogItems(html: string, baseURL: string, sourceId: string) {
  const block = html.match(/class=["'][^"']*exemptComic-box[^"']*["'][^>]+list=["']([\s\S]*?)["'][^>]*>/i)?.[1] ?? ""
  const decoded = decodeHTML(block)
  const items: MangaSummary[] = []
  const pattern = /\{\s*['"]path_word['"]\s*:\s*['"]([^'"]+)['"][^{}]*?['"]name['"]\s*:\s*['"]([^'"]+)['"][^{}]*?['"]cover['"]\s*:\s*['"]([^'"]+)['"]/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(decoded))) {
    items.push({
      sourceId,
      id: decodeHTML(match[1]),
      title: decodeHTML(match[2]),
      coverURL: decodeHTML(match[3]),
      url: `${baseURL}/comic/${decodeHTML(match[1])}`,
    })
  }
  const total = Number(html.match(/exemptComic-box[^>]+total=["'](\d+)["']/i)?.[1] ?? items.length)
  return { items, total }
}

function copyRecommendItems(html: string, baseURL: string, sourceId: string) {
  const items: MangaSummary[] = []
  const seen = new Set<string>()
  const pattern = /<a[^>]+href=["']\/comic\/([^"'/?#]+)["'][^>]*>[\s\S]{0,500}?<img[^>]+(?:data-src|src)=["']([^"']+)["'][^>]*>[\s\S]{0,1200}?<a[^>]+href=["']\/comic\/\1["'][^>]*>[\s\S]{0,300}?<p[^>]+title=["']([^"']+)["']/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html))) {
    const id = decodeHTML(match[1])
    if (seen.has(id)) continue
    seen.add(id)
    items.push({
      sourceId,
      id,
      title: decodeHTML(match[3]),
      coverURL: absoluteURL(baseURL, match[2]),
      url: `${baseURL}/comic/${id}`,
    })
  }
  if (!items.length) {
    const fallbackPattern = /<a[^>]+href=["']\/comic\/([^"'/?#]+)["'][^>]*>[\s\S]{0,600}?<img[^>]+(?:data-src|src)=["']([^"']+)["'][^>]*>[\s\S]{0,600}?(?:<p[^>]+title=["']([^"']+)["']|<p[^>]*>([\s\S]*?)<\/p>)/gi
    while ((match = fallbackPattern.exec(html))) {
      const id = decodeHTML(match[1])
      if (seen.has(id)) continue
      const title = stripTags(decodeHTML(match[3] || match[4] || "")).trim()
      if (!title) continue
      seen.add(id)
      items.push({
        sourceId,
        id,
        title,
        coverURL: absoluteURL(baseURL, match[2]),
        url: `${baseURL}/comic/${id}`,
      })
    }
  }
  return items
}

function normalizedURL(value: string) {
  try {
    const parsed = new URL(value.trim())
    if (!/^https?:$/i.test(parsed.protocol)) throw new Error()
    return parsed
  } catch {
    throw new Error("漫画网址必须是有效的 http:// 或 https:// 地址")
  }
}

function sortItems(items: MangaSummary[], sort: SourceSort) {
  if (sort === "source") return items
  return [...items].sort((left, right) => {
    const value = left.title.localeCompare(right.title, "zh-Hans-CN")
    return sort === "titleAsc" ? value : -value
  })
}

function textFromMatch(html: string, pattern: RegExp) {
  const match = html.match(pattern)
  return match?.[1] ? stripTags(match[1]) : ""
}

function copyTitle(html: string, fallback: string) {
  return textFromMatch(html, /comicParticulars-title-right[\s\S]*?<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)
    || metaContent(html, "og:title").replace(/\s*[-|].*$/, "")
    || fallback
}

function copyCover(html: string, baseURL: string) {
  const value = html.match(/comicParticulars-left-img[\s\S]*?<img[^>]+(?:data-src|src)=["']([^"']+)["']/i)?.[1]
    || metaContent(html, "og:image")
  return value ? absoluteURL(baseURL, value) : ""
}

function copyAuthors(html: string) {
  const block = html.match(/<span>\s*作者：\s*<\/span>([\s\S]*?)<\/li>/i)?.[1] ?? ""
  return stripTags(block).split(/[、,，/&]+/).map(item => item.trim()).filter(Boolean)
}

function copyTags(html: string) {
  const values: string[] = []
  const pattern = /<a[^>]+href=["'][^"']*(?:comics\?|theme=)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html))) {
    const value = stripTags(match[1])
    if (value && !values.includes(value)) values.push(value)
  }
  return values
}

function chapterURL(baseURL: string, slug: string, uuid: string) {
  return `${baseURL}/comic/${encodeURIComponent(slug)}/chapter/${encodeURIComponent(uuid)}`
}

function chapterList(payload: CopyChapterPayload, baseURL: string, slug: string): MangaChapter[] {
  const chapters: MangaChapter[] = []
  const seen = new Set<string>()
  const groups = Object.values(payload.groups ?? {})
  for (const group of groups) {
    for (const item of group.chapters ?? []) {
      const uuid = item.uuid || item.id || ""
      if (!uuid || seen.has(uuid)) continue
      seen.add(uuid)
      chapters.push({
        id: uuid,
        slug: uuid,
        title: item.name?.trim() || `第 ${chapters.length + 1} 话`,
        order: chapters.length + 1,
        updatedAt: item.datetime_created,
        url: chapterURL(baseURL, item.comic_path_word || slug, uuid),
      })
    }
  }
  return chapters
}

async function encryptedJSON<T>(url: string, referer: string, dnt = "", key = COPY_KEY) {
  const response = JSON.parse(await requestText(url, referer, { "User-Agent": COPY_DESKTOP_UA, ...(dnt ? { dnts: dnt } : {}) })) as CopyResponse
  if (response.code !== 200 || !response.results) throw new Error(`拷贝漫画接口返回异常：${response.message ?? "未知错误"}`)
  return decryptJSON<T>(response.results, key)
}

export function isCopy3000URL(value: string) {
  try {
    return /(?:^|\.)copy3000\.com$/i.test(new URL(value.trim()).hostname)
  } catch {
    return false
  }
}

export function copy3000SummaryFromURL(value: string): MangaSummary {
  const url = normalizedURL(value)
  const parts = url.pathname.split("/").filter(Boolean)
  const comicIndex = parts.indexOf("comic")
  const slug = comicIndex >= 0 ? parts[comicIndex + 1] : ""
  if (!slug) throw new Error("拷贝漫画网址应为 /comic/漫画路径 或章节页地址")
  const chapterIndex = parts.indexOf("chapter")
  const chapterID = chapterIndex >= 0 ? parts[chapterIndex + 1] : ""
  return {
    sourceId: COPY_ID,
    id: slug,
    title: slug,
    coverURL: "",
    url: `${url.origin}/comic/${slug}`,
    subtitle: chapterID ? `chapter:${chapterID}` : undefined,
  }
}

export class Copy3000Source implements MangaSource {
  id: string
  name: string
  baseURL: string
  categories: SourceCategory[]
  private detailCache = new AsyncCache<MangaDetail>(24, 30 * 60 * 1000)
  private pageCache = new AsyncCache<string[]>(80, 60 * 60 * 1000)

  constructor(config: string | SavedSourceConfig = "https://copy3000.com") {
    if (typeof config === "string") {
      this.id = COPY_ID
      this.name = "拷贝漫画"
      this.baseURL = normalizedURL(config).origin
      this.categories = COPY3000_CATEGORIES
    } else {
      this.id = config.id
      this.name = config.name
      this.baseURL = normalizedURL(config.baseURL).origin
      this.categories = config.categories.length ? config.categories : COPY3000_CATEGORIES
    }
  }

  async browse(category: SourceCategory, page: number, sort: SourceSort): Promise<BrowsePage> {
    const url = new URL(category.path, `${this.baseURL}/`)
    const isRecommend = /^\/recommend\b/i.test(url.pathname)
    const limit = isRecommend ? 60 : 50
    if (/^\/(?:comics|recommend)\b/i.test(url.pathname)) {
      url.searchParams.set("offset", String(Math.max(0, page - 1) * limit))
      url.searchParams.set("limit", String(limit))
    } else if (page > 1) url.searchParams.set("page", String(page))
    const html = await requestText(url.toString(), this.baseURL, { "User-Agent": COPY_DESKTOP_UA })
    const catalog = copyCatalogItems(html, this.baseURL, this.id)
    const recommended = isRecommend ? copyRecommendItems(html, this.baseURL, this.id) : []
    const parsed = recommended.length ? recommended : catalog.items.length ? catalog.items : parseMangaCards(html, this.baseURL, this.id)
    const items = sortItems(parsed, sort)
    const hasNext = isRecommend
      ? items.length >= limit
      : catalog.items.length ? Math.max(0, page - 1) * limit + items.length < catalog.total : items.length >= 18
    return { items, page, hasNext }
  }

  async search(query: string, page: number, sort: SourceSort): Promise<BrowsePage> {
    const limit = 12
    const offset = Math.max(0, page - 1) * limit
    const url = `${this.baseURL}/api/kb/web/searchci/comics?offset=${offset}&platform=2&limit=${limit}&q=${encodeURIComponent(query.trim())}&q_type=`
    const payload = await requestJSON<CopySearchResponse>(url, `${this.baseURL}/search?q=${encodeURIComponent(query.trim())}`, { "User-Agent": COPY_DESKTOP_UA })
    const list = payload.results?.list ?? []
    const items = sortItems(list.map(item => ({
      sourceId: this.id,
      id: item.path_word ?? "",
      title: item.name?.trim() || item.path_word || "未命名漫画",
      coverURL: item.cover ?? "",
      url: `${this.baseURL}/comic/${item.path_word ?? ""}`,
      subtitle: item.author?.map(author => author.name).filter(Boolean).join(" · "),
    })).filter(item => item.id && item.coverURL), sort)
    const total = Number(payload.results?.total ?? items.length)
    return { items, page, hasNext: offset + limit < total }
  }

  async detail(manga: MangaSummary): Promise<MangaDetail> {
    const key = `${manga.sourceId}:${manga.id}:${this.baseURL}`
    return this.detailCache.get(key, async () => {
      const stored = loadCachedDetail(manga)
      if (stored && !manga.subtitle) return stored
      const detailURL = `${this.baseURL}/comic/${encodeURIComponent(manga.id)}`
      const html = await requestText(detailURL, this.baseURL, { "User-Agent": COPY_DESKTOP_UA })
      const dnt = html.match(/id=["']dnt["'][^>]+value=["']([^"']+)["']/i)?.[1] ?? ""
      const key = html.match(/var\s+ccz\s*=\s*["']([^"']+)["']/i)?.[1] || COPY_KEY
      const chapters = await encryptedJSON<CopyChapterPayload>(`${this.baseURL}/comicdetail/${encodeURIComponent(manga.id)}/chapters`, detailURL, dnt, key)
      const objects = jsonLDObjects(html)
      const series = objects.find(item => /ComicSeries|Book|CreativeWork/i.test(String(item?.["@type"] ?? "")))
      const detail: MangaDetail = {
        ...manga,
        url: detailURL,
        title: copyTitle(html, series?.name || manga.title),
        coverURL: copyCover(html, this.baseURL) || series?.image || manga.coverURL,
        description: textFromMatch(html, /<p[^>]+class=["'][^"']*intro[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)
          || textFromMatch(html, /(?:comicParticulars|comicIntro|description)[^>]*[\s\S]{0,120}?<p[^>]*>([\s\S]*?)<\/p>/i)
          || metaContent(html, "description")
          || series?.description
          || "暂无简介",
        authors: copyAuthors(html),
        tags: copyTags(html),
        status: textFromMatch(html, /<span>\s*狀態：\s*<\/span>([\s\S]*?)<\/li>/i) || "状态未知",
        chapters: chapterList(chapters, this.baseURL, manga.id),
      }
      if (!detail.chapters.length) {
        const chapterID = manga.subtitle?.match(/^chapter:(.+)$/)?.[1]
        const fallbackID = chapterID || html.match(new RegExp(`/comic/${manga.id}/chapter/([a-f0-9-]+)`, "i"))?.[1]
        if (fallbackID) {
          detail.chapters = [{
            id: fallbackID,
            slug: fallbackID,
            title: chapterID ? "当前章节" : "开始阅读",
            order: 1,
            url: chapterURL(this.baseURL, manga.id, fallbackID),
          }]
        }
      }
      if (!manga.subtitle) setTimeout(() => saveCachedDetail(detail), 300)
      return detail
    })
  }

  async pages(manga: MangaSummary, chapter: MangaChapter): Promise<string[]> {
    const key = `${manga.sourceId}:${manga.id}:${chapter.id}:${this.baseURL}`
    return this.pageCache.get(key, async () => {
      const stored = loadCachedPages(manga, chapter.id)
      if (stored?.length) return stored
      if (!chapter.url) throw new Error("拷贝漫画章节缺少网页地址")
      const html = await requestText(chapter.url, manga.url, { "User-Agent": COPY_DESKTOP_UA })
      const contentKey = html.match(/var\s+contentKey\s*=\s*["']([^"']+)["']/i)?.[1]
      const pageKey = html.match(/var\s+cct\s*=\s*["']([^"']+)["']/i)?.[1] || COPY_KEY
      if (!contentKey) throw new Error("拷贝漫画章节未取得图片数据；该章节可能需要登录或触发了站点验证")
      const pages = decryptJSON<CopyPage[]>(contentKey, pageKey)
      const urls = pages.map(item => item.url?.trim() ?? "").filter((url): url is string => /^https?:\/\//i.test(url))
      if (!urls.length) throw new Error("拷贝漫画章节解密后没有图片")
      setTimeout(() => saveCachedPages(manga, chapter.id, urls), 300)
      return urls
    })
  }
}

export const COPY3000_SOURCE = new Copy3000Source()

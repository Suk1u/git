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
import { jsonLDObjects, parseMangaCards } from "../html"
import { READER_UA, requestJSON, requestText } from "../net"
import { loadCachedDetail, loadCachedPages, saveCachedDetail, saveCachedPages } from "../storage"

const PRIMARY_BASE = "https://godamh.com"
const MIRROR_BASE = "https://baozimh.org"
const API_BASE = "https://v2.apikk.top"
const DECODER_URLS = [
  `${MIRROR_BASE}/assets/runtime/chapter-decoder.js`,
  `${PRIMARY_BASE}/assets/runtime/chapter-decoder.js`,
]
let preferredHTMLBase = MIRROR_BASE
let decoderPromise: Promise<{ r: (cipher: string) => Promise<any[]> }> | null = null
const detailCache = new AsyncCache<MangaDetail>(24, 30 * 60 * 1000)
const pageCache = new AsyncCache<string[]>(80, 60 * 60 * 1000)

export const GODAMH_CATEGORIES: SourceCategory[] = [
  { id: "hots", title: "人气", path: "/hots", systemImage: "flame.fill" },
  { id: "newss", title: "最新", path: "/newss", systemImage: "clock.fill" },
  { id: "all", title: "全部", path: "/manga", systemImage: "square.grid.2x2.fill" },
  { id: "cn", title: "国漫", path: "/manga-genre/cn", systemImage: "book.closed.fill" },
  { id: "jp", title: "日漫", path: "/manga-genre/jp", systemImage: "globe.asia.australia" },
  { id: "kr", title: "韩漫", path: "/manga-genre/kr", systemImage: "flag.fill" },
  { id: "xuanhuan", title: "玄幻", path: "/manga-tag/xuanhuan", systemImage: "sparkles" },
  { id: "rexue", title: "热血", path: "/manga-tag/rexue", systemImage: "bolt.fill" },
  { id: "lianai", title: "恋爱", path: "/manga-tag/lianai", systemImage: "heart.fill" },
  { id: "chuanyue", title: "穿越", path: "/manga-tag/chuanyue", systemImage: "arrow.triangle.swap" },
  { id: "xitong", title: "系统", path: "/manga-tag/xitong", systemImage: "cpu.fill" },
  { id: "fuchou", title: "复仇", path: "/manga-tag/fuchou", systemImage: "scope" },
]

type GodamhChapterResponse = {
  code: number
  status?: boolean
  data: {
    id: string
    title: string
    slug: string
    status: string
    cover: string
    desc: string
    chapters: Array<{
      id: string
      attributes: {
        title: string
        slug: string
        order: number
        updatedAt?: string
      }
    }>
  }
}

type GodamhPageResponse = {
  code: number
  data: {
    info: {
      id: string
      title: string
      images: {
        images: string
        line?: number
      }
    }
  }
}

function sortItems(items: MangaSummary[], sort: SourceSort) {
  if (sort === "source") return items
  return [...items].sort((left, right) => {
    const value = left.title.localeCompare(right.title, "zh-Hans-CN")
    return sort === "titleAsc" ? value : -value
  })
}

function pagePath(path: string, page: number) {
  return page <= 1 ? path : `${path.replace(/\/$/, "")}/page/${page}`
}

function hasNextPage(html: string, basePath: string, page: number, itemCount: number) {
  const nextPage = page + 1
  const normalized = basePath.replace(/\/$/, "")
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const markers = [
    new RegExp(`${escaped}/page/${nextPage}(?:[/\\s?#"']|$)`, "i"),
    new RegExp(`[?&](?:page|paged)=${nextPage}(?:[&#"']|$)`, "i"),
    new RegExp(`data-(?:page|next-page)=["']${nextPage}["']`, "i"),
  ]
  return itemCount >= 18 || markers.some(pattern => pattern.test(html))
}

async function requestGodamhHTML(path: string, selectedBase?: string) {
  let lastError: unknown
  const baseURLs = [...new Set([selectedBase, preferredHTMLBase, PRIMARY_BASE, MIRROR_BASE].filter((value): value is string => Boolean(value)))]
  for (const baseURL of baseURLs) {
    try {
      const html = await requestText(`${baseURL}${path}`, `${baseURL}/`)
      preferredHTMLBase = baseURL
      return { html, baseURL }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error("G站页面加载失败")
}

function base64Decode(input: string) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
  let output = ""
  let buffer = 0
  let bits = 0
  for (const char of input.replace(/\s+/g, "")) {
    if (char === "=") break
    const value = chars.indexOf(char)
    if (value < 0) continue
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      output += String.fromCharCode((buffer >> bits) & 0xff)
    }
  }
  return output
}

function base64Encode(input: string) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
  let output = ""
  for (let index = 0; index < input.length; index += 3) {
    const a = input.charCodeAt(index) & 0xff
    const b = index + 1 < input.length ? input.charCodeAt(index + 1) & 0xff : NaN
    const c = index + 2 < input.length ? input.charCodeAt(index + 2) & 0xff : NaN
    output += chars[a >> 2]
    output += chars[((a & 3) << 4) | (Number.isNaN(b) ? 0 : b >> 4)]
    output += Number.isNaN(b) ? "=" : chars[((b & 15) << 2) | (Number.isNaN(c) ? 0 : c >> 6)]
    output += Number.isNaN(c) ? "=" : chars[c & 63]
  }
  return output
}

async function initializeDecoder(): Promise<{ r: (cipher: string) => Promise<any[]> }> {
  const globalObject = globalThis as any
  if (typeof globalObject.__cimg?.r === "function") return globalObject.__cimg

  const locationShim = {
    hostname: "baozimh.org",
    host: "baozimh.org",
    origin: "https://baozimh.org",
    href: "https://baozimh.org/",
    protocol: "https:",
  }

  try { globalObject.window = globalObject } catch { /* readonly host global */ }
  try { globalObject.self = globalObject } catch { /* readonly host global */ }
  try { globalObject.location = locationShim } catch {
    try { Object.defineProperty(globalObject, "location", { value: locationShim, configurable: true }) } catch { /* no-op */ }
  }
  try {
    if (globalObject.window) globalObject.window.location = locationShim
  } catch { /* readonly location */ }
  if (typeof globalObject.atob !== "function") globalObject.atob = base64Decode
  if (typeof globalObject.btoa !== "function") globalObject.btoa = base64Encode
  if (!globalObject.document) {
    globalObject.document = {
      createElement: () => ({ style: {}, appendChild: () => undefined, setAttribute: () => undefined }),
      createTextNode: (value: string) => value,
      getElementsByTagName: () => [{ appendChild: () => undefined }],
      head: { appendChild: () => undefined },
      body: { appendChild: () => undefined },
    }
  }

  let lastError: unknown
  for (const url of DECODER_URLS) {
    try {
      const code = await requestText(url, MIRROR_BASE)
      ;(0, eval)(code)
      if (typeof globalObject.__cimg?.r === "function") {
        globalObject.__godaDecoderReady = true
        return globalObject.__cimg
      }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error("G站图片解码器初始化失败")
}

function ensureDecoder(): Promise<{ r: (cipher: string) => Promise<any[]> }> {
  const globalObject = globalThis as any
  if (typeof globalObject.__cimg?.r === "function") return Promise.resolve(globalObject.__cimg)
  if (!decoderPromise) {
    decoderPromise = initializeDecoder().catch(error => {
      decoderPromise = null
      throw error
    })
  }
  return decoderPromise
}

export function isGodamhURL(value: string) {
  try {
    return /(?:^|\.)(?:godamh\.com|baozimh\.org|godamanga\.com)$/i.test(new URL(value.trim()).hostname)
  } catch {
    return false
  }
}

export function godamhSummaryFromURL(value: string): MangaSummary {
  const url = new URL(value.trim())
  const parts = url.pathname.split("/").filter(Boolean)
  const mangaIndex = parts.indexOf("manga")
  const slug = mangaIndex >= 0 ? parts[mangaIndex + 1] : ""
  if (!slug) throw new Error("G站网址应为 /manga/漫画路径 或章节页地址")
  return {
    sourceId: "godamh",
    id: slug,
    title: slug,
    coverURL: "",
    url: `${url.origin}/manga/${slug}`,
  }
}

export class GodamhSource implements MangaSource {
  id: string
  name: string
  baseURL: string
  categories: SourceCategory[]

  constructor(config?: { id: string; name: string; baseURL: string; categories: SourceCategory[] }) {
    this.id = config?.id ?? "godamh"
    this.name = config?.name ?? "G站漫画"
    this.baseURL = config?.baseURL ?? PRIMARY_BASE
    this.categories = config?.categories?.length ? config.categories : GODAMH_CATEGORIES
  }

  async browse(category: SourceCategory, page: number, sort: SourceSort): Promise<BrowsePage> {
    const path = pagePath(category.path, page)
    const { html, baseURL } = await requestGodamhHTML(path, this.baseURL)
    const items = sortItems(parseMangaCards(html, baseURL, this.id), sort)
    return { items, page, hasNext: hasNextPage(html, category.path, page, items.length) }
  }

  async search(query: string, page: number, sort: SourceSort): Promise<BrowsePage> {
    const encoded = encodeURIComponent(query.trim())
    if (!encoded) return { items: [], page: 1, hasNext: false }
    const basePath = `/s/${encoded}`
    const path = pagePath(basePath, page)
    const { html, baseURL } = await requestGodamhHTML(path, this.baseURL)
    const items = sortItems(parseMangaCards(html, baseURL, this.id), sort)
    return { items, page, hasNext: hasNextPage(html, basePath, page, items.length) }
  }

  async detail(manga: MangaSummary): Promise<MangaDetail> {
    const key = `${manga.sourceId}:${manga.id}:${this.baseURL}`
    return detailCache.get(key, async () => {
      const stored = loadCachedDetail(manga)
      if (stored) return stored

      void ensureDecoder().catch(() => undefined)
      const path = new URL(manga.url).pathname
      const { html, baseURL } = await requestGodamhHTML(path, this.baseURL)
      const mid = html.match(/data-mid=["'](\d+)["']/i)?.[1]
      if (!mid) throw new Error("未能从详情页取得漫画 ID")
      const apiHost = html.match(/data-api-host=["']([^"']+)["']/i)?.[1] ?? API_BASE
      const payload = await requestJSON<GodamhChapterResponse>(`${apiHost}/api/manga/get?mid=${mid}&mode=all`, manga.url)
      if (payload.code !== 200 || !payload.data) throw new Error("G站详情接口返回异常")

      const series = jsonLDObjects(html).find(item => item?.["@type"] === "ComicSeries")
      const rawAuthors = Array.isArray(series?.author) ? series.author : series?.author ? [series.author] : []
      const authors = rawAuthors.map((item: any) => typeof item === "string" ? item : item?.name).filter(Boolean)
      const genres = Array.isArray(series?.genre) ? series.genre : series?.genre ? [series.genre] : []
      const chapters = payload.data.chapters.map(item => ({
        id: item.id,
        slug: item.attributes.slug,
        title: item.attributes.title,
        order: Number(item.attributes.order ?? 0),
        updatedAt: item.attributes.updatedAt,
        url: `${baseURL}/manga/${payload.data.slug}/${item.attributes.slug}`,
      }))

      const detail: MangaDetail = {
        ...manga,
        id: payload.data.slug || manga.id,
        url: `${baseURL}/manga/${payload.data.slug || manga.id}`,
        title: payload.data.title || manga.title,
        coverURL: payload.data.cover || manga.coverURL,
        mid,
        description: payload.data.desc || series?.description || "暂无简介",
        authors,
        tags: genres.filter((item: unknown): item is string => typeof item === "string"),
        status: series?.creativeWorkStatus || (payload.data.status === "1" ? "已完结" : "连载中"),
        chapters,
      }
      setTimeout(() => saveCachedDetail(detail), 2000)
      return detail
    })
  }

  async pages(manga: MangaSummary, chapter: MangaChapter): Promise<string[]> {
    const key = `${manga.sourceId}:${manga.id}:${chapter.id}:${this.baseURL}`
    return pageCache.get(key, async () => {
      const stored = loadCachedPages(manga, chapter.id)
      if (stored?.length) return stored

      let mid = (manga as MangaDetail).mid
      if (!mid) mid = (await this.detail(manga)).mid
      if (!mid) throw new Error("缺少漫画 ID")
      const decoderTask = ensureDecoder()
      const payloadTask = requestJSON<GodamhPageResponse>(
        `${API_BASE}/api/v2/chapter/getinfo?m=${encodeURIComponent(mid)}&c=${encodeURIComponent(chapter.id)}`,
        chapter.url ?? manga.url,
      )
      const [payload, decoder] = await Promise.all([payloadTask, decoderTask])
      const images = payload.data?.info?.images
      if (payload.code !== 200 || !images?.images) throw new Error("章节图片接口返回异常")
      const decoded = await decoder.r(images.images)
      const cdn = images.line === 2 ? "https://c-nd2-1.6wm.top" : "https://c-nd3-1.6wm.top"
      const urls = decoded
        .map(item => typeof item === "string" ? item : item?.url)
        .filter((item): item is string => typeof item === "string" && item.length > 0)
        .map(item => /^https?:\/\//i.test(item) ? item : `${cdn}${item.startsWith("/") ? "" : "/"}${item}`)
      if (!urls.length) throw new Error("章节解密后没有图片")
      setTimeout(() => saveCachedPages(manga, chapter.id, urls), 300)
      return urls
    })
  }
}

export const GODAMH_SOURCE = new GodamhSource()

export const GODAMH_IMAGE_HEADERS = {
  "User-Agent": READER_UA,
  Referer: `${PRIMARY_BASE}/`,
}

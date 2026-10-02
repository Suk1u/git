import { fetch } from "scripting"
import type {
  BrowsePage,
  MangaChapter,
  MangaDetail,
  MangaSource,
  MangaSummary,
  SourceAccount,
  SourceCategory,
  SourceSort,
} from "../model"
import { AsyncCache } from "../cache"
import { requestImage } from "../net"
import { mapWithConcurrency, retryAsync } from "../async-utils"
import { loadCachedDetail, loadCachedPages, saveCachedDetail, saveCachedPages } from "../storage"

const PICA_API_KEY = "C69BAF41DA5ABD1FFEDC6D2FEA56B"
const PICA_SECRET_KEY = "~d}$Q7$eIni=V)9\\RK/P.RM4;9[7|@/CA}b~OW!3?EV`:<>M7pddUBL5n|0/*Cn"
const PICA_NONCE = "4ce7a7aa759b40f794d189a88b84aba8"
const PICA_HOSTS = ["https://picaapi.go2778.com/", "https://picaapi.picacomic.com/"]
const PICA_ACCOUNT_KEY = "liquid_manga_pica_account_v1"
const PICA_PAGE_CONCURRENCY = 3

export const PICA_CATEGORIES: SourceCategory[] = [
  { id: "latest", title: "最新上架", path: "latest", systemImage: "clock.fill" },
  { id: "likes", title: "最多喜欢", path: "likes", systemImage: "heart.fill" },
  { id: "views", title: "最多观看", path: "views", systemImage: "eye.fill" },
]

type PicaAuth = { email: string; token: string; host: string }
type PicaThumb = { fileServer?: string; path?: string; originalName?: string }
type PicaComic = {
  _id?: string
  id?: string
  title?: string
  author?: string
  categories?: string[]
  tags?: string[]
  pagesCount?: number
  epsCount?: number
  finished?: boolean
  likesCount?: number
  totalViews?: number
  thumb?: PicaThumb
  description?: string
  chineseTeam?: string
  updated_at?: string
  created_at?: string
}

declare const Keychain: {
  get(key: string): string | null
  set(key: string, value: string): boolean
  remove(key: string): boolean
}

function account(): PicaAuth | null {
  try {
    const value = JSON.parse(Keychain.get(PICA_ACCOUNT_KEY) || "{}")
    return value?.token && value?.host ? value as PicaAuth : null
  } catch { return null }
}

function storeAccount(value: PicaAuth) {
  Keychain.set(PICA_ACCOUNT_KEY, JSON.stringify(value))
}

function picaTimestamp() {
  return `${Math.floor(Date.now() / 1000)}`
}

function picaSignature(path: string, timestamp: string, method: "GET" | "POST") {
  const raw = `${path}${timestamp}${PICA_NONCE}${method}${PICA_API_KEY}`.toLowerCase()
  return Crypto.hmacSHA256(Data.fromString(raw)!, Data.fromString(PICA_SECRET_KEY)!).toHexString()
}

function queryPath(path: string, query?: Record<string, string | number | undefined>) {
  const pairs = Object.entries(query ?? {})
    .filter(([, value]) => value !== undefined && value !== null && `${value}` !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  return pairs.length ? `${path}?${pairs.join("&")}` : path
}

async function picaRequest<T>(path: string, options: {
  method?: "GET" | "POST"
  query?: Record<string, string | number | undefined>
  body?: Record<string, unknown>
  unauthenticated?: boolean
  host?: string
} = {}): Promise<T> {
  const method = options.method ?? "GET"
  const auth = account()
  if (!options.unauthenticated && !auth) throw new Error("请先登录嗶咔漫画")
  const requestPath = queryPath(path, method === "GET" ? options.query : undefined)
  const timestamp = picaTimestamp()
  const headers = {
    accept: "application/vnd.picacomic.com.v1+json",
    "User-Agent": "okhttp/3.8.1",
    "Content-Type": "application/json; charset=UTF-8",
    "api-key": PICA_API_KEY,
    "app-build-version": "45",
    "app-platform": "android",
    "app-uuid": "defaultUuid",
    "app-version": "2.2.1.3.3.4",
    nonce: PICA_NONCE,
    "app-channel": "1",
    time: timestamp,
    signature: picaSignature(requestPath, timestamp, method),
    authorization: auth?.token ?? "",
    "image-quality": "original",
  }
  const host = options.host || auth?.host || PICA_HOSTS[0]
  const response = await fetch(`${host.replace(/\/$/, "")}/${requestPath}`, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(options.body ?? {}) : undefined,
    timeout: 20,
  })
  const result = await response.json() as { code?: number; message?: string; data?: T }
  if (response.status === 401) {
    try { Keychain.remove(PICA_ACCOUNT_KEY) } catch { /* preserve primary API error */ }
    throw new Error("嗶咔登录已失效，请重新登录")
  }
  if (!response.ok || result.code !== 200) throw new Error(result.message || `嗶咔请求失败 (${response.status})`)
  return result.data as T
}

function imageURL(thumb?: PicaThumb) {
  const server = String(thumb?.fileServer ?? "").replace(/\/$/, "")
  const path = String(thumb?.path ?? "").replace(/^\//, "")
  if (/^https?:\/\//i.test(path)) return path
  if (!server || !path) return ""
  const base = /\/static$/i.test(server) ? server : `${server}/static`
  return `${base}/${path}`.replace(/([^:]\/)(\/)+/g, "$1")
}

function toSummary(sourceId: string, comic: PicaComic, baseURL = PICA_HOSTS[0]): MangaSummary {
  const id = String(comic._id ?? comic.id ?? "")
  return {
    sourceId,
    id,
    title: String(comic.title ?? "未命名漫画"),
    coverURL: imageURL(comic.thumb),
    url: `${baseURL.replace(/\/$/, "")}/comics/${encodeURIComponent(id)}`,
    subtitle: String(comic.author ?? "未知作者"),
  }
}

function sortPath(category: SourceCategory, sort: SourceSort) {
  if (category.path === "likes") return "ld"
  if (category.path === "views") return "vd"
  return sort === "titleAsc" || sort === "titleDesc" ? "dd" : "dd"
}

export class PicaSource implements MangaSource {
  id: string
  name: string
  baseURL: string
  categories: SourceCategory[]
  supportsLogin = true
  private detailCache = new AsyncCache<MangaDetail>(20, 30 * 60 * 1000)
  private pagesCache = new AsyncCache<string[]>(80, 60 * 60 * 1000)

  constructor(config?: { id?: string; name?: string; baseURL?: string; categories?: SourceCategory[] }) {
    this.id = config?.id ?? "pica"
    this.name = config?.name ?? "嗶咔漫画"
    this.baseURL = config?.baseURL ?? PICA_HOSTS[0].replace(/\/$/, "")
    this.categories = config?.categories?.length ? config.categories : PICA_CATEGORIES
  }

  isLoggedIn() { return Boolean(account()) }
  savedLoginIdentifier() { return account()?.email ?? "" }
  async loadAccount(): Promise<SourceAccount> {
    const value = account()
    if (!value) throw new Error("尚未登录嗶咔漫画")
    return { identifier: value.email, label: value.email }
  }
  async login(identifier: string, password: string): Promise<SourceAccount> {
    let lastError: unknown
    for (const host of PICA_HOSTS) {
      try {
        const old = account()
        if (old?.host !== host) storeAccount({ email: identifier, token: "", host })
        let token: { token?: string } | null = null
        let loginError: unknown
        for (const body of [{ username: identifier, password }, { email: identifier, password }]) {
          try {
            token = await picaRequest<{ token?: string }>("auth/sign-in", {
              method: "POST",
              unauthenticated: true,
              host,
              body,
            })
            break
          } catch (error) { loginError = error }
        }
        if (!token?.token) throw loginError instanceof Error ? loginError : new Error("嗶咔登录未返回令牌")
        storeAccount({ email: identifier, token: token.token, host })
        return { identifier, label: identifier }
      } catch (error) { lastError = error }
    }
    try { Keychain.remove(PICA_ACCOUNT_KEY) } catch { /* no-op */ }
    throw lastError instanceof Error ? lastError : new Error("嗶咔登录失败")
  }
  async logout() { try { Keychain.remove(PICA_ACCOUNT_KEY) } catch { /* no-op */ } }

  async browse(category: SourceCategory, page: number, sort: SourceSort): Promise<BrowsePage> {
    const data = await picaRequest<{ comics?: { docs?: PicaComic[]; page?: number; pages?: number } }>("comics", {
      query: { page, s: sortPath(category, sort) },
    })
    const comics = data.comics ?? {}
    return {
      items: (comics.docs ?? []).map(comic => toSummary(this.id, comic, this.baseURL)).filter(item => item.id),
      page: Number(comics.page ?? page),
      hasNext: Number(comics.page ?? page) < Number(comics.pages ?? 1),
    }
  }

  async search(query: string, page: number, _sort: SourceSort): Promise<BrowsePage> {
    const data = await picaRequest<{ comics?: { docs?: PicaComic[]; page?: number; pages?: number } }>(`comics/advanced-search?page=${page}`, {
      method: "POST",
      body: { keyword: query.trim(), sort: "dd" },
    })
    const comics = data.comics ?? {}
    return {
      items: (comics.docs ?? []).map(comic => toSummary(this.id, comic, this.baseURL)).filter(item => item.id),
      page: Number(comics.page ?? page),
      hasNext: Number(comics.page ?? page) < Number(comics.pages ?? 1),
    }
  }

  async detail(manga: MangaSummary): Promise<MangaDetail> {
    return this.detailCache.get(manga.id, async () => {
      const stored = loadCachedDetail(manga)
      if (stored) return stored
      const data = await picaRequest<{ comic?: PicaComic }>(`comics/${encodeURIComponent(manga.id)}`)
      const comic = data.comic ?? {}
      const first = await picaRequest<{ eps?: { docs?: Array<{ _id?: string; id?: string; title?: string; order?: number; updated_at?: string }>; pages?: number } }>(`comics/${encodeURIComponent(manga.id)}/eps`, { query: { page: 1 } })
      const eps = first.eps ?? {}
      const rest = await mapWithConcurrency(
        Array.from({ length: Math.max(0, Number(eps.pages ?? 1) - 1) }, (_, index) => index + 2),
        PICA_PAGE_CONCURRENCY,
        page => retryAsync(() => picaRequest<{ eps?: { docs?: any[] } }>(`comics/${encodeURIComponent(manga.id)}/eps`, { query: { page } }), { attempts: 3, delayMs: 250 }),
      )
      const rawChapters = [...(eps.docs ?? []), ...rest.flatMap(entry => entry.eps?.docs ?? [])]
      const detail: MangaDetail = {
        ...toSummary(this.id, comic, this.baseURL),
        url: manga.url,
        description: String(comic.description ?? "暂无简介"),
        authors: [String(comic.author ?? "未知作者")],
        tags: [...(comic.categories ?? []), ...(comic.tags ?? [])].map(String).filter(Boolean),
        status: comic.finished ? "已完结" : "连载中",
        chapters: rawChapters.map((chapter, index) => ({
          id: String(chapter._id ?? chapter.id ?? index),
          slug: String(chapter._id ?? chapter.id ?? index),
          title: String(chapter.title ?? `第 ${Number(chapter.order ?? index + 1)} 话`),
          order: Number(chapter.order ?? index + 1),
          updatedAt: String(chapter.updated_at ?? ""),
        })).sort((left, right) => left.order - right.order),
      }
      saveCachedDetail(detail)
      return detail
    })
  }

  async pages(manga: MangaSummary, chapter: MangaChapter): Promise<string[]> {
    return this.pagesCache.get(`${manga.id}:${chapter.id}`, async () => {
      const stored = loadCachedPages(manga, chapter.id)
      if (stored?.length) return stored
      const first = await picaRequest<{ pages?: { docs?: Array<{ media?: PicaThumb }>; pages?: number } }>(`comics/${encodeURIComponent(manga.id)}/order/${chapter.order}/pages`, { query: { page: 1 } })
      const pages = first.pages ?? {}
      const rest = await mapWithConcurrency(
        Array.from({ length: Math.max(0, Number(pages.pages ?? 1) - 1) }, (_, index) => index + 2),
        PICA_PAGE_CONCURRENCY,
        page => retryAsync(() => picaRequest<{ pages?: { docs?: Array<{ media?: PicaThumb }> } }>(`comics/${encodeURIComponent(manga.id)}/order/${chapter.order}/pages`, { query: { page } }), { attempts: 3, delayMs: 250 }),
      )
      const urls = [...(pages.docs ?? []), ...rest.flatMap(entry => entry.pages?.docs ?? [])]
        .map(item => imageURL(item.media)).filter(Boolean)
      if (!urls.length) throw new Error("嗶咔章节没有返回图片")
      saveCachedPages(manga, chapter.id, urls)
      return urls
    })
  }

  async loadImage(url: string, manga: MangaSummary, _chapter: MangaChapter) {
    const fallback = url.includes("go2778.com")
      ? url.replace(/picaapi\.go2778\.com/gi, "picaapi.picacomic.com")
      : url.replace(/picaapi\.picacomic\.com/gi, "picaapi.go2778.com")
    try {
      return await requestImage(url, this.baseURL)
    } catch (firstError) {
      if (fallback === url) throw firstError
      return requestImage(fallback, this.baseURL)
    }
  }
}

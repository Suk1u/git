import { fetch } from "scripting"
import type {
  BrowsePage,
  MangaChapter,
  MangaDetail,
  MangaSource,
  MangaSummary,
  SavedSourceConfig,
  SourceAccount,
  SourceCategory,
  SourceSort,
} from "../model"

declare const Keychain: {
  get(key: string): string | null
  set(key: string, value: string): boolean
  remove(key: string): boolean
}
import { AsyncCache } from "../cache"
import { READER_UA } from "../net"
import { loadCachedDetail, loadCachedPages, saveCachedDetail, saveCachedPages } from "../storage"

const DISPLAY_BASE = "https://komiic.cc"
const API_BASE = "https://komiic.com"
const QUERY_URL = `${API_BASE}/api/query`
const LOGIN_URL = `${DISPLAY_BASE}/api/login`
const REFRESH_URL = `${DISPLAY_BASE}/auth/refresh`
const LOGOUT_URL = `${DISPLAY_BASE}/auth/logout`
const TOKEN_KEY = "liquid_manga_komiic_access_token_v1"
const COOKIE_KEY = "liquid_manga_komiic_cookie_v1"
const EMAIL_KEY = "liquid_manga_komiic_email_v1"
const PAGE_SIZE = 30

const COMIC_FIELDS = `
  id
  title
  status
  year
  imageUrl
  authors { id name }
  categories { id name }
  dateUpdated
  monthViews
  views
  favoriteCount
  lastBookUpdate
  lastChapterUpdate
`

const RECENT_QUERY = `query recentUpdate($pagination: Pagination!) {
  recentUpdate(pagination: $pagination) { ${COMIC_FIELDS} }
}`
const HOT_QUERY = `query hotComics($pagination: Pagination!) {
  hotComics(pagination: $pagination) { ${COMIC_FIELDS} }
}`
const RECOMMEND_QUERY = `query topRecommendedComics($period: RecommendationPeriod!, $pagination: Pagination!, $adult: Boolean) {
  topRecommendedComics(period: $period, pagination: $pagination, adult: $adult) { ${COMIC_FIELDS} }
}`
const CATEGORY_QUERY = `query comicByCategories($categoryId: [ID!]!, $pagination: Pagination!) {
  comicByCategories(categoryId: $categoryId, pagination: $pagination) { ${COMIC_FIELDS} }
}`
const SEARCH_QUERY = `query searchComicAndAuthorQuery($keyword: String!) {
  searchComicsAndAuthors(keyword: $keyword) {
    comics { ${COMIC_FIELDS} }
  }
}`
const COMIC_QUERY = `query comicById($comicId: ID!) {
  comicById(comicId: $comicId) { ${COMIC_FIELDS} dateCreated }
}`
const DETAIL_QUERY = `query comicDetailedInfo($comicId: ID!) {
  comicById(comicId: $comicId) { description otherTitles warnings }
}`
const CHAPTER_QUERY = `query chapterByComicId($comicId: ID!) {
  chaptersByComicId(comicId: $comicId) { id serial type dateCreated dateUpdated size }
}`
const IMAGE_QUERY = `query imagesByChapterId($chapterId: ID!) {
  imagesByChapterId(chapterId: $chapterId) { id kid height width }
}`
const ACCOUNT_QUERY = `query accountQuery {
  account {
    id email nickname dateCreated profileText profileTextColor profileBackgroundColor
    totalDonateAmount activeSubscriptionAmount profileImageUrl nextChapterMode ageVerified
    pendingEmail language
  }
}`

export const KOMIIC_CATEGORIES: SourceCategory[] = [
  { id: "recommended", title: "推荐", path: "komiic:recommended", systemImage: "hand.thumbsup.fill" },
  { id: "popular", title: "热门", path: "komiic:popular", systemImage: "flame.fill" },
  { id: "updated", title: "最近更新", path: "komiic:updated", systemImage: "clock.fill" },
]

type KomiicComic = {
  id: string
  title: string
  status?: string
  year?: number
  imageUrl?: string
  authors?: Array<{ id: string; name: string }>
  categories?: Array<{ id: string; name: string }>
  dateUpdated?: string
  lastBookUpdate?: string
  lastChapterUpdate?: string
}

type KomiicChapter = {
  id: string
  serial: string
  type: string
  dateCreated?: string
  dateUpdated?: string
  size?: number
}

export type KomiicAccount = {
  id: string
  email: string
  nickname: string
  dateCreated?: string
  profileText?: string
  profileTextColor?: string
  profileBackgroundColor?: string
  totalDonateAmount?: number
  activeSubscriptionAmount?: number
  profileImageUrl?: string
  nextChapterMode?: string
  ageVerified?: boolean
  pendingEmail?: string
  language?: string
}

type StoredCookie = {
  name: string
  value: string
  domain: string
  path: string
  isSecure: boolean
  isHTTPOnly: boolean
  isSessionOnly: boolean
  expiresDate?: string | null
}

type GraphQLResponse<T> = {
  data?: T | null
  errors?: Array<{ message?: string; path?: string[] }>
}

const detailCache = new AsyncCache<MangaDetail>(24, 30 * 60 * 1000)
const pageCache = new AsyncCache<string[]>(80, 60 * 60 * 1000)

function keychainGet(key: string) {
  try { return Keychain.get(key) } catch { return null }
}

function keychainSet(key: string, value: string) {
  try { Keychain.set(key, value) } catch { /* Keychain unavailable on an old host */ }
}

function keychainRemove(key: string) {
  try { Keychain.remove(key) } catch { /* Keychain unavailable on an old host */ }
}

function storedCookies(): StoredCookie[] {
  try {
    const raw = keychainGet(COOKIE_KEY)
    const values = raw ? JSON.parse(raw) : []
    if (!Array.isArray(values)) return []
    return values.filter(item => item && typeof item.name === "string" && typeof item.value === "string")
  } catch {
    return []
  }
}

function saveCookies(cookies: any[]) {
  if (!cookies.length) return
  const merged = new Map(storedCookies().map(cookie => [cookie.name, cookie]))
  for (const cookie of cookies) {
    if (!cookie?.name) continue
    if (!cookie.value) merged.delete(cookie.name)
    else merged.set(cookie.name, {
      name: String(cookie.name),
      value: String(cookie.value),
      domain: String(cookie.domain ?? "komiic.com"),
      path: String(cookie.path ?? "/"),
      isSecure: Boolean(cookie.isSecure),
      isHTTPOnly: Boolean(cookie.isHTTPOnly),
      isSessionOnly: Boolean(cookie.isSessionOnly),
      expiresDate: cookie.expiresDate ? new Date(cookie.expiresDate).toISOString() : null,
    })
  }
  keychainSet(COOKIE_KEY, JSON.stringify(Array.from(merged.values())))
}

function cookieHeader() {
  return storedCookies()
    .filter(cookie => !cookie.expiresDate || new Date(cookie.expiresDate).getTime() > Date.now())
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join("; ")
}

function accessToken() {
  return keychainGet(TOKEN_KEY) || storedCookies().find(cookie => cookie.name === "komiic-access-token")?.value || ""
}

function clearAuth() {
  keychainRemove(TOKEN_KEY)
  keychainRemove(COOKIE_KEY)
}

function authHeaders(extra: Record<string, string> = {}) {
  const token = accessToken()
  const cookies = cookieHeader()
  return {
    "User-Agent": READER_UA,
    Accept: "application/json,text/plain,*/*",
    "Content-Type": "application/json",
    Origin: DISPLAY_BASE,
    Referer: `${DISPLAY_BASE}/`,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(cookies ? { Cookie: cookies } : {}),
    ...extra,
  }
}

function responseMessage(payload: any, fallback: string) {
  if (typeof payload?.error === "string") return payload.error
  if (typeof payload?.message === "string") return payload.message
  if (Array.isArray(payload?.errors) && payload.errors[0]?.message) return payload.errors[0].message
  return fallback
}

async function refreshKomiicSession() {
  const cookies = cookieHeader()
  if (!cookies) return false
  const response = await fetch(REFRESH_URL, {
    method: "POST",
    headers: authHeaders(),
    timeout: 20,
  })
  saveCookies((response as any).cookies ?? [])
  const token = ((response as any).cookies ?? []).find((cookie: any) => cookie?.name === "komiic-access-token")?.value
  if (token) keychainSet(TOKEN_KEY, token)
  return response.ok && Boolean(accessToken() || cookieHeader())
}

async function graphQL<T>(operationName: string, query: string, variables: Record<string, unknown> = {}, retryAuth = true) {
  const response = await fetch(QUERY_URL, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ operationName, query, variables }),
    timeout: 25,
  })
  saveCookies((response as any).cookies ?? [])
  let payload: GraphQLResponse<T>
  try { payload = await response.json() as GraphQLResponse<T> } catch { throw new Error(`Komiic 接口返回 HTTP ${response.status}`) }
  if (!response.ok || payload.errors?.length || !payload.data) {
    const message = responseMessage(payload, `Komiic 接口返回 HTTP ${response.status}`)
    if (retryAuth && /no token|token.*(?:expired|invalid)|unauth|未登录|登入/i.test(message)) {
      try {
        if (await refreshKomiicSession()) return await graphQL<T>(operationName, query, variables, false)
      } catch { /* fall through to the original authentication error */ }
      clearAuth()
    }
    throw new Error(/no token/i.test(message) ? "Komiic 邮箱或密码错误，或登录状态已失效" : message)
  }
  return payload.data
}

function sortItems(items: MangaSummary[], sort: SourceSort) {
  if (sort === "source") return items
  return [...items].sort((left, right) => {
    const value = left.title.localeCompare(right.title, "zh-Hans-CN")
    return sort === "titleAsc" ? value : -value
  })
}

function summary(item: KomiicComic, sourceId: string): MangaSummary {
  return {
    sourceId,
    id: String(item.id),
    title: item.title || `漫画 ${item.id}`,
    coverURL: item.imageUrl || "",
    url: `${DISPLAY_BASE}/comic/${item.id}`,
    subtitle: [item.authors?.map(author => author.name).join(" · "), item.lastChapterUpdate || item.lastBookUpdate].filter(Boolean).join(" · "),
  }
}

function statusName(status?: string) {
  if (/END|COMPLETE|FINISH/i.test(status ?? "")) return "已完结"
  if (/HIATUS|PAUSE/i.test(status ?? "")) return "暂停更新"
  return "连载中"
}

function chapterTitle(item: KomiicChapter) {
  const prefix = item.type === "book" ? "卷" : "话"
  return `${prefix} ${item.serial || item.id}`
}

function categoryId(path: string) {
  return path.match(/^komiic:category:(.+)$/)?.[1] ?? ""
}

export function isKomiicURL(value: string) {
  try {
    return /(?:^|\.)komiic\.(?:cc|com)$/i.test(new URL(value.trim()).hostname)
  } catch {
    return false
  }
}

export async function discoverKomiicCategories(): Promise<SourceCategory[]> {
  const data = await graphQL<{ allCategory: Array<{ id: string; name: string }> }>(
    "allCategory",
    "query allCategory { allCategory { id name } }",
  )
  const filters = (data.allCategory ?? [])
    .filter(item => item?.id && item?.name)
    .slice(0, 80)
    .map((item, index) => ({
      id: `category-${item.id}`,
      title: item.name,
      path: `komiic:category:${item.id}`,
      systemImage: ["tag.fill", "sparkles", "heart.fill", "bolt.fill", "book.closed.fill"][index % 5],
    }))
  return [...KOMIIC_CATEGORIES, ...filters]
}

export async function komiicLogin(email: string, password: string): Promise<KomiicAccount> {
  const response = await fetch(LOGIN_URL, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ email: email.trim(), password }),
    timeout: 25,
  })
  saveCookies((response as any).cookies ?? [])
  let payload: any = null
  try { payload = await response.json() } catch { /* login may only set HttpOnly cookies */ }
  if (!response.ok) throw new Error(responseMessage(payload, "登录失败，请检查邮箱和密码"))
  const token = typeof payload?.token === "string"
    ? payload.token
    : ((response as any).cookies ?? []).find((cookie: any) => cookie?.name === "komiic-access-token")?.value
  if (token) keychainSet(TOKEN_KEY, token)
  keychainSet(EMAIL_KEY, email.trim())
  try {
    return await loadKomiicAccount()
  } catch (error) {
    clearAuth()
    throw error
  }
}

export async function loadKomiicAccount(): Promise<KomiicAccount> {
  if (!accessToken() && !cookieHeader()) throw new Error("尚未登录 Komiic")
  const data = await graphQL<{ account: KomiicAccount }>("accountQuery", ACCOUNT_QUERY)
  if (!data.account || data.account.id === "0") throw new Error("Komiic 登录状态已失效")
  return data.account
}

export async function komiicLogout() {
  try {
    await fetch(LOGOUT_URL, {
      method: "POST",
      headers: authHeaders(),
      timeout: 20,
    })
  } catch {
    // Local logout must still succeed if the network is unavailable.
  } finally {
    clearAuth()
  }
}

export function komiicSavedEmail() {
  return keychainGet(EMAIL_KEY) ?? ""
}

export function hasKomiicSession() {
  return Boolean(accessToken() || cookieHeader())
}

export function komiicImageHeaders(mangaId: string, chapterId: string) {
  return {
    "User-Agent": READER_UA,
    Referer: `${API_BASE}/comic/${mangaId}/chapter/${chapterId}`,
  }
}

export class KomiicSource implements MangaSource {
  id: string
  name: string
  baseURL: string
  categories: SourceCategory[]
  supportsLogin = true

  constructor(config?: Pick<SavedSourceConfig, "id" | "name" | "baseURL" | "categories">) {
    this.id = config?.id ?? "site:komiic-cc"
    this.name = config?.name ?? "Komiic 漫画"
    this.baseURL = config?.baseURL ?? DISPLAY_BASE
    this.categories = config?.categories?.length ? config.categories : KOMIIC_CATEGORIES
  }

  isLoggedIn() {
    return hasKomiicSession()
  }

  savedLoginIdentifier() {
    return komiicSavedEmail()
  }

  async loadAccount(): Promise<SourceAccount> {
    const account = await loadKomiicAccount()
    return { label: account.nickname || "Komiic 用户", identifier: account.email }
  }

  async login(identifier: string, password: string): Promise<SourceAccount> {
    const account = await komiicLogin(identifier, password)
    return { label: account.nickname || "Komiic 用户", identifier: account.email }
  }

  async logout() {
    await komiicLogout()
  }

  async browse(category: SourceCategory, page: number, sort: SourceSort): Promise<BrowsePage> {
    const pagination = {
      limit: PAGE_SIZE,
      offset: Math.max(0, page - 1) * PAGE_SIZE,
      orderBy: category.id === "popular" ? "MONTH_VIEWS" : "DATE_UPDATED",
      status: "",
      asc: false,
    }
    let comics: KomiicComic[] = []
    if (category.id === "recommended") {
      comics = (await graphQL<{ topRecommendedComics: KomiicComic[] }>("topRecommendedComics", RECOMMEND_QUERY, {
        period: "WEEK",
        pagination,
        adult: false,
      })).topRecommendedComics ?? []
    } else if (category.id === "popular") {
      comics = (await graphQL<{ hotComics: KomiicComic[] }>("hotComics", HOT_QUERY, { pagination })).hotComics ?? []
    } else if (category.id === "updated") {
      comics = (await graphQL<{ recentUpdate: KomiicComic[] }>("recentUpdate", RECENT_QUERY, { pagination })).recentUpdate ?? []
    } else {
      const id = categoryId(category.path)
      if (!id) throw new Error("Komiic 分类标识无效")
      comics = (await graphQL<{ comicByCategories: KomiicComic[] }>("comicByCategories", CATEGORY_QUERY, {
        categoryId: [id],
        pagination,
      })).comicByCategories ?? []
    }
    const items = sortItems(comics.map(item => summary(item, this.id)), sort)
    return { items, page, hasNext: comics.length >= PAGE_SIZE }
  }

  async search(query: string, page: number, sort: SourceSort): Promise<BrowsePage> {
    const keyword = query.trim()
    if (!keyword) return { items: [], page: 1, hasNext: false }
    const data = await graphQL<{ searchComicsAndAuthors: { comics: KomiicComic[] } }>(
      "searchComicAndAuthorQuery",
      SEARCH_QUERY,
      { keyword },
    )
    const all = data.searchComicsAndAuthors?.comics ?? []
    const offset = Math.max(0, page - 1) * PAGE_SIZE
    const items = sortItems(all.slice(offset, offset + PAGE_SIZE).map(item => summary(item, this.id)), sort)
    return { items, page, hasNext: offset + PAGE_SIZE < all.length }
  }

  async detail(manga: MangaSummary): Promise<MangaDetail> {
    const key = `${manga.sourceId}:${manga.id}`
    return detailCache.get(key, async () => {
      const stored = loadCachedDetail(manga)
      if (stored) return stored
      const [comicData, detailData, chapterData] = await Promise.all([
        graphQL<{ comicById: KomiicComic }>("comicById", COMIC_QUERY, { comicId: manga.id }),
        graphQL<{ comicById: { description?: string; otherTitles?: string[]; warnings?: string[] } }>("comicDetailedInfo", DETAIL_QUERY, { comicId: manga.id }),
        graphQL<{ chaptersByComicId: KomiicChapter[] }>("chapterByComicId", CHAPTER_QUERY, { comicId: manga.id }),
      ])
      const comic = comicData.comicById
      if (!comic) throw new Error("Komiic 没有返回漫画详情")
      const chapters = (chapterData.chaptersByComicId ?? []).map((item, index) => ({
        id: item.id,
        slug: item.id,
        title: chapterTitle(item),
        order: index,
        updatedAt: item.dateUpdated,
        url: `${DISPLAY_BASE}/comic/${comic.id}/chapter/${item.id}`,
      }))
      const description = detailData.comicById?.description?.trim()
      const otherTitles = detailData.comicById?.otherTitles ?? []
      const warnings = detailData.comicById?.warnings ?? []
      const detail: MangaDetail = {
        ...manga,
        title: comic.title || manga.title,
        coverURL: comic.imageUrl || manga.coverURL,
        url: `${DISPLAY_BASE}/comic/${comic.id}`,
        description: description || (otherTitles.length ? `其他名称：${otherTitles.join("、")}` : "暂无简介"),
        authors: (comic.authors ?? []).map(author => author.name).filter(Boolean),
        tags: [...(comic.categories ?? []).map(item => item.name), ...warnings].filter(Boolean),
        status: statusName(comic.status),
        chapters,
      }
      setTimeout(() => saveCachedDetail(detail), 500)
      return detail
    })
  }

  async loadImage(url: string, _manga: MangaSummary, _chapter: MangaChapter) {
    const response = await fetch(url, {
      headers: authHeaders({ Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" }),
      timeout: 30,
    })
    if (!response.ok) throw new Error(`Komiic 图片请求失败 (${response.status})`)
    const image = UIImage.fromData(await response.data())
    if (!image) throw new Error("Komiic 图片无法解码")
    return image
  }

  async pages(manga: MangaSummary, chapter: MangaChapter): Promise<string[]> {
    const key = `${manga.sourceId}:${manga.id}:${chapter.id}`
    return pageCache.get(key, async () => {
      const stored = loadCachedPages(manga, chapter.id)
      if (stored?.length) return stored
      const data = await graphQL<{ imagesByChapterId: Array<{ id: string; kid: string }> }>(
        "imagesByChapterId",
        IMAGE_QUERY,
        { chapterId: chapter.id },
      )
      const urls = (data.imagesByChapterId ?? [])
        .filter(item => item?.kid)
        .map(item => `${API_BASE}/api/image/${encodeURIComponent(item.kid)}`)
      if (!urls.length) throw new Error("Komiic 没有返回章节图片")
      setTimeout(() => saveCachedPages(manga, chapter.id, urls), 300)
      return urls
    })
  }
}

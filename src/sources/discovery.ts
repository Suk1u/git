import type { SavedSourceConfig, SourceCategory } from "../model"
import { decodeHTML, parseMangaCards, stripTags } from "../html"
import { requestText } from "../net"
import { isCopy3000URL } from "./copy3000"
import { isGodamhURL } from "./godamh"
import { discoverKomiicCategories, isKomiicURL } from "./komiic"
import { isMyComicURL, MYCOMIC_CATEGORIES } from "./mycomic"

function normalizeSiteURL(value: string) {
  try {
    const parsed = new URL(value.trim())
    if (!/^https?:$/i.test(parsed.protocol)) throw new Error()
    return parsed.origin
  } catch {
    throw new Error("图源地址必须是网站首页，例如 https://copy3000.com")
  }
}

function sourceID(origin: string) {
  const host = new URL(origin).hostname.toLowerCase().replace(/^www\./, "")
  return `site:${host.replace(/[^a-z0-9]+/g, "-")}`
}

function siteName(html: string, origin: string) {
  const meta = html.match(/<meta[^>]+(?:property|name)=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:site_name["']/i)?.[1]
  const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
  return decodeHTML(meta || title.split(/\s*[-|｜]\s*/)[0] || new URL(origin).hostname).trim()
}

function categoryIcon(index: number) {
  const icons = ["square.grid.2x2.fill", "flame.fill", "clock.fill", "sparkles", "heart.fill", "bolt.fill", "book.closed.fill", "globe"]
  return icons[index % icons.length]
}

function uniqueCategories(items: Array<{ title: string; path: string }>, fallbackPath: string) {
  const seen = new Set<string>()
  const categories: SourceCategory[] = []
  for (const item of items) {
    const title = item.title.replace(/^#+/, "").trim()
    if (!title || title.length > 18 || seen.has(item.path)) continue
    seen.add(item.path)
    categories.push({ id: `category-${categories.length}`, title, path: item.path, systemImage: categoryIcon(categories.length) })
    if (categories.length >= 80) break
  }
  if (!categories.length) categories.push({ id: "catalog", title: "目录", path: fallbackPath, systemImage: "square.grid.2x2.fill" })
  return categories
}

function extractCategoryLinks(html: string, origin: string) {
  const items: Array<{ title: string; path: string }> = []
  const pattern = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html))) {
    const title = stripTags(match[2])
    if (!title || /^(?:登录|登錄|注册|註冊|首页|首頁|返回|更多|查看更多)$/i.test(title)) continue
    const href = decodeHTML(match[1])
    let url: URL
    try { url = new URL(href, origin) } catch { continue }
    if (url.origin !== origin) continue
    const marker = `${url.pathname}${url.search}`
    if (!/(?:\/comics?\b|\/manga(?:s)?\b|\/category\b|\/genre\b|\/tag\b|[?&](?:theme|genre|category|tag|type)=)/i.test(marker)) continue
    if (/\/comic\/[^/?#]+/i.test(url.pathname)) continue
    items.push({ title, path: `${url.pathname}${url.search}` })
  }
  return items
}

function detectSearchPath(html: string) {
  const input = html.match(/<input[^>]+(?:url|data-url|action)=["']([^"']*(?:search|s\/)[^"']*)["']/i)?.[1]
  if (input) return input.includes("{query}") ? input : `${input}{query}`
  const form = html.match(/<form[^>]+action=["']([^"']*(?:search|s\/)[^"']*)["'][^>]*>[\s\S]*?<input[^>]+name=["']([^"']+)["']/i)
  if (form) return `${form[1]}${form[1].includes("?") ? "&" : "?"}${form[2]}={query}`
  return "/search?q={query}"
}

function discoverLogin(html: string, origin: string) {
  const loginText = /(?:登录|登入|sign\s?in|log\s?in|account|会员)/i
  const passwordForm = /<form\b[^>]*>[\s\S]{0,900}?<input[^>]+type=["']password["']/i.test(html)
  const href = html.match(/<a[^>]+href=["']([^"']+)["'][^>]*>[^<]*(?:登录|登入|sign\s?in|log\s?in)[^<]*<\/a>/i)?.[1]
    ?? html.match(/href=["']([^"']*(?:login|signin|sign-in)[^"']*)["']/i)?.[1]
  if (passwordForm) return { loginDiscovery: "detected" as const, loginURL: origin }
  if (!loginText.test(html)) return { loginDiscovery: "none" as const, loginURL: undefined }
  if (!href) return { loginDiscovery: "manual" as const, loginURL: origin }
  try {
    const url = new URL(decodeHTML(href), origin)
    return url.origin === origin
      ? { loginDiscovery: "detected" as const, loginURL: url.toString() }
      : { loginDiscovery: "manual" as const, loginURL: origin }
  } catch {
    return { loginDiscovery: "manual" as const, loginURL: origin }
  }
}

function copy3000Categories(html: string) {
  const themes = extractCategoryLinks(html, "https://copy3000.com")
    .filter(item => /[?&]theme=/i.test(item.path))
  return uniqueCategories([
    { title: "推荐", path: "/recommend" },
    { title: "热门", path: "/comics?ordering=-popular" },
    { title: "最近更新", path: "/comics?ordering=-datetime_updated" },
    ...themes,
  ], "/recommend")
}

export async function discoverMangaSource(value: string): Promise<SavedSourceConfig> {
  const origin = normalizeSiteURL(value)
  const id = sourceID(origin)

  if (isMyComicURL(origin)) {
    return {
      id: "mycomic",
      adapter: "mycomic",
      name: "我的漫画 (MyComic)",
      baseURL: "https://mycomic.com",
      catalogPath: "/cn/comics?sort=-views",
      searchPath: "/cn/comics?q={query}",
      categories: MYCOMIC_CATEGORIES,
      loginDiscovery: "detected",
      loginURL: "https://mycomic.com/cn",
    }
  }

  if (isGodamhURL(origin)) {
    let home = ""
    try { home = await requestText(`${origin}/`, origin) } catch {
      home = await requestText("https://baozimh.org/", "https://baozimh.org")
    }
    const login = discoverLogin(home, origin)
    return {
      id,
      adapter: "godamh",
      name: siteName(home, origin) || "G站漫画",
      baseURL: origin,
      catalogPath: "/hots",
      searchPath: "/s/{query}",
      categories: [
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
      ],
      ...login,
    }
  }

  const home = await requestText(`${origin}/`, origin)
  const login = discoverLogin(home, origin)

  if (isCopy3000URL(origin)) {
    const catalogHTML = await requestText(`${origin}/comics`, origin)
    const items = parseMangaCards(catalogHTML, origin, id)
    if (!items.length) throw new Error("已识别为拷贝漫画，但目录页没有解析到漫画卡片")
    const categories = copy3000Categories(catalogHTML)
    return {
      id,
      adapter: "copy3000",
      name: siteName(home, origin) || "拷贝漫画",
      baseURL: origin,
      catalogPath: categories[0].path,
      searchPath: "/search?q={query}",
      categories,
      ...login,
    }
  }

  if (isKomiicURL(origin)) {
    const categories = await discoverKomiicCategories()
    return {
      id,
      adapter: "komiic",
      name: siteName(home, origin) || "Komiic 漫画",
      baseURL: origin,
      catalogPath: categories[0]?.path ?? "komiic:recommended",
      searchPath: "komiic:search",
      categories,
      loginDiscovery: "detected",
      loginURL: `${origin}/login`,
    }
  }

  const discovered = extractCategoryLinks(home, origin)
  const likelyCatalog = discovered[0]?.path || "/"
  let catalogHTML = home
  if (likelyCatalog !== "/") catalogHTML = await requestText(new URL(likelyCatalog, origin).toString(), origin)
  const items = parseMangaCards(catalogHTML, origin, id)
  if (!items.length) {
    throw new Error("自动分析未找到漫画卡片。该网站需要新增专用适配器，不能仅靠通用网页规则生成可阅读图源。")
  }
  const categories = uniqueCategories(discovered, likelyCatalog)
  return {
    id,
    adapter: "generic",
    name: siteName(home, origin),
    baseURL: origin,
    catalogPath: categories[0].path,
    searchPath: detectSearchPath(home),
    categories,
    ...login,
  }
}

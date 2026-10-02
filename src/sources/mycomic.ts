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
import {
  absoluteURL,
  decodeHTML,
  metaContent,
  stripTags,
} from "../html"
import { requestText } from "../net"
import { loadCachedDetail, loadCachedPages, saveCachedDetail, saveCachedPages } from "../storage"

const MYCOMIC_ID = "mycomic"
const MYCOMIC_BASE = "https://mycomic.com"
const MYCOMIC_DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"

export const MYCOMIC_CATEGORIES: SourceCategory[] = [
  { id: "popular", title: "最高人气", path: "/cn/comics?sort=-views", systemImage: "flame.fill" },
  { id: "updated", title: "最近更新", path: "/cn/comics?sort=-update", systemImage: "clock.fill" },
  { id: "newest", title: "最新上架", path: "/cn/comics", systemImage: "sparkles" },
  { id: "rank", title: "排行榜", path: "/cn/rank", systemImage: "chart.bar.fill" },
  { id: "jp", title: "日漫", path: "/cn/comics?filter[country]=japan", systemImage: "globe.asia.australia" },
  { id: "kr", title: "韩漫", path: "/cn/comics?filter[country]=korea", systemImage: "flag.fill" },
  { id: "cn", title: "国漫", path: "/cn/comics?filter[country]=china", systemImage: "book.closed.fill" },
  { id: "rexue", title: "热血", path: "/cn/comics?filter[tag]=rexue", systemImage: "bolt.fill" },
  { id: "maoxian", title: "冒险", path: "/cn/comics?filter[tag]=maoxian", systemImage: "figure.walk" },
  { id: "aiqing", title: "爱情", path: "/cn/comics?filter[tag]=aiqing", systemImage: "heart.fill" },
  { id: "gaoxiao", title: "搞笑", path: "/cn/comics?filter[tag]=gaoxiao", systemImage: "face.smiling" },
  { id: "kehuan", title: "科幻", path: "/cn/comics?filter[tag]=kehuan", systemImage: "cpu.fill" },
  { id: "xuanyi", title: "悬疑", path: "/cn/comics?filter[tag]=xuanyi", systemImage: "magnifyingglass" },
  { id: "danmei", title: "耽美", path: "/cn/comics?filter[tag]=danmei", systemImage: "heart.circle" },
  { id: "baihe", title: "百合", path: "/cn/comics?filter[tag]=baihe", systemImage: "heart.circle.fill" },
]

export function isMyComicURL(value: string) {
  try {
    const hostname = new URL(value.trim()).hostname
    return /(?:^|\.)mycomic\.com$/i.test(hostname)
  } catch {
    return false
  }
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

function extractCoverURL(html: string): string {
  // 1. 优先提取 data-src（针对 Lozad 懒加载，避免被 data:image/png;base64 占位图截胡）
  const dataSrc = html.match(/data-src=["'](https?:\/\/[^"']+)["']/i)?.[1]
  if (dataSrc) return dataSrc
  // 2. 提取有效 http/https 开头的真实 src
  const src = html.match(/src=["'](https?:\/\/[^"']+)["']/i)?.[1]
  if (src && !src.startsWith("data:")) return src
  return ""
}

function parseCards(html: string, baseURL: string, sourceId: string): MangaSummary[] {
  const items: MangaSummary[] = []
  const seen = new Set<string>()

  // 1. Grid 卡片结构解析
  // 匹配形如: <a href="https://mycomic.com/cn/comics/1128"> ... <img ...> ... <div data-flux-subheading>ONE PIECE航海王</div>
  const cardBlockPattern = /<a[^>]+href=["'](?:https?:\/\/mycomic\.com)?(\/cn\/comics\/(\d+))["'][^>]*>([\s\S]*?)<\/a>[\s\S]{0,500}?(?:<div[^>]+data-flux-subheading[^>]*>([\s\S]*?)<\/div>|<p[^>]*>([\s\S]*?)<\/p>)?/gi
  let match: RegExpExecArray | null
  while ((match = cardBlockPattern.exec(html))) {
    const path = match[1]
    const id = match[2]
    if (seen.has(id)) continue
    const innerHTML = match[3]
    const outerTitle = stripTags(decodeHTML(match[4] || match[5] || "")).trim()
    const coverURL = extractCoverURL(innerHTML)
    const altTitle = innerHTML.match(/alt=["']([^"']+)["']/i)?.[1] || ""
    const subtitle = stripTags(decodeHTML(innerHTML.match(/<div[^>]+text-white[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "")).trim()
    const title = outerTitle || stripTags(decodeHTML(altTitle)).trim()

    if (title && coverURL) {
      seen.add(id)
      items.push({
        sourceId,
        id,
        title,
        coverURL: absoluteURL(baseURL, coverURL),
        url: `${baseURL}${path}`,
        subtitle: subtitle || undefined,
      })
    }
  }

  return items
}

export class MyComicSource implements MangaSource {
  id: string
  name: string
  baseURL: string
  categories: SourceCategory[]
  loginDiscovery: "detected" = "detected"
  loginURL: string
  supportsLogin = true

  private detailCache = new AsyncCache<MangaDetail>(24, 30 * 60 * 1000)
  private pageCache = new AsyncCache<string[]>(80, 60 * 60 * 1000)

  constructor(config: string | SavedSourceConfig = MYCOMIC_BASE) {
    if (typeof config === "string") {
      this.id = MYCOMIC_ID
      this.name = "我的漫画 (MyComic)"
      this.baseURL = normalizedURL(config).origin
      this.categories = MYCOMIC_CATEGORIES
    } else {
      this.id = config.id
      this.name = config.name
      this.baseURL = normalizedURL(config.baseURL).origin
      this.categories = config.categories.length ? config.categories : MYCOMIC_CATEGORIES
    }
    this.loginURL = `${this.baseURL}/cn`
  }

  async browse(category: SourceCategory, page: number, sort: SourceSort): Promise<BrowsePage> {
    const url = new URL(category.path, `${this.baseURL}/`)
    if (page > 1) {
      url.searchParams.set("page", String(page))
    }
    const html = await requestText(url.toString(), this.baseURL, { "User-Agent": MYCOMIC_DESKTOP_UA })
    const parsed = parseCards(html, this.baseURL, this.id)
    const items = sortItems(parsed, sort)
    const hasNext = html.includes(`page=${page + 1}`) || items.length >= 18
    return { items, page, hasNext }
  }

  async search(query: string, page: number, sort: SourceSort): Promise<BrowsePage> {
    const url = new URL("/cn/comics", `${this.baseURL}/`)
    url.searchParams.set("q", query.trim())
    if (page > 1) {
      url.searchParams.set("page", String(page))
    }
    const html = await requestText(url.toString(), `${this.baseURL}/cn`, { "User-Agent": MYCOMIC_DESKTOP_UA })
    const parsed = parseCards(html, this.baseURL, this.id)
    const items = sortItems(parsed, sort)
    const hasNext = html.includes(`page=${page + 1}`) || items.length >= 18
    return { items, page, hasNext }
  }

  async detail(manga: MangaSummary): Promise<MangaDetail> {
    const key = `${manga.sourceId}:${manga.id}:${this.baseURL}`
    return this.detailCache.get(key, async () => {
      const stored = loadCachedDetail(manga)
      if (stored && stored.chapters.length) return stored

      const detailURL = `${this.baseURL}/cn/comics/${encodeURIComponent(manga.id)}`
      const html = await requestText(detailURL, `${this.baseURL}/cn`, { "User-Agent": MYCOMIC_DESKTOP_UA })

      const rawTitle = metaContent(html, "og:title")
        || html.match(/<h[1-2][^>]*>([\s\S]*?)<\/h[1-2]>/i)?.[1]
        || manga.title
      const title = decodeHTML(rawTitle).replace(/\s*[-|]\s*MYCOMIC.*$/i, "").trim() || manga.title

      const coverURL = html.match(/data-src=["'](https?:\/\/[^"']*biccam\.com\/comics\/[^"'\s]+)["']/i)?.[1]
        || html.match(/src=["'](https?:\/\/[^"']*biccam\.com\/comics\/[^"'\s]+)["']/i)?.[1]
        || metaContent(html, "og:image")
        || manga.coverURL

      const description = metaContent(html, "og:description")
        || stripTags(decodeHTML(html.match(/(?:intro|description|summary)[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "")).trim()
        || "暂无简介"

      // 提取作者
      const authors: string[] = []
      const authorPattern = /filter(?:%5B|\[)author(?:%5D|\])=[^"'>]+["'][^>]*>([\s\S]*?)<\/a>/gi
      let match: RegExpExecArray | null
      while ((match = authorPattern.exec(html))) {
        const author = stripTags(decodeHTML(match[1])).trim()
        if (author && !authors.includes(author)) authors.push(author)
      }

      // 提取分类标签
      const tags: string[] = []
      const tagPattern = /filter(?:%5B|\[)(?:tag|genre|audience|country)(?:%5D|\])=[^"'>]+["'][^>]*>([\s\S]*?)<\/a>/gi
      while ((match = tagPattern.exec(html))) {
        const tag = stripTags(decodeHTML(match[1])).trim()
        if (tag && !tags.includes(tag) && tag.length < 20) tags.push(tag)
      }

      const status = /已完结/i.test(html) ? "已完结" : /连载中/i.test(html) ? "连载中" : "状态未知"

      // 提取真正属于当前漫画的专属章节列表
      // MyComic 将当前漫画章节列表存放在 Alpine.js 数据对象中:
      // chapters: [{"id":818150,"title":"\u7b2c07\u8bdd"}, ...],
      const chapters: MangaChapter[] = []
      const seenChapters = new Set<string>()

      const alpinePattern = /chapters:\s*(\[\s*\{[\s\S]*?\}\s*\])/gi
      let alpineMatch: RegExpExecArray | null
      while ((alpineMatch = alpinePattern.exec(html))) {
        try {
          const rawJSON = alpineMatch[1]
          const list = JSON.parse(rawJSON)
          if (Array.isArray(list)) {
            for (const item of list) {
              const chapterId = String(item.id ?? "").trim()
              if (!chapterId || seenChapters.has(chapterId)) continue
              seenChapters.add(chapterId)
              const chapterTitle = String(item.title ?? "").trim() || `第 ${chapters.length + 1} 话`
              chapters.push({
                id: chapterId,
                slug: chapterId,
                title: chapterTitle,
                order: chapters.length + 1,
                url: `${this.baseURL}/cn/chapters/${chapterId}`,
              })
            }
          }
        } catch {
          // ignore parse error and continue to next block
        }
      }

      // 如果未找到 Alpine.js 章节数据，后备方案：从“单话/章節”正文区后方提取链接，避开侧边栏推荐
      if (!chapters.length) {
        const danHuaIndex = html.indexOf("单话") !== -1
          ? html.indexOf("单话")
          : html.indexOf("章節") !== -1
          ? html.indexOf("章節")
          : html.indexOf("章节")
        const mainContent = danHuaIndex !== -1 ? html.slice(danHuaIndex) : html
        const chapterPattern = /<a[^>]+href=["'](?:https?:\/\/mycomic\.com)?(\/cn\/chapters\/(\d+))["'][^>]*>([\s\S]*?)<\/a>/gi
        while ((match = chapterPattern.exec(mainContent))) {
          const path = match[1]
          const chapterId = match[2]
          if (seenChapters.has(chapterId)) continue
          const chapterTitle = stripTags(decodeHTML(match[3])).trim()
          if (!chapterTitle || /^(?:开始阅读|上一话|下一话|返回目录|随机漫画)$/.test(chapterTitle)) continue
          seenChapters.add(chapterId)
          chapters.push({
            id: chapterId,
            slug: chapterId,
            title: chapterTitle,
            order: chapters.length + 1,
            url: `${this.baseURL}${path}`,
          })
        }
      }

      // 校准正序排列（第01话在前）
      if (chapters.length > 1) {
        const first = chapters[0].title
        const last = chapters[chapters.length - 1].title
        const firstNum = Number(first.match(/\d+/)?.[0] ?? 0)
        const lastNum = Number(last.match(/\d+/)?.[0] ?? 0)
        if (firstNum > lastNum && lastNum > 0) {
          chapters.reverse()
          chapters.forEach((c, i) => { c.order = i + 1 })
        }
      }

      const detail: MangaDetail = {
        ...manga,
        title,
        url: detailURL,
        coverURL: coverURL ? absoluteURL(this.baseURL, coverURL) : manga.coverURL,
        description,
        authors,
        tags,
        status,
        chapters,
      }

      setTimeout(() => saveCachedDetail(detail), 300)
      return detail
    })
  }

  async pages(manga: MangaSummary, chapter: MangaChapter): Promise<string[]> {
    const key = `${manga.sourceId}:${manga.id}:${chapter.id}:${this.baseURL}`
    return this.pageCache.get(key, async () => {
      const stored = loadCachedPages(manga, chapter.id)
      if (stored?.length) return stored

      if (!chapter.url) throw new Error("MyComic 章节缺少网页链接")
      const html = await requestText(chapter.url, manga.url || `${this.baseURL}/cn`, { "User-Agent": MYCOMIC_DESKTOP_UA })

      const urls: string[] = []
      const seen = new Set<string>()

      // 提取章节中的所有漫画图片（优先 data-src 避免获取到 1x1 占位图）
      const dataSrcMatches = [...html.matchAll(/data-src=["'](https?:\/\/[^"']*(?:biccam\.com|mycomic\.com)\/chapters\/[^"'\s]+)["']/gi)]
      for (const m of dataSrcMatches) {
        const url = m[1].trim()
        if (!seen.has(url)) {
          seen.add(url)
          urls.push(url)
        }
      }

      // 备用：匹配真实 src
      if (!urls.length) {
        const srcMatches = [...html.matchAll(/src=["'](https?:\/\/[^"']*(?:biccam\.com|mycomic\.com)\/chapters\/[^"'\s]+)["']/gi)]
        for (const m of srcMatches) {
          const url = m[1].trim()
          if (!seen.has(url) && !url.includes("data:image")) {
            seen.add(url)
            urls.push(url)
          }
        }
      }

      if (!urls.length) {
        throw new Error("未解析到漫画图片，请确认该章节是否可正常阅读，或点击右上角账号按钮完成安全验证。")
      }

      setTimeout(() => saveCachedPages(manga, chapter.id, urls), 300)
      return urls
    })
  }
}

export const MYCOMIC_SOURCE = new MyComicSource()

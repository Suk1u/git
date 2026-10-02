import type { MangaChapter, MangaSummary } from "./model"

export function decodeHTML(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
}

export function stripTags(value: string) {
  return decodeHTML(value.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
}

export function absoluteURL(baseURL: string, value: string) {
  try {
    return new URL(decodeHTML(value), baseURL).toString()
  } catch {
    return value
  }
}

export function metaContent(html: string, key: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escaped}["']`, "i"),
  ]
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match?.[1]) return decodeHTML(match[1]).trim()
  }
  return ""
}

export function jsonLDObjects(html: string): any[] {
  const result: any[] = []
  const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html))) {
    try {
      const parsed = JSON.parse(decodeHTML(match[1].trim()))
      if (Array.isArray(parsed)) result.push(...parsed)
      else if (parsed?.["@graph"] && Array.isArray(parsed["@graph"])) result.push(...parsed["@graph"])
      else result.push(parsed)
    } catch {
      // Ignore malformed analytics JSON-LD blocks.
    }
  }
  return result
}

function firstAttribute(block: string, names: string[]) {
  for (const name of names) {
    const match = block.match(new RegExp(`${name}=["']([^"']+)["']`, "i"))
    if (match?.[1]) return match[1]
  }
  return ""
}

export function parseMangaCards(html: string, baseURL: string, sourceId: string): MangaSummary[] {
  const items: MangaSummary[] = []
  const seen = new Set<string>()
  const anchorPattern = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = anchorPattern.exec(html))) {
    const href = absoluteURL(baseURL, match[1])
    if (!/\/(?:manga|comic|comics|title|book)\//i.test(new URL(href, baseURL).pathname)) continue
    const block = match[2]
    const image = block.match(/<img[^>]+(?:src|data-src|data-original)=["']([^"']+)["']/i)
    const heading = block.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)
    const title = stripTags(heading?.[1] ?? firstAttribute(block, ["title", "alt"]))
    const coverURL = image?.[1] ? absoluteURL(baseURL, image[1]) : ""
    if (!title || !coverURL || seen.has(href)) continue
    seen.add(href)
    const path = new URL(href, baseURL).pathname
    items.push({ sourceId, id: path.split("/").filter(Boolean).pop() ?? href, title, coverURL, url: href })
  }
  return items
}

export function parseGenericChapters(html: string, baseURL: string): MangaChapter[] {
  const chapters: MangaChapter[] = []
  const seen = new Set<string>()
  const pattern = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html))) {
    const url = absoluteURL(baseURL, match[1])
    const title = stripTags(match[2])
    if (!title || !/(?:chapter|chap|read|episode|第.{0,8}[话話章节節回卷])|\/(?:manga|comic)\/[^/]+\/[^/]+/i.test(`${url} ${title}`)) continue
    if (seen.has(url)) continue
    seen.add(url)
    chapters.push({ id: url, slug: url, title, order: chapters.length + 1, url })
  }
  return chapters
}

export function parseGenericImages(html: string, baseURL: string) {
  const images: string[] = []
  const seen = new Set<string>()
  const pattern = /<img[^>]+(?:data-src|data-original|src)=["']([^"']+)["'][^>]*>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html))) {
    const url = absoluteURL(baseURL, match[1])
    if (!/^https?:/i.test(url) || /(?:logo|avatar|icon|favicon|banner|ads?|cover)/i.test(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    images.push(url)
  }
  return images
}

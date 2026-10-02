import { fetch } from "scripting"
import { sourceCookieHeader } from "./auth"

declare const UIImage: {
  fromData(data: any): any | null
}

export const READER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"

export async function requestText(url: string, referer?: string, extraHeaders: Record<string, string> = {}) {
  const cookie = sourceCookieHeader(url)
  const response = await fetch(url, {
    headers: {
      "User-Agent": READER_UA,
      Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      ...(referer ? { Referer: referer } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...extraHeaders,
    },
    timeout: 25,
  })
  if (!response.ok) {
    if (response.status === 403) {
      const text = await response.text().catch(() => "")
      if (/Just a moment|Attention Required|Enable JavaScript and cookies/i.test(text)) {
        throw new Error("站点触发了 Cloudflare 验证，请点击右上角账号/验证按钮打开内置浏览器完成验证。")
      }
    }
    throw new Error(`HTTP ${response.status}: ${url}`)
  }
  const text = await response.text()
  if (/Just a moment|Enable JavaScript and cookies to continue/i.test(text)) {
    throw new Error("站点触发了 Cloudflare 验证，请点击右上角账号/验证按钮打开内置浏览器完成验证。")
  }
  return text
}

export async function requestImage(url: string, referer?: string, extraHeaders: Record<string, string> = {}) {
  const normalizedURL = url.trim()
  if (!/^https?:\/\//i.test(normalizedURL)) throw new Error(`无效图片地址: ${url}`)
  const cookie = sourceCookieHeader(normalizedURL)
  const response = await fetch(normalizedURL, {
    headers: {
      "User-Agent": READER_UA,
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      ...(referer ? { Referer: referer } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...extraHeaders,
    },
    timeout: 30,
  })
  if (!response.ok) throw new Error(`图片 HTTP ${response.status}: ${normalizedURL}`)
  const image = UIImage.fromData(await response.data())
  if (!image) throw new Error(`无法解码图片: ${normalizedURL}`)
  return image
}

export async function requestJSON<T>(url: string, referer?: string, extraHeaders: Record<string, string> = {}): Promise<T> {
  const cookie = sourceCookieHeader(url)
  const response = await fetch(url, {
    headers: {
      "User-Agent": READER_UA,
      Accept: "application/json,text/plain,*/*",
      ...(referer ? { Referer: referer } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...extraHeaders,
    },
    timeout: 25,
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`)
  return await response.json() as T
}

declare class WebViewController {
  constructor(options?: { ephemeral?: boolean })
  loadURL(url: string): Promise<void>
  present(options?: { fullscreen?: boolean; navigationTitle?: string }): Promise<void>
  getCookies(url: string): Promise<StoredCookie[]>
  dispose(): void
}

export type StoredCookie = {
  name: string
  value: string
  domain: string
  path?: string
  isSecure?: boolean
  isHTTPOnly?: boolean
  isSessionOnly?: boolean
  expiresDate?: string | null
}

declare const Keychain: {
  get(key: string): string | null
  set(key: string, value: string): boolean
  remove(key: string): boolean
}

function hostFor(url: string) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, "") } catch { return "" }
}

function keyFor(url: string) {
  return `liquid_manga_source_auth_${hostFor(url).replace(/[^a-z0-9.-]/g, "_")}`
}

function read(url: string): StoredCookie[] {
  try {
    const raw = Keychain.get(keyFor(url))
    const values = raw ? JSON.parse(raw) : []
    return Array.isArray(values) ? values.filter(item => item && typeof item.name === "string" && typeof item.value === "string") : []
  } catch {
    return []
  }
}

function write(url: string, values: StoredCookie[]) {
  try { Keychain.set(keyFor(url), JSON.stringify(values)) } catch { /* unavailable on older hosts */ }
}

function isActive(cookie: StoredCookie) {
  return !cookie.expiresDate || new Date(cookie.expiresDate).getTime() > Date.now()
}

function matchesHost(cookie: StoredCookie, host: string) {
  const domain = cookie.domain.replace(/^\./, "").toLowerCase()
  const value = host.toLowerCase()
  return value === domain || value.endsWith(`.${domain}`)
}

export function sourceCookieHeader(url: string) {
  let host = ""
  try { host = new URL(url).hostname } catch { return "" }
  return read(url)
    .filter(cookie => isActive(cookie) && matchesHost(cookie, host))
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join("; ")
}

export function sourceHasLogin(url: string) {
  return Boolean(sourceCookieHeader(url))
}

export function clearSourceLogin(url: string) {
  try { Keychain.remove(keyFor(url)) } catch { /* unavailable on older hosts */ }
}

export async function openSourceLogin(source: { name: string; baseURL: string; loginURL?: string }) {
  const url = source.loginURL || source.baseURL
  const controller = new WebViewController()
  try {
    await controller.loadURL(url)
    await controller.present({ fullscreen: true, navigationTitle: `${source.name} 登录` })
    const cookies = await controller.getCookies(source.baseURL) as StoredCookie[]
    const usable = cookies.filter(cookie => cookie && cookie.name && cookie.value)
    if (!usable.length) throw new Error("未检测到登录会话，请完成登录后再关闭浏览器。")
    write(source.baseURL, usable.map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      isSecure: Boolean(cookie.isSecure),
      isHTTPOnly: Boolean(cookie.isHTTPOnly),
      isSessionOnly: Boolean(cookie.isSessionOnly),
      expiresDate: cookie.expiresDate ? new Date(cookie.expiresDate).toISOString() : null,
    })))
    return usable.length
  } finally {
    controller.dispose()
  }
}

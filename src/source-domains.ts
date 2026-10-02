import type { SavedSourceConfig, SavedSourceDomainConfig } from "./model"

export function normalizeSourceOrigin(value: string) {
  const url = new URL(value.trim())
  if (!/^https?:$/i.test(url.protocol)) throw new Error("网址必须以 http:// 或 https:// 开头")
  return url.origin
}

function domainFromSource(source: SavedSourceConfig): SavedSourceDomainConfig {
  return {
    adapter: source.adapter,
    name: source.name,
    baseURL: normalizeSourceOrigin(source.baseURL),
    catalogPath: source.catalogPath,
    searchPath: source.searchPath,
    categories: source.categories,
    loginDiscovery: source.loginDiscovery,
    loginURL: source.loginURL,
  }
}

function normalizeDomain(domain: SavedSourceDomainConfig): SavedSourceDomainConfig | null {
  try {
    return {
      ...domain,
      baseURL: normalizeSourceOrigin(domain.baseURL),
      categories: Array.isArray(domain.categories) ? domain.categories : [],
    }
  } catch {
    return null
  }
}

export function sourceDomains(source: SavedSourceConfig) {
  const domains: SavedSourceDomainConfig[] = []
  const seen = new Set<string>()
  const candidates: SavedSourceDomainConfig[] = []
  try { candidates.push(domainFromSource(source)) } catch { /* malformed legacy source */ }
  if (Array.isArray(source.domains)) candidates.push(...source.domains)
  for (const candidate of candidates) {
    const domain = normalizeDomain(candidate)
    if (!domain) continue
    const key = domain.baseURL.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    domains.push(domain)
  }
  return domains
}

export function normalizeSourceDomains(source: SavedSourceConfig): SavedSourceConfig {
  const domains = sourceDomains(source)
  return { ...source, domains }
}

export function addSourceDomain(source: SavedSourceConfig, discovered: SavedSourceConfig) {
  if (source.adapter !== discovered.adapter) {
    throw new Error(`该网址识别为不同的网站类型（${discovered.adapter}），不能加入当前图源`)
  }
  const sourceName = source.name.replace(/\s+/g, "").toLowerCase()
  const discoveredName = discovered.name.replace(/\s+/g, "").toLowerCase()
  const categoryPaths = new Set(source.categories.map(category => category.path))
  const sharesCategory = discovered.categories.some(category => categoryPaths.has(category.path))
  const sharesRules = source.catalogPath === discovered.catalogPath && source.searchPath === discovered.searchPath
  if (source.adapter === "generic" && sourceName !== discoveredName && !sharesRules && !sharesCategory) {
    throw new Error(`该网址识别为“${discovered.name}”，与当前图源“${source.name}”的规则不一致`)
  }
  const domains = sourceDomains(source)
  const added = domainFromSource(discovered)
  const origin = added.baseURL.toLowerCase()
  if (domains.some(domain => domain.baseURL.toLowerCase() === origin)) {
    throw new Error("这个网址已经在源列表中")
  }
  return { ...source, domains: [...domains, added] }
}

export function selectSourceDomain(source: SavedSourceConfig, baseURL: string) {
  const origin = normalizeSourceOrigin(baseURL).toLowerCase()
  const domains = sourceDomains(source)
  const selected = domains.find(domain => domain.baseURL.toLowerCase() === origin)
  if (!selected) throw new Error("选择的源不存在，请重新添加")
  return {
    ...source,
    ...selected,
    id: source.id,
    name: source.name,
    domains,
  }
}

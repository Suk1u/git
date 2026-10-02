import { fetch } from "scripting"
import {
  JM_AUTH_KEY,
  JM_DATA_SECRET,
  JM_DOMAIN_REFRESH_SECRET,
  JM_DOMAIN_REFRESH_URLS,
  JM_PKG,
  JM_PREFERRED_IMAGE_SHUNTS,
  JM_UA,
  JM_VERSION,
  JM_WEB_URL,
} from "./jm-definitions"

export type JMApiContext = {
  domain: string
  cdnBase: string
}

type JMSettingResp = {
  img_host?: string
}

type JMDomainRefreshResp = {
  Server?: string[]
  server?: string[]
}

let jmApiContextCache: { value: JMApiContext; updatedAt: number } | null = null

const AES256_NR = 14
const JM_AES = (() => {
  const s = new Uint8Array(256)
  const inv = new Uint8Array(256)
  const rot8 = (x: number, n: number) => ((x << n) | (x >>> (8 - n))) & 255
  const mul = (a: number, b: number) => {
    let r = 0
    for (; b; b >>>= 1) {
      if (b & 1) r ^= a
      a = ((a << 1) ^ (a & 0x80 ? 0x11b : 0)) & 255
    }
    return r
  }
  const pow = (a: number, e: number) => {
    let r = 1
    while (e > 0) {
      if (e & 1) r = mul(r, a)
      a = mul(a, a)
      e >>>= 1
    }
    return r
  }
  for (let i = 0; i < 256; i++) {
    const x = i ? pow(i, 254) : 0
    const y = x ^ rot8(x, 1) ^ rot8(x, 2) ^ rot8(x, 3) ^ rot8(x, 4) ^ 0x63
    s[i] = y
    inv[y] = i
  }
  return { s, inv, mul }
})()

export const jmMd5Hex = (value: string): string => {
  const data = Data.fromRawString(value, "utf-8")
  if (!data) throw new Error("JM 数据编码失败")
  return Crypto.md5(data).toHexString()
}

const jmAsciiBytes = (value: string): Uint8Array => {
  const data = Data.fromRawString(value, "ascii")
  const bytes = data?.toUint8Array()
  if (!bytes) throw new Error("JM ASCII 编码失败")
  return bytes
}

const jmExpandKey256 = (key: Uint8Array): Uint8Array => {
  if (key.length !== 32) throw new Error("JM AES key 长度异常")
  const w = new Uint8Array(16 * (AES256_NR + 1))
  w.set(key)
  let i = 32
  let rcon = 1
  let t0 = 0
  let t1 = 0
  let t2 = 0
  let t3 = 0
  while (i < w.length) {
    t0 = w[i - 4]
    t1 = w[i - 3]
    t2 = w[i - 2]
    t3 = w[i - 1]
    if (i % 32 === 0) {
      const a = t0
      t0 = JM_AES.s[t1] ^ rcon
      t1 = JM_AES.s[t2]
      t2 = JM_AES.s[t3]
      t3 = JM_AES.s[a]
      rcon = JM_AES.mul(rcon, 2)
    } else if (i % 32 === 16) {
      t0 = JM_AES.s[t0]
      t1 = JM_AES.s[t1]
      t2 = JM_AES.s[t2]
      t3 = JM_AES.s[t3]
    }
    w[i] = w[i - 32] ^ t0; i += 1
    w[i] = w[i - 32] ^ t1; i += 1
    w[i] = w[i - 32] ^ t2; i += 1
    w[i] = w[i - 32] ^ t3; i += 1
  }
  return w
}

const jmAddRoundKey = (state: Uint8Array, roundKeys: Uint8Array, round: number): void => {
  const offset = round * 16
  for (let i = 0; i < 16; i++) state[i] ^= roundKeys[offset + i]
}

const jmInvSubBytes = (state: Uint8Array): void => {
  for (let i = 0; i < 16; i++) state[i] = JM_AES.inv[state[i]]
}

const jmInvShiftRows = (state: Uint8Array): void => {
  let t = state[13]
  state[13] = state[9]
  state[9] = state[5]
  state[5] = state[1]
  state[1] = t
  t = state[2]
  let u = state[6]
  state[2] = state[10]
  state[6] = state[14]
  state[10] = t
  state[14] = u
  t = state[3]
  u = state[7]
  const v = state[11]
  state[3] = u
  state[7] = v
  state[11] = state[15]
  state[15] = t
}

const jmInvMixColumns = (state: Uint8Array): void => {
  for (let c = 0; c < 16; c += 4) {
    const a0 = state[c]
    const a1 = state[c + 1]
    const a2 = state[c + 2]
    const a3 = state[c + 3]
    state[c] = JM_AES.mul(a0, 14) ^ JM_AES.mul(a1, 11) ^ JM_AES.mul(a2, 13) ^ JM_AES.mul(a3, 9)
    state[c + 1] = JM_AES.mul(a0, 9) ^ JM_AES.mul(a1, 14) ^ JM_AES.mul(a2, 11) ^ JM_AES.mul(a3, 13)
    state[c + 2] = JM_AES.mul(a0, 13) ^ JM_AES.mul(a1, 9) ^ JM_AES.mul(a2, 14) ^ JM_AES.mul(a3, 11)
    state[c + 3] = JM_AES.mul(a0, 11) ^ JM_AES.mul(a1, 13) ^ JM_AES.mul(a2, 9) ^ JM_AES.mul(a3, 14)
  }
}

const jmAes256EcbDecrypt = (ciphertext: Uint8Array, key: Uint8Array): Uint8Array => {
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new Error(`JM 响应数据长度异常：${ciphertext.length}`)
  }
  const roundKeys = jmExpandKey256(key)
  const output = new Uint8Array(ciphertext.length)
  for (let offset = 0; offset < ciphertext.length; offset += 16) {
    const state = ciphertext.slice(offset, offset + 16)
    jmAddRoundKey(state, roundKeys, AES256_NR)
    for (let round = AES256_NR - 1; round > 0; round--) {
      jmInvShiftRows(state)
      jmInvSubBytes(state)
      jmAddRoundKey(state, roundKeys, round)
      jmInvMixColumns(state)
    }
    jmInvShiftRows(state)
    jmInvSubBytes(state)
    jmAddRoundKey(state, roundKeys, 0)
    output.set(state, offset)
  }
  const pad = output[output.length - 1] ?? 0
  if (pad < 1 || pad > 16 || pad > output.length) throw new Error("JM 响应填充数据异常")
  for (let i = output.length - pad; i < output.length; i++) {
    if (output[i] !== pad) throw new Error("JM 响应填充校验失败")
  }
  return output.slice(0, output.length - pad)
}

const jmDecodeEncryptedBase64 = (payload: string, secret: string): Uint8Array => {
  const base64Data = Data.fromBase64String(payload.trim())
  const bytes = base64Data?.toUint8Array()
  if (!bytes) throw new Error("JM base64 解码失败")
  const key = jmAsciiBytes(jmMd5Hex(secret))
  return jmAes256EcbDecrypt(bytes, key)
}

const jmCurrentTs = (): number => Math.floor(Date.now() / 1000)

const jmNormalizeDomain = (value: string): string => value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "")
const jmNormalizeCdnBase = (value: string): string => value.trim().replace(/\/+$/, "")

const jmApiAuth = (ts: number): { token: string; tokenparam: string } => ({
  token: jmMd5Hex(`${ts}${JM_AUTH_KEY}`),
  tokenparam: `${ts},${JM_VERSION}`,
})

const jmRequestHeaders = (ts: number, bearerToken?: string): Record<string, string> => {
  const auth = jmApiAuth(ts)
  return {
    "user-agent": JM_UA,
    token: auth.token,
    tokenparam: auth.tokenparam,
    "x-requested-with": JM_PKG,
    accept: "*/*",
    origin: "https://localhost",
    referer: "https://localhost/",
    ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
  }
}

export const jmImageHeaders = (): Record<string, string> => ({
  referer: "https://localhost/",
  "user-agent": JM_UA,
  "x-requested-with": JM_PKG,
})

const jmExtractJsonText = (bytes: Uint8Array): string => {
  const data = Data.fromUint8Array(bytes)
  const text = data?.toDecodedString("utf8") ?? ""
  if (!text) throw new Error("JM 响应文本为空")
  const startCandidates = [text.indexOf("{"), text.indexOf("[")].filter((value) => value >= 0)
  const endCandidates = [text.lastIndexOf("}"), text.lastIndexOf("]")].filter((value) => value >= 0)
  const start = startCandidates.length > 0 ? Math.min(...startCandidates) : 0
  const end = endCandidates.length > 0 ? Math.max(...endCandidates) : (text.length - 1)
  if (start > end) throw new Error("JM 响应边界异常")
  return text.slice(start, end + 1)
}

const jmFetchDomainCandidates = async (): Promise<string[]> => {
  for (const url of JM_DOMAIN_REFRESH_URLS) {
    try {
      const response = await fetch(url, { headers: { "user-agent": JM_UA } })
      if (!response.ok) continue
      const text = (await response.text()).trim().replace(/^\uFEFF/, "")
      const bytes = jmDecodeEncryptedBase64(text, JM_DOMAIN_REFRESH_SECRET)
      const payload = JSON.parse(jmExtractJsonText(bytes)) as JMDomainRefreshResp
      const domains = Array.from(new Set([...(payload.Server ?? []), ...(payload.server ?? [])].map(jmNormalizeDomain).filter(Boolean)))
      if (domains.length > 0) return domains
    } catch {
      continue
    }
  }
  return []
}

export const jmApiGet = async <T,>(domain: string, path: string, bearerToken?: string, ts?: number): Promise<T> => {
  const currentTs = ts ?? jmCurrentTs()
  const response = await fetch(`https://${domain}${path}`, { headers: jmRequestHeaders(currentTs, bearerToken) })
  if (!response.ok) throw new Error(`JM 请求失败 (${response.status})`)
  const outer = await response.json() as { data?: string }
  const encrypted = String(outer?.data ?? "")
  if (!encrypted) throw new Error("JM 响应数据为空")
  const bytes = jmDecodeEncryptedBase64(encrypted, `${currentTs}${JM_DATA_SECRET}`)
  return JSON.parse(jmExtractJsonText(bytes)) as T
}

export const ensureJMApiContext = async (): Promise<JMApiContext> => {
  if (jmApiContextCache && Date.now() - jmApiContextCache.updatedAt < 10 * 60 * 1000) return jmApiContextCache.value
  const domains = await jmFetchDomainCandidates()
  if (domains.length === 0) throw new Error("JM 域名列表为空")
  for (const domain of domains) {
    for (const shunt of JM_PREFERRED_IMAGE_SHUNTS) {
      try {
        const setting = await jmApiGet<JMSettingResp>(domain, `/setting?app_img_shunt=${shunt}&express=`)
        const cdnBase = jmNormalizeCdnBase(String(setting?.img_host ?? ""))
        if (cdnBase.startsWith("http")) {
          const value = { domain, cdnBase }
          jmApiContextCache = { value, updatedAt: Date.now() }
          return value
        }
      } catch {
        continue
      }
    }
  }
  throw new Error("当前所有 JM 域名都暂时不可用")
}

export const jmResolveAbsoluteUrl = (url?: string): string | undefined => {
  const value = String(url ?? "").trim()
  if (!value || value.endsWith("/blank.jpg")) return undefined
  if (/^https?:\/\//i.test(value)) return value
  if (value.startsWith("//")) return `https:${value}`
  if (value.startsWith("/")) return `${JM_WEB_URL}${value}`
  return value
}

export const jmCoverUrl = (cdnBase: string, id: string): string => `${cdnBase}/media/albums/${id}_3x4.jpg`
export const jmSearchPath = (query: string, order: string, category: string, page: number): string => {
  const q = encodeURIComponent(query)
  if (!category) return `/search?search_query=${q}&o=${order}&page=${page}`
  return `/search?search_query=${q}&o=${order}&c=${encodeURIComponent(category)}&page=${page}`
}

export const jmFilterPath = (order: string, category: string, page: number): string => {
  if (!category) return `/categories/filter?o=${order}&page=${page}`
  return `/categories/filter?o=${order}&c=${encodeURIComponent(category)}&page=${page}`
}

export const jmAlbumPath = (id: string): string => `/album?id=${encodeURIComponent(id)}`
export const jmChapterPath = (id: string): string => `/chapter?id=${encodeURIComponent(id)}`

import { Path } from "scripting"
import type { AppSettings } from "./model"

declare const FileManager: {
  temporaryDirectory: string
  existsSync(path: string): boolean
  exists(path: string): Promise<boolean>
  createDirectory(path: string, recursive?: boolean): Promise<void>
  createDirectorySync(path: string, recursive?: boolean): void
  readDirectory(path: string, recursive?: boolean): Promise<string[]>
  remove(path: string): Promise<void>
  writeAsData(path: string, data: any): Promise<void>
  writeAsDataSync(path: string, data: any): void
  stat(path: string): Promise<{ size: number }>
}

declare const UIImage: {
  fromFile(path: string): any | null
}

declare const Data: any

export type EnhancedCacheParams = {
  engine: "waifu2x" | "anime4k"
  scale: number
  denoise: number
  profile?: string
  strength?: number
  sourceId: string
  mangaId: string
  chapterId: string
  url: string
}

const CACHE_DIR_NAME = "liquid_manga_enhanced_cache"

function getCacheDir(): string {
  const dir = Path.join(FileManager.temporaryDirectory, CACHE_DIR_NAME)
  try {
    if (!FileManager.existsSync(dir)) {
      FileManager.createDirectorySync(dir, true)
    }
  } catch {
    // Ignore directory creation error if already created
  }
  return dir
}

function fastHash(input: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c64e6d
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

export function makeEnhancedCacheKey(params: EnhancedCacheParams): string {
  const { engine, scale, denoise, profile = "", strength = 0, sourceId, mangaId, chapterId, url } = params
  const engineVersion = engine === "waifu2x" ? "waifu2x_aidoku_v2" : engine
  return `${engineVersion}_s${scale}_d${denoise}_p${profile}_st${strength}_${sourceId}_${mangaId}_${chapterId}_${url}`
}

export function makeEnhancedCacheParamsFromSettings(
  settings: AppSettings,
  sourceId: string,
  mangaId: string,
  chapterId: string,
  url: string,
): EnhancedCacheParams {
  const engine = settings.upscalerEngine === "waifu2x" ? "waifu2x" : "anime4k"
  if (engine === "waifu2x") {
    return {
      engine: "waifu2x",
      scale: settings.waifu2xScale,
      denoise: settings.waifu2xDenoise,
      sourceId,
      mangaId,
      chapterId,
      url,
    }
  }
  return {
    engine: "anime4k",
    scale: settings.anime4kScale,
    denoise: settings.anime4kDenoise,
    profile: settings.anime4kProfile,
    strength: settings.anime4kStrength,
    sourceId,
    mangaId,
    chapterId,
    url,
  }
}

function getFilePath(key: string, engine: string, scale: number): string {
  const dir = getCacheDir()
  const hash = fastHash(key)
  return Path.join(dir, `${engine}_s${scale}_${hash}.jpg`)
}

// In-memory LRU cache to avoid touching disk for active reading session
const memCache = new Map<string, any>()
const MAX_MEM_ENTRIES = 32
// Known disk keys set to prevent repeated synchronous disk stat syscalls
const knownDiskKeys = new Set<string>()

function touchMemCache(key: string, image: any) {
  memCache.delete(key)
  memCache.set(key, image)
  while (memCache.size > MAX_MEM_ENTRIES) {
    const oldestKey = memCache.keys().next().value
    if (oldestKey) memCache.delete(oldestKey)
    else break
  }
}

export function hasEnhancedImage(params: EnhancedCacheParams): boolean {
  const key = makeEnhancedCacheKey(params)
  if (memCache.has(key) || knownDiskKeys.has(key)) return true
  const filePath = getFilePath(key, params.engine, params.scale)
  const exists = FileManager.existsSync(filePath)
  if (exists) knownDiskKeys.add(key)
  return exists
}

export async function getEnhancedImage(params: EnhancedCacheParams): Promise<any | null> {
  const key = makeEnhancedCacheKey(params)
  const inMem = memCache.get(key)
  if (inMem != null) {
    touchMemCache(key, inMem)
    return inMem
  }
  const filePath = getFilePath(key, params.engine, params.scale)
  if (!knownDiskKeys.has(key) && !FileManager.existsSync(filePath)) return null
  knownDiskKeys.add(key)
  try {
    const loaded = UIImage.fromFile(filePath)
    if (loaded) {
      touchMemCache(key, loaded)
      return loaded
    }
  } catch (err) {
    console.error("Failed to load enhanced cached image from disk:", err)
  }
  return null
}

export async function saveEnhancedImage(params: EnhancedCacheParams, image: any): Promise<void> {
  const key = makeEnhancedCacheKey(params)
  touchMemCache(key, image)
  knownDiskKeys.add(key)
  const filePath = getFilePath(key, params.engine, params.scale)
  try {
    const b64 = image.toJPEGBase64String?.(0.96) ?? image.toPNGBase64String?.()
    if (b64 && typeof Data !== "undefined" && typeof Data.fromBase64String === "function") {
      const data = Data.fromBase64String(b64)
      await FileManager.writeAsData(filePath, data)
    }
  } catch (err) {
    console.error("Failed to save enhanced image to disk cache:", err)
  }
}

export async function getEnhancedCacheStats(): Promise<{ count: number; totalBytes: number; totalMB: string }> {
  try {
    const dir = getCacheDir()
    const files = await FileManager.readDirectory(dir)
    const imageFiles = files.filter(f => f.endsWith(".jpg") || f.endsWith(".png"))
    const count = imageFiles.length
    if (count === 0) return { count: 0, totalBytes: 0, totalMB: "0.0" }
    
    // Batch stat requests in parallel chunks of 16
    let totalBytes = 0
    const CHUNK_SIZE = 16
    for (let i = 0; i < imageFiles.length; i += CHUNK_SIZE) {
      const chunk = imageFiles.slice(i, i + CHUNK_SIZE)
      const stats = await Promise.all(
        chunk.map(file => FileManager.stat(Path.join(dir, file)).catch(() => ({ size: 0 }))),
      )
      for (const s of stats) totalBytes += s.size ?? 0
    }
    const totalMB = (totalBytes / (1024 * 1024)).toFixed(1)
    return { count, totalBytes, totalMB }
  } catch {
    return { count: 0, totalBytes: 0, totalMB: "0.0" }
  }
}

export async function clearEnhancedCache(): Promise<number> {
  memCache.clear()
  knownDiskKeys.clear()
  try {
    const dir = getCacheDir()
    const files = await FileManager.readDirectory(dir)
    const removePromises = files.map(file => FileManager.remove(Path.join(dir, file)).catch(() => undefined))
    await Promise.all(removePromises)
    return files.length
  } catch {
    return 0
  }
}

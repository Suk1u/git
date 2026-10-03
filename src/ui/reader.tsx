import {
  Button,
  DragGesture,
  HStack,
  Image,
  LazyVStack,
  Navigation,
  NavigationStack,
  ProgressView,
  ScrollView,
  ScrollViewReader,
  Slider,
  Spacer,
  Text,
  VStack,
  ZStack,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "scripting"
import type { AppSettings, MangaChapter, MangaDetail, MangaSource } from "../model"
import { enhanceImageWithAnime4K, prepareAnime4K } from "../anime4k"
import { enhanceImageWithWaifu2x, prepareWaifu2x } from "../waifu2x"
import { requestImage } from "../net"
import { AsyncCache } from "../cache"
import {
  getEnhancedImage,
  hasEnhancedImage,
  makeEnhancedCacheParamsFromSettings,
  saveEnhancedImage,
} from "../enhanced-cache"
import {
  DEFAULT_SETTINGS,
  loadSettings,
  markChapterRead,
  saveHistory,
  saveSettings,
} from "../storage"
import { ReaderSheetControls } from "./reader-sheets"

type ReaderProps = {
  source: MangaSource
  manga: MangaDetail
  initialChapter: MangaChapter
  initialPage?: number
  settings: AppSettings
  onSettingsChanged: (settings: AppSettings) => void
}

type ChapterSegment = {
  chapter: MangaChapter
  urls: string[]
}

type FlatPage = {
  key: string
  chapter: MangaChapter
  index: number
  url: string
}

type ReaderImageValue = string | any

function ReaderImageStatus({ fullscreen = false }: { fullscreen?: boolean }) {
  return (
    <VStack
      spacing={10}
      frame={fullscreen
        ? { maxWidth: "infinity", maxHeight: "infinity" }
        : { maxWidth: "infinity", height: 520 }}
    >
      <ProgressView progressViewStyle="circular" tint="white" scaleEffect={1.6} />
      <Text font="subheadline" foregroundStyle="rgba(255,255,255,0.72)">
        图片加载中
      </Text>
    </VStack>
  )
}

function ReaderImage({ value, fullscreen = false }: { value: ReaderImageValue | null; fullscreen?: boolean }) {
  if (value == null) return <ReaderImageStatus fullscreen={fullscreen} />
  return (
    <Image
      image={value as any}
      resizable={true}
      scaleToFit={true}
      interpolation="high"
      clipped={true}
      frame={fullscreen
        ? { maxWidth: "infinity", maxHeight: "infinity" }
        : { maxWidth: "infinity" }}
      placeholder={<ReaderImageStatus fullscreen={fullscreen} />}
    />
  )
}

function WebtoonPageItem({
  itemKey,
  image,
  onTap,
}: {
  itemKey: string
  image: any
  onTap: () => void
}) {
  return (
    <VStack
      key={itemKey}
      frame={{ maxWidth: "infinity" }}
      contentShape="rect"
      onTapGesture={onTap}
    >
      <ReaderImage value={image ?? null} />
    </VStack>
  )
}

const READER_BUTTON_SIZE = 50
const READER_BUTTON_RADIUS = READER_BUTTON_SIZE / 2
const READER_ICON_SIZE = 29

function ReaderCircleButton({
  systemName,
  action,
  disabled = false,
  tint = "white",
}: {
  systemName: string
  action: () => void
  disabled?: boolean
  tint?: "white" | "systemRed"
}) {
  function performAction() {
    if (disabled) return
    const haptic = (globalThis as any).HapticFeedback
    haptic?.impactOccurred?.("light")
    withAnimation(Animation.easeOut(0.18), action)
  }

  return (
    <Button
      buttonStyle="plain"
      disabled={disabled}
      frame={{ width: READER_BUTTON_SIZE, height: READER_BUTTON_SIZE, alignment: "center" }}
      contentShape="rect"
      action={performAction}
    >
      <ZStack
        frame={{ width: READER_BUTTON_SIZE, height: READER_BUTTON_SIZE, alignment: "center" }}
        contentShape="rect"
        opacity={disabled ? 0.38 : 1}
        glassEffect={{ glass: UIGlass.regular().interactive(), shape: { type: "rect", cornerRadius: READER_BUTTON_RADIUS, style: "continuous" } }}
        glassEffectTransition="materialize"
      >
        <Image systemName={systemName} font="title2" foregroundStyle={tint} frame={{ width: READER_ICON_SIZE, height: READER_ICON_SIZE, alignment: "center" }} />
      </ZStack>
    </Button>
  )
}


function pageKey(chapterId: string, index: number) {
  return `${chapterId}::${index}`
}

export function ReaderPage({
  source,
  manga,
  initialChapter,
  initialPage = 0,
  settings,
  onSettingsChanged,
}: ReaderProps) {
  const dismiss = Navigation.useDismiss()

  function handleReaderClose() {
    withAnimation(Animation.easeOut(0.18), () => dismiss("close"))
  }

  const [chapter, setChapter] = useState(initialChapter)
  const [segments, setSegments] = useState<ChapterSegment[]>([])
  const [loadedImages, setLoadedImages] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(Math.max(0, initialPage))
  const mode = settings.readerMode
  const [readerSettings, setReaderSettings] = useState<AppSettings>(() => ({
    ...DEFAULT_SETTINGS,
    ...loadSettings(),
    ...settings,
  }))

  useEffect(() => {
    const fresh = loadSettings()
    setReaderSettings(prev => ({ ...prev, ...fresh, ...settings }))
  }, [settings])
  const [upscalerStatus, setUpscalerStatus] = useState("尚未启动")
  const [chapterProgress, setChapterProgress] = useState<{ completed: number; total: number }>({ completed: 0, total: 0 })
  const [processingAnchor, setProcessingAnchor] = useState(pageKey(initialChapter.id, Math.max(0, initialPage)))
  const [processingVersion, setProcessingVersion] = useState(0)
  const [showControls, setShowControls] = useState(true)
  const proxyRef = useRef<any>(null)
  const imageCache = useMemo(() => new AsyncCache<any>(18, 20 * 60 * 1000), [])
  const readerState = useMemo(() => ({
    generation: 0,
    processingVersion: 0,
    historyTimer: null as any,
    visibleUpdateTimer: null as any,
    uiSyncTimer: null as any,
    pendingVisibleItem: null as FlatPage | null,
    lastPageKey: "",
    visiblePage: Math.max(0, initialPage),
    visibleChapterId: initialChapter.id,
    visibleChapter: initialChapter,
    controlsVisible: true,
    processedKeys: new Set<string>(),
    processingKeys: new Set<string>(),
    downloadedKeys: new Set<string>(),
    downloadingKeys: new Set<string>(),
    loadedIds: new Set<string>(),
    loadingIds: new Set<string>(),
    isDragging: false,
    dragTimer: null as any,
  }), [])

  const flatPages = useMemo<FlatPage[]>(() => segments.flatMap(segment =>
    segment.urls.map((url, index) => ({
      key: pageKey(segment.chapter.id, index),
      chapter: segment.chapter,
      index,
      url,
    }))), [segments])

  const pageByKey = useMemo(() => new Map(flatPages.map(item => [item.key, item])), [flatPages])
  const interactionSpring = Animation.spring({ response: 0.32, dampingFraction: 0.82 })
  // 阅读器控件只做透明度过渡，显隐时保持原位，避免点击屏幕后产生跳动。
  const controlsTransition = Transition.asymmetric(
    Transition.opacity().animation(Animation.easeOut(0.46)),
    Transition.opacity().animation(Animation.easeOut(0.36)),
  )

  const currentSegment = segments.find(segment => segment.chapter.id === chapter.id)
  const urls = currentSegment?.urls ?? []
  const chapterIndex = manga.chapters.findIndex(item => item.id === chapter.id)
  const previous = chapterIndex > 0 ? manga.chapters[chapterIndex - 1] : null
  const next = chapterIndex >= 0 && chapterIndex < manga.chapters.length - 1 ? manga.chapters[chapterIndex + 1] : null

  useEffect(() => {
    return () => {
      readerState.generation += 1
      if (readerState.historyTimer) clearTimeout(readerState.historyTimer)
      if (readerState.visibleUpdateTimer) clearTimeout(readerState.visibleUpdateTimer)
      if (readerState.uiSyncTimer) clearTimeout(readerState.uiSyncTimer)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const upscalerEnabled = readerSettings.upscalerEnabled ?? !!(readerSettings.anime4kEnabled)
    if (!upscalerEnabled) {
      setUpscalerStatus("已关闭")
      return () => { cancelled = true }
    }
    const isWaifu = readerSettings.upscalerEngine === "waifu2x"
    const engineName = isWaifu ? "Waifu2x" : "Anime4K"
    if (isWaifu) {
      setUpscalerStatus("正在启动本地 Waifu2x")
      prepareWaifu2x({ denoise: readerSettings.waifu2xDenoise, scale: readerSettings.waifu2xScale })
        .then(status => {
          if (cancelled) return
          if (readerSettings.upscalerScope === "all") {
            const currentCount = currentSegment?.urls.length ?? 0
            setUpscalerStatus(`Waifu2x 已就绪 · ${status.scale}× / 降噪 ${status.denoise} · 全量超分中 (${currentCount}页)`)
          } else {
            setUpscalerStatus(`Waifu2x 已就绪 · ${status.scale}× / 降噪 ${status.denoise} · 窗口模式`)
          }
        })
        .catch(reason => {
          if (!cancelled) setUpscalerStatus(reason?.message ?? String(reason))
          console.error(reason)
        })
      return () => { cancelled = true }
    }
    setUpscalerStatus("正在初始化本地 WebGL2")
    prepareAnime4K()
      .then(status => {
        if (cancelled) return
        if (readerSettings.upscalerScope === "all") {
          setUpscalerStatus(`Anime4K WebGL2 · 全量超分就绪 · 最大纹理 ${status.maxTextureSize}px`)
        } else {
          setUpscalerStatus(`Anime4K WebGL2 · 窗口模式 · 最大纹理 ${status.maxTextureSize}px`)
        }
      })
      .catch(reason => {
        if (!cancelled) setUpscalerStatus(reason?.message ?? String(reason))
        console.error(reason)
      })
    return () => { cancelled = true }
  }, [readerSettings.upscalerEnabled, readerSettings.upscalerEngine, readerSettings.upscalerScope, readerSettings.waifu2xDenoise, readerSettings.waifu2xScale, currentSegment?.urls.length])

  useEffect(() => {
    // 内存安全控制：只有多章节拼接且远离视口超过 6 页时才安全卸载，避免单章节阅读时频繁执行状态比较
    if (segments.length <= 1) return

    const visibleIndex = flatPages.findIndex(item => item.key === processingAnchor)
    const center = visibleIndex >= 0 ? visibleIndex : 0
    const activeKeys = new Set<string>()
    for (let i = center - 6; i <= center + 6; i++) {
      if (flatPages[i]) activeKeys.add(flatPages[i].key)
    }

    setLoadedImages(current => {
      let changed = false
      const next = { ...current }
      for (const key of Object.keys(next)) {
        // 当前章节的所有页面一律在内存中常驻！
        if (key.startsWith(`${chapter.id}::`)) continue
        if (!activeKeys.has(key)) {
          delete next[key]
          changed = true
          for (const processedKey of Array.from(readerState.processedKeys)) {
            if (processedKey.endsWith(`:${key}`)) readerState.processedKeys.delete(processedKey)
          }
        }
      }
      return changed ? next : current
    })
  }, [processingAnchor, chapter.id, segments.length])

  useEffect(() => {
    const generation = readerState.generation
    const version = processingVersion
    let cancelled = false

    const upscalerEnabled = readerSettings.upscalerEnabled ?? !!(readerSettings.anime4kEnabled)

    let progressTimer: any = null
    function scheduleRefreshProgress(immediate = false) {
      if (immediate) {
        if (progressTimer) clearTimeout(progressTimer)
        progressTimer = null
        doRefreshProgress()
        return
      }
      if (progressTimer) return
      progressTimer = setTimeout(() => {
        progressTimer = null
        doRefreshProgress()
      }, 240)
    }

    function doRefreshProgress() {
      const currentPages = flatPages.filter(p => p.chapter.id === chapter.id)
      const total = currentPages.length
      if (!total) return
      if (!upscalerEnabled) {
        setChapterProgress({ completed: 0, total })
        setUpscalerStatus("已关闭")
        return
      }

      let completed = 0
      for (const p of currentPages) {
        const k = `${version}:${p.key}`
        if (readerState.processedKeys.has(k) || Boolean(loadedImages[p.key])) {
          completed++
        } else {
          const cacheParams = makeEnhancedCacheParamsFromSettings(
            readerSettings,
            source.id,
            manga.id,
            chapter.id,
            p.url,
          )
          if (hasEnhancedImage(cacheParams)) {
            readerState.processedKeys.add(k)
            completed++
          }
        }
      }
      setChapterProgress({ completed, total })

      const isWaifu = readerSettings.upscalerEngine === "waifu2x"
      const engineName = isWaifu ? "Waifu2x" : "Anime4K"
      if (readerSettings.upscalerScope === "all") {
        if (completed >= total) {
          setUpscalerStatus(`${engineName} · 本话已全量超分完成 (${total}/${total}页)`)
        } else {
          const pct = Math.round((completed / total) * 100)
          setUpscalerStatus(`${engineName} · 全量超分中 ${completed}/${total}页 (${pct}%)`)
        }
      } else {
        setUpscalerStatus(`${engineName} 已就绪 · 窗口模式`)
      }
    }

    function pickNextPage(): FlatPage | null {
      // 1. 获取所有待处理页面
      const candidates = flatPages.filter(p => {
        if (p.chapter.id !== chapter.id && readerSettings.upscalerScope === "window") {
          return false
        }
        const workKey = `${version}:${p.key}`
        return !readerState.processedKeys.has(workKey) && !readerState.processingKeys.has(workKey)
      })
      if (!candidates.length) return null

      // 如果是窗口模式，只处理当前视口 ±4 页范围内的页面
      const curPage = readerState.visiblePage
      if (readerSettings.upscalerScope === "window") {
        const inWindow = candidates.filter(p => p.chapter.id === chapter.id && Math.abs(p.index - curPage) <= 4)
        if (!inWindow.length) return null
        inWindow.sort((a, b) => Math.abs(a.index - curPage) - Math.abs(b.index - curPage))
        return inWindow[0]
      }

      // 全量超分模式：对候选页按阅读优先级动态排序
      candidates.sort((a, b) => {
        const aIsCurChap = a.chapter.id === chapter.id
        const bIsCurChap = b.chapter.id === chapter.id
        if (aIsCurChap && !bIsCurChap) return -1
        if (!aIsCurChap && bIsCurChap) return 1

        const aDist = a.index - curPage
        const bDist = b.index - curPage

        // 当前页及后续页权重为正向距离 (0, 1, 2...)
        // 之前已读页排在其后 (1000 + 距离)
        const aWeight = aDist >= 0 ? aDist : Math.abs(aDist) + 1000
        const bWeight = bDist >= 0 ? bDist : Math.abs(bDist) + 1000
        return aWeight - bWeight
      })

      return candidates[0] ?? null
    }

    async function loadWithRetry(item: FlatPage) {
      const cacheKey = `${source.id}:${manga.id}:${item.chapter.id}:${item.url}`
      return imageCache.get(cacheKey, async () => {
        let lastError: unknown
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            return source.loadImage
              ? await source.loadImage(item.url, manga, item.chapter)
              : await requestImage(item.url, manga.url)
          } catch (reason) {
            lastError = reason
            if (attempt < 2) await new Promise<void>(resolve => setTimeout(resolve, 220 * (attempt + 1)))
          }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "图片加载失败"))
      })
    }

    // 管线 1：并发原图预载器（3 线程并行拉取），确保翻页立即可读，彻底杜绝 Anime4K/Waifu2x 阻塞网络图片加载
    async function preloadWorker() {
      while (!cancelled && generation === readerState.generation) {
        const curPage = readerState.visiblePage
        const candidates = flatPages.filter(p => {
          if (p.chapter.id !== chapter.id && readerSettings.upscalerScope === "window") return false
          return !readerState.downloadedKeys.has(p.key) && !readerState.downloadingKeys.has(p.key)
        }).sort((a, b) => {
          const aIsCur = a.chapter.id === chapter.id
          const bIsCur = b.chapter.id === chapter.id
          if (aIsCur && !bIsCur) return -1
          if (!aIsCur && bIsCur) return 1
          const aDist = a.index - curPage
          const bDist = b.index - curPage
          const aWeight = aDist >= 0 ? aDist : Math.abs(aDist) + 500
          const bWeight = bDist >= 0 ? bDist : Math.abs(bDist) + 500
          return aWeight - bWeight
        })

        const item = candidates[0]
        if (!item) {
          await new Promise<void>(resolve => setTimeout(resolve, 250))
          if (cancelled || generation !== readerState.generation) return
          continue
        }

        readerState.downloadingKeys.add(item.key)
        try {
          if (upscalerEnabled) {
            const cacheParams = makeEnhancedCacheParamsFromSettings(
              readerSettings,
              source.id,
              manga.id,
              item.chapter.id,
              item.url,
            )
            const cached = await getEnhancedImage(cacheParams)
            if (cached) {
              readerState.downloadedKeys.add(item.key)
              if (generation === readerState.generation) {
                setLoadedImages(current => current[item.key] === cached ? current : ({ ...current, [item.key]: cached }))
                scheduleRefreshProgress()
              }
              continue
            }
          }

          const original = await loadWithRetry(item)
          readerState.downloadedKeys.add(item.key)
          if (generation === readerState.generation) {
            setLoadedImages(current => current[item.key] ? current : ({ ...current, [item.key]: original }))
          }
        } catch {
          // ignore
        } finally {
          readerState.downloadingKeys.delete(item.key)
        }
      }
    }

    // 管线 2：后台专属 AI 超分管线，独立运行，不阻塞原图展示，根据阅读视口动态优先增强
    async function upscalerWorker() {
      while (!cancelled && generation === readerState.generation && version === readerState.processingVersion) {
        if (!upscalerEnabled) break

        const item = pickNextPage()
        if (!item) {
          // 当前候选队列暂无页面（可能正在等待原图网络下载，或已全部处理完成）
          await new Promise<void>(resolve => setTimeout(resolve, 350))
          if (cancelled || generation !== readerState.generation || version !== readerState.processingVersion) return
          continue
        }

        const workKey = `${version}:${item.key}`
        if (readerState.processedKeys.has(workKey) || readerState.processingKeys.has(workKey)) continue
        readerState.processingKeys.add(workKey)

        try {
          const cacheParams = makeEnhancedCacheParamsFromSettings(
            readerSettings,
            source.id,
            manga.id,
            item.chapter.id,
            item.url,
          )

          // 1. 如果已启用超分，优先检查磁盘超分缓存（毫秒级命中）
          const cachedEnhanced = await getEnhancedImage(cacheParams)
          if (cachedEnhanced != null) {
            if (generation !== readerState.generation || version !== readerState.processingVersion) return
            readerState.processedKeys.add(workKey)
            setLoadedImages(current => current[item.key] === cachedEnhanced ? current : ({ ...current, [item.key]: cachedEnhanced }))
            scheduleRefreshProgress()
            continue
          }

          // 2. 获取原图（已被 preloadWorker 秒级预载好）
          const original = await loadWithRetry(item)
          if (generation !== readerState.generation || version !== readerState.processingVersion) return

          // 3. 执行超分推理
          const enhanced = readerSettings.upscalerEngine === "waifu2x"
            ? await enhanceImageWithWaifu2x(original, {
              denoise: readerSettings.waifu2xDenoise,
              scale: readerSettings.waifu2xScale,
              format: "jpeg",
              quality: 0.98,
            })
            : await enhanceImageWithAnime4K(original, {
              profile: readerSettings.anime4kProfile,
              strength: readerSettings.anime4kStrength,
              denoise: readerSettings.anime4kDenoise,
              scale: readerSettings.anime4kScale,
            })
          if (generation !== readerState.generation || version !== readerState.processingVersion) return

          // 4. 持久化缓存到本地磁盘
          if (enhanced) {
            await saveEnhancedImage(cacheParams, enhanced)
            readerState.processedKeys.add(workKey)
            setLoadedImages(current => current[item.key] === enhanced ? current : ({ ...current, [item.key]: enhanced }))
            scheduleRefreshProgress()
          } else {
            readerState.processedKeys.add(workKey)
            scheduleRefreshProgress()
          }
        } catch (reason) {
          console.error("超分推理异常:", reason)
          readerState.processedKeys.add(workKey)
          scheduleRefreshProgress()
        } finally {
          readerState.processingKeys.delete(workKey)
        }
      }
    }

    Promise.all(Array.from({ length: 3 }, preloadWorker)).catch(console.error)
    upscalerWorker().catch(console.error)
    scheduleRefreshProgress(true)
    return () => {
      cancelled = true
      if (progressTimer) clearTimeout(progressTimer)
    }
  }, [
    flatPages.length,
    chapter.id,
    processingVersion,
    source.id,
    manga.id,
    readerSettings.upscalerEnabled,
    readerSettings.upscalerEngine,
    readerSettings.upscalerScope,
    readerSettings.waifu2xDenoise,
    readerSettings.waifu2xScale,
    readerSettings.anime4kProfile,
    readerSettings.anime4kStrength,
    readerSettings.anime4kDenoise,
    readerSettings.anime4kScale,
  ])

  async function appendFollowing(afterChapter: MangaChapter) {
    const index = manga.chapters.findIndex(item => item.id === afterChapter.id)
    const nextChapter = index >= 0 ? manga.chapters[index + 1] : null
    if (!nextChapter) return
    if (readerState.loadedIds.has(nextChapter.id) || readerState.loadingIds.has(nextChapter.id)) return

    const generation = readerState.generation
    readerState.loadingIds.add(nextChapter.id)
    try {
      const nextURLs = await source.pages(manga, nextChapter)
      if (generation !== readerState.generation || !nextURLs.length) return
      readerState.loadedIds.add(nextChapter.id)
      setSegments(current => current.some(item => item.chapter.id === nextChapter.id)
        ? current
        : [...current, { chapter: nextChapter, urls: nextURLs }])
    } catch (reason) {
      console.error(reason)
    } finally {
      readerState.loadingIds.delete(nextChapter.id)
    }
  }

  function scheduleHistory(nextChapter: MangaChapter, nextPage: number) {
    if (readerState.historyTimer) clearTimeout(readerState.historyTimer)
    readerState.historyTimer = setTimeout(() => {
      saveHistory({
        manga,
        chapterId: nextChapter.id,
        chapterTitle: nextChapter.title,
        page: nextPage,
        updatedAt: Date.now(),
      })
      readerState.historyTimer = null
    }, 420)
  }

  async function loadChapter(nextChapter: MangaChapter, restorePage = 0) {
    const generation = readerState.generation + 1
    const haptic = (globalThis as any).HapticFeedback
    haptic?.impactOccurred?.("light")
    readerState.generation = generation
    readerState.processedKeys.clear()
    readerState.processingKeys.clear()
    readerState.downloadedKeys.clear()
    readerState.downloadingKeys.clear()
    readerState.loadedIds.clear()
    readerState.loadingIds.clear()
    readerState.lastPageKey = ""
    readerState.pendingVisibleItem = null
    readerState.visiblePage = 0
    readerState.visibleChapterId = nextChapter.id
    readerState.visibleChapter = nextChapter
    if (readerState.visibleUpdateTimer) {
      clearTimeout(readerState.visibleUpdateTimer)
      readerState.visibleUpdateTimer = null
    }
    if (readerState.uiSyncTimer) {
      clearTimeout(readerState.uiSyncTimer)
      readerState.uiSyncTimer = null
    }
    setLoading(true)
    setError(null)
    setLoadedImages({})

    try {
      const images = await source.pages(manga, nextChapter)
      if (generation !== readerState.generation) return
      if (!images.length) throw new Error("当前章节没有可读取的图片")
      const safe = Math.max(0, Math.min(Math.max(0, images.length - 1), restorePage))
      readerState.loadedIds.add(nextChapter.id)
      withAnimation(Animation.smooth({ duration: 0.24, extraBounce: 0 }), () => {
        setSegments([{ chapter: nextChapter, urls: images }])
        setChapter(nextChapter)
        setPage(safe)
      })
      setProcessingAnchor(pageKey(nextChapter.id, safe))
      readerState.visiblePage = safe
      markChapterRead(manga, nextChapter.id)
      scheduleHistory(nextChapter, safe)

      setTimeout(() => {
        proxyRef.current?.scrollTo?.(pageKey(nextChapter.id, safe), "top")
        if (mode === "webtoon") appendFollowing(nextChapter).catch(() => undefined)
      }, 0)
    } catch (reason: any) {
      if (generation !== readerState.generation) return
      console.error(reason)
      setError(reason?.message ?? String(reason))
      setSegments([])
    } finally {
      if (generation === readerState.generation) setLoading(false)
    }
  }

  useEffect(() => {
    loadChapter(initialChapter, initialPage).catch(() => undefined)
  }, [initialChapter.id])

  function updateVisiblePage(item: FlatPage) {
    if (readerState.lastPageKey === item.key) return
    readerState.lastPageKey = item.key
    readerState.visiblePage = item.index
    setProcessingAnchor(item.key)
    readerState.visibleChapterId = item.chapter.id
    readerState.visibleChapter = item.chapter
    if (item.chapter.id !== chapter.id) {
      setChapter(item.chapter)
      setPage(item.index)
      markChapterRead(manga, item.chapter.id)
    } else if (readerState.controlsVisible) {
      if (readerState.uiSyncTimer) clearTimeout(readerState.uiSyncTimer)
      readerState.uiSyncTimer = setTimeout(() => {
        readerState.uiSyncTimer = null
        setPage(readerState.visiblePage)
      }, 320)
    }
    scheduleHistory(item.chapter, item.index)

    const segment = segments.find(entry => entry.chapter.id === item.chapter.id)
    if (segment && item.index >= Math.max(0, segment.urls.length - 4)) {
      appendFollowing(item.chapter).catch(() => undefined)
    }
  }

  function handleVisiblePages(ids: string[] | number[]) {
    for (const id of ids) {
      const item = pageByKey.get(String(id))
      if (!item) continue
      readerState.pendingVisibleItem = item
      if (!readerState.visibleUpdateTimer) {
        readerState.visibleUpdateTimer = setTimeout(() => {
          readerState.visibleUpdateTimer = null
          const pending = readerState.pendingVisibleItem
          readerState.pendingVisibleItem = null
          if (pending) updateVisiblePage(pending)
        }, 120)
      }
      return
    }
  }

  function seek(nextPage: number) {
    const safe = Math.max(0, Math.min(Math.max(0, urls.length - 1), Math.round(nextPage)))
    readerState.visiblePage = safe
    setProcessingAnchor(pageKey(chapter.id, safe))
    readerState.visibleChapterId = chapter.id
    withAnimation(Animation.easeOut(0.18), () => setPage(safe))
    scheduleHistory(chapter, safe)
    if (mode === "webtoon") proxyRef.current?.scrollTo?.(pageKey(chapter.id, safe), "top")
  }

  function updateReaderSettings(patch: Partial<AppSettings>) {
    const nextSettings = { ...readerSettings, ...patch }
    setReaderSettings(nextSettings)
    saveSettings(nextSettings)
    onSettingsChanged(nextSettings)
    const haptic = (globalThis as any).HapticFeedback
    haptic?.selectionChanged?.()
  }

  function changeUpscalerSettings(patch: Partial<AppSettings>) {
    updateReaderSettings(patch)
    readerState.processedKeys.clear()
    readerState.processingVersion += 1
    // Keep the displayed original while the new engine/profile result is prepared.
    // The following queue run replaces it when a result is ready.
    setProcessingVersion(readerState.processingVersion)
  }

  function previousPage() {
    if (page > 0) {
      seek(page - 1)
      return
    }
    if (previous) loadChapter(previous, Number.MAX_SAFE_INTEGER).catch(() => undefined)
  }

  function nextPage() {
    if (page < urls.length - 1) {
      seek(page + 1)
      return
    }
    if (next) loadChapter(next, 0).catch(() => undefined)
  }

  function setControlsVisible(visible: boolean) {
    if (readerState.controlsVisible === visible) return
    readerState.controlsVisible = visible
    if (visible) {
      // 呼出控制面板时，根据当前缓存状态即时校准并显示最新进度
      const currentPages = flatPages.filter(p => p.chapter.id === chapter.id)
      const total = currentPages.length
      const upscalerEnabled = readerSettings.upscalerEnabled ?? !!(readerSettings.anime4kEnabled)
      if (total > 0 && upscalerEnabled) {
        let completed = 0
        for (const p of currentPages) {
          const cacheParams = makeEnhancedCacheParamsFromSettings(
            readerSettings,
            source.id,
            manga.id,
            chapter.id,
            p.url,
          )
          const k = `${processingVersion}:${p.key}`
          if (hasEnhancedImage(cacheParams) || readerState.processedKeys.has(k) || Boolean(loadedImages[p.key])) {
            completed++
          }
        }
        setChapterProgress({ completed, total })
      }
    }
    withAnimation(Animation.easeOut(visible ? 0.46 : 0.36), () => {
      setShowControls(visible)
    })
  }

  function hideControlsForGesture() {
    setControlsVisible(false)
  }

  function toggleControls() {
    setControlsVisible(!readerState.controlsVisible)
  }

  function toggleUpscaler() {
    const enabled = !(readerSettings.upscalerEnabled ?? !!(readerSettings.anime4kEnabled))
    const haptic = (globalThis as any).HapticFeedback
    haptic?.notification?.(enabled ? "success" : "warning")
    withAnimation(interactionSpring, () => {
      changeUpscalerSettings({ upscalerEnabled: enabled, anime4kEnabled: enabled })
      setUpscalerStatus(enabled ? `正在初始化本地 ${readerSettings.upscalerEngine === "waifu2x" ? "Waifu2x" : "Anime4K"}` : "已关闭")
    })
  }

  function triggerFullUpscale() {
    changeUpscalerSettings({ upscalerScope: "all", upscalerEnabled: true, anime4kEnabled: true })
    const haptic = (globalThis as any).HapticFeedback
    haptic?.notification?.("success")
  }

  const pageImage = urls[Math.max(0, Math.min(page, urls.length - 1))]

  function renderControls() {
    return (
      <ZStack alignment="bottom" frame={{ maxWidth: "infinity", height: 126 }}>
        <HStack alignment="bottom" spacing={0} padding={{ horizontal: 2 }} frame={{ maxWidth: "infinity", height: 126 }}>
          <VStack spacing={4} frame={{ width: READER_BUTTON_SIZE, height: 126, alignment: "bottom" }}>
            <ReaderCircleButton
              systemName="chevron.up"
              disabled={!previous || loading}
              action={() => { if (previous) loadChapter(previous, 0).catch(() => undefined) }}
            />
            <ReaderCircleButton
              systemName="chevron.down"
              disabled={!next || loading}
              action={() => { if (next) loadChapter(next, 0).catch(() => undefined) }}
            />
          </VStack>
          <Spacer />
        </HStack>
        <VStack padding={{ horizontal: 68 }} frame={{ maxWidth: "infinity", height: 54, alignment: "center" }}>
          <VStack
            spacing={1}
            padding={{ horizontal: 14, top: 6, bottom: 4 }}
            frame={{ maxWidth: "infinity", height: 54, alignment: "center" }}
            foregroundStyle="white"
            glassEffect={{ glass: UIGlass.regular().interactive(), shape: { type: "capsule", style: "continuous" } }}
            glassEffectTransition="materialize"
          >
            <Slider
              value={page}
              min={0}
              max={Math.max(1, urls.length - 1)}
              step={1}
              onChanged={(value: number) => seek(value)}
              sliderThumbVisibility="visible"
              tint="white"
              offset={{ x: 0, y: 3 }}
              frame={{ maxWidth: "infinity", height: 16 }}
            />
            <Text font="caption2" fontWeight="semibold" foregroundStyle="white" offset={{ x: 0, y: 3 }} frame={{ maxWidth: "infinity", alignment: "center" }}>
              {urls.length ? `${page + 1} / ${urls.length}` : "-"}
            </Text>
          </VStack>
        </VStack>
      </ZStack>
    )
  }

  const webtoon = (
    <ScrollViewReader>
      {(proxy: any) => {
        proxyRef.current = proxy
        return (
          <ScrollView
            background="black"
            frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
            ignoresSafeArea={true}
            scrollIndicator="never"
            simultaneousGesture={DragGesture({ minDistance: 4, coordinateSpace: "global" })
              .onChanged(() => {
                hideControlsForGesture()
                readerState.isDragging = true
                if (readerState.dragTimer) clearTimeout(readerState.dragTimer)
                readerState.dragTimer = setTimeout(() => {
                  readerState.isDragging = false
                }, 300)
              })}
            onScrollTargetVisibilityChange={{
              idType: "string",
              threshold: 0.1,
              onChanged: handleVisiblePages,
            }}
          >
            <LazyVStack spacing={0} alignment="center" frame={{ maxWidth: "infinity" }} scrollTargetLayout={true}>
              {flatPages.map(item => (
                <WebtoonPageItem
                  key={item.key}
                  itemKey={item.key}
                  image={loadedImages[item.key]}
                  onTap={toggleControls}
                />
              ))}
            </LazyVStack>
          </ScrollView>
        )
      }}
    </ScrollViewReader>
  )

  const paged = (
    <ZStack
      background="black"
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      simultaneousGesture={DragGesture({ minDistance: 4, coordinateSpace: "global" })
        .onChanged(() => {
          hideControlsForGesture()
          readerState.isDragging = true
          if (readerState.dragTimer) clearTimeout(readerState.dragTimer)
          readerState.dragTimer = setTimeout(() => {
            readerState.isDragging = false
          }, 300)
        })}
    >
      {pageImage || loadedImages[pageKey(chapter.id, page)] ? (
        <ReaderImage value={loadedImages[pageKey(chapter.id, page)] ?? null} fullscreen />
      ) : (
        <VStack spacing={10} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
          <Image systemName="photo.badge.exclamationmark" font="title2" foregroundStyle="rgba(255,255,255,0.64)" />
          <Text font="subheadline" foregroundStyle="rgba(255,255,255,0.72)">当前页面没有图片</Text>
        </VStack>
      )}
      <HStack spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <Button buttonStyle="plain" action={previousPage}>
          <VStack background="rgba(0,0,0,0.001)" contentShape="rect" frame={{ maxWidth: "infinity", maxHeight: "infinity" }} />
        </Button>
        <Button buttonStyle="plain" action={toggleControls}>
          <VStack background="rgba(0,0,0,0.001)" contentShape="rect" frame={{ maxWidth: "infinity", maxHeight: "infinity" }} />
        </Button>
        <Button buttonStyle="plain" action={nextPage}>
          <VStack background="rgba(0,0,0,0.001)" contentShape="rect" frame={{ maxWidth: "infinity", maxHeight: "infinity" }} />
        </Button>
      </HStack>
    </ZStack>
  )

  return (
    <NavigationStack background="black" ignoresSafeArea={true}>
      <ZStack
        alignment="bottom"
        background="black"
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        ignoresSafeArea={true}
      >
        {loading ? (
          <VStack spacing={14} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
            <ProgressView progressViewStyle="circular" tint="white" scaleEffect={1.2} />
            <VStack spacing={3}>
              <Text font="headline" foregroundStyle="white">正在读取章节</Text>
              <Text font="caption" foregroundStyle="rgba(255,255,255,0.58)" lineLimit={1}>{chapter.title}</Text>
            </VStack>
          </VStack>
        ) : error ? (
          <VStack spacing={12} padding={24} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
            <Image systemName="exclamationmark.triangle.fill" foregroundStyle="systemOrange" font="title2" />
            <Text foregroundStyle="white" multilineTextAlignment="center">{error}</Text>
            <Button title="重试" systemImage="arrow.clockwise" buttonStyle="glassProminent" tint="white" action={() => loadChapter(chapter, page).catch(() => undefined)} />
          </VStack>
        ) : mode === "webtoon" ? webtoon : paged}

        {showControls ? (
          <>
            <VStack
              spacing={0}
              frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
              transition={controlsTransition}
            >
              <ZStack alignment="center" padding={{ horizontal: 16, top: 50 }} frame={{ maxWidth: "infinity", height: 112 }}>
                <HStack frame={{ maxWidth: "infinity" }}>
                  <ReaderCircleButton systemName="xmark" action={handleReaderClose} />
                  <Spacer />
                </HStack>
                <VStack spacing={2} padding={{ horizontal: 14, vertical: 8 }} frame={{ maxWidth: 184 }} glassEffect={{ glass: UIGlass.regular().interactive(), shape: { type: "capsule", style: "continuous" } }} glassEffectTransition="materialize">
                  <Text font="headline" fontWeight="semibold" foregroundStyle="white" lineLimit={1}>{manga.title}</Text>
                  <Text font="caption" foregroundStyle="rgba(255,255,255,0.68)" lineLimit={1}>{chapter.title}</Text>
                </VStack>
              </ZStack>
              <Spacer />
            </VStack>
            <VStack
              padding={{ horizontal: 16, bottom: 32 }}
              frame={{ maxWidth: "infinity" }}
              transition={controlsTransition}
            >
              {renderControls()}
            </VStack>
            <ReaderSheetControls
              manga={manga}
              chapterBinding={{ value: chapter, select: item => loadChapter(item, 0).catch(() => undefined) }}
              settingsBinding={{ value: readerSettings, updateUpscaler: changeUpscalerSettings }}
              upscalerStatus={upscalerStatus}
              loading={loading}
              toggleUpscaler={toggleUpscaler}
              chapterProgress={chapterProgress}
              onTriggerFullUpscale={triggerFullUpscale}
            />
          </>
        ) : null}
      </ZStack>
    </NavigationStack>
  )
}

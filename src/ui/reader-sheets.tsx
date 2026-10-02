import {
  Button,
  Divider,
  HStack,
  Image,
  LazyVStack,
  Picker,
  ProgressView,
  ScrollView,
  Spacer,
  Text,
  Toggle,
  VStack,
  ZStack,
  useEffect,
  useRef,
  useState,
} from "scripting"
import type { AppSettings, MangaChapter, MangaDetail } from "../model"
import { clearEnhancedCache, getEnhancedCacheStats } from "../enhanced-cache"

const READER_BUTTON_SIZE = 50
const READER_BUTTON_RADIUS = READER_BUTTON_SIZE / 2
const READER_ICON_SIZE = 29
const SHEET_CLOSE_SIZE = 40

type ChapterBinding = {
  value: MangaChapter
  select: (chapter: MangaChapter) => void
}

type SettingsBinding = {
  value: AppSettings
  updateUpscaler: (patch: Partial<AppSettings>) => void
}

function SheetCloseButton({ action }: { action: () => void }) {
  return (
    <Button
      buttonStyle="plain"
      frame={{ width: SHEET_CLOSE_SIZE, height: SHEET_CLOSE_SIZE, alignment: "center" }}
      contentShape="rect"
      action={action}
    >
      <ZStack
        frame={{ width: SHEET_CLOSE_SIZE, height: SHEET_CLOSE_SIZE, alignment: "center" }}
        contentShape="rect"
        glassEffect={{ glass: UIGlass.regular().interactive(), shape: { type: "rect", cornerRadius: SHEET_CLOSE_SIZE / 2, style: "continuous" } }}
        glassEffectTransition="materialize"
      >
        <Image systemName="xmark" font="headline" foregroundStyle="white" frame={{ width: 24, height: 24, alignment: "center" }} />
      </ZStack>
    </Button>
  )
}

function SheetTrigger({ systemName, active, disabled = false, action }: {
  systemName: string
  active: boolean
  disabled?: boolean
  action: () => void
}) {
  return (
    <Button
      buttonStyle="plain"
      disabled={disabled}
      frame={{ width: READER_BUTTON_SIZE, height: READER_BUTTON_SIZE, alignment: "center" }}
      contentShape="rect"
      action={action}
    >
      <ZStack
        frame={{ width: READER_BUTTON_SIZE, height: READER_BUTTON_SIZE, alignment: "center" }}
        contentShape="rect"
        opacity={disabled ? 0.38 : 1}
        glassEffect={{ glass: UIGlass.regular().interactive(), shape: { type: "rect", cornerRadius: READER_BUTTON_RADIUS, style: "continuous" } }}
        glassEffectTransition="materialize"
      >
        <Image systemName={systemName} font="title2" foregroundStyle={active ? "systemRed" : "white"} frame={{ width: READER_ICON_SIZE, height: READER_ICON_SIZE, alignment: "center" }} />
      </ZStack>
    </Button>
  )
}

export function ReaderSheetControls({
  manga,
  chapterBinding,
  settingsBinding,
  upscalerStatus,
  loading,
  toggleUpscaler,
  chapterProgress,
  onTriggerFullUpscale,
}: {
  manga: MangaDetail
  chapterBinding: ChapterBinding
  settingsBinding: SettingsBinding
  upscalerStatus: string
  loading: boolean
  toggleUpscaler: () => void
  chapterProgress?: { completed: number; total: number }
  onTriggerFullUpscale?: () => void
}) {
  // 弹窗状态隔离在子视图：切换 isChapterSheet 不会让阅读器根视图整体刷新。
  const [isChapterSheet, setIsChapterSheet] = useState(false)
  const [isUpscalerSheet, setIsUpscalerSheet] = useState(false)
  const [cacheInfo, setCacheInfo] = useState<{ count: number; totalMB: string } | null>(null)
  const longPressHandled = useRef(false)
  const sheetAnimation = Animation.smooth({ duration: 0.42, extraBounce: 0 })
  const sheetTransition = Transition.move("bottom").combined(Transition.opacity()).animation(sheetAnimation)
  const chapter = chapterBinding.value
  const readerSettings = settingsBinding.value

  useEffect(() => {
    if (isUpscalerSheet) {
      getEnhancedCacheStats()
        .then(stats => setCacheInfo({ count: stats.count, totalMB: stats.totalMB }))
        .catch(() => undefined)
    }
  }, [isUpscalerSheet])

  async function handleClearCache() {
    const haptic = (globalThis as any).HapticFeedback
    haptic?.notification?.("warning")
    await clearEnhancedCache()
    setCacheInfo({ count: 0, totalMB: "0.0" })
  }

  function toggleChapterSheet() {
    const haptic = (globalThis as any).HapticFeedback
    haptic?.selectionChanged?.()
    withAnimation(sheetAnimation, () => {
      setIsUpscalerSheet(false)
      setIsChapterSheet(value => !value)
    })
  }

  function toggleUpscalerSheet() {
    const haptic = (globalThis as any).HapticFeedback
    haptic?.selectionChanged?.()
    withAnimation(sheetAnimation, () => {
      setIsChapterSheet(false)
      setIsUpscalerSheet(value => !value)
    })
  }

  function selectChapter(item: MangaChapter) {
    withAnimation(Animation.easeOut(0.2), () => setIsChapterSheet(false))
    chapterBinding.select(item)
  }

  const chapterSheet = isChapterSheet ? (
    <VStack
      alignment="leading"
      spacing={8}
      padding={16}
      frame={{ maxWidth: "infinity", maxHeight: 420 }}
      foregroundStyle="white"
      glassEffect={{ glass: UIGlass.regular().interactive(), shape: { type: "rect", cornerRadius: 32, style: "continuous" } }}
      glassEffectTransition="materialize"
      transition={sheetTransition}
    >
      <HStack frame={{ maxWidth: "infinity", minHeight: SHEET_CLOSE_SIZE }}>
        <Text font="headline">选择章节</Text>
        <Spacer />
        <SheetCloseButton action={toggleChapterSheet} />
      </HStack>
      <ScrollView scrollIndicator="never">
        <LazyVStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity" }}>
          {manga.chapters.map(item => {
            const current = item.id === chapter.id
            return (
              <VStack key={item.id} spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <Divider background="rgba(255,255,255,0.22)" />
                <Button buttonStyle="plain" frame={{ maxWidth: "infinity", alignment: "leading" }} contentShape="rect" action={() => selectChapter(item)}>
                  <HStack padding={{ vertical: 10 }} frame={{ maxWidth: "infinity", alignment: "leading" }} contentShape="rect">
                    <Text font="subheadline" fontWeight={current ? "bold" : "regular"} foregroundStyle={current ? "systemRed" : "white"} lineLimit={2}>{item.title}</Text>
                    <Spacer />
                  </HStack>
                </Button>
              </VStack>
            )
          })}
        </LazyVStack>
      </ScrollView>
    </VStack>
  ) : null

  const upscalerSheet = isUpscalerSheet ? (
    <VStack
      alignment="leading"
      spacing={14}
      padding={16}
      foregroundStyle="white"
      frame={{ maxWidth: "infinity" }}
      glassEffect={{ glass: UIGlass.regular().interactive(), shape: { type: "rect", cornerRadius: 30, style: "continuous" } }}
      glassEffectTransition="materialize"
      transition={sheetTransition}
    >
      <HStack frame={{ maxWidth: "infinity", minHeight: SHEET_CLOSE_SIZE }}>
        <Text font="headline">离线超分</Text>
        <Spacer />
        <SheetCloseButton action={toggleUpscalerSheet} />
      </HStack>
      <Toggle title="启用本地超分" systemImage="sparkles.rectangle.stack" value={readerSettings.upscalerEnabled ?? readerSettings.anime4kEnabled} onChanged={value => withAnimation(sheetAnimation, () => settingsBinding.updateUpscaler({ upscalerEnabled: value, anime4kEnabled: value }))} />
      <VStack alignment="leading" spacing={7} frame={{ maxWidth: "infinity" }}>
        <Text font="subheadline" fontWeight="semibold">引擎</Text>
        <Picker
          title="引擎"
          value={readerSettings.upscalerEngine}
          onChanged={(value: string) => {
            if (value && value !== readerSettings.upscalerEngine) {
              withAnimation(sheetAnimation, () => settingsBinding.updateUpscaler({ upscalerEngine: value as any }))
            }
          }}
          pickerStyle="segmented"
          tint="systemRed"
        >
          <Text tag="anime4k">Anime4K</Text>
          <Text tag="waifu2x">Waifu2x</Text>
        </Picker>
      </VStack>
      <VStack alignment="leading" spacing={7} frame={{ maxWidth: "infinity" }}>
        <Text font="subheadline" fontWeight="semibold">超分范围</Text>
        <Picker
          title="超分范围"
          value={readerSettings.upscalerScope}
          onChanged={(value: string) => {
            if (value && value !== readerSettings.upscalerScope) {
              withAnimation(sheetAnimation, () => settingsBinding.updateUpscaler({ upscalerScope: value as any }))
            }
          }}
          pickerStyle="segmented"
          tint="systemRed"
        >
          <Text tag="all">全量超分 (整话)</Text>
          <Text tag="window">滑动窗口 (省电)</Text>
        </Picker>
      </VStack>
      {(readerSettings.upscalerEnabled ?? readerSettings.anime4kEnabled) && readerSettings.upscalerScope === "all" && chapterProgress && chapterProgress.total > 0 ? (
        <VStack
          alignment="leading"
          spacing={8}
          padding={12}
          frame={{ maxWidth: "infinity" }}
          background="rgba(255,255,255,0.08)"
          clipShape={{ type: "rect", cornerRadius: 14, style: "continuous" }}
        >
          <HStack frame={{ maxWidth: "infinity" }}>
            <Text font="caption" fontWeight="semibold" foregroundStyle="rgba(255,255,255,0.9)">整话超分进度</Text>
            <Spacer />
            <Text font="caption" fontWeight="bold" foregroundStyle={chapterProgress.completed >= chapterProgress.total ? "systemGreen" : "systemRed"}>
              {chapterProgress.completed} / {chapterProgress.total} 页 ({Math.round((chapterProgress.completed / chapterProgress.total) * 100)}%)
            </Text>
          </HStack>
          <ProgressView
            value={chapterProgress.completed}
            total={chapterProgress.total}
            tint={chapterProgress.completed >= chapterProgress.total ? "systemGreen" : "systemRed"}
          />
          <HStack spacing={6}>
            <Image
              systemName={chapterProgress.completed >= chapterProgress.total ? "checkmark.circle.fill" : "sparkles"}
              foregroundStyle={chapterProgress.completed >= chapterProgress.total ? "systemGreen" : "systemRed"}
              font="caption"
            />
            <Text font="caption2" foregroundStyle="rgba(255,255,255,0.72)">
              {chapterProgress.completed >= chapterProgress.total
                ? "整话图片已全部超分，阅读翻页秒开"
                : "优先超分当前可视页，后台持续全量处理"}
            </Text>
            <Spacer />
            {chapterProgress.completed < chapterProgress.total && onTriggerFullUpscale ? (
              <Button
                title="立即全量超分"
                buttonStyle="glass"
                tint="systemRed"
                action={onTriggerFullUpscale}
              />
            ) : null}
          </HStack>
        </VStack>
      ) : null}
      {readerSettings.upscalerEngine === "anime4k" ? (
        <>
          <VStack alignment="leading" spacing={7} frame={{ maxWidth: "infinity" }}>
            <Text font="subheadline" fontWeight="semibold">处理档位</Text>
            <Picker title="处理档位" value={readerSettings.anime4kProfile} onChanged={(value: string) => withAnimation(sheetAnimation, () => settingsBinding.updateUpscaler({ anime4kProfile: value === "fast" || value === "balanced" ? value : "quality" }))} pickerStyle="segmented" tint="systemRed">
              <Text tag="fast">快速</Text><Text tag="balanced">均衡</Text><Text tag="quality">高质量</Text>
            </Picker>
          </VStack>
          <VStack alignment="leading" spacing={7} frame={{ maxWidth: "infinity" }}>
            <Text font="subheadline" fontWeight="semibold">锐化强度</Text>
            <Picker title="锐化强度" value={readerSettings.anime4kStrength} onChanged={(value: number) => withAnimation(sheetAnimation, () => settingsBinding.updateUpscaler({ anime4kStrength: Number(value) }))} pickerStyle="segmented" tint="systemRed">
              <Text tag={0.8}>轻微</Text><Text tag={1.25}>清晰</Text><Text tag={1.8}>强烈</Text>
            </Picker>
          </VStack>
        </>
      ) : null}
      <VStack alignment="leading" spacing={7} frame={{ maxWidth: "infinity" }}>
        <Text font="subheadline" fontWeight="semibold">降噪</Text>
        <Picker
          title="降噪"
          value={readerSettings.upscalerEngine === "waifu2x" ? readerSettings.waifu2xDenoise : readerSettings.anime4kDenoise}
          onChanged={(value: number) => {
            const nextVal = Number(value)
            const curVal = readerSettings.upscalerEngine === "waifu2x" ? readerSettings.waifu2xDenoise : readerSettings.anime4kDenoise
            if (nextVal !== curVal) {
              withAnimation(sheetAnimation, () => settingsBinding.updateUpscaler(readerSettings.upscalerEngine === "waifu2x" ? { waifu2xDenoise: nextVal } : { anime4kDenoise: nextVal }))
            }
          }}
          pickerStyle="segmented"
        >
          <Text tag={0}>0×</Text><Text tag={1}>1×</Text><Text tag={2}>2×</Text><Text tag={3}>3×</Text>
        </Picker>
      </VStack>
      <VStack alignment="leading" spacing={7} frame={{ maxWidth: "infinity" }}>
        <Text font="subheadline" fontWeight="semibold">放大</Text>
        {readerSettings.upscalerEngine === "waifu2x" ? (
          <Picker
            title="放大"
            value={readerSettings.waifu2xScale}
            onChanged={(value: number) => {
              const nextVal = Number(value)
              if (nextVal !== readerSettings.waifu2xScale) {
                withAnimation(sheetAnimation, () => settingsBinding.updateUpscaler({ waifu2xScale: nextVal }))
              }
            }}
            pickerStyle="segmented"
          >
            <Text tag={1}>1×</Text><Text tag={2}>2×</Text>
          </Picker>
        ) : (
          <Picker
            title="放大"
            value={readerSettings.anime4kScale}
            onChanged={(value: number) => {
              const nextVal = Number(value)
              if (nextVal !== readerSettings.anime4kScale) {
                withAnimation(sheetAnimation, () => settingsBinding.updateUpscaler({ anime4kScale: nextVal }))
              }
            }}
            pickerStyle="segmented"
          >
            <Text tag={1.5}>1.5×</Text><Text tag={2}>2×</Text><Text tag={3}>3×</Text>
          </Picker>
        )}
      </VStack>
      <Text font="caption" foregroundStyle="rgba(255,255,255,0.68)">
        {readerSettings.upscalerEngine === "waifu2x"
          ? "Waifu2x 使用内置动漫 AI 模型，以 100% 神经重建输出最清晰的线稿与文字。开启“全量超分”可在后台对整话所有页面进行超分并持久化缓存到本地，翻页秒开。"
          : "Anime4K 使用边缘导向重建和局部对比增强；“高质量 + 强烈”效果最明显。全量模式将自动增强整话所有页面。"}
      </Text>
      <HStack frame={{ maxWidth: "infinity" }}>
        <Text font="caption2" foregroundStyle="rgba(255,255,255,0.64)">
          {cacheInfo ? `超分磁盘缓存: ${cacheInfo.count} 张 · ${cacheInfo.totalMB} MB` : "正在统计缓存..."}
        </Text>
        <Spacer />
        <Button
          buttonStyle="plain"
          action={handleClearCache}
        >
          <Text font="caption2" foregroundStyle="systemRed">清空缓存</Text>
        </Button>
      </HStack>
      <HStack spacing={6}><Image systemName={upscalerStatus.includes("·") ? "checkmark.seal.fill" : "info.circle"} foregroundStyle={upscalerStatus.includes("·") ? "systemGreen" : "rgba(255,255,255,0.68)"} /><Text font="caption2" foregroundStyle="rgba(255,255,255,0.68)">{upscalerStatus}</Text></HStack>
    </VStack>
  ) : null

  return (
    <ZStack alignment="bottom" frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      {chapterSheet || upscalerSheet ? (
        <VStack padding={{ horizontal: 16, bottom: 166 }} frame={{ maxWidth: "infinity" }}>
          {chapterSheet}{upscalerSheet}
        </VStack>
      ) : null}

      {isChapterSheet || isUpscalerSheet ? null : (
        <VStack spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
          <HStack alignment="center" padding={{ horizontal: 16, top: 50 }} frame={{ maxWidth: "infinity", height: 112 }}>
            <Spacer />
            <Button
              buttonStyle="plain"
              frame={{ width: READER_BUTTON_SIZE, height: READER_BUTTON_SIZE, alignment: "center" }}
              contentShape="rect"
              action={() => {
                if (!longPressHandled.current) toggleUpscaler()
              }}
            >
              <ZStack
                frame={{ width: READER_BUTTON_SIZE, height: READER_BUTTON_SIZE, alignment: "center" }}
                contentShape="rect"
                glassEffect={{ glass: UIGlass.regular().interactive(), shape: { type: "rect", cornerRadius: READER_BUTTON_RADIUS, style: "continuous" } }}
                glassEffectTransition="materialize"
                onLongPressGesture={{
                  minDuration: 550,
                  onPressingChanged: (pressing: boolean) => {
                    if (!pressing) setTimeout(() => { longPressHandled.current = false }, 400)
                  },
                  perform: () => {
                    longPressHandled.current = true
                    toggleUpscalerSheet()
                  },
                }}
              >
                <Image systemName="sparkles.rectangle.stack" font="title2" foregroundStyle={(readerSettings.upscalerEnabled ?? readerSettings.anime4kEnabled) ? "systemRed" : "white"} frame={{ width: READER_ICON_SIZE, height: READER_ICON_SIZE, alignment: "center" }} />
              </ZStack>
            </Button>
          </HStack>
          <Spacer />
        </VStack>
      )}

      {isChapterSheet || isUpscalerSheet ? null : (
        <HStack padding={{ horizontal: 16, bottom: 32 }} frame={{ maxWidth: "infinity" }}>
          <Spacer />
          <SheetTrigger systemName="list.bullet" active={isChapterSheet} disabled={loading} action={toggleChapterSheet} />
        </HStack>
      )}
    </ZStack>
  )
}

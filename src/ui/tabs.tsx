import {
  Button,
  Divider,
  GlassEffectContainer,
  Group,
  HStack,
  Image,
  List,
  Navigation,
  NavigationLink,
  Picker,
  ProgressView,
  ScrollView,
  Section,
  Script,
  SecureField,
  Spacer,
  Text,
  TextField,
  Toggle,
  VStack,
  ZStack,
  useEffect,
  useMemo,
  useState,
} from "scripting"
import type { AppSettings, MangaSource, MangaSummary, SavedSourceConfig, SourceCategory, SourceSort } from "../model"
import {
  clearCachedSourceData,
  loadFavorites,
  loadHistory,
  loadSettings,
  mangaKey,
  removeHistory,
  saveSettings,
} from "../storage"
import { availableSources, sourceFor } from "../sources"
import { discoverMangaSource } from "../sources/discovery"
import { clearSourceLogin, openSourceLogin, sourceHasLogin } from "../auth"
import { addSourceDomain, normalizeSourceOrigin, selectSourceDomain, sourceDomains } from "../source-domains"
import { clearEnhancedCache, getEnhancedCacheStats } from "../enhanced-cache"
import { EmptyState, ErrorState, HistoryRow, LoadingState, MangaGrid, MinimizeButton, ToolbarIconButton } from "./components"
import { DetailPage } from "./detail"

type SettingsProps = {
  settings: AppSettings
  onSettingsChanged: (settings: AppSettings) => void
}

function sourceForSettings(settings: AppSettings, manga: MangaSummary) {
  const saved = settings.savedSources.find(item => item.id === manga.sourceId)
  if (saved) return sourceFor(settings, manga.sourceId, manga.url)
  try {
    const mangaHost = new URL(manga.url).hostname.replace(/^www\./, "")
    const config = settings.savedSources.find(item => new URL(item.baseURL).hostname.replace(/^www\./, "") === mangaHost)
    if (config) return sourceFor(settings, config.id, manga.url)
  } catch { /* historic URL is malformed */ }
  return sourceFor(settings, manga.sourceId, manga.url)
}

async function presentDetail(manga: MangaSummary, settings: AppSettings, onSettingsChanged: (value: AppSettings) => void) {
  const freshSettings = { ...settings, ...loadSettings() }
  const source = sourceForSettings(freshSettings, manga)
  const detailTask = source.detail(manga)
  await Navigation.present({
    element: <DetailPage source={source} manga={manga} detailTask={detailTask} settings={freshSettings} onSettingsChanged={onSettingsChanged} />,
    modalPresentationStyle: "overFullScreen",
  })
}


function SourceDomainAddPage({ source, onAdded }: { source: SavedSourceConfig; onAdded: (source: SavedSourceConfig) => void }) {
  const dismiss = Navigation.useDismiss()
  const [url, setURL] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    if (!url.trim() || loading) return
    setLoading(true)
    setError(null)
    try {
      const origin = normalizeSourceOrigin(url)
      const discovered = await discoverMangaSource(origin)
      const next = addSourceDomain(source, discovered)
      onAdded(next)
      dismiss()
    } catch (reason: any) {
      setError(reason?.message ?? String(reason))
    } finally {
      setLoading(false)
    }
  }

  return (
    <VStack
      alignment="leading"
      spacing={16}
      padding={{ horizontal: 18, vertical: 20 }}
      frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "top" }}
      navigationTitle="添加源"
      navigationBarTitleDisplayMode="inline"
      toolbar={{ topBarLeading: [<ToolbarIconButton key="close" systemName="xmark" action={() => dismiss()} />] }}
    >
      <TextField
        title="网址"
        value={url}
        onChanged={value => { setURL(value); setError(null) }}
        prompt="https://example.com"
        textInputAutocapitalization="never"
        autocorrectionDisabled={true}
        frame={{ maxWidth: "infinity" }}
      />
      <Button
        title={loading ? "正在确认" : "确认"}
        systemImage={loading ? "hourglass" : "checkmark.circle.fill"}
        buttonStyle="glassProminent"
        tint="systemRed"
        disabled={loading || !url.trim()}
        frame={{ maxWidth: "infinity", minHeight: 48 }}
        action={() => confirm().catch(() => undefined)}
      />
      {error ? <Text font="caption" foregroundStyle="systemRed">{error}</Text> : null}
      <Spacer />
    </VStack>
  )
}

function SourceDomainPickerPage({ initialSource, onChanged }: { initialSource: SavedSourceConfig; onChanged: (source: SavedSourceConfig) => void }) {
  const dismiss = Navigation.useDismiss()
  const [source, setSource] = useState(initialSource)
  const domains = sourceDomains(source)
  const activeOrigin = normalizeSourceOrigin(source.baseURL)
  const active = domains.find(domain => domain.baseURL === activeOrigin) ?? domains[0]
  const inactive = domains.filter(domain => domain.baseURL !== activeOrigin)

  function commit(next: SavedSourceConfig) {
    setSource(next)
    onChanged(next)
  }

  function choose(baseURL: string) {
    commit(selectSourceDomain(source, baseURL))
    dismiss()
  }

  async function openAddSource() {
    await Navigation.present({
      element: <SourceDomainAddPage source={source} onAdded={commit} />,
    })
  }

  function domainLabel(baseURL: string) {
    try { return new URL(baseURL).hostname } catch { return baseURL }
  }

  return (
    <ScrollView
      navigationTitle="选择源"
      navigationBarTitleDisplayMode="inline"
      scrollContentBackground="hidden"
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      toolbar={{ topBarLeading: [<ToolbarIconButton key="close" systemName="xmark" action={() => dismiss()} />] }}
    >
      <VStack alignment="leading" spacing={14} padding={{ horizontal: 16, vertical: 18 }} frame={{ maxWidth: "infinity" }}>
        <Text font="caption" foregroundStyle="secondaryLabel">正在使用的源</Text>
        {active ? (
          <HStack
            spacing={12}
            padding={{ horizontal: 16, vertical: 14 }}
            frame={{ maxWidth: "infinity", minHeight: 52 }}
            glassEffect={{ glass: UIGlass.regular().interactive().tint("rgba(215,38,56,0.14)"), shape: { type: "rect", cornerRadius: 22, style: "continuous" } }}
          >
            <Image systemName="checkmark.circle.fill" foregroundStyle="systemRed" />
            <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Text font="headline" fontWeight="semibold" foregroundStyle="systemRed">{domainLabel(active.baseURL)}</Text>
              <Text font="caption" foregroundStyle="systemRed" lineLimit={1}>{active.baseURL}</Text>
            </VStack>
          </HStack>
        ) : null}
        {inactive.length ? <Text font="caption" foregroundStyle="secondaryLabel">未使用的源</Text> : null}
        {inactive.map(domain => (
          <Button key={domain.baseURL} buttonStyle="plain" frame={{ maxWidth: "infinity" }} action={() => choose(domain.baseURL)}>
            <HStack
              spacing={12}
              padding={{ horizontal: 16, vertical: 14 }}
              frame={{ maxWidth: "infinity", minHeight: 52 }}
              contentShape="rect"
              glassEffect={{ glass: UIGlass.regular().interactive(), shape: { type: "rect", cornerRadius: 22, style: "continuous" } }}
            >
              <Image systemName="globe" foregroundStyle="secondaryLabel" />
              <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <Text font="headline" fontWeight="semibold">{domainLabel(domain.baseURL)}</Text>
                <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>{domain.baseURL}</Text>
              </VStack>
              <Image systemName="chevron.right" font="caption" foregroundStyle="tertiaryLabel" />
            </HStack>
          </Button>
        ))}
        <Button
          title="添加源"
          systemImage="plus.circle.fill"
          buttonStyle="glassProminent"
          buttonBorderShape="capsule"
          tint="systemRed"
          frame={{ maxWidth: "infinity", minHeight: 52 }}
          action={() => openAddSource().catch(() => undefined)}
        />
      </VStack>
    </ScrollView>
  )
}

async function presentSourceDomainPicker(source: SavedSourceConfig, onChanged: (source: SavedSourceConfig) => void) {
  await Navigation.present({
    element: <SourceDomainPickerPage initialSource={source} onChanged={onChanged} />,
  })
}

function SourceCard({ source, settings, onSettingsChanged, onRemove, onPin, onSelectSource }: {
  source: MangaSource
  settings: AppSettings
  onSettingsChanged: (settings: AppSettings) => void
  onRemove: (sourceId: string) => void
  onPin: (sourceId: string) => void
  onSelectSource: (sourceId: string) => void
}) {
  const pinned = settings.sourcePinnedAt[source.id] != null
  const savedSource = settings.savedSources.find(item => item.id === source.id)
  const domainCount = savedSource ? sourceDomains(savedSource).length : 1
  const loginDetected = source.loginDiscovery && source.loginDiscovery !== "none"
  const pinAction = () => onPin(source.id)
  const selectSourceAction = () => onSelectSource(source.id)
  const removeAction = () => onRemove(source.id)
  return (
    <NavigationLink
      destination={<SourceCatalogPage source={source} settings={settings} onSettingsChanged={onSettingsChanged} />}
      buttonStyle="plain"
      frame={{ maxWidth: "infinity" }}
      contextMenu={{
        menuItems: <Group>
          <Button title={pinned ? "取消置顶" : "置顶"} systemImage={pinned ? "pin.slash" : "pin.fill"} action={pinAction} />
          <Button title="选择源" systemImage="arrow.triangle.2.circlepath" action={selectSourceAction} />
          <Button title="删除图源" systemImage="trash" role="destructive" action={removeAction} />
        </Group>,
      }}
    >
      <HStack
        spacing={14}
        padding={{ horizontal: 16, vertical: 14 }}
        frame={{ maxWidth: "infinity" }}
        contentShape="rect"
        glassEffect={{ glass: UIGlass.regular().interactive(), shape: { type: "rect", cornerRadius: 26, style: "continuous" } }}
        glassEffectTransition="materialize"
      >
        <Image
          systemName={/komiic/i.test(source.id) ? "person.crop.circle.badge.checkmark" : /(?:^|\.)godamh\.com$/i.test(new URL(source.baseURL).hostname) ? "globe.asia.australia" : /(?:^|\.)mycomic\.com$/i.test(new URL(source.baseURL).hostname) || source.id === "mycomic" ? "books.vertical.fill" : "network"}
          font="title2"
          foregroundStyle="systemRed"
          frame={{ width: 34, height: 34, alignment: "center" }}
        />
        <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <HStack spacing={6}>
            <Text font="headline" fontWeight="semibold">{source.name}</Text>
            {pinned ? <Image systemName="pin.fill" font="caption" foregroundStyle="systemOrange" /> : null}
            {loginDetected ? <Image systemName="person.crop.circle.badge.checkmark" font="caption" foregroundStyle="systemGreen" /> : null}
          </HStack>
          <Text font="caption" foregroundStyle="secondaryLabel">{source.categories.length} 个分类 · {new URL(source.baseURL).hostname}{domainCount > 1 ? ` · ${domainCount} 个源` : ""}</Text>
        </VStack>
        <Image systemName="chevron.right" font="caption" foregroundStyle="tertiaryLabel" frame={{ width: 16, height: 16, alignment: "center" }} />
      </HStack>
    </NavigationLink>
  )
}

function CatalogLoginCloseButton({ action }: { action: () => void }) {
  const [pressed, setPressed] = useState(false)

  function close() {
    const haptic = (globalThis as any).HapticFeedback
    haptic?.impactOccurred?.("light")
    withAnimation(Animation.easeOut(0.1), () => setPressed(true))
    setTimeout(() => {
      withAnimation(Animation.easeOut(0.2), action)
      setPressed(false)
    }, 70)
  }

  return (
    <Button
      buttonStyle="plain"
      frame={{ width: 44, height: 44, alignment: "center" }}
      action={close}
    >
      <ZStack
        frame={{ width: 44, height: 44, alignment: "center" }}
        contentShape="circle"
        scaleEffect={pressed ? 0.88 : 1}
        glassEffect={{ glass: UIGlass.regular().interactive(), shape: { type: "rect", cornerRadius: 22, style: "continuous" } }}
        glassEffectTransition="materialize"
      >
        <Image systemName="xmark" font="title3" fontWeight="semibold" foregroundStyle="systemRed" frame={{ width: 26, height: 26, alignment: "center" }} />
      </ZStack>
    </Button>
  )
}

const CATALOG_TAB_SPACING = 8
const FILTER_TYPE_COLUMN_SPACING = 6
const FILTER_TYPE_ROW_SPACING = 4
const CATALOG_TAB_WIDTH = 120
const CATALOG_BUTTON_HEIGHT = 52
const FILTER_FOUR_COLUMN_WIDTH = 86
const FILTER_THREE_COLUMN_WIDTH = 117

type FilterCategoryRow = {
  items: SourceCategory[]
  columns: 3 | 4
}

type SourceCatalogConfiguration = {
  recommendedCategory: SourceCategory | null
  popularCategory: SourceCategory | null
  updatedCategory: SourceCategory | null
  filterCategories: SourceCategory[]
  filterCategoryIds: Set<string>
  filterCategoryRows: FilterCategoryRow[]
  selectableCategories: SourceCategory[]
  categoryById: Map<string, SourceCategory>
  defaultCategory: SourceCategory | undefined
}

type CatalogViewState = {
  items: MangaSummary[]
  page: number
  hasNext: boolean
  loading: boolean
  error: string | null
}

function visibleCharacterCount(title: string) {
  return Array.from(title.replace(/\s+/g, "")).length
}

function makeFilterCategoryRows(categories: SourceCategory[]): FilterCategoryRow[] {
  const rows: FilterCategoryRow[] = []
  let offset = 0

  while (offset < categories.length) {
    const fourItemCandidate = categories.slice(offset, offset + 4)
    const candidateCharacterCount = fourItemCandidate.reduce(
      (total, item) => total + visibleCharacterCount(item.title),
      0,
    )
    const columns: 3 | 4 = candidateCharacterCount <= 8 ? 4 : 3
    const items = categories.slice(offset, offset + columns)
    rows.push({ items, columns })
    offset += items.length
  }

  return rows
}

function makeSourceCatalogConfiguration(source: MangaSource): SourceCatalogConfiguration {
  const hostname = new URL(source.baseURL).hostname
  const isCopy3000Source = /(?:^|\.)copy3000\.com$/i.test(hostname)
  const isKomiicSource = /(?:^|\.)komiic\.(?:cc|com)$/i.test(hostname)
  const isMyComicSource = /(?:^|\.)mycomic\.com$/i.test(hostname) || source.id === "mycomic"
  const savedRecommended = source.categories.find(item => /\/recommend\b|推荐|推薦/i.test(`${item.path} ${item.title}`))
  const savedPopular = source.categories.find(item => /ordering=-popular|热门|熱門|人气|人氣|hots/i.test(`${item.path} ${item.title}`))
  const savedUpdated = source.categories.find(item => /ordering=-datetime_updated|最近更新|最新|newss/i.test(`${item.path} ${item.title}`))
  const recommendedCategory: SourceCategory | null = isCopy3000Source
    ? { id: "website-recommended", title: "推荐", path: "/recommend", systemImage: "hand.thumbsup.fill" }
    : isMyComicSource
      ? { id: "website-recommended", title: "最高人气", path: "/cn/comics?sort=-views", systemImage: "flame.fill" }
      : savedRecommended ?? null
  const popularCategory: SourceCategory | null = isCopy3000Source
    ? { id: "website-popular", title: "热门", path: "/comics?ordering=-popular", systemImage: "flame.fill" }
    : isMyComicSource
      ? { id: "website-popular", title: "排行榜", path: "/cn/rank", systemImage: "chart.bar.fill" }
      : savedPopular ?? null
  const updatedCategory: SourceCategory | null = isCopy3000Source
    ? { id: "website-updated", title: "最近更新", path: "/comics?ordering=-datetime_updated", systemImage: "clock.fill" }
    : isMyComicSource
      ? { id: "website-updated", title: "最近更新", path: "/cn/comics?sort=-update", systemImage: "clock.fill" }
      : savedUpdated ?? null
  const primaryCategories = [recommendedCategory, popularCategory, updatedCategory]
    .filter((item): item is SourceCategory => item !== null)
  const primaryIds = new Set(primaryCategories.map(item => item.id))
  for (const id of [savedRecommended?.id, savedPopular?.id, savedUpdated?.id]) {
    if (id) primaryIds.add(id)
  }
  const websiteFilters = isKomiicSource
    ? source.categories.filter(item => /^komiic:category:/i.test(item.path))
    : source.categories.filter(item => /[?&](?:theme|genre|category|tag)=/i.test(item.path))
  const filterCategories = websiteFilters.length
    ? websiteFilters
    : source.categories.filter(item => !primaryIds.has(item.id))
  const selectableCategories = [...primaryCategories, ...filterCategories]

  return {
    recommendedCategory,
    popularCategory,
    updatedCategory,
    filterCategories,
    filterCategoryIds: new Set(filterCategories.map(item => item.id)),
    filterCategoryRows: makeFilterCategoryRows(filterCategories),
    selectableCategories,
    categoryById: new Map(selectableCategories.map(item => [item.id, item])),
    defaultCategory: selectableCategories[0] ?? source.categories[0],
  }
}

function appendUniqueManga(current: MangaSummary[], incoming: MangaSummary[]) {
  const seen = new Set(current.map(item => `${item.sourceId}:${item.id}`))
  return [...current, ...incoming.filter(item => !seen.has(`${item.sourceId}:${item.id}`))]
}

function CatalogPillLabel({ title, systemName, compact = false }: { title: string; systemName: string; compact?: boolean }) {
  return (
    <HStack spacing={compact ? 4 : 6} frame={{ maxWidth: "infinity", alignment: "center" }}>
      <Image systemName={systemName} font={compact ? "subheadline" : "body"} />
      <Text font={compact ? "subheadline" : "body"} fontWeight="semibold" lineLimit={1}>{title}</Text>
    </HStack>
  )
}

function SourceCatalogPage({ source, settings, onSettingsChanged }: { source: MangaSource; settings: AppSettings; onSettingsChanged: (settings: AppSettings) => void }) {
  const dismiss = Navigation.useDismiss()
  const configuration = useMemo(() => makeSourceCatalogConfiguration(source), [source.id, source.baseURL, source.categories])
  const {
    recommendedCategory,
    popularCategory,
    updatedCategory,
    filterCategories,
    filterCategoryIds,
    filterCategoryRows,
    selectableCategories,
    categoryById,
    defaultCategory,
  } = configuration
  if (!defaultCategory) return <EmptyState title="图源没有分类" detail="请删除后重新添加该图源。" icon="exclamationmark.triangle.fill" />
  const initialCategory = settings.activeSourceId === source.id
    ? categoryById.get(settings.categoryId) ?? defaultCategory
    : defaultCategory
  const [catalogSettings, setCatalogSettings] = useState<AppSettings>({
    ...settings,
    ...loadSettings(),
    activeSourceId: source.id,
    categoryId: initialCategory.id,
  })

  useEffect(() => {
    setCatalogSettings(prev => ({ ...prev, ...settings, ...loadSettings() }))
  }, [settings])
  const [category, setCategory] = useState<SourceCategory>(initialCategory)
  const [filterExpanded, setFilterExpanded] = useState(false)
  const [catalog, setCatalog] = useState<CatalogViewState>({
    items: [],
    page: 1,
    hasNext: false,
    loading: true,
    error: null,
  })
  const { items, page, hasNext, loading, error } = catalog
  const [reloadToken, setReloadToken] = useState(0)
  const [accountLabel, setAccountLabel] = useState("")
  const [loginIdentifier, setLoginIdentifier] = useState(source.savedLoginIdentifier?.() ?? "")
  const [loginPassword, setLoginPassword] = useState("")
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginLoading, setLoginLoading] = useState(false)
  const [loginStatus, setLoginStatus] = useState("")
  const [manualLoginLoading, setManualLoginLoading] = useState(false)
  const initialWebLoginActive = useMemo(() => sourceHasLogin(source.baseURL), [source.baseURL])
  const [webLoginActive, setWebLoginActive] = useState(initialWebLoginActive)
  const nativeLogin = Boolean(source.login && source.supportsLogin)
  const loginDetected = Boolean(source.loginDiscovery && source.loginDiscovery !== "none")
  const shouldShowLogin = Boolean(nativeLogin || loginDetected || webLoginActive)
  const browserLogin = Boolean(loginDetected && !nativeLogin)
  const needsManualLogin = source.loginDiscovery === "manual"
  const loadState = useMemo(() => ({ requestId: 0, appendLoading: false, lastTrigger: 0 }), [])

  async function load(targetPage: number, append = false) {
    if (append && loadState.appendLoading) return
    const requestId = ++loadState.requestId
    if (append) {
      loadState.appendLoading = true
    } else {
      loadState.appendLoading = false
      loadState.lastTrigger = 0
    }
    setCatalog(current => ({ ...current, loading: true, error: null }))
    try {
      const result = await source.browse(category, targetPage, "source")
      if (requestId !== loadState.requestId) return
      setCatalog(current => ({
        items: append ? appendUniqueManga(current.items, result.items) : result.items,
        page: result.page,
        hasNext: result.hasNext,
        loading: false,
        error: null,
      }))
    } catch (reason: any) {
      if (requestId !== loadState.requestId) return
      setCatalog(current => ({
        ...current,
        items: append ? current.items : [],
        loading: false,
        error: reason?.message ?? String(reason),
      }))
    } finally {
      if (append && requestId === loadState.requestId) loadState.appendLoading = false
    }
  }

  useEffect(() => {
    load(1, false).catch(() => undefined)
  }, [category.id, reloadToken])

  useEffect(() => {
    saveSettings(catalogSettings)
    onSettingsChanged(catalogSettings)
    if (source.supportsLogin && source.isLoggedIn?.() && source.loadAccount) {
      source.loadAccount().then(account => {
        setAccountLabel(account.label || account.identifier)
        setLoginIdentifier(account.identifier || loginIdentifier)
      }).catch(() => undefined)
    }
  }, [])

  async function login() {
    if (!source.login || !loginIdentifier.trim() || !loginPassword) return
    setLoginLoading(true)
    setLoginStatus("")
    try {
      const account = await source.login(loginIdentifier.trim(), loginPassword)
      setAccountLabel(account.label || account.identifier)
      setLoginIdentifier(account.identifier || loginIdentifier)
      setLoginPassword("")
      setLoginOpen(false)
      setLoginStatus(`已登录 · ${account.label || account.identifier}`)
      setReloadToken(value => value + 1)
    } catch (reason: any) {
      setLoginStatus(reason?.message ?? String(reason))
    } finally {
      setLoginLoading(false)
    }
  }

  async function logout() {
    if (!source.logout) return
    setLoginLoading(true)
    try {
      await source.logout()
      setAccountLabel("")
      setLoginOpen(false)
      setLoginStatus("已退出登录")
      setReloadToken(value => value + 1)
    } finally {
      setLoginLoading(false)
    }
  }

  async function loginInBrowser() {
    setManualLoginLoading(true)
    setLoginStatus("")
    try {
      const count = await openSourceLogin(source)
      setWebLoginActive(count > 0)
      setLoginStatus(`已保存 ${count} 条登录信息`)
      setLoginOpen(false)
      setReloadToken(value => value + 1)
    } catch (reason: any) {
      setLoginStatus(reason?.message ?? String(reason))
    } finally {
      setManualLoginLoading(false)
    }
  }

  async function clearBrowserLogin() {
    const selected = await Dialog.actionSheet({
      title: "清除网页登录信息？",
      message: `将删除 ${source.name} 保存的 Cookie，之后需要重新登录。`,
      cancelButton: true,
      actions: [{ label: "清除登录信息", destructive: true }],
    })
    if (selected !== 0) return
    clearSourceLogin(source.baseURL)
    setWebLoginActive(false)
    setLoginStatus("已清除网页登录信息")
    setReloadToken(value => value + 1)
  }

  function handleScroll(event: any) {
    const offset = Number(event.contentOffset?.y ?? 0)
    const content = Number(event.contentSize?.height ?? 0)
    const frame = Number(event.frame?.height ?? 0)
    if (!hasNext || loading || loadState.appendLoading || content <= frame) return
    const ratio = (offset + frame) / content
    if (ratio > 0.86 && loadState.lastTrigger < page) {
      loadState.lastTrigger = page
      load(page + 1, true).catch(() => undefined)
    }
  }

  const loadMoreKey = `load-more:${category.id}:${page}`

  function handleCatalogVisibility(ids: string[] | number[]) {
    if (!hasNext || loading || !ids.map(String).includes(loadMoreKey)) return
    load(page + 1, true).catch(() => undefined)
  }

  async function open(manga: MangaSummary) {
    await presentDetail(manga, catalogSettings, onSettingsChanged)
    setReloadToken(value => value + 1)
  }

  function openLoginPanel() {
    const haptic = (globalThis as any).HapticFeedback
    haptic?.selectionChanged?.()
    withAnimation(Animation.smooth({ duration: 0.24, extraBounce: 0 }), () => setLoginOpen(value => !value))
  }

  function changeCategory(id: string) {
    const next = categoryById.get(id) ?? defaultCategory
    if (!next || next.id === category.id) {
      setFilterExpanded(false)
      return
    }
    loadState.requestId += 1
    loadState.appendLoading = false
    loadState.lastTrigger = 0
    setCategory(next)
    setFilterExpanded(false)
    const nextSettings = { ...catalogSettings, categoryId: next.id, sort: "source" as SourceSort }
    setCatalogSettings(nextSettings)
    saveSettings(nextSettings)
    onSettingsChanged(nextSettings)
  }

  function toggleFilter() {
    withAnimation(Animation.smooth({ duration: 0.24 }), () => setFilterExpanded(value => !value))
  }

  async function refreshCatalog() {
    await load(1, false)
  }

  return (
    <ScrollView
      {...({ onScroll: handleScroll } as any)}
      navigationTitle={source.name}
      navigationBarTitleDisplayMode="large"
      scrollContentBackground="hidden"
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      onScrollTargetVisibilityChange={{
        idType: "string",
        threshold: 0.2,
        onChanged: handleCatalogVisibility,
      }}
      refreshable={refreshCatalog}
      navigationBarBackButtonHidden={true}
      toolbar={{
        topBarLeading: [
          <ToolbarIconButton key="back" systemName="chevron.left" action={() => dismiss()} />,
        ],
        topBarTrailing: [
          ...(shouldShowLogin ? [<ToolbarIconButton key="login" systemName={(source.isLoggedIn?.() || webLoginActive) ? "person.crop.circle.fill.badge.checkmark" : needsManualLogin ? "safari" : "person.crop.circle.badge.plus"} tint={(source.isLoggedIn?.() || webLoginActive) ? "systemGreen" : "systemRed"} action={openLoginPanel} />] : []),
          <ToolbarIconButton key="refresh" systemName="arrow.clockwise" action={() => refreshCatalog().catch(reason => console.error(reason))} />,
        ],
      }}
    >
      <VStack
        alignment="leading"
        spacing={8}
        padding={{ horizontal: 8, vertical: 8 }}
        frame={{ maxWidth: "infinity" }}
        scrollTargetLayout={true}
      >
        {loginOpen && shouldShowLogin ? (
          <VStack
            alignment="leading"
            spacing={10}
            padding={14}
            frame={{ maxWidth: "infinity" }}
            glassEffect={{ glass: UIGlass.regular().interactive(), shape: { type: "rect", cornerRadius: 24, style: "continuous" } }}
            glassEffectTransition="materialize"
            transition={Transition.offset({ x: 0, y: -8 }).combined(Transition.opacity())}
          >
            <HStack alignment="center" spacing={8} frame={{ maxWidth: "infinity", minHeight: 44 }}>
              <Image systemName="person.crop.circle.badge.checkmark" foregroundStyle="systemRed" />
              <Text font="headline">{accountLabel || `登录 ${source.name}`}</Text>
              <Spacer />
              <CatalogLoginCloseButton action={() => setLoginOpen(false)} />
            </HStack>
            {browserLogin ? (
              <>
                <Text font="caption" foregroundStyle="secondaryLabel">{needsManualLogin ? "未能定位登录入口，请在内置浏览器中自行找到并登录。" : "已定位网站登录入口，请在内置浏览器中完成登录。"}关闭浏览器后会保存 Cookie，下次自动复用。</Text>
                <Button title={manualLoginLoading ? "正在打开" : webLoginActive ? "重新获取登录信息" : needsManualLogin ? "打开网站并查找登录" : "打开登录页面"} systemImage={needsManualLogin ? "safari" : "person.crop.circle.badge.plus"} buttonStyle="glassProminent" tint="systemRed" disabled={manualLoginLoading} frame={{ maxWidth: "infinity" }} action={() => loginInBrowser().catch(() => undefined)} />
                {webLoginActive ? <Button title="清除网页登录" systemImage="trash" buttonStyle="glass" role="destructive" frame={{ maxWidth: "infinity" }} action={() => clearBrowserLogin().catch(() => undefined)} /> : null}
              </>
            ) : source.isLoggedIn?.() ? (
              <Button title={loginLoading ? "正在退出" : "退出登录"} systemImage="rectangle.portrait.and.arrow.right" buttonStyle="glass" role="destructive" disabled={loginLoading} frame={{ maxWidth: "infinity" }} action={() => logout().catch(() => undefined)} />
            ) : (
              <>
                <TextField title="账号" value={loginIdentifier} onChanged={setLoginIdentifier} prompt="邮箱或用户名" textInputAutocapitalization="never" autocorrectionDisabled={true} />
                <SecureField title="密码" value={loginPassword} onChanged={setLoginPassword} prompt="密码" textContentType="password" />
                <Button title={loginLoading ? "正在登录" : "登录并刷新目录"} systemImage="person.crop.circle.badge.checkmark" buttonStyle="glassProminent" tint="systemRed" disabled={loginLoading || !loginIdentifier.trim() || !loginPassword} frame={{ maxWidth: "infinity" }} action={() => login().catch(() => undefined)} />
              </>
            )}
            {loginStatus ? <Text font="caption" foregroundStyle={source.isLoggedIn?.() ? "systemGreen" : "systemRed"}>{loginStatus}</Text> : null}
          </VStack>
        ) : null}
        <GlassEffectContainer>
          <VStack spacing={8} frame={{ maxWidth: "infinity" }}>
            <ScrollView axes="horizontal" scrollIndicator="never">
              <HStack spacing={CATALOG_TAB_SPACING} padding={{ vertical: 3 }}>
                {recommendedCategory ? (
                  <Button
                    buttonStyle={category.id === recommendedCategory.id && !filterExpanded ? "glassProminent" : "glass"}
                    buttonBorderShape="capsule"
                    tint="systemRed"
                    frame={{ width: CATALOG_TAB_WIDTH, height: CATALOG_BUTTON_HEIGHT }}
                    action={() => changeCategory(recommendedCategory.id)}
                  >
                    <CatalogPillLabel title="推荐" systemName="hand.thumbsup.fill" />
                  </Button>
                ) : null}
                {popularCategory ? (
                  <Button
                    buttonStyle={category.id === popularCategory.id && !filterExpanded ? "glassProminent" : "glass"}
                    buttonBorderShape="capsule"
                    tint="systemRed"
                    frame={{ width: CATALOG_TAB_WIDTH, height: CATALOG_BUTTON_HEIGHT }}
                    action={() => changeCategory(popularCategory.id)}
                  >
                    <CatalogPillLabel title="热门" systemName="flame.fill" />
                  </Button>
                ) : null}
                {updatedCategory ? (
                  <Button
                    buttonStyle={category.id === updatedCategory.id && !filterExpanded ? "glassProminent" : "glass"}
                    buttonBorderShape="capsule"
                    tint="systemRed"
                    frame={{ width: CATALOG_TAB_WIDTH, height: CATALOG_BUTTON_HEIGHT }}
                    action={() => changeCategory(updatedCategory.id)}
                  >
                    <CatalogPillLabel title="最近更新" systemName="clock.fill" />
                  </Button>
                ) : null}
                {filterCategories.length ? (
                  <Button
                    buttonStyle={filterExpanded || filterCategoryIds.has(category.id) ? "glassProminent" : "glass"}
                    buttonBorderShape="capsule"
                    tint="systemRed"
                    frame={{ width: CATALOG_TAB_WIDTH, height: CATALOG_BUTTON_HEIGHT }}
                    action={toggleFilter}
                  >
                    <CatalogPillLabel title="筛选" systemName="line.3.horizontal.decrease.circle" />
                  </Button>
                ) : null}
              </HStack>
            </ScrollView>
            {filterExpanded ? (
              <VStack
                alignment="leading"
                spacing={8}
                padding={{ vertical: 6 }}
                frame={{ maxWidth: "infinity", alignment: "leading" }}
                transition={Transition.offset({ x: 0, y: -8 }).combined(Transition.opacity())}
              >
                <HStack spacing={7} frame={{ maxWidth: "infinity" }}>
                  <Image systemName="tag.fill" foregroundStyle="systemRed" />
                  <Text font="headline" fontWeight="semibold">漫画类型</Text>
                  <Spacer />
                  <Text font="caption" foregroundStyle="secondaryLabel">来自网站 · {filterCategories.length} 类</Text>
                </HStack>
                <VStack
                  alignment="leading"
                  spacing={FILTER_TYPE_ROW_SPACING}
                  frame={{ maxWidth: "infinity", alignment: "leading" }}
                >
                  {filterCategoryRows.map((row, rowIndex) => {
                    const itemWidth = row.columns === 4 ? FILTER_FOUR_COLUMN_WIDTH : FILTER_THREE_COLUMN_WIDTH
                    return (
                      <HStack
                        key={`filter-row:${rowIndex}:${row.items[0]?.id ?? "empty"}`}
                        spacing={FILTER_TYPE_COLUMN_SPACING}
                        frame={{ maxWidth: "infinity", alignment: "leading" }}
                      >
                        {row.items.map(item => {
                          const selected = item.id === category.id
                          return (
                            <Button
                              key={item.id}
                              buttonStyle={selected ? "glassProminent" : "glass"}
                              buttonBorderShape="capsule"
                              tint="systemRed"
                              frame={{ width: itemWidth, height: CATALOG_BUTTON_HEIGHT }}
                              action={() => changeCategory(item.id)}
                            >
                              <CatalogPillLabel title={item.title} systemName={selected ? "checkmark" : "tag"} compact={true} />
                            </Button>
                          )
                        })}
                      </HStack>
                    )
                  })}
                </VStack>
              </VStack>
            ) : null}
          </VStack>
        </GlassEffectContainer>
        {loading && !items.length ? <LoadingState title="正在加载漫画" /> : null}
        {error && !items.length ? <ErrorState message={error} onRetry={() => load(1, false).catch(() => undefined)} /> : null}
        {!loading && !error && !items.length ? <EmptyState title="没有漫画" detail="当前分类暂时没有返回内容。" icon="book.closed.fill" /> : null}
        {items.length ? <MangaGrid items={items} onOpen={manga => open(manga).catch(() => undefined)} /> : null}
        {items.length && hasNext ? (
          <Button
            key={loadMoreKey}
            title={loading ? "正在加载" : "加载更多"}
            systemImage={loading ? "hourglass" : "chevron.down"}
            buttonStyle="glass"
            buttonBorderShape="capsule"
            disabled={loading}
            frame={{ maxWidth: "infinity" }}
            action={() => load(page + 1, true).catch(() => undefined)}
          />
        ) : null}
        {error && items.length ? <Text font="caption" foregroundStyle="systemRed">{error}</Text> : null}
      </VStack>
    </ScrollView>
  )
}

export function BrowseTab({ settings, onSettingsChanged }: SettingsProps) {
  const dismiss = Navigation.useDismiss()
  const sources = availableSources(settings)
  const [query, setQuery] = useState("")
  const [siteURL, setSiteURL] = useState("")
  const [sourceLoading, setSourceLoading] = useState(false)
  const [sourceStatus, setSourceStatus] = useState<string | null>(null)
  const filtered = sources.filter(source => source.name.toLowerCase().includes(query.trim().toLowerCase()))

  function commit(next: AppSettings) {
    saveSettings(next)
    onSettingsChanged(next)
  }

  async function addSource() {
    const value = siteURL.trim()
    if (!value) return
    setSourceLoading(true)
    setSourceStatus(null)
    try {
      const discovered = await discoverMangaSource(value)
      const discoveredHost = new URL(discovered.baseURL).hostname.replace(/^www\./, "").toLowerCase()
      const savedSources = [
        discovered,
        ...settings.savedSources.filter(item => {
          if (item.id === discovered.id) return false
          try {
            return new URL(item.baseURL).hostname.replace(/^www\./, "").toLowerCase() !== discoveredHost
          } catch {
            return true
          }
        }),
      ]
      commit({
        ...settings,
        savedSources,
        activeSourceId: discovered.id,
        categoryId: discovered.categories[0]?.id ?? "catalog",
      })
      setSiteURL("")
      setSourceStatus(`已添加 ${discovered.name} · ${discovered.categories.length} 个分类`)
    } catch (reason: any) {
      setSourceStatus(reason?.message ?? String(reason))
    } finally {
      setSourceLoading(false)
    }
  }

  async function removeSource(id: string) {
    const source = settings.savedSources.find(item => item.id === id)
    const selected = await Dialog.actionSheet({
      title: `删除 ${source?.name ?? "图源"}？`,
      message: "此操作会移除图源配置，但不会清除收藏和阅读历史。",
      cancelButton: true,
      actions: [{ label: "删除图源", destructive: true }],
    })
    if (selected !== 0) return
    const savedSources = settings.savedSources.filter(item => item.id !== id)
    const fallback = savedSources[0]
    const activeRemoved = settings.activeSourceId === id
    const { [id]: _, ...sourcePinnedAt } = settings.sourcePinnedAt
    commit({
      ...settings,
      savedSources,
      sourcePinnedAt,
      searchExcludedSourceIds: settings.searchExcludedSourceIds.filter(value => value !== id),
      loginEnabledSourceIds: settings.loginEnabledSourceIds.filter(value => value !== id),
      activeSourceId: activeRemoved ? fallback?.id ?? "" : settings.activeSourceId,
      categoryId: activeRemoved ? fallback?.categories[0]?.id ?? "" : settings.categoryId,
    })
    setSourceStatus("图源已删除")
  }

  function togglePin(id: string) {
    const sourcePinnedAt = { ...settings.sourcePinnedAt }
    if (sourcePinnedAt[id] != null) delete sourcePinnedAt[id]
    else sourcePinnedAt[id] = Date.now()
    commit({ ...settings, sourcePinnedAt })
    setSourceStatus(sourcePinnedAt[id] != null ? "图源已置顶" : "已取消置顶")
  }

  function updateSourceDomains(sourceId: string, updated: SavedSourceConfig) {
    const previous = settings.savedSources.find(source => source.id === sourceId)
    if (previous && previous.baseURL !== updated.baseURL) clearCachedSourceData(sourceId)
    const savedSources = previous
      ? settings.savedSources.map(source => source.id === sourceId ? updated : source)
      : [updated, ...settings.savedSources]
    const activeSourceChanged = settings.activeSourceId === sourceId
    const categoryId = activeSourceChanged && !updated.categories.some(category => category.id === settings.categoryId)
      ? updated.categories[0]?.id ?? ""
      : settings.categoryId
    commit({ ...settings, savedSources, categoryId })
    setSourceStatus(`正在使用 ${new URL(updated.baseURL).hostname}`)
  }

  async function selectSource(sourceId: string) {
    const saved = settings.savedSources.find(item => item.id === sourceId)
    const runtime = sources.find(item => item.id === sourceId)
    const source = saved ?? (runtime ? {
      id: runtime.id,
      adapter: "generic" as const,
      name: runtime.name,
      baseURL: runtime.baseURL,
      catalogPath: runtime.categories[0]?.path ?? settings.genericSource.catalogPath,
      searchPath: settings.genericSource.searchPath,
      categories: runtime.categories,
    } : null)
    if (!source) return
    await presentSourceDomainPicker(source, updated => updateSourceDomains(sourceId, updated))
  }

  function close() {
    try { dismiss("close") } catch { Script.exit() }
  }

  return (
    <ScrollView
      navigationTitle="浏览"
      navigationBarTitleDisplayMode="large"
      searchable={{ value: query, onChanged: setQuery, placement: "navigationBarDrawer", prompt: "搜索已添加图源" }}
      scrollDismissesKeyboard="interactively"
      scrollContentBackground="hidden"
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      ignoresSafeArea={{ regions: "container", edges: "bottom" }}
      toolbar={{
        topBarLeading: [<ToolbarIconButton key="close" systemName="xmark" action={close} />],
        topBarTrailing: [
          <MinimizeButton key="minimize" />,
        ],
      }}
    >
      <VStack alignment="leading" spacing={18} padding={{ horizontal: 12, vertical: 8 }} frame={{ maxWidth: "infinity" }}>
        <GlassEffectContainer>
          <VStack alignment="leading" spacing={10} padding={14} frame={{ maxWidth: "infinity" }} glassEffect={{ glass: UIGlass.regular().interactive(), shape: { type: "rect", cornerRadius: 28, style: "continuous" } }} glassEffectTransition="materialize">
          <Text font="headline" fontWeight="semibold">添加漫画网站图源</Text>
          <Text font="caption" foregroundStyle="secondaryLabel">输入网站首页，自动分析漫画规则，同时检测网站登录系统。</Text>
          <TextField title="网站地址" value={siteURL} onChanged={value => { setSiteURL(value); setSourceStatus(null) }} prompt="https://copy3000.com" frame={{ maxWidth: "infinity" }} />
          <Button
            title={sourceLoading ? "正在分析网站" : "分析并添加图源"}
            systemImage={sourceLoading ? "hourglass" : "plus.circle.fill"}
            buttonStyle="glassProminent"
            tint="systemRed"
            disabled={sourceLoading || !siteURL.trim()}
            frame={{ maxWidth: "infinity" }}
            action={() => addSource().catch(() => undefined)}
          />
          {sourceStatus ? <Text font="caption" foregroundStyle={/已添加|已置顶|已取消|已删除/.test(sourceStatus) ? "systemGreen" : "systemRed"}>{sourceStatus}</Text> : null}
          </VStack>
        </GlassEffectContainer>
        {filtered.length ? filtered.map(source => (
          <SourceCard
            key={source.id}
            source={source}
            settings={settings}
            onSettingsChanged={onSettingsChanged}
            onRemove={id => { removeSource(id).catch(() => undefined) }}
            onPin={togglePin}
            onSelectSource={id => { selectSource(id).catch(() => undefined) }}
          />
        )) : <EmptyState title="没有匹配的图源" detail="请检查图源名称。" icon="magnifyingglass" />}
      </VStack>
    </ScrollView>
  )
}

export function SearchTab({ settings, onSettingsChanged }: SettingsProps) {
  const sources = availableSources(settings)
  const participatingSources = sources.filter(source => !settings.searchExcludedSourceIds.includes(source.id))
  const [query, setQuery] = useState("")
  const [items, setItems] = useState<MangaSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState(false)
  const searchState = useMemo(() => ({ generation: 0 }), [])

  async function search() {
    const keyword = query.trim()
    const generation = ++searchState.generation
    if (!keyword || !participatingSources.length) {
      withAnimation(Animation.easeOut(0.18), () => {
        setItems([])
        setError(null)
        setHasSearched(false)
        setLoading(false)
      })
      return
    }
    setLoading(true)
    setError(null)
    setHasSearched(true)
    const settled = await Promise.all(participatingSources.map(async source => {
      try {
        return { source, result: await source.search(keyword, 1, settings.sort), error: null as string | null }
      } catch (reason: any) {
        return { source, result: null, error: reason?.message ?? String(reason) }
      }
    }))
    if (generation !== searchState.generation) return
    const seen = new Set<string>()
    const merged: MangaSummary[] = []
    for (const entry of settled) {
      for (const manga of entry.result?.items ?? []) {
        const key = mangaKey(manga)
        if (!seen.has(key)) { seen.add(key); merged.push(manga) }
      }
    }
    const failures = settled.filter(entry => entry.error)
    withAnimation(Animation.smooth({ duration: 0.28, extraBounce: 0 }), () => {
      setItems(merged)
      setError(failures.length === participatingSources.length
        ? failures.map(entry => `${entry.source.name}: ${entry.error}`).join("\n")
        : failures.length ? `${failures.length} 个图源搜索失败，其余结果已显示。` : null)
      setLoading(false)
    })
  }

  useEffect(() => {
    if (!query.trim()) {
      searchState.generation += 1
      setItems([])
      setError(null)
      setHasSearched(false)
      setLoading(false)
      return
    }
    const timer = setTimeout(() => search().catch(() => undefined), 360)
    return () => clearTimeout(timer)
  }, [query, settings.searchExcludedSourceIds.join("|"), settings.sort, sources.map(item => item.id).join("|")])

  function setSourceParticipation(sourceId: string, participates: boolean) {
    const excluded = participates
      ? settings.searchExcludedSourceIds.filter(id => id !== sourceId)
      : Array.from(new Set([...settings.searchExcludedSourceIds, sourceId]))
    const next = { ...settings, searchExcludedSourceIds: excluded }
    const haptic = (globalThis as any).HapticFeedback
    haptic?.selectionChanged?.()
    withAnimation(Animation.smooth({ duration: 0.28, extraBounce: 0 }), () => onSettingsChanged(next))
    saveSettings(next)
  }

  return (
    <ScrollView
      navigationTitle="搜索"
      navigationBarTitleDisplayMode="large"
      searchable={{
        value: query,
        onChanged: setQuery,
        placement: "navigationBarDrawerAlwaysDisplay",
        prompt: "多图源并行搜索",
      }}
      scrollDismissesKeyboard="interactively"
      scrollContentBackground="hidden"
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      ignoresSafeArea={{ regions: "container", edges: "bottom" }}
    >
      <VStack alignment="leading" spacing={16} padding={{ horizontal: 12, top: 8, bottom: 108 }} frame={{ maxWidth: "infinity" }}>
        <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
          <Image systemName="bolt.horizontal.circle" foregroundStyle="systemRed" />
          <Text font="caption" foregroundStyle="secondaryLabel">{participatingSources.length} / {sources.length} 个图源参与并行搜索</Text>
          <Spacer />
          {loading ? <ProgressView controlSize="small" /> : null}
        </HStack>
        {sources.length ? (
          <VStack
            alignment="leading"
            spacing={10}
            padding={{ horizontal: 14, vertical: 12 }}
            frame={{ maxWidth: "infinity" }}
            glassEffect={{ glass: UIGlass.regular().interactive(), shape: { type: "rect", cornerRadius: 24, style: "continuous" } }}
            glassEffectTransition="materialize"
          >
            <Text font="subheadline" fontWeight="semibold">图源</Text>
            {sources.map(source => (
              <Toggle
                key={source.id}
                title={source.name}
                systemImage="network"
                value={!settings.searchExcludedSourceIds.includes(source.id)}
                onChanged={value => setSourceParticipation(source.id, value)}
                tint="systemRed"
              />
            ))}
          </VStack>
        ) : null}
        {!sources.length ? <EmptyState title="尚未添加图源" detail="请先在“浏览”页添加漫画网站。" icon="network" /> : null}
        {sources.length && !participatingSources.length ? <EmptyState title="没有参与搜索的图源" detail="请开启至少一个图源的滑动开关。" icon="checklist" /> : null}
        {loading && !items.length ? <LoadingState title="正在并行搜索" /> : null}
        {error ? <Text font="caption" foregroundStyle={items.length ? "systemOrange" : "systemRed"}>{error}</Text> : null}
        {!loading && hasSearched && !items.length && participatingSources.length ? <EmptyState title="没有搜索结果" detail="换一个关键词试试。" icon="magnifyingglass" /> : null}
        {items.length ? <MangaGrid items={items} onOpen={manga => presentDetail(manga, settings, onSettingsChanged).catch(() => undefined)} /> : null}
      </VStack>
    </ScrollView>
  )
}

export function LibraryTab({ settings, onSettingsChanged }: SettingsProps) {
  const dismiss = Navigation.useDismiss()
  const [items, setItems] = useState(loadFavorites())

  function close() {
    try { dismiss("close") } catch { Script.exit() }
  }

  async function open(manga: MangaSummary) {
    await presentDetail(manga, settings, onSettingsChanged)
    setItems(loadFavorites())
  }

  async function refreshLibrary() {
    setItems(loadFavorites())
  }

  return (
    <ScrollView
      navigationTitle="书架"
      navigationBarTitleDisplayMode="large"
      scrollContentBackground="hidden"
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      ignoresSafeArea={{ regions: "container", edges: "bottom" }}
      refreshable={refreshLibrary}
      toolbar={{
        topBarLeading: [<ToolbarIconButton key="close" systemName="xmark" action={close} />],
        topBarTrailing: [<ToolbarIconButton key="refresh" systemName="arrow.clockwise" action={() => setItems(loadFavorites())} />],
      }}
    >
      <VStack padding={{ horizontal: 12, top: 8, bottom: 108 }} frame={{ maxWidth: "infinity" }}>
        {items.length ? (
          <MangaGrid
            items={items}
            onOpen={manga => open(manga).catch(() => undefined)}
          />
        ) : (
          <EmptyState title="书架为空" detail="收藏的漫画会显示在这里。" icon="book.closed.fill" />
        )}
      </VStack>
    </ScrollView>
  )
}

export function HistoryTab({ settings, onSettingsChanged }: SettingsProps) {
  const dismiss = Navigation.useDismiss()
  const [items, setItems] = useState(loadHistory())
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<string[]>([])

  async function open(manga: MangaSummary) {
    if (selecting) {
      const key = mangaKey(manga)
      setSelected(current => current.includes(key) ? current.filter(value => value !== key) : [...current, key])
      return
    }
    await presentDetail(manga, settings, onSettingsChanged)
    setItems(loadHistory())
  }

  function close() {
    try { dismiss("close") } catch { Script.exit() }
  }

  async function deleteAction() {
    if (!selecting) {
      setSelecting(true)
      setSelected([])
      return
    }
    if (!selected.length) {
      setSelecting(false)
      return
    }
    const choice = await Dialog.actionSheet({
      title: `删除 ${selected.length} 条阅读记录？`,
      message: "此操作不可撤销。",
      cancelButton: true,
      actions: [{ label: "删除记录", destructive: true }],
    })
    if (choice !== 0) return
    setItems(removeHistory(selected))
    setSelected([])
    setSelecting(false)
  }

  return (
    <ScrollView
      navigationTitle={selecting ? `已选择 ${selected.length} 项` : "历史"}
      navigationBarTitleDisplayMode="large"
      scrollContentBackground="hidden"
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      ignoresSafeArea={{ regions: "container", edges: "bottom" }}
      toolbar={{
        topBarLeading: [<ToolbarIconButton key="close" systemName="xmark" action={close} />],
        topBarTrailing: [
          ...(selecting ? [<ToolbarIconButton key="cancel" systemName="xmark" action={() => { setSelecting(false); setSelected([]) }} />] : []),
          <ToolbarIconButton key="delete" systemName={selecting && selected.length ? "trash.fill" : "trash"} tint="systemRed" disabled={!items.length} action={() => deleteAction().catch(reason => console.error(reason))} />,
        ],
      }}
    >
      <VStack padding={{ horizontal: 12, top: 8, bottom: 108 }} frame={{ maxWidth: "infinity" }}>
        {selecting ? <Text font="caption" foregroundStyle="secondaryLabel" padding={{ bottom: 6 }}>点击漫画选择；再次点击右上角删除。未选择时再次点删除会退出多选。</Text> : null}
        {items.length ? (
          <VStack spacing={0} frame={{ maxWidth: "infinity" }}>
            {items.map((entry, index) => {
              const source = sourceForSettings(settings, entry.manga)
              const key = mangaKey(entry.manga)
              const checked = selected.includes(key)
              return (
                <VStack key={key} spacing={0} frame={{ maxWidth: "infinity" }}>
                  <Button buttonStyle="plain" frame={{ maxWidth: "infinity" }} action={() => open(entry.manga).catch(() => undefined)}>
                  <HStack
                    spacing={9}
                    frame={{ maxWidth: "infinity" }}
                    trailingSwipeActions={{
                      allowsFullSwipe: true,
                      actions: [<Button key="delete" title="删除" systemImage="trash" role="destructive" action={() => setItems(removeHistory([key]))} />],
                    }}
                    contextMenu={{
                      menuItems: <Group>
                        <Button title="继续阅读" systemImage="book.pages" action={() => open(entry.manga).catch(() => undefined)} />
                        <Button title="删除记录" systemImage="trash" role="destructive" action={() => setItems(removeHistory([key]))} />
                      </Group>,
                    }}
                  >
                      {selecting ? <Image systemName={checked ? "checkmark.circle.fill" : "circle"} font="title3" foregroundStyle={checked ? "systemRed" : "tertiaryLabel"} /> : null}
                      <VStack frame={{ maxWidth: "infinity" }}>
                        <HistoryRow manga={entry.manga} detail={`${entry.chapterTitle} · 第 ${entry.page + 1} 页`} sourceName={source.name} interactive={false} onOpen={() => undefined} />
                      </VStack>
                    </HStack>
                  </Button>
                  {index < items.length - 1 ? <Divider /> : null}
                </VStack>
              )
            })}
          </VStack>
        ) : <EmptyState title="暂无阅读历史" detail="打开章节后会自动记录阅读位置。" icon="clock.arrow.circlepath" />}
      </VStack>
    </ScrollView>
  )
}

export function SettingsTab({ settings, onSettingsChanged }: SettingsProps) {
  const dismiss = Navigation.useDismiss()
  const [status, setStatus] = useState("")
  const [enhancedCacheInfo, setEnhancedCacheInfo] = useState<{ count: number; totalMB: string } | null>(null)

  useEffect(() => {
    getEnhancedCacheStats()
      .then(s => setEnhancedCacheInfo({ count: s.count, totalMB: s.totalMB }))
      .catch(() => undefined)
  }, [])

  async function handleClearEnhancedCache() {
    const count = await clearEnhancedCache()
    setEnhancedCacheInfo({ count: 0, totalMB: "0.0" })
    setStatus(`已清理 ${count} 个超分缓存文件`)
  }

  function close() {
    try { dismiss("close") } catch { Script.exit() }
  }

  function apply(patch: Partial<AppSettings>) {
    const next = { ...settings, ...patch }
    const haptic = (globalThis as any).HapticFeedback
    haptic?.selectionChanged?.()
    saveSettings(next)
    withAnimation(Animation.smooth({ duration: 0.28, extraBounce: 0 }), () => onSettingsChanged(next))
  }

  async function removeSource(id: string) {
    const source = settings.savedSources.find(item => item.id === id)
    const selected = await Dialog.actionSheet({
      title: `删除 ${source?.name ?? "图源"}？`,
      message: "此操作会移除图源配置，但不会清除收藏和阅读历史。",
      cancelButton: true,
      actions: [{ label: "删除图源", destructive: true }],
    })
    if (selected !== 0) return
    const savedSources = settings.savedSources.filter(item => item.id !== id)
    const activeRemoved = settings.activeSourceId === id
    const fallback = savedSources[0]
    const { [id]: _, ...sourcePinnedAt } = settings.sourcePinnedAt
    const next: AppSettings = {
      ...settings,
      savedSources,
      sourcePinnedAt,
      searchExcludedSourceIds: settings.searchExcludedSourceIds.filter(value => value !== id),
      loginEnabledSourceIds: settings.loginEnabledSourceIds.filter(value => value !== id),
      activeSourceId: activeRemoved ? fallback?.id ?? "" : settings.activeSourceId,
      categoryId: activeRemoved ? fallback?.categories[0]?.id ?? "" : settings.categoryId,
    }
    saveSettings(next)
    onSettingsChanged(next)
    setStatus("图源已删除")
  }

  return (
    <List
      navigationTitle="设置"
      navigationBarTitleDisplayMode="large"
      scrollContentBackground="hidden"
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      contentMargins={{ edges: "bottom", insets: 132, placement: "scrollContent" }}
      toolbar={{
        topBarLeading: [<ToolbarIconButton key="close" systemName="xmark" action={close} />],
        topBarTrailing: [<MinimizeButton key="minimize" />],
      }}
    >
      <Section title="阅读">
        <Picker title="阅读模式" value={settings.readerMode} onChanged={(value: string) => apply({ readerMode: value as AppSettings["readerMode"] })} pickerStyle="segmented">
          <Text tag="webtoon">条漫</Text>
          <Text tag="paged">分页</Text>
        </Picker>
        <Picker title="章节顺序" value={settings.chapterAscending ? "asc" : "desc"} onChanged={(value: string) => apply({ chapterAscending: value === "asc" })} pickerStyle="segmented">
          <Text tag="asc">正序</Text>
          <Text tag="desc">倒序</Text>
        </Picker>
      </Section>

      <Section title="离线超分">
        <Toggle title="启用本地超分" systemImage="sparkles.rectangle.stack" value={settings.upscalerEnabled ?? settings.anime4kEnabled} onChanged={(value: boolean) => apply({ upscalerEnabled: value, anime4kEnabled: value })} />
        <Picker title="引擎" value={settings.upscalerEngine} onChanged={(value: string) => apply({ upscalerEngine: value as AppSettings["upscalerEngine"] })} pickerStyle="segmented">
          <Text tag="anime4k">Anime4K</Text><Text tag="waifu2x">Waifu2x</Text>
        </Picker>
        <Picker title="超分范围" value={settings.upscalerScope} onChanged={(value: string) => apply({ upscalerScope: value as AppSettings["upscalerScope"] })} pickerStyle="segmented">
          <Text tag="all">全量超分 (整话)</Text><Text tag="window">滑动窗口 (省电)</Text>
        </Picker>
        {settings.upscalerEngine === "anime4k" ? (
          <>
            <Picker title="Anime4K 档位" value={settings.anime4kProfile} onChanged={(value: string) => apply({ anime4kProfile: value === "fast" || value === "balanced" ? value : "quality" })} pickerStyle="segmented">
              <Text tag="fast">快速</Text><Text tag="balanced">均衡</Text><Text tag="quality">高质量</Text>
            </Picker>
            <Picker title="锐化强度" value={settings.anime4kStrength} onChanged={(value: number) => apply({ anime4kStrength: Number(value) })} pickerStyle="segmented">
              <Text tag={0.8}>轻微</Text><Text tag={1.25}>清晰</Text><Text tag={1.8}>强烈</Text>
            </Picker>
          </>
        ) : null}
        <Picker title="降噪等级" value={settings.upscalerEngine === "waifu2x" ? settings.waifu2xDenoise : settings.anime4kDenoise} onChanged={(value: number) => apply(settings.upscalerEngine === "waifu2x" ? { waifu2xDenoise: Number(value) } : { anime4kDenoise: Number(value) })} pickerStyle="segmented">
          <Text tag={0}>0</Text><Text tag={1}>1</Text><Text tag={2}>2</Text><Text tag={3}>3</Text>
        </Picker>
        {settings.upscalerEngine === "waifu2x" ? (
          <Picker title="放大倍率" value={settings.waifu2xScale} onChanged={(value: number) => apply({ waifu2xScale: Number(value) })} pickerStyle="segmented">
            <Text tag={1}>1×</Text><Text tag={2}>2×</Text>
          </Picker>
        ) : (
          <Picker title="放大倍率" value={settings.anime4kScale} onChanged={(value: number) => apply({ anime4kScale: Number(value) })} pickerStyle="segmented">
            <Text tag={1.5}>1.5×</Text><Text tag={2}>2×</Text><Text tag={3}>3×</Text>
          </Picker>
        )}
        <HStack>
          <Text>超分磁盘缓存</Text>
          <Spacer />
          <Text foregroundStyle="secondaryLabel">{enhancedCacheInfo ? `${enhancedCacheInfo.count} 张 (${enhancedCacheInfo.totalMB} MB)` : "计算中..."}</Text>
          <Button title="清空" buttonStyle="glass" tint="systemRed" action={handleClearEnhancedCache} />
        </HStack>
        <Text font="caption" foregroundStyle="secondaryLabel">阅读器右上角轻点即可开关，长按进入设置。Waifu2x 是推荐的高质量 AI 放大模式；全量超分模式会在阅读时自动对整话漫画在后台进行超分并保存到磁盘缓存，翻页秒开。两种引擎及模型均内置于脚本，不连接云端超分服务器。</Text>
      </Section>

      <Section title="登录系统">
        <HStack><Image systemName="person.crop.circle.badge.checkmark" foregroundStyle="systemRed" /><Text>目录右上角登录</Text><Spacer /><Text foregroundStyle="secondaryLabel">自动检测</Text></HStack>
        <Text font="caption" foregroundStyle="secondaryLabel">添加网站时自动检测登录入口。无登录系统的站点只显示刷新；识别到登录后会显示账号按钮；无法直接接入时可用内置浏览器手动登录并保存 Cookie。</Text>
      </Section>

      <Section title="已添加图源">
        {settings.savedSources.length ? settings.savedSources.map(source => (
          <HStack
            key={source.id}
            spacing={12}
            padding={{ horizontal: 14, vertical: 12 }}
            frame={{ maxWidth: "infinity" }}
            glassEffect={{ glass: UIGlass.regular().interactive(), shape: { type: "rect", cornerRadius: 22, style: "continuous" } }}
            glassEffectTransition="materialize"
            contextMenu={{
              menuItems: <Group><Button title="删除图源" systemImage="trash" role="destructive" action={() => removeSource(source.id).catch(() => undefined)} /></Group>,
            }}
          >
            <Image
              systemName={source.adapter === "copy3000" ? "square.stack.3d.up.fill" : source.adapter === "godamh" ? "globe.asia.australia" : source.adapter === "komiic" ? "person.crop.circle.badge.checkmark" : source.adapter === "mycomic" ? "books.vertical.fill" : "network"}
              foregroundStyle="systemRed"
              frame={{ width: 24, height: 24, alignment: "center" }}
            />
            <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <HStack spacing={6} alignment="center">
                <Text>{source.name}</Text>
              </HStack>
              <Text font="caption2" foregroundStyle="secondaryLabel">{source.baseURL} · {source.categories.length} 个分类</Text>
            </VStack>
          </HStack>
        )) : <Text foregroundStyle="secondaryLabel">尚未添加网站图源，请在“浏览”页输入漫画网站首页。</Text>}
        {status ? <Text font="caption" foregroundStyle="systemGreen">{status}</Text> : null}
      </Section>

      <Section title="当前配置">
        <VStack
          spacing={0}
          padding={{ horizontal: 16, vertical: 4 }}
          frame={{ maxWidth: "infinity" }}
          glassEffect={{ glass: UIGlass.regular().interactive(), shape: { type: "rect", cornerRadius: 26, style: "continuous" } }}
          glassEffectTransition="materialize"
        >
          <HStack padding={{ vertical: 13 }} frame={{ maxWidth: "infinity" }}>
            <Image systemName="network" foregroundStyle="systemRed" frame={{ width: 22, height: 22, alignment: "center" }} />
            <Text>主图源</Text><Spacer />
            <Text foregroundStyle="secondaryLabel" multilineTextAlignment="trailing">{availableSources(settings).find(source => source.id === settings.activeSourceId)?.name ?? "尚未添加"}</Text>
          </HStack>
          <Divider />
          <HStack padding={{ vertical: 13 }} frame={{ maxWidth: "infinity" }}>
            <Image systemName="magnifyingglass" foregroundStyle="systemRed" frame={{ width: 22, height: 22, alignment: "center" }} />
            <Text>参与搜索</Text><Spacer />
            <Text foregroundStyle="secondaryLabel" multilineTextAlignment="trailing">{availableSources(settings).filter(source => !settings.searchExcludedSourceIds.includes(source.id)).length} 个图源</Text>
          </HStack>
          <Divider />
          <HStack padding={{ vertical: 13 }} frame={{ maxWidth: "infinity" }}>
            <Image systemName="iphone.gen3" foregroundStyle="systemRed" frame={{ width: 22, height: 22, alignment: "center" }} />
            <Text>界面规范</Text><Spacer />
            <Text foregroundStyle="secondaryLabel" multilineTextAlignment="trailing">iOS 26 Liquid Glass</Text>
          </HStack>
        </VStack>
      </Section>
    </List>
  )
}

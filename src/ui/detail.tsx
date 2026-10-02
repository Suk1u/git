import {
  Button,
  Divider,
  Group,
  HStack,
  Image,
  LazyVStack,
  Navigation,
  NavigationStack,
  ProgressView,
  ScrollView,
  SecureField,
  Spacer,
  Text,
  TextField,
  VStack,
  ZStack,
  useEffect,
  useMemo,
  useState,
} from "scripting"
import type { AppSettings, MangaChapter, MangaDetail, MangaSource, MangaSummary } from "../model"
import {
  chapterKey,
  isFavorite,
  lastHistoryFor,
  loadReadSet,
  loadSettings,
  saveSettings,
  toggleFavorite,
} from "../storage"
import { MangaCover, ToolbarIconButton } from "./components"
import { ReaderPage } from "./reader"

function DetailLoginCloseButton({ action }: { action: () => void }) {
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
    <Button buttonStyle="plain" frame={{ width: 44, height: 44, alignment: "center" }} action={close}>
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

export function DetailPage({
  source,
  manga,
  detailTask,
  settings,
  onSettingsChanged,
}: {
  source: MangaSource
  manga: MangaSummary
  detailTask?: Promise<MangaDetail>
  settings: AppSettings
  onSettingsChanged: (settings: AppSettings) => void
}) {
  const dismiss = Navigation.useDismiss()
  const [detail, setDetail] = useState<MangaDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [favorite, setFavorite] = useState(isFavorite(manga))
  const [ascending, setAscending] = useState(settings.chapterAscending)
  const [readSet, setReadSet] = useState(loadReadSet())
  const [loginIdentifier, setLoginIdentifier] = useState(source.savedLoginIdentifier?.() ?? "")
  const [loginPassword, setLoginPassword] = useState("")
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginLoading, setLoginLoading] = useState(false)
  const [loginStatus, setLoginStatus] = useState("")
  const [accountLabel, setAccountLabel] = useState("")
  const [loginRequired, setLoginRequired] = useState(false)
  const sourceLoginForced = settings.loginEnabledSourceIds.includes(source.id)
  const loginErrorDetected = Boolean(loginRequired || (error && /登录|登入|login|sign.?in|unauth|token|权限|限制|完整阅读|会员/i.test(error)))
  const loginAvailable = Boolean(source.login && source.supportsLogin)
  const shouldShowLogin = Boolean(loginAvailable && (sourceLoginForced || source.isLoggedIn?.() || loginErrorDetected))

  async function load(task?: Promise<MangaDetail>) {
    setLoading(true)
    setError(null)
    try {
      const loaded = await (task ?? source.detail(manga))
      setDetail(loaded)
    } catch (reason: any) {
      setError(reason?.message ?? String(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load(detailTask).catch(() => undefined)
  }, [manga.id, manga.sourceId])

  useEffect(() => {
    if (!detail?.chapters.length) return
    const history = lastHistoryFor(detail)
    const warmChapter = history
      ? detail.chapters.find(item => item.id === history.chapterId) ?? detail.chapters[0]
      : detail.chapters[0]
    const timer = setTimeout(() => source.pages(detail, warmChapter).catch((reason: any) => {
      if (/登录|登入|login|sign.?in|unauth|token|权限|限制|完整阅读|会员/i.test(reason?.message ?? String(reason))) {
        setLoginRequired(true)
        setLoginStatus("该站点限制完整阅读，请先登录")
      }
    }), 180)
    return () => clearTimeout(timer)
  }, [detail?.id])

  async function refreshAccount() {
    if (!source.supportsLogin || !source.isLoggedIn?.() || !source.loadAccount) return
    try {
      const account = await source.loadAccount()
      setAccountLabel(account.label || account.identifier)
      setLoginIdentifier(account.identifier || loginIdentifier)
      setLoginStatus("登录状态已恢复")
    } catch (reason: any) {
      setLoginStatus(reason?.message ?? String(reason))
    }
  }

  useEffect(() => {
    refreshAccount().catch(() => undefined)
  }, [source.id])

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
      setLoginRequired(false)
      await load()
    } catch (reason: any) {
      setLoginStatus(reason?.message ?? String(reason))
    } finally {
      setLoginLoading(false)
    }
  }

  async function logout() {
    if (!source.logout) return
    const selected = await Dialog.actionSheet({
      title: `退出 ${source.name}？`,
      message: "退出后，受保护的章节可能无法继续读取。",
      cancelButton: true,
      actions: [{ label: "退出登录", destructive: true }],
    })
    if (selected !== 0) return
    setLoginLoading(true)
    try {
      await source.logout()
      setAccountLabel("")
      setLoginStatus("已退出登录")
      setLoginOpen(false)
    } finally {
      setLoginLoading(false)
    }
  }

  function openLoginPanel() {
    const haptic = (globalThis as any).HapticFeedback
    haptic?.selectionChanged?.()
    withAnimation(Animation.smooth({ duration: 0.24, extraBounce: 0 }), () => setLoginOpen(value => !value))
  }

  function changeSort() {
    const value = !ascending
    setAscending(value)
    const next = { ...settings, chapterAscending: value }
    saveSettings(next)
    onSettingsChanged(next)
  }

  async function openReader(chapter: MangaChapter, page = 0) {
    if (!detail) return
    const freshSettings = { ...settings, ...loadSettings() }
    await Navigation.present({
      element: (
        <ReaderPage
          source={source}
          manga={detail}
          initialChapter={chapter}
          initialPage={page}
          settings={freshSettings}
          onSettingsChanged={onSettingsChanged}
        />
      ),
      modalPresentationStyle: "overFullScreen",
    })
    setReadSet(loadReadSet())
  }

  function continueReading() {
    if (!detail?.chapters.length) return
    const history = lastHistoryFor(detail)
    const chapter = history
      ? detail.chapters.find(item => item.id === history.chapterId) ?? detail.chapters[0]
      : detail.chapters[0]
    openReader(chapter, history?.page ?? 0).catch(() => undefined)
  }

  const chapters = useMemo(() => detail
    ? (ascending ? [...detail.chapters] : [...detail.chapters].reverse())
    : [], [detail, ascending])
  const displayManga = detail ?? manga

  return (
    <NavigationStack ignoresSafeArea={true}>
      <ScrollView
        navigationTitle={detail?.title ?? manga.title}
        navigationBarTitleDisplayMode="inline"
        scrollContentBackground="hidden"
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        ignoresSafeArea={{ regions: "container", edges: "bottom" }}
        toolbar={{
          topBarLeading: [
            <ToolbarIconButton key="close" systemName="xmark" tint="label" action={() => dismiss()} />,
          ],
          topBarTrailing: [
            ...(shouldShowLogin ? [
              <ToolbarIconButton
                key="login"
                systemName={source.isLoggedIn?.() ? "person.crop.circle.fill.badge.checkmark" : "person.crop.circle.badge.plus"}
                tint={source.isLoggedIn?.() ? "systemGreen" : "systemRed"}
                action={openLoginPanel}
              />,
            ] : []),
            <ToolbarIconButton
              key="favorite"
              systemName={favorite ? "bookmark.fill" : "bookmark"}
              tint="label"
              action={() => setFavorite(toggleFavorite(detail ?? manga))}
            />,
          ],
        }}
      >
        <VStack alignment="leading" spacing={22} padding={{ horizontal: 12, vertical: 8 }} frame={{ maxWidth: "infinity" }}>
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
                  <DetailLoginCloseButton action={() => setLoginOpen(false)} />
                </HStack>
                {source.isLoggedIn?.() ? (
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
            <HStack alignment="top" spacing={16} frame={{ maxWidth: "infinity" }}>
              <MangaCover manga={displayManga} width={126} height={176} />
              <VStack alignment="leading" spacing={9} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <Text font="title2" fontWeight="bold" lineLimit={4}>{displayManga.title}</Text>
                <Text font="subheadline" foregroundStyle="secondaryLabel" lineLimit={2}>
                  {detail?.authors.length ? detail.authors.join(" · ") : source.name}
                </Text>
                {detail ? (
                  <HStack spacing={7}>
                    <Text padding={{ horizontal: 9, vertical: 5 }} font="caption" glassEffect={UIGlass.regular().interactive().tint("rgba(215,38,56,0.12)")} glassEffectTransition="materialize">
                      {detail.status}
                    </Text>
                    <Text padding={{ horizontal: 9, vertical: 5 }} font="caption" glassEffect={UIGlass.regular().interactive()} glassEffectTransition="materialize">
                      {detail.chapters.length} 章
                    </Text>
                  </HStack>
                ) : <ProgressView progressViewStyle="circular" tint="systemRed" scaleEffect={1.2} />}
                <Button
                  title={detail && lastHistoryFor(detail) ? "继续阅读" : "开始阅读"}
                  systemImage="book.pages.fill"
                  buttonStyle="glassProminent"
                  buttonBorderShape="capsule"
                  tint="systemRed"
                  disabled={!detail?.chapters.length}
                  action={continueReading}
                />
              </VStack>
            </HStack>

            {loading ? (
              <HStack spacing={12} padding={{ vertical: 14 }} frame={{ maxWidth: "infinity" }}>
                <ProgressView progressViewStyle="circular" tint="systemRed" scaleEffect={1.2} />
                <Text foregroundStyle="secondaryLabel">正在同步章节</Text>
              </HStack>
            ) : error ? (
              <VStack spacing={12} padding={{ vertical: 34 }} frame={{ maxWidth: "infinity" }}>
                <Image systemName="exclamationmark.triangle.fill" font="title2" foregroundStyle="systemOrange" />
                <Text foregroundStyle="secondaryLabel" multilineTextAlignment="center">{error}</Text>
                <Button title="重试" systemImage="arrow.clockwise" buttonStyle="glassProminent" tint="systemRed" action={() => load().catch(() => undefined)} />
              </VStack>
            ) : null}

            {detail ? (
              <VStack alignment="leading" spacing={22} frame={{ maxWidth: "infinity" }}>
            <VStack alignment="leading" spacing={8}>
              <Text font="title3" fontWeight="bold">简介</Text>
              <Text font="body" foregroundStyle="secondaryLabel">{detail.description}</Text>
            </VStack>

            {detail.tags.length ? (
              <ScrollView axes="horizontal">
                <HStack spacing={8}>
                  {detail.tags.map(tag => (
                    <Text key={tag} font="caption" padding={{ horizontal: 10, vertical: 6 }} glassEffect={UIGlass.regular().interactive()} glassEffectTransition="materialize">
                      {tag}
                    </Text>
                  ))}
                </HStack>
              </ScrollView>
            ) : null}

            <VStack alignment="leading" spacing={8} frame={{ maxWidth: "infinity" }}>
              <HStack frame={{ maxWidth: "infinity" }}>
                <Text font="title3" fontWeight="bold">章节</Text>
                <Spacer />
                <Button
                  title={ascending ? "正序" : "倒序"}
                  systemImage={ascending ? "arrow.up" : "arrow.down"}
                  buttonStyle="glass"
                  buttonBorderShape="capsule"
                  action={changeSort}
                />
              </HStack>
              {chapters.length ? (
                <LazyVStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity" }}>
                  {chapters.map((chapter, index) => {
                const read = readSet.has(chapterKey(detail, chapter.id))
                return (
                  <VStack key={chapter.id} spacing={0} frame={{ maxWidth: "infinity" }}>
                    <Button
                      buttonStyle="plain"
                      frame={{ maxWidth: "infinity" }}
                      contextMenu={{
                        menuItems: <Group><Button title="开始阅读" systemImage="book.pages" action={() => openReader(chapter, 0).catch(() => undefined)} /></Group>,
                      }}
                      action={() => openReader(chapter, 0).catch(() => undefined)}
                    >
                      <HStack spacing={10} padding={{ vertical: 11 }} frame={{ maxWidth: "infinity" }} contentShape="rect">
                        <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                          <Text font="subheadline" fontWeight={read ? "regular" : "semibold"} foregroundStyle={read ? "secondaryLabel" : "label"} lineLimit={2}>
                            {chapter.title}
                          </Text>
                          {chapter.updatedAt ? (
                            <Text font="caption2" foregroundStyle="tertiaryLabel">{chapter.updatedAt.slice(0, 10)}</Text>
                          ) : null}
                        </VStack>
                        {read ? <Image systemName="checkmark.circle.fill" foregroundStyle="systemGreen" /> : null}
                        <Image systemName="chevron.right" font="caption" foregroundStyle="tertiaryLabel" />
                      </HStack>
                    </Button>
                    {index < chapters.length - 1 ? <Divider /> : null}
                  </VStack>
                )
                  })}
                </LazyVStack>
              ) : (
                <Text foregroundStyle="secondaryLabel">该网页未解析到章节。</Text>
              )}
            </VStack>
              </VStack>
            ) : null}
        </VStack>
      </ScrollView>
    </NavigationStack>
  )
}

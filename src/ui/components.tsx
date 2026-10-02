import {
  Button,
  ContentUnavailableView,
  GlassEffectContainer,
  Group,
  HStack,
  Image,
  LazyVGrid,
  ProgressView,
  Script,
  Spacer,
  Text,
  VStack,
  ZStack,
  useState,
} from "scripting"
import type { MangaSummary, SourceCategory } from "../model"

const MANGA_GRID_COLUMNS = [
  { size: 183, spacing: 8 },
  { size: 183, spacing: 8 },
]

export function ToolbarIconButton({
  systemName,
  action,
  tint = "label",
  disabled = false,
}: {
  systemName: string
  action: () => void
  tint?: string
  disabled?: boolean
}) {
  return (
    <Button buttonStyle="plain" disabled={disabled} frame={{ width: 44, height: 44, alignment: "center" }} action={action}>
      <HStack frame={{ width: 44, height: 44, alignment: "center" }} contentShape="rect" opacity={disabled ? 0.38 : 1}>
        <Image systemName={systemName} font="headline" foregroundStyle={tint as any} />
      </HStack>
    </Button>
  )
}

export function MinimizeButton({ tint = "label" }: { tint?: string }) {
  if (!Script.supportsMinimization()) return null

  async function minimize() {
    if (Script.isMinimized()) return
    const success = await Script.minimize()
    if (!success) console.log("琉璃漫画最小化未执行")
  }

  return <ToolbarIconButton systemName="arrow.down.right.and.arrow.up.left" tint={tint} action={() => minimize().catch(reason => console.error(reason))} />
}

export function LoadingState({ title = "正在加载" }: { title?: string }) {
  return (
    <VStack spacing={12} padding={{ vertical: 44 }} frame={{ maxWidth: "infinity" }}>
      <ProgressView progressViewStyle="circular" scaleEffect={1.2} />
      <Text font="subheadline" foregroundStyle="secondaryLabel">{title}</Text>
    </VStack>
  )
}

export function EmptyState({ title, detail, icon }: { title: string; detail: string; icon: string }) {
  return (
    <ContentUnavailableView
      label={<VStack spacing={8}><Image systemName={icon} font="largeTitle" /><Text font="headline">{title}</Text></VStack>}
      description={<Text font="subheadline" foregroundStyle="secondaryLabel" multilineTextAlignment="center">{detail}</Text>}
    />
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <VStack spacing={12} padding={{ horizontal: 24, vertical: 42 }} frame={{ maxWidth: "infinity" }}>
      <Image systemName="exclamationmark.triangle.fill" font="title2" foregroundStyle="systemOrange" />
      <Text font="subheadline" foregroundStyle="secondaryLabel" multilineTextAlignment="center">{message}</Text>
      <Button title="重试" systemImage="arrow.clockwise" buttonStyle="glassProminent" tint="systemRed" action={onRetry} />
    </VStack>
  )
}

export function SourceBadge({ title }: { title: string }) {
  return (
    <Text
      font="caption2"
      foregroundStyle="systemRed"
      padding={{ horizontal: 7, vertical: 3 }}
      glassEffect={UIGlass.regular().interactive().tint("rgba(215,38,56,0.16)")}
      glassEffectTransition="materialize"
    >
      {title}
    </Text>
  )
}

export function MangaCover({ manga, width = 150, height = 210 }: { manga: MangaSummary; width?: number; height?: number }) {
  return (
    <Image
      imageUrl={manga.coverURL}
      resizable={true}
      frame={{ width, height }}
      clipped={true}
      clipShape={{ type: "rect", cornerRadius: 8, style: "continuous" }}
      placeholder={
        <VStack frame={{ width, height }} background="tertiarySystemFill" alignment="center">
          <Image systemName="book.closed.fill" foregroundStyle="secondaryLabel" />
        </VStack>
      }
    />
  )
}

function MangaCard({ manga, onOpen }: { manga: MangaSummary; onOpen: () => void }) {
  const [pressed, setPressed] = useState(false)

  function open() {
    const haptic = (globalThis as any).HapticFeedback
    haptic?.impactOccurred?.("light")
    withAnimation(Animation.easeOut(0.1), () => setPressed(true))
    setTimeout(() => {
      onOpen()
      withAnimation(Animation.smooth({ duration: 0.2, extraBounce: 0.08 }), () => setPressed(false))
    }, 70)
  }

  const openButton = <Button title="打开漫画" systemImage="book.pages" action={open} />
  return (
    <Button buttonStyle="plain" frame={{ width: 183, height: 257 }} action={open}>
      <ZStack
        alignment="bottomLeading"
        frame={{ width: 183, height: 257 }}
        scaleEffect={pressed ? 0.97 : 1}
        clipShape={{ type: "rect", cornerRadius: 18, style: "continuous" }}
        glassEffect={{ glass: UIGlass.regular().interactive(), shape: { type: "rect", cornerRadius: 18, style: "continuous" } }}
        glassEffectTransition="materialize"
        contextMenu={{
          menuItems: <Group>{openButton}</Group>,
          preview: <MangaCover manga={manga} width={183} height={257} />,
        }}
      >
        <MangaCover manga={manga} width={183} height={257} />
        <Text
          font="subheadline"
          fontWeight="bold"
          foregroundStyle="white"
          lineLimit={2}
          padding={{ horizontal: 8, vertical: 8 }}
          frame={{ width: 183, alignment: "leading" }}
        >
          {manga.title}
        </Text>
      </ZStack>
    </Button>
  )
}

export function MangaGrid({
  items,
  onOpen,
}: {
  items: MangaSummary[]
  onOpen: (manga: MangaSummary) => void
}) {
  return (
    <LazyVGrid
      columns={MANGA_GRID_COLUMNS}
      alignment="center"
      spacing={8}
      frame={{ maxWidth: "infinity" }}
    >
      {items.map(item => (
        <MangaCard key={`${item.sourceId}:${item.id}`} manga={item} onOpen={() => onOpen(item)} />
      ))}
    </LazyVGrid>
  )
}

export function CategoryStrip({
  categories,
  selectedId,
  onChanged,
}: {
  categories: SourceCategory[]
  selectedId: string
  onChanged: (id: string) => void
}) {
  return (
    <GlassEffectContainer>
      <HStack spacing={8} padding={{ vertical: 4 }}>
        {categories.map(category => {
          const selected = category.id === selectedId
          return (
            <Button
              key={category.id}
              title={category.title}
              systemImage={category.systemImage}
              buttonStyle={selected ? "glassProminent" : "glass"}
              buttonBorderShape="capsule"
              tint={selected ? "systemRed" : undefined}
              action={() => onChanged(category.id)}
            />
          )
        })}
      </HStack>
    </GlassEffectContainer>
  )
}

export function HistoryRow({
  manga,
  detail,
  sourceName,
  onOpen,
  interactive = true,
}: {
  manga: MangaSummary
  detail: string
  sourceName: string
  onOpen: () => void
  interactive?: boolean
}) {
  const content = (
    <HStack alignment="top" spacing={12} padding={{ vertical: 8 }} frame={{ maxWidth: "infinity" }}>
      <MangaCover manga={manga} width={64} height={90} />
      <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font="headline" lineLimit={2}>{manga.title}</Text>
        <Text font="subheadline" foregroundStyle="secondaryLabel" lineLimit={2}>{detail}</Text>
        <SourceBadge title={sourceName} />
      </VStack>
      <Spacer />
      {interactive ? <Image systemName="chevron.right" font="caption" foregroundStyle="tertiaryLabel" /> : null}
    </HStack>
  )
  return interactive ? <Button buttonStyle="plain" action={onOpen}>{content}</Button> : content
}

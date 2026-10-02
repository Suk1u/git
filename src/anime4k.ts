import { Path, Script } from "scripting"

declare const UIImage: {
  fromBase64String(base64: string): any | null
}

declare class WebViewController {
  loadFile(path: string, allowingReadAccessTo?: string): Promise<boolean | void>
  waitForLoad(): Promise<void>
  evaluateJavaScript<T = any>(javascript: string): Promise<T>
  dispose(): void
}

export type Anime4KProfile = "fast" | "balanced" | "quality"

export type Anime4KRuntimeStatus = {
  backend: "webgl2"
  maxTextureSize: number
  maxRenderbufferSize: number
}

type Anime4KOptions = {
  profile: Anime4KProfile
  strength: number
  denoise: number
  scale: number
}

let controller: WebViewController | null = null
let readyTask: Promise<void> | null = null
let enhancementTail: Promise<void> = Promise.resolve()

function resetEngine() {
  readyTask = null
  controller?.dispose()
  controller = null
}

function withTimeout<T>(task: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds)
    task.then(
      value => { clearTimeout(timer); resolve(value) },
      reason => { clearTimeout(timer); reject(reason) },
    )
  })
}

function enqueueEnhancement<T>(task: () => Promise<T>): Promise<T> {
  const next = enhancementTail.then(task, task)
  enhancementTail = next.then(() => undefined, () => undefined)
  return next
}

async function engine() {
  if (readyTask) return readyTask
  readyTask = (async () => {
    if (!controller) controller = new WebViewController()
    await withTimeout(controller.loadFile(Path.join(Script.directory, "anime4k.html"), Script.directory), 8_000, "Anime4K 本地页面加载超时")
    await withTimeout(controller.waitForLoad(), 8_000, "Anime4K 本地页面初始化超时")
    const status = await withTimeout(
      controller.evaluateJavaScript<Anime4KRuntimeStatus | null>("return window.Anime4KOffline?.status?.() ?? null"),
      5_000,
      "Anime4K WebGL2 引擎检查超时",
    )
    if (!status || status.backend !== "webgl2") throw new Error("Anime4K 本地 WebGL 引擎初始化失败")
  })().catch(reason => {
    resetEngine()
    throw reason
  })
  return readyTask
}

export async function prepareAnime4K() {
  await engine()
  return await controller!.evaluateJavaScript<Anime4KRuntimeStatus>("return window.Anime4KOffline.status()")
}

export async function enhanceImageWithAnime4K(image: any, options: Anime4KOptions) {
  try {
    return await enqueueEnhancement(async () => {
      await engine()
      const input = image.toPNGBase64String?.()
      if (!input) throw new Error("Anime4K 无法编码原图")
      const base64 = await withTimeout(
        controller!.evaluateJavaScript<string>(
          `return window.Anime4KOffline.run(${JSON.stringify(`data:image/png;base64,${input}`)}, ${JSON.stringify(options)})`,
        ),
        60_000,
        "Anime4K 本地推理超时，已回退普通放大",
      )
      const enhanced = UIImage.fromBase64String(base64)
      if (!enhanced) throw new Error("Anime4K 本地结果无法解码")
      return enhanced
    })
  } catch (reason) {
    console.error(reason)
    resetEngine()
    const scale = Math.max(1, Number(options.scale) || 2)
    return image.renderedIn?.({ width: image.width * scale, height: image.height * scale }) ?? image
  }
}

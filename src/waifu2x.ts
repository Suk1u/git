import { Path, Script } from "scripting"

declare const UIImage: {
  fromBase64String(base64: string): any | null
}

declare const FileManager: any

declare class WebViewController {
  loadFile(path: string, allowingReadAccessTo?: string): Promise<boolean | void>
  waitForLoad(): Promise<void>
  evaluateJavaScript<T = any>(javascript: string): Promise<T>
  dispose(): void
}

export type Waifu2xOptions = {
  denoise: number
  scale: number
  format?: "jpeg" | "png"
  quality?: number
}

export type Waifu2xRuntimeStatus = {
  backend: string
  model: string
  scale: number
  denoise: number
  tiled: boolean
  remote: false
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

function normalizedOptions(options: Waifu2xOptions): Waifu2xOptions {
  const denoise = [0, 1, 2, 3].includes(Number(options.denoise)) ? Number(options.denoise) : 1
  const scale = Number(options.scale) === 1 ? 1 : 2
  return { denoise, scale }
}

async function engine() {
  if (readyTask) return readyTask
  readyTask = (async () => {
    if (!controller) controller = new WebViewController()
    await withTimeout(
      controller.loadFile(Path.join(Script.directory, "waifu2x.html"), Script.directory),
      8_000,
      "Waifu2x 本地页面加载超时",
    )
    await withTimeout(controller.waitForLoad(), 8_000, "Waifu2x 本地页面初始化超时")
    try {
      const binPath = Path.join(Script.directory, "waifu2x_model.bin")
      if (typeof FileManager !== "undefined" && FileManager.existsSync?.(binPath)) {
        const b64 = FileManager.readAsDataSync(binPath).toBase64String()
        await controller.evaluateJavaScript(`window.__WAIFU2X_MODEL_BINARY__ = "${b64}";`)
      }
    } catch (e) {
      console.warn("注入 Waifu2x 模型数据异常:", e)
    }
    const status = await withTimeout(
      controller.evaluateJavaScript<Waifu2xRuntimeStatus | null>("return window.Waifu2xOffline?.status?.() ?? null"),
      5_000,
      "Waifu2x WebGL2 引擎检查超时",
    )
    if (!status || status.backend !== "webgl2") throw new Error("Waifu2x 本地 WebGL2 引擎初始化失败")
  })().catch(reason => {
    resetEngine()
    throw reason
  })
  return readyTask
}

export async function prepareWaifu2x(options: Waifu2xOptions): Promise<Waifu2xRuntimeStatus> {
  await engine()
  const normalized = normalizedOptions(options)
  // engine() 已同步确认本地 WebGL2 状态。这里直接组装
  // 就绪状态，避免 iOS 隐藏 WebView 对 `return await prepare()` 偶发不回调，
  // 从而把已就绪的引擎误报为“准备超时”。模型仍只在首次 run() 时懒加载。
  return {
    backend: "webgl2",
    model: "aidoku-waifu2x-upconv7-photo2x",
    scale: normalized.scale,
    denoise: normalized.denoise,
    tiled: true,
    remote: false,
  }
}

export async function enhanceImageWithWaifu2x(image: any, options: Waifu2xOptions) {
  const normalized = normalizedOptions(options)
  if (normalized.scale === 1 && normalized.denoise === 0) return image
  try {
    return await enqueueEnhancement(async () => {
      await engine()
      // 允许输入原图最大长边达到 2048px，确保常见 800~1600px 高清漫画能够 100% 完整原图输入，
      // 真正通过神经网络 2x 重建出 2000~3200px 的极致锐利线条与清晰网点，不再被预先降采样破坏细节。
      const pixelW = Math.round(image.width * (image.scale || 1))
      const pixelH = Math.round(image.height * (image.scale || 1))
      const MAX_INPUT_PIXELS = 2048
      let processImage = image
      if (pixelW > MAX_INPUT_PIXELS || pixelH > MAX_INPUT_PIXELS) {
        const ratio = MAX_INPUT_PIXELS / Math.max(pixelW, pixelH)
        const targetW = Math.max(1, Math.round((pixelW * ratio) / (image.scale || 1)))
        const targetH = Math.max(1, Math.round((pixelH * ratio) / (image.scale || 1)))
        processImage = image.preparingThumbnail?.({ width: targetW, height: targetH }) ?? image
      }
      const input = processImage.toJPEGBase64String?.(0.98) ?? processImage.toPNGBase64String?.()
      if (!input) throw new Error("Waifu2x 无法编码原图")
      const mime = input.startsWith("/9j/") ? "image/jpeg" : "image/png"
      const runOptions = {
        ...normalized,
        format: options.format ?? "jpeg",
        quality: options.quality ?? 0.98,
      }
      const base64 = await withTimeout(
        controller!.evaluateJavaScript<string>(
          `return window.Waifu2xOffline.run(${JSON.stringify(`data:${mime};base64,${input}`)}, ${JSON.stringify(runOptions)})`,
        ),
        60_000,
        "Waifu2x 本地推理超时，已回退普通放大",
      )
      const enhanced = UIImage.fromBase64String(base64)
      if (!enhanced) throw new Error("Waifu2x 本地结果无法解码")
      return enhanced
    })
  } catch (reason) {
    console.error(reason)
    resetEngine()
    const scale = Math.max(1, normalized.scale)
    // Fallback to high-quality bilinear rendering if the neural engine is unavailable.
    // `renderedIn` may not always exist on UIImage; try it first, then fall back to
    // the original image.
    let fallback: any
    if (scale > 1 && typeof image.renderedIn === "function") {
      fallback = image.renderedIn({ width: image.width * scale, height: image.height * scale, interpolation: "high" })
    } else {
      fallback = image
    }
    // Attach diagnostic info so the caller can surface it in the UI if desired.
    fallback.__waifu2xError = reason instanceof Error ? reason.message : String(reason)
    return fallback
  }
}

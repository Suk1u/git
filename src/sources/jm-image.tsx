import { fetch, Image, ImageRenderer, VStack } from "scripting"
import { JM_SCRAMBLE_ID } from "./jm-definitions"
import { jmImageHeaders, jmMd5Hex } from "./jm-request"

const jmCalcScrambleNum = (epId: number, filename: string): number => {
  if (epId < JM_SCRAMBLE_ID) return 0
  if (epId < 268850) return 10
  const picName = filename.replace(/\.[^.]+$/, "")
  const last = jmMd5Hex(`${epId}${picName}`).slice(-1).charCodeAt(0)
  return epId > 421926 ? (last % 8) * 2 + 2 : (last % 10) * 2 + 2
}

export const jmDecodePageImage = async (imageData: Data, epId: number, sourceFileName: string): Promise<any> => {
  const image = UIImage.fromData(imageData)
  if (!image || sourceFileName.toLowerCase().endsWith(".gif")) return image
  const scrambleNum = jmCalcScrambleNum(epId, sourceFileName)
  if (scrambleNum <= 1) return image
  const width = Math.max(1, image.width)
  const height = Math.max(1, image.height)
  const block = Math.floor(height / scrambleNum)
  const remainder = height % scrambleNum
  if (block <= 0) return image
  const orderedSlices: any[] = []
  for (let index = scrambleNum - 1; index >= 0; index--) {
    const currentHeight = index === scrambleNum - 1 ? block + remainder : block
    const slice = image.renderedIn(
      { width, height: currentHeight },
      { position: { x: 0, y: index * block }, size: { width, height: currentHeight } },
    )
    if (!slice) return image
    orderedSlices.push(slice)
  }
  const output = await ImageRenderer.toPNGData(
    <VStack spacing={0} frame={{ width, height }}>
      {orderedSlices.map((slice, index) => <Image key={`${sourceFileName}_${index}`} image={slice} resizable={true} frame={{ width, height: slice.height }} />)}
    </VStack>,
    { opaque: true, scale: 1 },
  )
  return UIImage.fromData(output) ?? image
}

export const jmFetchPageImage = async (url: string, epId: number, sourceFileName: string): Promise<any> => {
  const response = await fetch(url, { headers: jmImageHeaders(), timeout: 30 })
  if (!response.ok) throw new Error(`JM 图片请求失败 (${response.status})`)
  const data = Data.fromArrayBuffer(await response.arrayBuffer())
  if (!data) throw new Error("JM 图片数据为空")
  const image = await jmDecodePageImage(data, epId, sourceFileName)
  if (!image) throw new Error("JM 图片无法解码")
  return image
}

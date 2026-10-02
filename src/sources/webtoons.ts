import { fetch } from "scripting"
import type { MangaSummary } from "../model"

const BASE = "https://m.webtoons.com"
const RANKING_URL = `${BASE}/zh-hant/ranking/popular`
const RANKING_API = `${BASE}/zh-hant/ranking/titles/popular`

export type WebtoonsRecommendation = MangaSummary & {
  rank: number
  genre: string
}

type RankingTitle = {
  titleNo: number
  title: string
  posterThumbnail?: string | null
  titleGroupName?: string | null
  representGenreSeoCode?: string | null
  representGenreMessage?: string | null
}

function recommendation(item: RankingTitle, index: number): WebtoonsRecommendation {
  const id = String(item.titleNo)
  const genreCode = item.representGenreSeoCode || "challenge"
  const group = item.titleGroupName || id
  const url = `${BASE}/zh-hant/${genreCode}/${group}/list?title_no=${encodeURIComponent(id)}`
  return {
    sourceId: "webtoons-recommendation",
    id,
    title: item.title || `WEBTOON ${id}`,
    coverURL: item.posterThumbnail ? `https://webtoon-phinf.pstatic.net${item.posterThumbnail}?type=q70` : "",
    url,
    subtitle: `TOP ${index + 1} · ${item.representGenreMessage || "WEBTOON"}`,
    rank: index + 1,
    genre: item.representGenreMessage || "WEBTOON",
  }
}

export async function loadWebtoonsRecommendations(): Promise<WebtoonsRecommendation[]> {
  const response = await fetch(RANKING_API, {
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Accept-Language": "zh-TW,zh;q=0.9",
      "X-Requested-With": "XMLHttpRequest",
      Referer: RANKING_URL,
    },
    timeout: 25,
  })
  if (!response.ok) throw new Error(`WEBTOON 推荐 HTTP ${response.status}`)
  const payload = await response.json() as { titleList?: RankingTitle[] }
  return (payload.titleList ?? []).slice(0, 30).map(recommendation)
}

export function webtoonsRankingURL() {
  return RANKING_URL
}

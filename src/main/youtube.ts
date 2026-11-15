/**
 * "open youtube and search for X (and play the first video)" without a model or screen reading: the search page is
 * fetched directly, the first real video (not ads / shorts / channels) is taken from its data and opened. ~1 s.
 */
export interface YouTubeIntent {
  query: string
  /** open the first video instead of the results page */
  play: boolean
}

const N = (s: string) =>
  s
    .toLowerCase()
    .replace(/[“”"']/g, '')
    .replace(/[.,!?;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const PLAY = /\b(and |then )?(click|open|play|start|put on|watch)( on)? (the )?(first|top|1st) (video|result|one|clip)\b|\b(and |then )?play (it|that|the video)\b/

export function matchYouTube(raw: string): YouTubeIntent | null {
  let t = N(raw).replace(/^(hey |ok |okay )?(jarvis )?(can you |could you |please )?/, '').replace(/ (please|sir)$/, '')
  if (!/\byou ?tube\b/.test(t) || t.length > 140) return null
  // anything beyond search + play (comment, subscribe, download, send…) goes to the agent
  if (/\b(comment|subscribe|like the|download|share|send|playlist|upload|sign in|log in|history|account)\b/.test(t)) return null
  const play = PLAY.test(t) || /^(play|put on|watch)\b/.test(t)
  t = t.replace(PLAY, ' ').replace(/\s+/g, ' ').trim()
  const pats = [
    /^(?:open |go to |launch )?(?:the )?you ?tube(?: app| website| site)?(?: and| then)? (?:search|look up|find|search up)(?: for| up)? (.+)$/,
    /^(?:search|look up|find|search up)(?: on| in)? you ?tube (?:for )?(.+)$/,
    /^(?:search|look up|find|search up) (?:for )?(.+?) (?:on|in) you ?tube$/,
    /^(?:play|put on|watch|show me|find me) (.+?) (?:on|from) you ?tube$/,
    /^you ?tube (.+)$/
  ]
  for (const p of pats) {
    const m = t.match(p)
    if (m && m[1].trim().length >= 2) {
      const query = m[1].replace(/^(a |the )?(video|videos) (of|about|for) /, '').replace(/ (video|videos)$/, '').trim()
      if (query && !/\byou ?tube\b/.test(query)) return { query, play }
    }
  }
  return null
}

export const resultsUrl = (q: string) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`

/** first regular video in YouTube's search data (skips ads, shorts shelves, channels, playlists) */
export function firstVideo(html: string): { id: string; title: string } | null {
  const re = /"videoRenderer":\{"videoId":"([\w-]{11})"[\s\S]{0,2500}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/g
  const m = re.exec(html)
  if (!m) return null
  let title = m[2]
  try {
    title = JSON.parse(`"${m[2]}"`)
  } catch {}
  return { id: m[1], title }
}

export async function searchFirst(query: string): Promise<{ id: string; title: string } | null> {
  const r = await fetch(resultsUrl(query), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: 'SOCS=CAI; CONSENT=YES+'
    },
    signal: AbortSignal.timeout(6000)
  })
  if (!r.ok) return null
  return firstVideo(await r.text())
}

/**
 * Everyday commands that never wait for a model (Nixi-style): open apps / sites / folders, browser and window keys,
 * dark mode, timers, reminders, lists, finding files, time and date, screenshots. Matching is pure (testable); the
 * runner lives in instant-run.ts. Anything that doesn't match cleanly goes to the agent as before.
 */
export type Instant =
  | { kind: 'open'; target: string; label: string; site?: boolean; folder?: string }
  | { kind: 'keys'; keys: string; scope: 'browser' | 'app'; say: string }
  | { kind: 'find_on_page'; text: string }
  | { kind: 'window'; action: string; say: string }
  | { kind: 'theme'; dark: boolean }
  | { kind: 'timer'; ms: number; label: string }
  | { kind: 'timer_cancel' }
  | { kind: 'timer_status' }
  | { kind: 'remind'; at: number; text: string }
  | { kind: 'reminders_list' }
  | { kind: 'reminders_clear' }
  | { kind: 'list_add'; list: string; items: string[] }
  | { kind: 'list_show'; list: string }
  | { kind: 'list_remove'; list: string; item: string }
  | { kind: 'list_clear'; list: string }
  | { kind: 'find_file'; query: string; open: boolean }
  | { kind: 'time' }
  | { kind: 'date' }
  | { kind: 'screenshot' }

export const N = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[“”"]/g, '')
    .replace(/[.,!?;]+(\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const strip = (t: string) =>
  t
    .replace(/^(hey |ok |okay )?(jarvis )?(can you |could you |would you |please |will you |i want you to |go ahead and )*/, '')
    .replace(/ (please|sir|for me|now|thanks|thank you)$/, '')
    .replace(/ (please|sir|for me|now)$/, '')
    .trim()

// ---------------------------------------------------------------- numbers and durations
const ONES: Record<string, number> = { zero: 0, a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, couple: 2, few: 3 }
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }

/** "25", "twenty five", "twenty-five", "a", "1.5" → number */
export function num(s: string): number | null {
  s = s.trim().replace(/-/g, ' ').replace(/^(a )?(couple|few)( of)?$/, '$2')
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s)
  const w = s.split(' ')
  if (w.length === 1 && w[0] in ONES) return ONES[w[0]]
  if (w.length === 1 && w[0] in TENS) return TENS[w[0]]
  if (w.length === 2 && w[0] in TENS && w[1] in ONES && ONES[w[1]] < 10) return TENS[w[0]] + ONES[w[1]]
  return null
}

const NUM = String.raw`(?:\d+(?:\.\d+)?|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?|zero|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|(?:a )?couple(?: of)?|(?:a )?few)`
const UNIT = String.raw`(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)`
const PART = new RegExp(String.raw`(${NUM}) ?(${UNIT})\b`, 'g')

/** "10 minutes", "an hour and a half", "1 hour 30 minutes", "half an hour", "90 seconds" → ms */
export function duration(s: string): number | null {
  s = s.trim()
  if (/^half an? hour$/.test(s)) return 30 * 60_000
  let ms = 0
  let rest = s
  for (const m of s.matchAll(PART)) {
    const n = num(m[1])
    if (n === null) return null
    const u = m[2][0]
    ms += n * (u === 's' ? 1000 : u === 'm' ? 60_000 : 3_600_000)
    rest = rest.replace(m[0], ' ')
  }
  if (/\band a half\b/.test(rest)) {
    const unit = s.match(PART)?.[0]?.match(new RegExp(UNIT + '$'))?.[0]?.[0]
    ms += unit === 'h' ? 30 * 60_000 : unit === 'm' ? 30_000 : 0
    rest = rest.replace('and a half', ' ')
  }
  if (!ms || rest.replace(/\b(and|,)\b/g, '').trim()) return null
  return ms
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const parts = []
  if (h) parts.push(`${h} hour${h > 1 ? 's' : ''}`)
  if (m) parts.push(`${m} minute${m > 1 ? 's' : ''}`)
  if (sec && !h) parts.push(`${sec} second${sec > 1 ? 's' : ''}`)
  return parts.join(' ') || '0 seconds'
}

/** "6", "6pm", "6:30 pm", "18:30", "noon", "midnight", optionally "tomorrow" → next matching time */
export function clock(s: string, now: Date, tomorrow = false): number | null {
  s = s.trim().replace(/\./g, '').replace(/\bo'?clock\b/, '').trim()
  let h: number
  let mi = 0
  let ap: string | undefined
  if (s === 'noon' || s === 'midday') h = 12, ap = 'pm'
  else if (s === 'midnight') h = 0, ap = 'am'
  else {
    const m = s.match(/^(\d{1,2})(?::(\d{2}))? ?(am|pm|a m|p m|in the morning|in the evening|in the afternoon|at night|tonight)?$/)
    if (!m) {
      const w = s.match(/^([a-z]+(?: [a-z]+)?) ?(am|pm|in the morning|in the evening|in the afternoon|at night|tonight)?$/)
      const n = w ? num(w[1]) : null
      if (n === null || !Number.isInteger(n)) return null
      h = n
      ap = w![2]
    } else {
      h = Number(m[1])
      mi = m[2] ? Number(m[2]) : 0
      ap = m[3]
    }
  }
  if (h > 23 || mi > 59) return null
  if (ap) ap = /^(pm|p m|in the evening|in the afternoon|at night|tonight)$/.test(ap) ? 'pm' : 'am'
  if (ap && h > 12) return null
  const at = (hh: number, addDays: number) => {
    const d = new Date(now)
    d.setDate(d.getDate() + addDays)
    d.setHours(hh, mi, 0, 0)
    return d.getTime()
  }
  const day0 = tomorrow ? 1 : 0
  const cands: number[] = []
  if (ap) cands.push(ap === 'pm' ? (h % 12) + 12 : h % 12)
  else if (h >= 13 || h === 0) cands.push(h)
  else cands.push(h % 12, (h % 12) + 12) // "at 6" = next 6 o'clock, am or pm
  const times = []
  for (const hh of cands) for (const d of tomorrow ? [day0] : [0, 1]) times.push(at(hh, d))
  const future = times.filter((t) => t > now.getTime() + 15_000).sort((a, b) => a - b)
  return future[0] ?? null
}

// ---------------------------------------------------------------- open
export const SITES: Record<string, string> = {
  youtube: 'https://www.youtube.com',
  'youtube music': 'https://music.youtube.com',
  gmail: 'https://mail.google.com',
  'my email': 'https://mail.google.com',
  'my emails': 'https://mail.google.com',
  'my inbox': 'https://mail.google.com',
  google: 'https://www.google.com',
  'google drive': 'https://drive.google.com',
  drive: 'https://drive.google.com',
  'google docs': 'https://docs.google.com',
  'google sheets': 'https://sheets.google.com',
  'google slides': 'https://slides.google.com',
  'google calendar': 'https://calendar.google.com',
  'my calendar': 'https://calendar.google.com',
  'google maps': 'https://maps.google.com',
  maps: 'https://maps.google.com',
  'google translate': 'https://translate.google.com',
  netflix: 'https://www.netflix.com',
  reddit: 'https://www.reddit.com',
  twitter: 'https://x.com',
  x: 'https://x.com',
  facebook: 'https://www.facebook.com',
  instagram: 'https://www.instagram.com',
  tiktok: 'https://www.tiktok.com',
  twitch: 'https://www.twitch.tv',
  amazon: 'https://www.amazon.ca',
  github: 'https://github.com',
  chatgpt: 'https://chatgpt.com',
  perplexity: 'https://www.perplexity.ai',
  wikipedia: 'https://en.wikipedia.org',
  linkedin: 'https://www.linkedin.com',
  'chess com': 'https://www.chess.com',
  chess: 'https://www.chess.com',
  lichess: 'https://lichess.org',
  espn: 'https://www.espn.com',
  'disney plus': 'https://www.disneyplus.com',
  'prime video': 'https://www.primevideo.com',
  crave: 'https://www.crave.ca',
  pinterest: 'https://www.pinterest.com',
  outlook: 'outlook', // the app; falls back to the website in the runner
  'outlook web': 'https://outlook.live.com',
  canvas: 'canvas:'
}
const FOLDERS: Record<string, string> = { downloads: 'downloads', 'my downloads': 'downloads', documents: 'documents', 'my documents': 'documents', desktop: 'desktop', pictures: 'pictures', 'my pictures': 'pictures', photos: 'pictures', music: 'music', videos: 'videos', 'file explorer': 'explorer', explorer: 'explorer', 'this pc': 'explorer' }
const NOT_APP = /\b(and|then|after|email from|message|last|latest|first|second|file|folder named|link|tab with|chat|conversation|door|window|it|that|this)\b/

function matchOpen(t: string): Instant | null {
  const m = t.match(/^(?:open|launch|start|run|go to|bring up|pull up|load)( up)? (?:the |my )?(.+?)(?: app| application| website| site| page| folder)?$/)
  if (!m) return null
  let x = m[2].trim()
  const raw = t.replace(/^(?:open|launch|start|run|go to|bring up|pull up|load)( up)? /, '')
  for (const k of [raw, 'my ' + x, x]) {
    const key = k.replace(/\./g, ' ').replace(/ (app|application|website|site|page|folder)$/, '').trim()
    if (key in FOLDERS) return { kind: 'open', target: FOLDERS[key], label: key.replace(/^my /, ''), folder: FOLDERS[key] }
    if (key in SITES) return { kind: 'open', target: SITES[key], label: key.replace(/^my /, ''), site: SITES[key].startsWith('http') }
  }
  if (/^[\w-]+(\.[\w-]+)*\.(com|ca|org|net|io|ai|app|dev|tv|gg|co|me|edu|gov|uk|us|info)(\/\S*)?$/.test(x)) return { kind: 'open', target: 'https://' + x, label: x, site: true }
  if (/\b\w+ dot (com|ca|org|net|io|ai|app|tv|gg)\b/.test(x) && x.split(' ').length <= 4) {
    const host = x.replace(/ dot /g, '.').replace(/\s+/g, '')
    return { kind: 'open', target: 'https://' + host, label: host, site: true }
  }
  if (t.startsWith('go to')) return null // "go to the kitchen", "go to page 3" → agent
  if (x.split(' ').length > 3 || x.length < 2 || NOT_APP.test(x)) return null
  return { kind: 'open', target: x, label: x }
}

// ---------------------------------------------------------------- keys
const KEYS: [RegExp, string, 'browser' | 'app', string][] = [
  [/^(open |make |create )?(a )?new tab$/, 'ctrl+t', 'browser', 'New tab.'],
  [/^close (this |the |current |that )?tab$/, 'ctrl+w', 'browser', 'Tab closed.'],
  [/^(reopen|restore|bring back|undo close)( the)?( last)?( closed)? tab$/, 'ctrl+shift+t', 'browser', 'Tab restored.'],
  [/^(next tab|switch tabs?|go to the next tab|tab right)$/, 'ctrl+tab', 'browser', 'Next tab.'],
  [/^(previous tab|last tab|go to the previous tab|tab left)$/, 'ctrl+shift+tab', 'browser', 'Previous tab.'],
  [/^(refresh|reload)( the| this)?( page| tab)?$/, 'f5', 'browser', 'Refreshed.'],
  [/^(go back|back a page|go back a page|previous page|go to the previous page|browser back)$/, 'alt+left', 'browser', 'Back.'],
  [/^(go forward|forward a page|go forward a page|browser forward)$/, 'alt+right', 'browser', 'Forward.'],
  [/^(open |make )?(a )?new (browser )?window$/, 'ctrl+n', 'browser', 'New window.'],
  [/^(open )?(an? )?(incognito|private|inprivate)( window| tab| mode)?$/, 'ctrl+shift+n', 'browser', 'Private window.'],
  [/^bookmark (this|the page|this page|it)$/, 'ctrl+d', 'browser', 'Bookmarked.'],
  [/^(show |open )?(my )?(browser )?history$/, 'ctrl+h', 'browser', 'History.'],
  [/^zoom in( more)?$/, 'ctrl+plus', 'app', 'Zoomed in.'],
  [/^zoom out( more)?$/, 'ctrl+minus', 'app', 'Zoomed out.'],
  [/^(reset( the)? zoom|zoom (to )?(normal|100( percent)?|reset)|normal size|actual size)$/, 'ctrl+0', 'app', 'Zoom reset.'],
  [/^(scroll down|page down|scroll down a bit|scroll)$/, 'pagedown', 'app', ''],
  [/^(scroll up|page up|scroll up a bit)$/, 'pageup', 'app', ''],
  [/^(scroll|go|jump) to (the )?(top|beginning|start)( of the page)?$/, 'ctrl+home', 'app', ''],
  [/^(scroll|go|jump) to (the )?(bottom|end)( of the page)?$/, 'ctrl+end', 'app', ''],
  [/^((go |make it |make this )?full ?screen|(exit|leave) full ?screen)$/, 'f11', 'app', ''],
  [/^select all$/, 'ctrl+a', 'app', 'Selected.'],
  [/^copy( that| this| it)?$/, 'ctrl+c', 'app', 'Copied.'],
  [/^paste( it| that)?$/, 'ctrl+v', 'app', 'Pasted.'],
  [/^undo( that)?$/, 'ctrl+z', 'app', 'Undone.'],
  [/^redo( that)?$/, 'ctrl+y', 'app', 'Redone.'],
  [/^save( this| it| the file)?$/, 'ctrl+s', 'app', 'Saved.']
]
const WIN: [RegExp, string, string][] = [
  [/^minimi[sz]e( this| the| it| this window| the window| that)?$/, 'minimize', 'Minimised.'],
  [/^maximi[sz]e( this| the| it| this window| the window| that)?$/, 'maximize', 'Maximised.'],
  [/^snap( this| it| the window| this window)? (to the )?left$/, 'snap_left', 'Left.'],
  [/^snap( this| it| the window| this window)? (to the )?right$/, 'snap_right', 'Right.'],
  [/^close (this|the|that) (window|app)$/, 'close', 'Closed.'],
  [/^(move (it|this|this window) to (the )?(other|next) (monitor|screen|display))$/, 'next_monitor', 'Moved.']
]

// ---------------------------------------------------------------- lists
function listName(s?: string): string {
  s = (s || '').trim()
  if (/^(shopping|grocery|groceries)$/.test(s)) return 'shopping'
  if (/^(to ?do|to-do|todo|task|tasks)$/.test(s)) return 'to-do'
  return s || 'to-do'
}
const LIST = String.raw`(?:my|the)(?: (shopping|grocery|groceries|to ?do|to-do|todo|task|[a-z]+))? list`

export function matchInstant(raw: string, now = new Date()): Instant | null {
  const t = strip(N(raw))
  if (!t || t.length > 120) return null
  let m: RegExpMatchArray | null

  // time / date
  if (/^(what time is it|what's the time|what is the time|time|tell me the time|current time)( right now| now)?$/.test(t)) return { kind: 'time' }
  if (/^(what's|what is) (the date|today's date|the date today)$|^(what day is it|what's today|what is today)( today)?$|^(today's date|date)$/.test(t)) return { kind: 'date' }
  if (/^(take|grab) (a )?screenshot( of (this|the screen|my screen))?$|^screenshot( this| the screen)?$|^capture (the|my) screen$/.test(t)) return { kind: 'screenshot' }

  // dark / light mode
  if (/^((turn|switch) (on )?dark mode( on)?|dark mode( on)?|enable dark mode|switch to dark mode|turn off light mode|go dark)$/.test(t)) return { kind: 'theme', dark: true }
  if (/^((turn|switch) (on )?light mode( on)?|light mode( on)?|enable light mode|switch to light mode|turn off dark mode|dark mode off)$/.test(t)) return { kind: 'theme', dark: false }

  // timers
  if (/^(cancel|stop|delete|clear|remove|turn off)( the| my| all| all my)? timers?$/.test(t)) return { kind: 'timer_cancel' }
  if (/^(how much time|how long)( is)? (left|remaining)( on (the|my) timer)?$|^(timer status|check (the|my) timer)$/.test(t)) return { kind: 'timer_status' }
  if ((m = t.match(/^(?:set|start|put on|make)? ?(?:a |an )?timer (?:for |of )?(.+?)(?: for (.+))?$/)) || (m = t.match(/^(?:set |start )?(?:a |an )?(.+?) timer(?: for (.+))?$/))) {
    const ms = duration(m[1])
    if (ms && ms <= 24 * 3_600_000) return { kind: 'timer', ms, label: m[2] ? m[2].trim() : '' }
  }

  // reminders
  if (/^(what are|list|show( me)?|read( me)?|tell me) my reminders$|^(do i have any|any) reminders$|^my reminders$/.test(t)) return { kind: 'reminders_list' }
  if (/^(cancel|clear|delete|remove)( all)?( of)?( my| the)? reminders$/.test(t)) return { kind: 'reminders_clear' }
  if (/^(remind me|set a reminder|set reminder|reminder|add a reminder)\b/.test(t)) {
    const r = t.replace(/^(remind me|set a reminder|set reminder|reminder|add a reminder)(?: (?:to|that|about)\b)? ?/, '')
    const when = (w: string): number | null => {
      w = w.trim()
      let mm: RegExpMatchArray | null
      if ((mm = w.match(/^in (.+)$/))) {
        const d = duration(mm[1])
        return d ? now.getTime() + d : null
      }
      if ((mm = w.match(/^(tomorrow|tonight|today)(?: at (.+))?$/))) {
        if (mm[1] === 'tonight') return clock((mm[2] || '8') + ' pm', now)
        if (!mm[2]) return mm[1] === 'tomorrow' ? clock('9 am', now, true) : null
        return clock(mm[2], now, mm[1] === 'tomorrow')
      }
      if ((mm = w.match(/^at (.+?)(?: (tomorrow|today|tonight))?$/))) return clock(mm[2] === 'tonight' ? mm[1] + ' pm' : mm[1], now, mm[2] === 'tomorrow')
      return null
    }
    // "<task> in 20 minutes" / "<task> at 6 pm" / "<task> tomorrow at 9"
    if ((m = r.match(/^(.+?) ((?:in|at|tomorrow|tonight|today)\b.*)$/))) {
      const at = when(m[2])
      const what = (/^(remind me|set a reminder|reminder) that /.test(t) ? r : m[1]).replace(/^(to|that|about) /, '').trim()
      if (at && what) return { kind: 'remind', at, text: what }
    }
    // "in 20 minutes to <task>" / "at 6 to <task>" / "tomorrow at 9 to <task>"
    if ((m = r.match(/^((?:in|at|for|tomorrow|tonight|today)\b.*?) (?:to|that|about) (.+)$/))) {
      const at = when(m[1].replace(/^for /, 'at '))
      if (at) return { kind: 'remind', at, text: m[2].trim() }
    }
    return null
  }

  // lists
  if ((m = t.match(new RegExp(String.raw`^(?:add|put) (.+?) (?:to|on) ${LIST}$`)))) {
    const items = m[1].split(/, | and |,/).map((s) => s.replace(/^(some|a|an) /, '').trim()).filter(Boolean)
    if (items.length) return { kind: 'list_add', list: listName(m[2]), items }
  }
  if ((m = t.match(new RegExp(String.raw`^(?:what's|what is|whats) (?:on|in) ${LIST}$|^(?:read|show|tell)(?: me)? ${LIST}$|^${LIST}$`)))) return { kind: 'list_show', list: listName(m[1] ?? m[2] ?? m[3]) }
  if ((m = t.match(new RegExp(String.raw`^(?:remove|delete|cross off|take off|check off|tick off|scratch) (.+?) (?:from|off|on) ${LIST}$|^(?:take|cross|check|tick) (.+?) off ${LIST}$`)))) {
    const item = (m[1] ?? m[3]).trim()
    return { kind: 'list_remove', list: listName(m[2] ?? m[4]), item }
  }
  if ((m = t.match(new RegExp(String.raw`^(?:clear|empty|delete|reset) ${LIST}$`)))) return { kind: 'list_clear', list: listName(m[1]) }

  // find a file
  if ((m = t.match(/^(?:find|locate|search for|look for|where's|where is|show me) (?:my|the) (.+?)(?: file| document| doc| pdf| folder| photo| picture| spreadsheet| presentation| essay| assignment)?(?: on my (?:pc|computer|laptop))?$/))) {
    const q = m[1].trim()
    if (q && q.split(' ').length <= 5 && !/\b(phone|keys|wallet|location|order|package|car|friends?|tab|cursor|mouse|email|emails|messages?)\b/.test(q)) return { kind: 'find_file', query: q, open: false }
  }
  if ((m = t.match(/^open (?:my|the) (.+?) (?:file|document|doc|pdf|spreadsheet|presentation|essay|assignment)$/))) return { kind: 'find_file', query: m[1].trim(), open: true }

  // find text on the current page
  if ((m = t.match(/^(?:find|search for|look for) (.+?) on (?:this|the) page$/))) return { kind: 'find_on_page', text: m[1].trim() }

  for (const [re, keys, scope, say] of KEYS) if (re.test(t)) return { kind: 'keys', keys, scope, say }
  for (const [re, action, say] of WIN) if (re.test(t)) return { kind: 'window', action, say }

  return matchOpen(t)
}

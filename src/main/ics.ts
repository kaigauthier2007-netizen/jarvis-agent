/**
 * Minimal iCalendar (.ics) reader: enough for Google Calendar's "secret address" and Canvas' calendar feed.
 * Handles folded lines, TZID / UTC / all-day dates, RRULE (DAILY / WEEKLY+BYDAY / MONTHLY / YEARLY with INTERVAL,
 * COUNT, UNTIL), EXDATE and moved single occurrences (RECURRENCE-ID).
 */
export interface CalEvent {
  title: string
  start: Date
  end: Date
  allDay: boolean
  location?: string
  description?: string
  url?: string
}

interface Prop {
  name: string
  params: Record<string, string>
  value: string
}

interface RawEvent {
  uid: string
  props: Prop[]
}

function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n')
}

function parseLine(line: string): Prop | null {
  // NAME;PARAM=V;PARAM="V:X":VALUE
  let i = 0
  let inQ = false
  for (; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') inQ = !inQ
    else if (ch === ':' && !inQ) break
  }
  if (i >= line.length) return null
  const head = line.slice(0, i)
  const value = line.slice(i + 1)
  const parts = head.split(';')
  const params: Record<string, string> = {}
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=')
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name: parts[0].toUpperCase(), params, value }
}

const unescape = (v: string) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1')

/** offset (ms) of a time zone at a given instant: wallclock(tz) − UTC */
function tzOffset(tz: string, at: number): number {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const p: Record<string, number> = {}
  for (const x of f.formatToParts(new Date(at))) if (x.type !== 'literal') p[x.type] = Number(x.value)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000
}

/** wall-clock fields (as if UTC) → real instant */
function wallToInstant(wall: number, tz?: string): number {
  if (!tz) {
    // floating / local time
    const d = new Date(wall)
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()).getTime()
  }
  try {
    let t = wall - tzOffset(tz, wall)
    t = wall - tzOffset(tz, t)
    return t
  } catch {
    return wallToInstant(wall)
  }
}

interface ParsedTime {
  wall: number // wall-clock fields encoded as a UTC timestamp
  utc: boolean
  allDay: boolean
  tz?: string
}

function parseTime(p: Prop): ParsedTime | null {
  const m = p.value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/)
  if (!m) return null
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0)
  const allDay = !m[4]
  return { wall, utc: !!m[7], allDay, tz: !m[7] && !allDay ? p.params.TZID : undefined }
}

function toInstant(t: ParsedTime): number {
  if (t.utc) return t.wall
  if (t.allDay) return wallToInstant(t.wall)
  return wallToInstant(t.wall, t.tz)
}

function parseDuration(v: string): number {
  const m = v.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!m) return 0
  const ms = ((+(m[2] || 0) * 7 + +(m[3] || 0)) * 86400 + +(m[4] || 0) * 3600 + +(m[5] || 0) * 60 + +(m[6] || 0)) * 1000
  return m[1] === '-' ? -ms : ms
}

const DAY = 86_400_000
const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

/** wall-clock start times (UTC-encoded) of a recurring event that may fall in [, limitWall] */
function expand(start: number, rule: string, limitWall: number, untilInstant: number | null, toInst: (w: number) => number): number[] {
  const r: Record<string, string> = {}
  for (const kv of rule.split(';')) {
    const [k, v] = kv.split('=')
    if (k && v) r[k.toUpperCase()] = v
  }
  const freq = r.FREQ
  const interval = Math.max(1, Number(r.INTERVAL) || 1)
  const count = r.COUNT ? Number(r.COUNT) : Infinity
  const out: number[] = []
  const push = (w: number) => {
    if (w < start) return true
    if (out.length >= count) return false
    if (untilInstant !== null && toInst(w) > untilInstant) return false
    if (w > limitWall) return false
    out.push(w)
    return true
  }
  const timeOfDay = start % DAY
  let guard = 0
  if (freq === 'DAILY') {
    for (let w = start; guard++ < 20000; w += interval * DAY) if (!push(w)) break
  } else if (freq === 'WEEKLY') {
    const days = (r.BYDAY ? r.BYDAY.split(',').map((d) => WD.indexOf(d.slice(-2))) : [new Date(start).getUTCDay()]).filter((d) => d >= 0).sort()
    const weekStart = start - new Date(start).getUTCDay() * DAY - timeOfDay
    loop: for (let wk = weekStart; guard++ < 5000; wk += interval * 7 * DAY) {
      for (const d of days) if (!push(wk + d * DAY + timeOfDay)) break loop
    }
  } else if (freq === 'MONTHLY' || freq === 'YEARLY') {
    const s = new Date(start)
    for (let k = 0; guard++ < 2000; k += interval) {
      const y = s.getUTCFullYear() + (freq === 'YEARLY' ? k : Math.floor((s.getUTCMonth() + k) / 12))
      const mo = freq === 'YEARLY' ? s.getUTCMonth() : (s.getUTCMonth() + k) % 12
      const w = Date.UTC(y, mo, s.getUTCDate(), s.getUTCHours(), s.getUTCMinutes(), s.getUTCSeconds())
      if (new Date(w).getUTCDate() !== s.getUTCDate()) continue // 31st in a short month
      if (!push(w)) break
    }
  } else out.push(start)
  return out
}

/** all event occurrences overlapping [from, to) */
export function parseIcs(text: string, from: Date, to: Date): CalEvent[] {
  const events: RawEvent[] = []
  let cur: RawEvent | null = null
  let depth = 0
  for (const line of unfold(text)) {
    if (/^BEGIN:VEVENT/i.test(line)) {
      cur = { uid: '', props: [] }
      depth = 0
      continue
    }
    if (!cur) continue
    if (/^BEGIN:/i.test(line)) depth++
    else if (/^END:VEVENT/i.test(line)) {
      events.push(cur)
      cur = null
    } else if (/^END:/i.test(line)) depth--
    else if (depth === 0) {
      const p = parseLine(line)
      if (p) {
        if (p.name === 'UID') cur.uid = p.value
        cur.props.push(p)
      }
    }
  }

  const fromMs = from.getTime()
  const toMs = to.getTime()
  const out: CalEvent[] = []
  // moved / edited single occurrences: uid → instants they replace
  const overridden = new Map<string, Set<number>>()
  for (const e of events) {
    const rid = e.props.find((p) => p.name === 'RECURRENCE-ID')
    const t = rid && parseTime(rid)
    if (t) {
      if (!overridden.has(e.uid)) overridden.set(e.uid, new Set())
      overridden.get(e.uid)!.add(toInstant(t))
    }
  }

  for (const e of events) {
    const get = (n: string) => e.props.find((p) => p.name === n)
    if (/CANCELLED/i.test(get('STATUS')?.value || '')) continue
    const ds = get('DTSTART')
    const st = ds && parseTime(ds)
    if (!st) continue
    const de = get('DTEND')
    const et = de && parseTime(de)
    const durProp = get('DURATION')
    const startInst = toInstant(st)
    const length = et ? toInstant(et) - startInst : durProp ? parseDuration(durProp.value) : st.allDay ? DAY : 0
    const base = {
      title: unescape(get('SUMMARY')?.value || '(no title)'),
      location: get('LOCATION') ? unescape(get('LOCATION')!.value) || undefined : undefined,
      description: get('DESCRIPTION') ? unescape(get('DESCRIPTION')!.value).slice(0, 400) || undefined : undefined,
      url: get('URL')?.value || undefined,
      allDay: st.allDay
    }
    const conv = (w: number) => toInstant({ ...st, wall: w })
    const rrule = get('RRULE')
    const isOverride = !!get('RECURRENCE-ID')
    let starts: number[]
    if (rrule && !isOverride) {
      const untilM = rrule.value.match(/UNTIL=([0-9TZ]+)/i)
      const ut = untilM ? parseTime({ name: 'UNTIL', params: {}, value: untilM[1] }) : null
      const untilInst = ut ? (ut.utc ? ut.wall : ut.allDay ? wallToInstant(ut.wall) + DAY - 1 : wallToInstant(ut.wall, st.tz)) : null
      // limit in wall time: a day of slack covers any time-zone offset
      const limitWall = toMs + 2 * DAY + (st.wall - startInst)
      const ex = new Set<number>()
      for (const p of e.props.filter((x) => x.name === 'EXDATE'))
        for (const v of p.value.split(',')) {
          const t = parseTime({ ...p, value: v })
          if (t) ex.add(toInstant(t.tz || t.utc || t.allDay ? t : { ...t, tz: st.tz }))
        }
      const skip = overridden.get(e.uid)
      starts = expand(st.wall, rrule.value, limitWall, untilInst, conv)
        .map(conv)
        .filter((s) => !ex.has(s) && !skip?.has(s))
    } else starts = [startInst]
    for (const s of starts) {
      const end = s + Math.max(length, 0)
      if (end > fromMs && s < toMs) out.push({ ...base, start: new Date(s), end: new Date(end || s) })
      else if (length === 0 && s >= fromMs && s < toMs) out.push({ ...base, start: new Date(s), end: new Date(s) })
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime())
}

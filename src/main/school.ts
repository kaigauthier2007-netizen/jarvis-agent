/**
 * Direct, model-free access to Canvas and Google Calendar: one HTTP request instead of an agent clicking through web
 * pages. Used by the instant voice answers ("what's due this week?", "what's on my calendar tomorrow?") and by the
 * agent tools jarvis_school_due / jarvis_calendar_events / jarvis_calendar_add / jarvis_canvas_announcements /
 * jarvis_canvas_grades. Data is prefetched in the background so spoken answers come back in well under a second.
 */
import type { Settings } from '../shared/types'
import { CalEvent, parseIcs } from './ics'

export interface DueItem {
  title: string
  course: string
  due: Date
  type: string
  done: boolean
  missing: boolean
  url?: string
}

export interface SchoolIntent {
  kind: 'calendar' | 'due' | 'announcements' | 'grades'
  from: Date
  to: Date
  label: string
}

const DAY = 86_400_000
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes())
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

/** "today" / "tomorrow" / "this week" / "next week" / "on friday" / "this weekend" → a date range */
export function rangeOf(t: string, now = new Date(), fallbackDays = 1): { from: Date; to: Date; label: string } {
  const today = startOfDay(now)
  if (/\b(tomorrow|tmrw|tmr)\b/.test(t)) return { from: addDays(today, 1), to: addDays(today, 2), label: 'tomorrow' }
  if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(t)) return { from: now, to: addDays(today, 1), label: 'today' }
  if (/\bnext week\b/.test(t)) {
    const mon = addDays(today, ((8 - today.getDay()) % 7) || 7)
    return { from: mon, to: addDays(mon, 7), label: 'next week' }
  }
  if (/\b(this )?weekend\b/.test(t)) {
    const sat = addDays(today, (6 - today.getDay() + 7) % 7)
    return { from: today.getDay() === 0 ? now : sat, to: today.getDay() === 0 ? addDays(today, 1) : addDays(sat, 2), label: 'this weekend' }
  }
  if (/\b(this week|the week|week)\b/.test(t)) {
    // through Sunday night; on Sunday look at the coming week
    const left = today.getDay() === 0 ? 7 : 7 - today.getDay() + 1
    return { from: now, to: addDays(today, left), label: 'this week' }
  }
  if (/\b(next|coming|upcoming) (\d+|few|couple( of)?) days\b/.test(t)) {
    const n = Number(t.match(/\b(\d+) days\b/)?.[1]) || 3
    return { from: now, to: addDays(today, n + 1), label: `the next ${n} days` }
  }
  for (let i = 0; i < 7; i++) {
    const w = WEEKDAYS[i]
    if (new RegExp(`\\b(on )?${w}\\b`).test(t)) {
      const d = addDays(today, (i - today.getDay() + 7) % 7)
      return { from: d.getTime() === today.getTime() ? now : d, to: addDays(d, 1), label: d.getTime() === today.getTime() ? 'today' : `on ${w[0].toUpperCase() + w.slice(1)}` }
    }
  }
  if (fallbackDays === 1) return { from: now, to: addDays(today, 1), label: 'today' }
  return { from: now, to: addDays(today, fallbackDays + 1), label: fallbackDays === 7 ? 'in the next week' : `in the next ${fallbackDays} days` }
}

const N = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** a plain question about the calendar / Canvas that can be answered without the model */
export function matchSchool(raw: string, now = new Date()): SchoolIntent | null {
  const t = N(raw).replace(/^(hey |ok |okay )?(jarvis )?/, '').replace(/ (please|sir)$/, '')
  if (!t || t.length > 80) return null
  // anything that changes things, or needs thinking, goes to the agent
  if (/\b(add|create|put|book|move|cancel|delete|remove|reschedule|invite|remind|set up|help|write|draft|start|finish|explain|submit|summari[sz]e|work on|open|email|study|plan|make|schedule (a|an|my|me|it|this))\b/.test(t)) return null
  const question = /^(what|whats|wht|anything|any|do i|is there|are there|am i|show|check|read|list|tell me|give me|hows|how|when|my)\b/.test(t)
  if (!question) return null
  if (/\b(announcements?|anything new on canvas|new on canvas|whats new (on|in) canvas)\b/.test(t)) return { kind: 'announcements', from: new Date(now.getTime() - 7 * DAY), to: now, label: 'this past week' }
  if (/\b(my )?(grades?|marks?|scores?)\b/.test(t) && !/\bdue\b/.test(t)) return { kind: 'grades', from: now, to: now, label: '' }
  if (/\b(due|assignments?|homework|deadlines?|quiz(zes)?|quizes|canvas)\b/.test(t)) return { kind: 'due', ...rangeOf(t, now, 7) }
  if (/\b(calendar|schedule|agenda|plans|events?|busy|free)\b/.test(t) || /^(what|whats|anything) (do i have|have i got|is) (on )?(today|tomorrow|tonight|this|next|on)\b/.test(t) || /^whats (on|happening) (today|tomorrow|tonight|this|next)\b/.test(t))
    return { kind: 'calendar', ...rangeOf(t, now, 1) }
  return null
}

// ---------------------------------------------------------------- formatting
const clock = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(':00', '')
const dayName = (d: Date, now = new Date()) => {
  const diff = Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / DAY)
  if (diff === 0) return 'today'
  if (diff === 1) return 'tomorrow'
  if (diff > 1 && diff < 7) return d.toLocaleDateString('en-US', { weekday: 'long' })
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}
const join = (xs: string[]) => (xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1])

/** "HES_O 201 001 2026W1 Foundations of…" → "HES 201" */
export function shortCourse(name: string): string {
  const m = name.match(/\b([A-Z]{2,5})(?:_[A-Z])?[\s_-]?(\d{3}[A-Z]?)\b/)
  return m ? `${m[1]} ${m[2]}` : name.replace(/\s+\d{4}W\d.*$/, '').slice(0, 30)
}

export function describeEvents(evs: CalEvent[], label: string, now = new Date()): string {
  if (!evs.length) return `Nothing on your calendar ${label}.`
  const days = new Map<string, CalEvent[]>()
  for (const e of evs) {
    const k = dayName(e.start.getTime() < now.getTime() && !e.allDay ? now : e.start, now)
    if (!days.has(k)) days.set(k, [])
    days.get(k)!.push(e)
  }
  const one = (e: CalEvent) => (e.allDay ? `${e.title} (all day)` : `${clock(e.start)} ${e.title}`)
  if (days.size === 1) {
    const [k, list] = [...days][0]
    return `${k[0].toUpperCase() + k.slice(1)} you have ${list.length === 1 ? '' : list.length + ' things: '}${join(list.slice(0, 8).map(one))}${list.length > 8 ? `, plus ${list.length - 8} more` : ''}.`
  }
  return [...days].map(([k, list]) => `${k[0].toUpperCase() + k.slice(1)}: ${join(list.slice(0, 6).map(one))}${list.length > 6 ? ` (+${list.length - 6})` : ''}.`).join(' ')
}

export function describeDue(items: DueItem[], label: string, now = new Date()): string {
  const open = items.filter((i) => !i.done)
  const done = items.length - open.length
  if (!items.length) return `Nothing due ${label}.`
  if (!open.length) return `All ${done} thing${done === 1 ? '' : 's'} due ${label} ${done === 1 ? 'is' : 'are'} already submitted.`
  const one = (i: DueItem) => `${i.course ? i.course + ' ' : ''}${i.title}, ${dayName(i.due, now)} at ${clock(i.due)}${i.missing ? ' (missing)' : ''}`
  return `Due ${label}: ${open.slice(0, 8).map(one).join('; ')}${open.length > 8 ? `; plus ${open.length - 8} more` : ''}.${done ? ` ${done} already submitted.` : ''}`
}

// ---------------------------------------------------------------- data
interface Cached<T> {
  at: number
  value: T
}

export class School {
  private ics = new Map<string, Cached<string>>()
  private planner: Cached<DueItem[]> & { from: number; to: number } = { at: 0, value: [], from: 0, to: 0 }
  private courses: Cached<Map<number, string>> = { at: 0, value: new Map() }
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private settings: () => Settings) {}

  get hasCalendar() {
    return this.calendarUrls().length > 0
  }
  get hasCanvas() {
    const s = this.settings()
    return !!(s.canvasToken && s.canvasUrl) || !!s.canvasFeed
  }
  get hasCanvasApi() {
    const s = this.settings()
    return !!(s.canvasToken && s.canvasUrl)
  }

  private calendarUrls() {
    return (this.settings().calendarIcs || '')
      .split(/[\s,]+/)
      .map((x) => x.trim().replace(/^webcal:/i, 'https:'))
      .filter((x) => /^https?:\/\//i.test(x))
  }

  /** prefetch now and keep the data fresh, so spoken answers never wait for the network */
  startWarm() {
    const warm = () => {
      if (this.hasCalendar) void this.events(new Date(), new Date(Date.now() + 8 * DAY)).catch(() => {})
      if (this.hasCanvas) void this.due(new Date(), new Date(Date.now() + 8 * DAY)).catch(() => {})
    }
    warm()
    this.timer ??= setInterval(warm, 10 * 60_000)
  }

  invalidate() {
    this.ics.clear()
    this.planner.at = 0
  }

  private async fetchText(url: string, maxAge: number): Promise<string> {
    const c = this.ics.get(url)
    if (c && Date.now() - c.at < maxAge) return c.value
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const v = await r.text()
      if (!/BEGIN:VCALENDAR/i.test(v)) throw new Error('that address is not a calendar (.ics) feed')
      this.ics.set(url, { at: Date.now(), value: v })
      return v
    } catch (e) {
      if (c) return c.value // stale beats nothing
      throw e
    }
  }

  async events(from: Date, to: Date): Promise<CalEvent[]> {
    const urls = this.calendarUrls()
    if (!urls.length) throw new Error('Google Calendar is not connected yet: paste its secret iCal address in Settings → School.')
    const all: CalEvent[] = []
    const res = await Promise.allSettled(urls.map((u) => this.fetchText(u, 5 * 60_000)))
    const fails = res.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    if (fails.length === res.length) throw new Error(`could not read the calendar: ${fails[0].reason?.message || fails[0].reason}`)
    for (const r of res) if (r.status === 'fulfilled') all.push(...parseIcs(r.value, from, to))
    const seen = new Set<string>()
    return all
      .filter((e) => {
        const k = e.title + e.start.getTime()
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
      .sort((a, b) => a.start.getTime() - b.start.getTime())
  }

  private async canvas<T>(path: string): Promise<T> {
    const s = this.settings()
    const base = s.canvasUrl.trim().replace(/\/+$/, '').replace(/^(?!https?:)/, 'https://')
    const r = await fetch(`${base}/api/v1/${path}`, { headers: { Authorization: `Bearer ${s.canvasToken.trim()}`, Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) })
    if (r.status === 401) throw new Error('Canvas rejected the access token. Make a new one in Canvas → Account → Settings → New Access Token and paste it in Settings → School.')
    if (!r.ok) throw new Error(`Canvas answered HTTP ${r.status}`)
    return (await r.json()) as T
  }

  private async courseNames(): Promise<Map<number, string>> {
    if (Date.now() - this.courses.at < 6 * 3600_000 && this.courses.value.size) return this.courses.value
    const list = await this.canvas<{ id: number; name?: string; course_code?: string }[]>('courses?enrollment_state=active&per_page=100')
    const m = new Map<number, string>()
    for (const c of list) m.set(c.id, shortCourse(c.course_code || c.name || ''))
    this.courses = { at: Date.now(), value: m }
    return m
  }

  async due(from: Date, to: Date): Promise<DueItem[]> {
    const s = this.settings()
    if (s.canvasToken && s.canvasUrl) {
      // one fetch covers the usual "today / this week" questions; refresh every 2 minutes
      const p = this.planner
      const want0 = Math.min(from.getTime(), Date.now() - DAY)
      const want1 = Math.max(to.getTime(), Date.now() + 8 * DAY)
      if (!(Date.now() - p.at < 120_000 && p.from <= from.getTime() && p.to >= to.getTime())) {
        const [names, items] = await Promise.all([
          this.courseNames().catch(() => new Map<number, string>()),
          this.canvas<any[]>(`planner/items?start_date=${encodeURIComponent(new Date(want0).toISOString())}&end_date=${encodeURIComponent(new Date(want1).toISOString())}&per_page=100`)
        ])
        const out: DueItem[] = []
        for (const it of items) {
          if (!/^(assignment|quiz|discussion_topic|sub_assignment|planner_note|wiki_page)$/.test(it.plannable_type)) continue
          const when = it.plannable?.due_at || it.plannable_date || it.plannable?.todo_date
          if (!when) continue
          const sub = it.submissions || {}
          out.push({
            title: String(it.plannable?.title || 'untitled').trim(),
            course: it.course_id ? names.get(it.course_id) || shortCourse(it.context_name || '') : it.plannable_type === 'planner_note' ? 'To-do' : '',
            due: new Date(when),
            type: it.plannable_type,
            done: !!(sub.submitted || sub.excused || sub.graded || it.planner_override?.marked_complete),
            missing: !!sub.missing,
            url: it.html_url ? s.canvasUrl.replace(/\/+$/, '') + it.html_url : undefined
          })
        }
        out.sort((a, b) => a.due.getTime() - b.due.getTime())
        this.planner = { at: Date.now(), value: out, from: want0, to: want1 }
      }
      return this.planner.value.filter((i) => i.due >= from && i.due < to)
    }
    if (s.canvasFeed) {
      const text = await this.fetchText(s.canvasFeed.trim().replace(/^webcal:/i, 'https:'), 5 * 60_000)
      return parseIcs(text, from, to).map((e) => {
        const m = e.title.match(/^(.*?)\s*\[([^\]]+)\]\s*$/)
        return { title: m ? m[1] : e.title, course: m ? shortCourse(m[2]) : '', due: e.allDay ? new Date(e.start.getTime() + DAY - 60_000) : e.start, type: 'assignment', done: false, missing: false, url: e.url }
      })
    }
    throw new Error('Canvas is not connected yet: add your Canvas access token (or calendar feed) in Settings → School.')
  }

  async announcements(days = 7): Promise<{ course: string; title: string; posted: Date; text: string; url?: string }[]> {
    if (!this.hasCanvasApi) throw new Error('Announcements need a Canvas access token: add it in Settings → School.')
    const names = await this.courseNames()
    if (!names.size) return []
    const ctx = [...names.keys()].map((id) => `context_codes[]=course_${id}`).join('&')
    const start = new Date(Date.now() - days * DAY).toISOString()
    const list = await this.canvas<any[]>(`announcements?${ctx}&start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(new Date().toISOString())}&per_page=30`)
    return list
      .map((a) => ({
        course: names.get(Number(String(a.context_code || '').replace('course_', ''))) || '',
        title: String(a.title || '').trim(),
        posted: new Date(a.posted_at || a.created_at),
        text: String(a.message || '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 500),
        url: a.html_url
      }))
      .sort((a, b) => b.posted.getTime() - a.posted.getTime())
  }

  async grades(): Promise<{ course: string; score: number | null; grade: string | null }[]> {
    if (!this.hasCanvasApi) throw new Error('Grades need a Canvas access token: add it in Settings → School.')
    const [names, list] = await Promise.all([this.courseNames(), this.canvas<any[]>('users/self/enrollments?type[]=StudentEnrollment&state[]=active&per_page=100')])
    return list
      .filter((e) => names.has(e.course_id))
      .map((e) => ({ course: names.get(e.course_id)!, score: e.grades?.current_score ?? null, grade: e.grades?.current_grade ?? null }))
  }

  /** a spoken answer for an instant question (throws when not connected / offline) */
  async answer(i: SchoolIntent): Promise<string> {
    const now = new Date()
    if (i.kind === 'calendar') return describeEvents(await this.events(i.from, i.to), i.label, now)
    if (i.kind === 'due') return describeDue(await this.due(i.from, i.to), i.label, now)
    if (i.kind === 'announcements') {
      const a = await this.announcements(7)
      if (!a.length) return 'No new announcements on Canvas this past week.'
      return `${a.length} announcement${a.length === 1 ? '' : 's'} this week: ${a
        .slice(0, 5)
        .map((x) => `${x.course ? x.course + ', ' : ''}"${x.title}" ${dayName(x.posted, now) === 'today' ? 'today' : dayName(x.posted, now) === 'tomorrow' ? '' : 'on ' + x.posted.toLocaleDateString('en-US', { weekday: 'long' })}`.trim())
        .join('; ')}.`
    }
    const g = await this.grades()
    if (!g.length) return 'I could not find any active courses on Canvas.'
    return `Current grades: ${g.map((x) => `${x.course} ${x.score === null ? 'no grade yet' : Math.round(x.score * 10) / 10 + '%'}`).join(', ')}.`
  }
}

/** Google Calendar "new event" page, pre-filled; the user presses Save (no Google sign-in setup needed) */
export function calendarTemplateUrl(a: { title: string; start: string; end?: string; allDay?: boolean; location?: string; details?: string }): string {
  const local = (v: string): Date => {
    if (/[zZ]$|[+-]\d\d:?\d\d$/.test(v)) return new Date(v)
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/)
    if (!m) return new Date(v)
    return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0)
  }
  const p2 = (n: number) => String(n).padStart(2, '0')
  const ymd = (d: Date) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`
  const stamp = (d: Date) => `${ymd(d)}T${p2(d.getHours())}${p2(d.getMinutes())}00`
  const s = local(a.start)
  if (isNaN(s.getTime())) throw new Error('could not read the start time; use e.g. 2026-11-19T18:00')
  const allDay = a.allDay || /^\d{4}-\d{2}-\d{2}$/.test(a.start.trim())
  const e = a.end ? local(a.end) : allDay ? new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1) : new Date(s.getTime() + 3600_000)
  const dates = allDay ? `${ymd(s)}/${ymd(e.getTime() > s.getTime() ? e : new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1))}` : `${stamp(s)}/${stamp(e)}`
  const q = new URLSearchParams({ action: 'TEMPLATE', text: a.title, dates, ctz: Intl.DateTimeFormat().resolvedOptions().timeZone })
  if (a.location) q.set('location', a.location)
  if (a.details) q.set('details', a.details)
  return `https://calendar.google.com/calendar/render?${q.toString()}`
}

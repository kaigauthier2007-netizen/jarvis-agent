/**
 * Runs the instant commands from instant.ts. Timers, reminders and lists are kept in small JSON files in the app data
 * folder, so reminders survive a restart.
 */
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { app, Notification } from 'electron'
import type { WinBridge, WinWindow } from './win'
import { fmtDuration, type Instant } from './instant'

interface Alarm {
  id: string
  kind: 'timer' | 'reminder'
  at: number
  text: string
  setAt: number
}

export interface InstantDeps {
  win: WinBridge
  dataDir: string
  powershell(cmd: string, timeout?: number): Promise<string>
  /** spoken + chat line when a timer/reminder goes off */
  announce(text: string): void
  canvasUrl(): string
}

const BROWSERS = /^(msedge|chrome|firefox|brave|opera|vivaldi|arc|zen)$/i
const OWN = /^(jarvis|electron)$/i
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`
const pad = (n: number) => String(n).padStart(2, '0')

export function whenText(at: number, now = Date.now()): string {
  const d = new Date(at)
  const today = new Date(now)
  const tomorrow = new Date(now + 86_400_000)
  const hh = d.getHours() % 12 || 12
  const time = `${hh}${d.getMinutes() ? ':' + pad(d.getMinutes()) : ''} ${d.getHours() < 12 ? 'AM' : 'PM'}`
  if (d.toDateString() === today.toDateString()) return at - now < 3_600_000 ? `in ${fmtDuration(at - now)} (${time})` : `at ${time}`
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`
  return `${d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} at ${time}`
}

export class InstantRunner {
  private alarms: Alarm[] = []
  private timers = new Map<string, NodeJS.Timeout>()
  private lists: Record<string, string[]> = {}

  constructor(private d: InstantDeps) {
    this.alarms = this.load<Alarm[]>('alarms.json', [])
    this.lists = this.load<Record<string, string[]>>('lists.json', {})
    // missed while Jarvis was closed: say so once; still to come: schedule again
    const now = Date.now()
    const missed = this.alarms.filter((a) => a.kind === 'reminder' && a.at <= now)
    this.alarms = this.alarms.filter((a) => a.at > now)
    this.saveAlarms()
    for (const a of this.alarms) this.schedule(a)
    if (missed.length) setTimeout(() => this.d.announce(`While I was off, sir: ${missed.map((m) => m.text).join('; ')}.`), 8000)
  }

  private load<T>(name: string, def: T): T {
    try {
      const p = join(this.d.dataDir, name)
      return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : def
    } catch {
      return def
    }
  }
  private saveAlarms() {
    writeFileSync(join(this.d.dataDir, 'alarms.json'), JSON.stringify(this.alarms, null, 1))
  }
  private saveLists() {
    writeFileSync(join(this.d.dataDir, 'lists.json'), JSON.stringify(this.lists, null, 1))
  }

  private schedule(a: Alarm) {
    const fire = () => {
      const left = a.at - Date.now()
      if (left > 60_000) return void this.timers.set(a.id, setTimeout(fire, Math.min(left, 2 ** 31 - 1)))
      this.timers.delete(a.id)
      this.alarms = this.alarms.filter((x) => x.id !== a.id)
      this.saveAlarms()
      const msg = a.kind === 'timer' ? `Sir, your ${a.text ? a.text + ' ' : ''}timer is done.` : `Reminder, sir: ${a.text}.`
      try {
        new Notification({ title: a.kind === 'timer' ? 'Timer done' : 'Reminder', body: a.kind === 'timer' ? `${a.text || fmtDuration(a.at - a.setAt)} is up` : a.text, silent: false }).show()
      } catch {}
      this.d.announce(msg)
    }
    // long waits are re-armed in steps (setTimeout max ≈ 24.8 days; also survives sleep/wake drift)
    this.timers.set(a.id, setTimeout(fire, Math.max(0, Math.min(a.at - Date.now(), 2 ** 31 - 1))))
  }

  private add(kind: Alarm['kind'], at: number, text: string) {
    const a: Alarm = { id: Math.random().toString(36).slice(2), kind, at, text, setAt: Date.now() }
    this.alarms.push(a)
    this.saveAlarms()
    this.schedule(a)
  }

  /** topmost real window (not Jarvis), optionally only browsers */
  private async target(browser: boolean): Promise<WinWindow | null> {
    const ws = await this.d.win.call<WinWindow[]>('windows').catch(() => [] as WinWindow[])
    return ws.find((w) => !OWN.test(w.process) && !w.minimized && (!browser || BROWSERS.test(w.process))) ?? null
  }

  private async focus(w: WinWindow) {
    const fg = await this.d.win.call<WinWindow>('foreground').catch(() => null)
    if (fg?.hwnd !== w.hwnd) await this.d.win.call('focus', { hwnd: w.hwnd }).catch(() => {})
  }

  /** run it; returns the reply line, or null to hand the request to the agent instead */
  async run(x: Instant): Promise<string | null> {
    switch (x.kind) {
      case 'time': {
        const d = new Date()
        return `It's ${d.getHours() % 12 || 12}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}, sir.`
      }
      case 'date':
        return `Today is ${new Date().toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.`
      case 'screenshot':
        await this.d.win.call('keys', { keys: 'win+printscreen' })
        return 'Screenshot saved to Pictures, Screenshots.'
      case 'theme': {
        const v = x.dark ? 0 : 1
        const k = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
        await this.d.powershell(`Set-ItemProperty -Path '${k}' -Name AppsUseLightTheme -Value ${v} -Type DWord; Set-ItemProperty -Path '${k}' -Name SystemUsesLightTheme -Value ${v} -Type DWord`, 8000)
        return x.dark ? 'Dark mode on.' : 'Light mode on.'
      }
      case 'open': {
        let target = x.target
        if (x.folder) target = x.folder === 'explorer' ? 'explorer' : app.getPath(x.folder as any)
        if (target === 'canvas:') target = this.d.canvasUrl() || 'https://canvas.instructure.com'
        try {
          await this.d.win.call('launch', { name: target, wait: 0 }, 12000)
        } catch (e) {
          if (target === 'outlook') await this.d.win.call('launch', { name: 'https://outlook.live.com', wait: 0 }, 12000)
          else if (x.site || x.folder) throw e
          else return null // not an app we know: let the agent work it out
        }
        return `Opening ${x.label}.`
      }
      case 'keys': {
        const w = await this.target(x.scope === 'browser')
        if (!w) return x.scope === 'browser' ? null : 'There is no window to send that to, sir.'
        await this.focus(w)
        await this.d.win.call('keys', { keys: x.keys })
        return x.say || 'Done.'
      }
      case 'find_on_page': {
        const w = await this.target(false)
        if (!w) return null
        await this.focus(w)
        await this.d.win.call('keys', { keys: 'ctrl+f' })
        await new Promise((r) => setTimeout(r, 150))
        await this.d.win.call('keys', { keys: 'ctrl+a' })
        await this.d.win.call('type', { text: x.text, char_delay: 2 })
        await this.d.win.call('keys', { keys: 'enter' })
        return `Looking for "${x.text}".`
      }
      case 'window': {
        const w = await this.target(false)
        if (!w) return 'There is no window for that, sir.'
        await this.d.win.call('window_control', { hwnd: w.hwnd, action: x.action })
        return x.say
      }
      case 'timer': {
        this.add('timer', Date.now() + x.ms, x.label)
        return `Timer set for ${fmtDuration(x.ms)}${x.label ? ' for ' + x.label : ''}.`
      }
      case 'timer_cancel': {
        const ts = this.alarms.filter((a) => a.kind === 'timer')
        for (const a of ts) clearTimeout(this.timers.get(a.id)!)
        this.alarms = this.alarms.filter((a) => a.kind !== 'timer')
        this.saveAlarms()
        return ts.length ? `Cancelled ${ts.length === 1 ? 'the timer' : ts.length + ' timers'}.` : 'There is no timer running, sir.'
      }
      case 'timer_status': {
        const ts = this.alarms.filter((a) => a.kind === 'timer').sort((a, b) => a.at - b.at)
        if (!ts.length) return 'No timer is running, sir.'
        return ts.map((a) => `${fmtDuration(a.at - Date.now())} left${a.text ? ' on ' + a.text : ''}`).join('; ') + '.'
      }
      case 'remind': {
        this.add('reminder', x.at, x.text)
        return `Reminder set: ${x.text}, ${whenText(x.at)}.`
      }
      case 'reminders_list': {
        const rs = this.alarms.filter((a) => a.kind === 'reminder').sort((a, b) => a.at - b.at)
        if (!rs.length) return 'You have no reminders, sir.'
        return rs.map((a) => `${a.text}, ${whenText(a.at)}`).join('; ') + '.'
      }
      case 'reminders_clear': {
        const rs = this.alarms.filter((a) => a.kind === 'reminder')
        for (const a of rs) clearTimeout(this.timers.get(a.id)!)
        this.alarms = this.alarms.filter((a) => a.kind !== 'reminder')
        this.saveAlarms()
        return rs.length ? `Cleared ${rs.length} reminder${rs.length > 1 ? 's' : ''}.` : 'You have no reminders, sir.'
      }
      case 'list_add': {
        const l = (this.lists[x.list] ??= [])
        for (const it of x.items) if (!l.some((y) => y.toLowerCase() === it.toLowerCase())) l.push(it)
        this.saveLists()
        return `Added ${x.items.join(' and ')} to your ${x.list} list.`
      }
      case 'list_show': {
        const l = this.lists[x.list] ?? []
        return l.length ? `Your ${x.list} list: ${l.join(', ')}.` : `Your ${x.list} list is empty.`
      }
      case 'list_remove': {
        const l = this.lists[x.list] ?? []
        const i = l.findIndex((y) => y.toLowerCase() === x.item.toLowerCase()) ?? -1
        const j = i >= 0 ? i : l.findIndex((y) => y.toLowerCase().includes(x.item.toLowerCase()) || x.item.toLowerCase().includes(y.toLowerCase()))
        if (j < 0) return `${x.item} isn't on your ${x.list} list.`
        const [gone] = l.splice(j, 1)
        this.saveLists()
        return `Removed ${gone}.`
      }
      case 'list_clear': {
        this.lists[x.list] = []
        this.saveLists()
        return `Your ${x.list} list is cleared.`
      }
      case 'find_file':
        return this.findFile(x.query, x.open)
    }
  }

  /** Windows Search index first (instant), then a shallow walk of the usual folders */
  private async findFile(q: string, open: boolean): Promise<string | null> {
    const words = q.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter((w) => w.length > 1).slice(0, 4)
    if (!words.length) return null
    const home = app.getPath('home')
    const like = words.map((w) => `System.FileName LIKE '%${w.replace(/'/g, "''")}%'`).join(' AND ')
    const ps = `
$ErrorActionPreference='SilentlyContinue'
$out=@()
try {
  $c=New-Object -ComObject ADODB.Connection
  $c.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
  $rs=$c.Execute("SELECT TOP 8 System.ItemPathDisplay FROM SYSTEMINDEX WHERE ${like.replace(/"/g, '""')} AND SCOPE='file:${home.replace(/\\/g, '/').replace(/'/g, "''")}' ORDER BY System.DateModified DESC")
  while(-not $rs.EOF){ $out+=$rs.Fields.Item(0).Value; $rs.MoveNext() }
} catch {}
if(-not $out){
  $w=@(${words.map(psq).join(',')})
  $roots=@('Desktop','Documents','Downloads','OneDrive','Pictures') | % { Join-Path ${psq(home)} $_ } | ? { Test-Path $_ }
  $out=Get-ChildItem -Path $roots -Recurse -Depth 4 -ErrorAction SilentlyContinue | ? { $n=$_.Name; ($w | ? { $n -notlike "*$_*" }).Count -eq 0 } | Sort-Object LastWriteTime -Descending | Select-Object -First 8 -ExpandProperty FullName
}
$out -join "\`n"`
    const res = (await this.d.powershell(ps, 9000).catch(() => '')).split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[a-z]:\\/i.test(s))
    if (!res.length) return null
    const best = res.find((p) => !/\.lnk$/i.test(p) && !/\\AppData\\/i.test(p)) ?? res[0]
    const name = best.split('\\').pop()!
    if (open) await this.d.win.call('launch', { name: best, wait: 0 }, 12000).catch(() => this.d.powershell(`Start-Process ${psq(best)}`, 8000))
    else await this.d.powershell(`Start-Process explorer.exe -ArgumentList ${psq('/select,"' + best + '"')}`, 8000)
    return `${open ? 'Opening' : 'Found'} ${name}${res.length > 1 && !open ? ` (${res.length} matches; newest shown)` : ''}.`
  }

  dispose() {
    for (const t of this.timers.values()) clearTimeout(t)
  }
}

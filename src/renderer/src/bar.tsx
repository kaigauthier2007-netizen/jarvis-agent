// Jarvis's main interface: a small black bar at the top centre of the screen that opens into a compact panel.
// No animation library, no canvas, no timers while idle: CSS transitions only, and the 1 s clock runs only during a task.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowUp, ChevronUp, Download, History, Mic, MessageSquarePlus, Settings as Cog, Square, Trash2, Volume2, X, Check, Loader2, Wrench } from 'lucide-react'
import './bar.css'
import type { ChatItem, PermissionRequest, ThreadState } from '@shared/types'
import { Markdown } from './components/Markdown'
import { api, IPC } from './api'
import { bootstrap, useApp, useT } from './store'

// microphone capture + speech playback live in this always-present window (one renderer process for everything)
if (!new URLSearchParams(location.search).has('noaudio')) void import('./audio')

type View = 'chat' | 'history'
/** an open panel folds back into the bar after this long without use (never while working, asking or hovered) */
const AUTO_FOLD_MS = 45_000

function App() {
  const ready = useApp((s) => s.ready)
  useEffect(() => void bootstrap({ chat: true, lite: true }), [])
  if (!ready) return null
  return <Bar />
}

function Bar() {
  const status = useApp((s) => s.status)
  const settings = useApp((s) => s.settings)
  const chat = useApp((s) => s.chat)
  const perms = useApp((s) => s.permissions)
  const partial = useApp((s) => s.partial)
  const subtitle = useApp((s) => s.subtitle)
  const assets = useApp((s) => s.assets)
  const { t } = useT()

  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>('chat')
  const [draft, setDraft] = useState('')
  const [maxH, setMaxH] = useState(560)
  const [hover, setHover] = useState(false)
  const [focused, setFocused] = useState(document.hasFocus())
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const feed = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const busy = status.state === 'thinking' || status.state === 'speaking' || status.state === 'transcribing'
  const st = status.dictating ? 'dictating' : status.teaching ? 'teaching' : status.state

  // ---- the window is exactly as big as the bar: report every size change to the main process
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const report = () => api.send('bar:size', el.offsetWidth, el.offsetHeight, open)
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [open])

  // ---- main process → bar
  useEffect(() => {
    void api.invoke('bar:geom').then((g: any) => g?.maxHeight && setMaxH(g.maxHeight))
    const offs = [
      api.on('bar:geom', (g: any) => g?.maxHeight && setMaxH(g.maxHeight)),
      api.on('bar:open', (o: { focus?: boolean; view?: View }) => {
        setOpen(true)
        if (o?.view) setView(o.view)
        if (o?.focus) setTimeout(() => input.current?.focus(), 40)
      }),
      api.on('bar:hidden', () => {
        setOpen(false)
        setView('chat')
      })
    ]
    const onFocus = () => setFocused(true)
    const onBlur = () => setFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      offs.forEach((f) => f())
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // ---- answers expand downward: open the panel when Jarvis replies or asks something
  const lastId = useRef(chat[chat.length - 1]?.id)
  useEffect(() => {
    const last = chat[chat.length - 1]
    if (!last || last.id === lastId.current) return
    lastId.current = last.id
    if (last.kind === 'assistant' && last.text.trim()) setOpen(true)
  }, [chat])
  useEffect(() => {
    if (perms.length) setOpen(true)
  }, [perms.length])

  // ---- fold the panel back after a while unused (not while working, asking, hovered, focused or typing)
  useEffect(() => {
    if (!open || hover || focused || busy || st === 'listening' || st === 'wake' || perms.length || draft) return
    const id = setTimeout(() => setOpen(false), AUTO_FOLD_MS)
    return () => clearTimeout(id)
  }, [open, hover, focused, busy, st, perms.length, draft, chat.length])

  // ---- keep the conversation scrolled to the newest message
  useEffect(() => {
    const el = feed.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [chat, perms.length, open, view])

  // ---- Esc: stop what Jarvis is doing; with nothing to stop, hide the bar
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (busy || st === 'listening' || st === 'wake') void api.invoke(IPC.abort)
      else hide()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, st])

  const hide = () => {
    setOpen(false)
    setView('chat')
    api.send(IPC.window, 'bar-hide')
  }
  const submit = () => {
    const v = draft.trim()
    if (!v) return
    setDraft('')
    setView('chat')
    stick.current = true
    void api.invoke(IPC.sendText, v)
  }
  const stop = () => void api.invoke(IPC.abort)
  const mic = () => void api.invoke(IPC.toggleListen)

  // ---- what the bar says
  const labels: Record<string, string> = {
    idle: 'Jarvis',
    wake: t('state.wake'),
    listening: t('state.listening'),
    transcribing: t('state.transcribing'),
    thinking: t('state.thinking'),
    speaking: t('state.speaking'),
    error: t('state.error'),
    dictating: 'Dictating · release Right Alt',
    teaching: 'Your turn'
  }
  const live = st === 'listening' || st === 'wake' ? partial : ''
  const said = settings.showSubtitles && st === 'speaking' ? subtitle : ''
  const detail = status.flash || status.teaching || live || said || (st === 'thinking' ? status.activity || '' : '')
  const setupNeeded = status.speech === 'missing-models' || assets.some((a) => a.required && !a.installed)

  const head = (
    <div className="b-head" onClick={() => !open && setOpen(true)}>
      <span className={`b-eye s-${st}` + (!settings.wakeEnabled && st === 'idle' ? ' hollow' : '')} />
      {(st === 'listening' || st === 'wake' || st === 'speaking' || st === 'dictating') && (
        <span className="b-bars" aria-hidden>
          <i />
          <i />
          <i />
          <i />
        </span>
      )}
      {(st === 'thinking' || st === 'transcribing') && <Loader2 size={13} className="b-spin" />}
      <span className="b-label">
        <b className={st === 'idle' ? 'dim' : ''}>{labels[st] ?? st}</b>
        {detail && <span className="b-detail">{detail}</span>}
      </span>
      {!open && busy && (
        <button className="b-icon stop" title="Stop (Esc)" onClick={(e) => (e.stopPropagation(), stop())}>
          <Square size={11} fill="currentColor" />
        </button>
      )}
      {open && (
        <span className="b-tools" onClick={(e) => e.stopPropagation()}>
          <button className={'b-icon' + (view === 'history' ? ' on' : '')} title="Chat history" onClick={() => setView(view === 'history' ? 'chat' : 'history')}>
            <History size={15} />
          </button>
          <button className="b-icon" title="New chat" onClick={() => (setView('chat'), void api.invoke(IPC.threadNew))}>
            <MessageSquarePlus size={15} />
          </button>
          <button className="b-icon" title="Settings" onClick={() => api.send(IPC.window, 'settings')}>
            <Cog size={15} />
          </button>
          <button className="b-icon" title="Fold up" onClick={() => setOpen(false)}>
            <ChevronUp size={16} />
          </button>
          <button className="b-icon" title="Hide (Esc) · Jarvis keeps listening" onClick={hide}>
            <X size={15} />
          </button>
        </span>
      )}
    </div>
  )

  if (!open)
    return (
      <div ref={root} className={`bar mini s-${st}`} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} title="Jarvis · click to open">
        {head}
      </div>
    )

  return (
    <div ref={root} className={`bar open s-${st}`} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {head}
      <div className="b-input">
        <button className={'b-icon mic' + (st === 'listening' || st === 'wake' ? ' live' : '')} title={st === 'listening' ? 'Stop listening' : 'Speak'} onClick={mic}>
          <Mic size={16} />
        </button>
        <input
          ref={input}
          value={draft}
          placeholder="Ask Jarvis…"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
        {busy ? (
          <button className="b-icon stop big" title="Stop (Esc)" onClick={stop}>
            <Square size={12} fill="currentColor" />
          </button>
        ) : (
          <button className="b-icon send big" title="Send" disabled={!draft.trim()} onClick={submit}>
            <ArrowUp size={16} />
          </button>
        )}
      </div>
      <div
        className="b-body"
        ref={feed}
        style={{ maxHeight: Math.max(160, maxH - 120) }}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
      >
        {view === 'history' ? <HistoryList onPick={() => setView('chat')} /> : <Conversation chat={chat} onTry={(q) => void api.invoke(IPC.sendText, q)} />}
        {status.steps?.length && busy ? <LiveSteps steps={status.steps} started={status.turnStartedAt} /> : null}
        {perms.map((r) => (
          <PermCard key={r.id} r={r} />
        ))}
      </div>
      <div className="b-foot">
        <span className="chip">{(settings.model.split('/')[1] || settings.model || 'agent').slice(0, 28)}</span>
        <button className={'chip' + (settings.wakeEnabled ? ' ok' : '')} title="Wake word on/off (off = hotkey only)" onClick={() => void useApp.getState().patchSettings({ wakeEnabled: !settings.wakeEnabled })}>
          {settings.wakeEnabled ? `“${settings.wakePhrases[0] ?? 'jarvis'}”` : 'hotkey only'}
        </button>
        <span className="chip">{settings.hotkey.replace('Control', 'Ctrl')}</span>
        {setupNeeded && (
          <button className="chip warn" onClick={() => api.send(IPC.window, 'settings')}>
            <Download size={11} /> setup needed
          </button>
        )}
        {status.controlling && <span className="chip warn">controlling PC · Ctrl+Alt+K stops</span>}
      </div>
    </div>
  )
}

/** The current conversation: your requests, Jarvis's answers, and each task's steps folded into one line. */
function Conversation({ chat, onTry }: { chat: ChatItem[]; onTry: (q: string) => void }) {
  const items = chat.filter((c) => c.kind !== 'thinking').slice(-60)
  if (!items.length)
    return (
      <div className="b-empty">
        <div>Ask anything, or try:</div>
        <div className="b-tries">
          {["What's on my screen?", "What's due on Canvas this week?", "What's on my calendar today?", 'Show me how to insert a picture in Word'].map((q) => (
            <button key={q} onClick={() => onTry(q)}>
              {q}
            </button>
          ))}
        </div>
      </div>
    )
  // group runs of tool calls so a 12-step task is one line, not 12 cards
  const groups: (ChatItem | ChatItem[])[] = []
  type Sys = Extract<ChatItem, { kind: 'system' }> & { n?: number }
  const isSwitch = (it: ChatItem | ChatItem[] | undefined): it is Sys => !!it && !Array.isArray(it) && it.kind === 'system' && it.text.startsWith('↻')
  for (const it of items) {
    const prev = groups[groups.length - 1]
    if (it.kind === 'tool' && Array.isArray(prev)) prev.push(it)
    else if (isSwitch(it) && isSwitch(prev)) {
      // several model fallbacks in a row → one line naming the model that finally answered
      const to = /“([^”]+)”|"([^"]+)" and retrying|«([^»]+)» и повторяю/.exec(it.text)
      const n = (prev.n || 1) + 1
      const target = to ? to[2] || to[3] || to[1] : ''
      groups[groups.length - 1] = { ...prev, text: `↻ ${n} models were out — now using "${target}".`, n } as Sys
    } else groups.push(it.kind === 'tool' ? [it] : it)
  }
  return (
    <>
      {groups.map((g) => (Array.isArray(g) ? <Steps key={g[0].id} items={g} /> : <Msg key={g.id} item={g} />))}
    </>
  )
}

function Msg({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return <div className="m user">{item.text}</div>
    case 'assistant':
      if (!item.text.trim()) return null
      return (
        <div className="m jarvis">
          <Markdown text={item.text} />
          {!item.done && <span className="caret" />}
        </div>
      )
    case 'say':
      return (
        <div className="m say">
          <Volume2 size={12} /> {item.text}
        </div>
      )
    case 'system':
      return <div className="m sys">{item.text}</div>
    default:
      return null
  }
}

function Steps({ items }: { items: ChatItem[] }) {
  const [open, setOpen] = useState(false)
  const tools = items.filter((i): i is Extract<ChatItem, { kind: 'tool' }> => i.kind === 'tool').map((i) => i.tool)
  const running = tools.some((x) => x.status === 'running' || x.status === 'pending')
  const failed = tools.filter((x) => x.status === 'error').length
  const last = tools[tools.length - 1]
  const name = (x: (typeof tools)[number]) => x.tool.replace(/^jarvis_/, '').replace(/_/g, ' ')
  return (
    <div className="m steps">
      <button onClick={() => setOpen(!open)}>
        {running ? <Loader2 size={12} className="b-spin" /> : <Wrench size={12} />}
        <span>
          {tools.length} step{tools.length === 1 ? '' : 's'}
          {failed ? ` · ${failed} failed` : ''} · {name(last)}
          {last.title ? ` — ${last.title}` : ''}
        </span>
      </button>
      {open && (
        <ol>
          {tools.map((x) => (
            <li key={x.id} className={x.status}>
              {x.status === 'error' ? <X size={11} /> : x.status === 'completed' ? <Check size={11} /> : <Loader2 size={11} className="b-spin" />}
              <b>{name(x)}</b>
              <span>{x.title || ''}</span>
              <em>{x.ms ? (x.ms / 1000).toFixed(1) + 's' : ''}</em>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

/** "What Jarvis is doing right now", with elapsed seconds (the 1 s clock only exists while a task runs). */
function LiveSteps({ steps, started }: { steps: NonNullable<ReturnType<typeof useApp.getState>['status']['steps']>; started?: number }) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!started) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [started])
  const secs = started ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0
  const s = steps[steps.length - 1]
  return (
    <div className="m live">
      <Loader2 size={12} className="b-spin" />
      <span>{s?.label}</span>
      <em>{secs}s</em>
    </div>
  )
}

function HistoryList({ onPick }: { onPick: () => void }) {
  const ts: ThreadState = useApp((s) => s.threads)
  const when = (ms: number) => {
    const m = Math.round((Date.now() - ms) / 60000)
    if (m < 1) return 'now'
    if (m < 60) return m + 'm'
    if (m < 1440) return Math.round(m / 60) + 'h'
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  }
  return (
    <div className="b-history">
      <div className="b-history-head">
        <span>Chat history</span>
        <button className="chip" title="Save this chat as a file in Documents\Jarvis" onClick={() => (void api.invoke(IPC.sendText, 'export this chat'), onPick())}>
          <Download size={11} /> export current
        </button>
      </div>
      {ts.threads.length === 0 && <div className="m sys">No chats yet.</div>}
      {ts.threads.map((th) => (
        <div
          key={th.id}
          className={'b-thread' + (th.id === ts.currentId ? ' on' : '')}
          onClick={() => {
            void api.invoke(IPC.threadSwitch, th.id)
            onPick()
          }}
        >
          <span className="tt">{th.title || 'New chat'}</span>
          <small>{when(th.updatedAt)}</small>
          <button
            className="b-icon"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation()
              void api.invoke(IPC.threadDelete, th.id)
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}

/** Approvals and questions from Jarvis: answered right in the bar. */
function PermCard({ r }: { r: PermissionRequest }) {
  const [answer, setAnswer] = useState('')
  const reply = (a: any) => {
    void api.invoke(IPC.permissionReply, r.id, a)
    useApp.setState((s) => ({ permissions: s.permissions.filter((p) => p.id !== r.id) }))
  }
  return (
    <div className="m perm">
      <div className="pt">{r.kind === 'question' ? 'Jarvis asks' : 'Allow this?'}</div>
      <div className="pq">{r.title}</div>
      {r.detail && <code>{r.detail}</code>}
      {r.hint && <div className="ph">{r.hint}</div>}
      {r.kind === 'permission' ? (
        <div className="pb">
          <button className="primary" onClick={() => reply('once')}>
            Allow
          </button>
          {!r.id.startsWith('ctl-') && <button onClick={() => reply('always')}>Always</button>}
          <button className="danger" onClick={() => reply('reject')}>
            Deny
          </button>
        </div>
      ) : (
        <>
          {r.options && r.options.length > 0 && (
            <div className="pb">
              {r.options.map((o) => (
                <button key={o} onClick={() => reply(r.id.startsWith('ask-') ? o : [o])}>
                  {o}
                </button>
              ))}
            </div>
          )}
          <input
            className="pa"
            placeholder="Type an answer…"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && answer.trim() && reply(r.id.startsWith('ask-') ? answer : [answer])}
          />
        </>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)

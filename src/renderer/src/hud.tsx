import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AnimatePresence, motion } from 'framer-motion'
import './styles.css'
import { Orb } from './components/Orb'
import { PermissionStack } from './components/Overlays'
import { api, IPC } from './api'
import { bootstrap, useApp, useT } from './store'
import { applyTheme } from './theme'
// microphone capture + speech playback live in this always-present window
if (!new URLSearchParams(location.search).has('noaudio')) void import('./audio')

function Hud() {
  const ready = useApp((s) => s.ready)
  const settings = useApp((s) => s.settings)
  useEffect(() => void bootstrap(), [])
  useEffect(() => applyTheme(settings.accent, settings.theme), [settings.accent, settings.theme])
  if (!ready) return null
  return settings.hudStyle === 'orb' ? <OrbHud /> : <PillHud />
}

/** Nixi-style black bar at the top of the screen. Completely still while idle (no animation frames, no timers). */
function PillHud() {
  const status = useApp((s) => s.status)
  const settings = useApp((s) => s.settings)
  const subtitle = useApp((s) => s.subtitle)
  const partial = useApp((s) => s.partial)
  const perms = useApp((s) => s.permissions)
  const { t } = useT()
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(
    () =>
      api.on('hud:type', (on: boolean) => {
        setTyping(on)
        if (on) setTimeout(() => input.current?.focus(), 30)
        else setDraft('')
      }),
    []
  )

  const st = status.dictating ? 'dictating' : status.teaching ? 'teaching' : status.state
  const live = status.state === 'listening' || status.state === 'wake' ? partial : ''
  const subs = settings.showSubtitles
  const text = status.flash || status.teaching || (subs ? subtitle || live : '') || (status.state === 'thinking' ? status.activity || '' : '')
  const label: Record<string, string> = {
    wake: t('state.wake'),
    listening: t('state.listening'),
    transcribing: t('state.transcribing'),
    thinking: t('state.thinking'),
    error: t('state.error'),
    dictating: 'Dictating · release Right Alt',
    teaching: 'Your turn'
  }
  const open = typing || st !== 'idle' || !!text || perms.length > 0
  const hotkeyOnly = !settings.wakeEnabled

  const submit = () => {
    const v = draft.trim()
    setDraft('')
    api.send(IPC.window, 'hud-type-done')
    if (v) void api.invoke(IPC.sendText, v)
  }

  return (
    <div className="pill-root">
      <motion.div
        layout
        transition={{ type: 'spring', stiffness: 520, damping: 40 }}
        className={`pill s-${st}${open ? ' open' : ''}${typing ? ' typing' : ''}`}
        onMouseEnter={() => api.send(IPC.window, 'hud-interactive')}
        onMouseLeave={() => !typing && api.send(IPC.window, 'hud-passthrough')}
        onClick={() => !typing && api.send(IPC.window, 'showMain')}
        title={typing ? '' : 'Jarvis · click to open'}
      >
        <span className={'eye' + (hotkeyOnly && st === 'idle' ? ' hollow' : '')} />
        {(st === 'listening' || st === 'wake' || st === 'speaking' || st === 'dictating') && (
          <span className="bars" aria-hidden>
            <i />
            <i />
            <i />
            <i />
          </span>
        )}
        {typing ? (
          <input
            ref={input}
            className="pill-input"
            value={draft}
            placeholder="Ask Jarvis…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') {
                setDraft('')
                api.send(IPC.window, 'hud-type-done')
              }
            }}
            onBlur={() => api.send(IPC.window, 'hud-type-done')}
          />
        ) : (
          open && (
            <span className="pill-text">
              {label[st] && !text ? <b>{label[st]}</b> : null}
              {text ? <span className={subtitle && text === subtitle ? '' : 'dim'}>{text}</span> : null}
            </span>
          )
        )}
      </motion.div>
      {perms.length > 0 && (
        <div className="pill-perms" onMouseEnter={() => api.send(IPC.window, 'hud-interactive')}>
          <PermissionStack inline />
        </div>
      )}
    </div>
  )
}

/** The classic glowing orb in a corner (Settings → Appearance → On-screen style). */
function OrbHud() {
  const status = useApp((s) => s.status)
  const settings = useApp((s) => s.settings)
  const subtitle = useApp((s) => s.subtitle)
  const partial = useApp((s) => s.partial)
  const { t } = useT()

  const active = status.state !== 'idle'
  const live = status.state === 'listening' || status.state === 'wake' ? partial : ''
  const act = status.state === 'thinking' && status.activity ? '⚙ ' + status.activity : ''
  const text = status.flash || (settings.showSubtitles ? subtitle || live || act : '')
  const right = settings.hudCorner.endsWith('r')
  return (
    <div className="hud-root" style={{ alignItems: right ? 'flex-end' : 'flex-start', justifyContent: settings.hudCorner.startsWith('b') ? 'flex-end' : 'flex-start', flexDirection: settings.hudCorner.startsWith('b') ? 'column' : 'column-reverse' }}>
      <PermissionStack inline />
      <AnimatePresence>
        {text && (
          <motion.div key={text} className={'hud-sub' + (subtitle ? '' : ' live')} initial={{ opacity: 0, y: 10, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.25 }}>
            {text}
          </motion.div>
        )}
      </AnimatePresence>
      <div style={{ display: 'flex', alignItems: 'center', flexDirection: right ? 'row' : 'row-reverse' }}>
        <AnimatePresence>
          {active && (
            <motion.div className="hud-state" initial={{ opacity: 0, x: right ? 10 : -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} style={{ marginRight: right ? 14 : 0, marginLeft: right ? 0 : 14 }}>
              {t('state.' + status.state)}
            </motion.div>
          )}
        </AnimatePresence>
        <motion.div
          className="hud-orb"
          animate={{ scale: active ? 1 : 0.62, opacity: active ? 1 : 0.92 }}
          transition={{ type: 'spring', stiffness: 220, damping: 22 }}
          style={{ transformOrigin: right ? 'bottom right' : 'bottom left' }}
          onMouseEnter={() => api.send(IPC.window, 'hud-interactive')}
          onMouseLeave={() => api.send(IPC.window, 'hud-passthrough')}
          onClick={() => api.send(IPC.window, 'showMain')}
        >
          <Orb state={status.state} size={150} accent={settings.accent} compact />
        </motion.div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Hud />)

import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, session, shell, Tray, desktopCapturer, net } from 'electron'
import { join } from 'path'
import { existsSync, writeFileSync } from 'fs'
import { IPC, DEFAULT_SETTINGS, type Settings, type SetupProgress } from '../shared/types'
import { Assistant } from './assistant'
import { dataDir } from './store'
import { listAssets, installAsset } from './models'
import { rendererUrl, preloadPath, resourcePath } from './paths'
import { initLogging, logDir } from './log'
import { Updater } from './updater'

// promo capture / tests: run with a throw-away profile so the real data is never touched
if (process.env.JARVIS_USERDATA) app.setPath('userData', process.env.JARVIS_USERDATA)
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}
app.setName('Jarvis')
initLogging()
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.commandLine.appendSwitch('js-flags', '--expose-gc') // lets the speech worker hand model memory back when idle
// memory: network and audio services run inside the main process instead of two extra processes.
// (No process-per-site: sharing one renderer between the opaque main window and the transparent HUD / overlay makes
// those windows paint an opaque background on Windows — the whole screen went dark during computer use.)
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess')
app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess,SpareRendererForSitePerProcess,CalculateNativeWinOcclusion')

let assistant: Assistant
/** The bar at the top of the screen: Jarvis's only always-present window. It also hosts the microphone and speech playback. */
let barWin: BrowserWindow | null = null
/** Settings / Commands / Memory: created only when asked for, destroyed when closed (its memory is freed). */
let settingsWin: BrowserWindow | null = null
let tray: Tray | null = null
let updateWin: BrowserWindow | null = null
/** small frameless Jarvis-styled window for updates (replaces system dialogs) */
function showUpdateWindow() {
  if (updateWin && !updateWin.isDestroyed()) {
    updateWin.show()
    updateWin.focus()
    return
  }
  updateWin = new BrowserWindow({
    width: 560,
    height: 300,
    useContentSize: true,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    skipTaskbar: true,
    // transparent so only the rounded card is drawn (an opaque frameless window has square corners)
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    title: 'Jarvis',
    icon: resourcePath('icon.png'),
    webPreferences: { preload: preloadPath(), sandbox: false }
  })
  void updateWin.loadURL(rendererUrl('update.html'))
  updateWin.once('ready-to-show', () => updateWin?.show())
  updateWin.on('closed', () => (updateWin = null))
}
const updater = new Updater({ show: showUpdateWindow })
let quitting = false

const all = () => [barWin, settingsWin, updateWin].filter((w): w is BrowserWindow => !!w && !w.isDestroyed())
const broadcast = (ch: string, ...args: unknown[]) => all().forEach((w) => w.webContents.send(ch, ...args))
const toUi = (ch: string, ...args: unknown[]) => [barWin, settingsWin].forEach((w) => w && !w.isDestroyed() && w.webContents.send(ch, ...args))
const toBar = (ch: string, ...args: unknown[]) => barWin && !barWin.isDestroyed() && barWin.webContents.send(ch, ...args)

function iconImage() {
  const p = resourcePath('icon.png')
  return existsSync(p) ? nativeImage.createFromPath(p) : nativeImage.createEmpty()
}

// ---------------------------------------------------------------- Settings window (on demand)
function openSettings(page: 'settings' | 'routines' | 'memory' = 'settings') {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('app:page', page)
    if (settingsWin.isMinimized()) settingsWin.restore()
    settingsWin.show()
    settingsWin.focus()
    return
  }
  const promo = !!process.env.JARVIS_PROMO // off-screen rendering for the promo video (src/main/promo.ts)
  settingsWin = new BrowserWindow({
    width: promo ? 1080 : 1000,
    height: promo ? 1920 : 720,
    useContentSize: promo,
    minWidth: 760,
    minHeight: 540,
    show: false,
    frame: false,
    skipTaskbar: true, // Jarvis has no taskbar button; the tray icon and the bar reopen this window
    backgroundColor: '#05080d',
    title: 'Jarvis settings',
    icon: iconImage(),
    webPreferences: { preload: preloadPath(), offscreen: promo }
  })
  settingsWin.once('ready-to-show', () => {
    settingsWin?.show()
    settingsWin?.focus()
  })
  // closing it really closes it: nothing of the old dashboard stays loaded in the background
  settingsWin.on('closed', () => (settingsWin = null))
  settingsWin.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  void settingsWin.loadURL(rendererUrl('index.html', '?page=' + page))
}

// ---------------------------------------------------------------- the bar
/** The window is always exactly the size of what is drawn, so it never blocks clicks beside the bar. */
let barSize = { width: 210, height: 34 }
let barExpanded = false
function barBounds() {
  const wa = screen.getPrimaryDisplay().workArea
  const width = Math.min(barSize.width, wa.width - 20)
  const height = Math.min(barSize.height, wa.height - 20)
  return { x: Math.round(wa.x + (wa.width - width) / 2), y: wa.y, width, height }
}
function placeBar() {
  if (!barWin || barWin.isDestroyed()) return
  const b = barBounds()
  const cur = barWin.getBounds()
  if (cur.x !== b.x || cur.y !== b.y || cur.width !== b.width || cur.height !== b.height) barWin.setBounds(b)
}
function barGeometry() {
  const wa = screen.getPrimaryDisplay().workArea
  return { maxHeight: Math.max(240, Math.round(wa.height * 0.72)), maxWidth: wa.width - 20 }
}

function createBar(showNow: boolean) {
  barWin = new BrowserWindow({
    ...barBounds(),
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true, // no taskbar button
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: 'Jarvis',
    icon: iconImage(),
    // the bar hosts the microphone (wake word) and the voice: it must keep running while hidden
    webPreferences: { preload: preloadPath(), backgroundThrottling: false }
  })
  barWin.setAlwaysOnTop(true, 'screen-saver')
  barWin.setContentProtection(true) // never in screenshots / screen shares (nor in Jarvis's own screen reading)
  barWin.once('ready-to-show', () => {
    if (showNow) showBar()
  })
  // closing (Alt+F4) only hides it: Quit lives in the tray
  barWin.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    hideBar()
  })
  barWin.on('closed', () => (barWin = null))
  barWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  barWin.webContents.on('will-navigate', (e, url) => {
    e.preventDefault()
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed'] as const)
    screen.on(ev as any, () => {
      placeBar()
      toBar('bar:geom', barGeometry())
    })
  void barWin.loadURL(rendererUrl('bar.html') + (process.env.JARVIS_PROMO ? '?noaudio=1' : ''))
}

/** Show the bar without taking keyboard focus (the app you were in keeps it). */
function showBar(opts: { expand?: boolean; focus?: boolean; view?: 'chat' | 'history' } = {}) {
  if (!barWin || barWin.isDestroyed()) return
  placeBar()
  if (opts.expand || opts.focus || opts.view) toBar('bar:open', { focus: !!opts.focus, view: opts.view })
  if (opts.focus) {
    barWin.show()
    barWin.focus()
    barWin.webContents.focus()
  } else if (!barWin.isVisible()) barWin.showInactive()
  // Windows drops TOPMOST when another topmost window (video player, game overlay) is raised: re-assert on every reveal
  barWin.setAlwaysOnTop(true, 'screen-saver')
  barWin.moveTop()
}

/** Hide = Jarvis keeps running (wake word, hotkeys, tray); Quit in the tray ends everything. */
function hideBar() {
  if (!barWin || barWin.isDestroyed()) return
  toBar('bar:hidden')
  if (barWin.isFocused()) barWin.blur()
  barWin.hide()
}

function toggleBar() {
  if (barWin?.isVisible()) hideBar()
  else showBar()
}

function registerHotkey() {
  globalShortcut.unregisterAll()
  globalShortcut.register('Control+Alt+K', () => assistant.emergencyStop())
  // fallback for when the key helper can't run (it handles the plain Ctrl+Shift tap)
  if (assistant.settings().quickTypeEnabled) globalShortcut.register('Control+Shift+Space', () => showBar({ expand: true, focus: true }))
  const key = assistant.settings().hotkey
  if (!key) return
  try {
    if (!globalShortcut.register(key, () => assistant.toggleListen())) console.warn('hotkey busy', key)
  } catch (e) {
    console.warn('bad hotkey', key, e)
  }
}

function applyAutoStart() {
  app.setLoginItemSettings({ openAtLogin: assistant.settings().autoStart, args: ['--hidden'] })
}

function quitJarvis() {
  quitting = true
  app.quit()
}

function buildTray() {
  tray = new Tray(iconImage().resize({ width: 16, height: 16 }))
  tray.setToolTip('Jarvis')
  const menu = () =>
    Menu.buildFromTemplate([
      { label: 'Show Jarvis', click: () => showBar({ expand: true }) },
      { label: 'Hide Jarvis', click: hideBar },
      { label: 'Listen now', click: () => assistant.toggleListen() },
      { label: 'Chat history', click: () => showBar({ view: 'history', focus: true }) },
      {
        label: 'Wake word active',
        type: 'checkbox',
        checked: assistant.settings().wakeEnabled,
        click: (m) => applySettings({ wakeEnabled: m.checked })
      },
      { type: 'separator' },
      { label: 'Settings', click: () => openSettings('settings') },
      { type: 'separator' },
      { label: 'Quit Jarvis', click: quitJarvis }
    ])
  tray.setContextMenu(menu())
  tray.on('click', toggleBar)
  assistant.settingsStore.on('change', () => tray?.setContextMenu(menu()))
}

function applySettings(patch: Partial<Settings>) {
  const before = assistant.settings()
  // picking a model by hand makes it the new choice: forget any temporary fallback
  if (patch.model !== undefined && patch.primaryModel === undefined) patch = { ...patch, primaryModel: '' }
  const next = assistant.settingsStore.set(patch)
  broadcast(IPC.settingsChanged, next)
  if (patch.sttModel && patch.sttModel !== before.sttModel) assistant.speech.restart()
  else if ('wakePhrases' in patch || 'wakeSensitivity' in patch || 'wakeEnabled' in patch || 'sttLanguage' in patch || 'speechPatience' in patch) assistant.speech.updateConfig()
  if (patch.apiKey !== undefined && patch.apiKey !== before.apiKey) void assistant.opencode.applyAuth().then(() => assistant.opencode.listModels(true))
  if ((patch.permissionMode && patch.permissionMode !== before.permissionMode) || (patch.cwd !== undefined && patch.cwd !== before.cwd) || (patch.customProvider && JSON.stringify(patch.customProvider) !== JSON.stringify(before.customProvider)) || (patch.connectors && JSON.stringify(patch.connectors) !== JSON.stringify(before.connectors)) || (patch.openrouterKey !== undefined && patch.openrouterKey !== before.openrouterKey) || (patch.browserControl !== undefined && patch.browserControl !== before.browserControl) || (patch.browserChannel !== undefined && patch.browserChannel !== before.browserChannel) || (patch.browserToken !== undefined && patch.browserToken !== before.browserToken))
    void assistant.opencode.restart()
  if (patch.autoUpdate) updater.setMode(patch.autoUpdate)
  if (patch.hotkey !== undefined) registerHotkey()
  if (patch.autoStart !== undefined) applyAutoStart()
  if (patch.quickTypeEnabled !== undefined) registerHotkey()
  if (patch.cloneIdleMinutes !== undefined) assistant.xtts.idleMinutes = patch.cloneIdleMinutes
  if ('fishApiKey' in patch || 'fishVoiceRu' in patch || 'fishVoiceEn' in patch || 'fishModel' in patch) {
    assistant.resetFishState()
    assistant.prewarmVoices()
  }
  if (patch.voiceRu || patch.voiceEn) assistant.prewarmVoices()
  assistant.emitStatus()
  return next
}

function wireIpc() {
  ipcMain.handle(IPC.settingsGet, () => assistant.settings())
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<Settings>) => applySettings(patch))
  ipcMain.handle('status:get', () => assistant.status())
  ipcMain.handle(IPC.chatHistory, () => assistant.opencode.history())
  ipcMain.handle(IPC.sendText, (_e, text: string) => assistant.handleCommand(text, 'text'))
  ipcMain.handle(IPC.abort, () => assistant.abortTask())
  ipcMain.handle(IPC.chatReset, () => assistant.opencode.newThread())
  ipcMain.handle(IPC.threads, () => assistant.threads.state())
  ipcMain.handle(IPC.threadNew, () => assistant.opencode.newThread())
  ipcMain.handle(IPC.threadSwitch, (_e, id: string) => assistant.opencode.switchThread(id))
  ipcMain.handle(IPC.threadDelete, (_e, id: string) => assistant.opencode.deleteThread(id))
  ipcMain.handle(IPC.threadRename, (_e, id: string, title: string) => assistant.threads.rename(id, title))
  ipcMain.handle(IPC.models, (_e, fetchAll: boolean) => assistant.opencode.listModels(fetchAll))
  ipcMain.handle(IPC.permissionReply, (_e, id: string, answer: any) => {
    toUi(IPC.permissionClose, id) // answered here → close the mirrored card in the other window too
    return assistant.replyPermission(id, answer)
  })
  ipcMain.handle(IPC.toggleListen, () => assistant.toggleListen())

  ipcMain.handle(IPC.modelAssets, () => listAssets(dataDir()))
  ipcMain.handle(IPC.modelDownload, (_e, ids: string[]) => installAssets(ids))

  ipcMain.handle(IPC.routines, () => assistant.routines.list())
  ipcMain.handle(IPC.routinesSave, (_e, r) => assistant.routines.save1(r))
  ipcMain.handle(IPC.routinesDelete, (_e, id: string) => assistant.routines.delete(id))
  ipcMain.handle(IPC.routinesRun, (_e, id: string) => {
    const r = assistant.routines.get(id)
    return r ? assistant.runRoutine(r) : 'not found'
  })
  ipcMain.handle(IPC.memory, () => assistant.memory.list())
  ipcMain.handle(IPC.memoryAdd, (_e, text: string) => assistant.memory.add(text, [], false))
  ipcMain.handle(IPC.memoryDelete, (_e, id: string) => assistant.memory.delete(id))
  ipcMain.handle(IPC.memoryPin, (_e, id: string, pinned: boolean) => assistant.memory.pin(id, pinned))

  ipcMain.handle(IPC.openPath, (_e, p: string) => shell.openPath(p))
  ipcMain.handle('app:dataDir', () => dataDir())
  ipcMain.handle('app:openLogs', () => shell.openPath(logDir()))
  // only ever opens plain https links (key pages) in the user's browser
  ipcMain.handle('app:openUrl', (_e, url: string) => (/^https:\/\//.test(String(url)) ? shell.openExternal(url) : undefined))
  ipcMain.handle('update:state', () => updater.state)
  ipcMain.handle('update:close', () => updateWin?.close())
  ipcMain.handle('update:check', () => updater.check(false))
  ipcMain.handle('update:download', () => updater.download())
  ipcMain.handle('update:install', () => updater.install())
  ipcMain.handle('agent:wake', () => assistant.opencode.wake())
  ipcMain.handle('connectors:status', () => assistant.opencode.mcpStatus())
  ipcMain.handle('connectors:auth', (_e, id: string) => assistant.opencode.mcpAuthenticate(String(id)))
  ipcMain.handle('connectors:reconnect', async (_e, id: string) => {
    await assistant.opencode.mcpReconnect(String(id))
    return assistant.opencode.mcpStatus()
  })
  ipcMain.handle('connectors:signout', async (_e, id: string) => {
    await assistant.opencode.mcpSignOut(String(id))
    return assistant.opencode.mcpStatus()
  })
  ipcMain.handle('voice:serverHealth', async () => {
    try {
      const base = (assistant.settings().ttsServerUrl || DEFAULT_SETTINGS.ttsServerUrl).replace(/\/+$/, '')
      const r = await net.fetch(base + '/api/health', { signal: AbortSignal.timeout(8000) })
      return await r.json()
    } catch (e: any) {
      return { ok: false, notice: '' }
    }
  })
  ipcMain.handle('providers:list', async () => {
    await assistant.opencode.wake()
    return assistant.opencode.providers()
  })
  ipcMain.handle('providers:connect', async (_e, id: string, key: string) => {
    await assistant.opencode.connectProvider(id, key)
    // the OpenRouter fast-model entry is only added to the engine config once a key exists (else it looks "connected")
    if (id === 'openrouter' && !assistant.settings().openrouterKey) applySettings({ openrouterKey: true })
    return true
  })
  ipcMain.handle('providers:disconnect', async (_e, id: string) => {
    await assistant.opencode.disconnectProvider(id)
    if (id === 'openrouter' && assistant.settings().openrouterKey) applySettings({ openrouterKey: false })
    return true
  })
  ipcMain.handle('app:info', () => {
    const st = assistant.status()
    const mem = process.memoryUsage()
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      platform: `${process.platform} ${process.arch}`,
      dataDir: dataDir(),
      logDir: logDir(),
      status: st,
      model: assistant.settings().model,
      assets: listAssets(dataDir()).filter((a) => a.installed).map((a) => a.id),
      cloneAvailable: assistant.xtts.available(),
      asrLoaded: assistant.speech.asrLoaded,
      mainRssMB: Math.round(mem.rss / 1048576)
    }
  })
  ipcMain.handle(IPC.captureForUi, async () => {
    const img = await (settingsWin ?? barWin)?.webContents.capturePage()
    return img?.toPNG()
  })
  ipcMain.handle('voice:extra', () => {
    const s = assistant.settings()
    const out: { id: string; name: string; lang: 'ru' | 'en' | 'both' }[] = []
    if (s.fishApiKey) out.push({ id: 'fish:ru', name: 'Fish Audio — Jarvis (RU, cloud)', lang: 'ru' })
    if (s.fishApiKey) out.push({ id: 'fish:en', name: 'Fish Audio — Jarvis (EN, cloud)', lang: 'en' })
    if (assistant.xtts.available()) out.push({ id: 'xtts:jarvis', name: 'Jarvis — cloned from your clips (local GPU, RU + EN)', lang: 'both' })
    return out
  })
  ipcMain.handle('voice:preview', async (_e, text: string, voice: string) => {
    const lang = /[а-яё]/i.test(text) ? 'ru' : 'en'
    const wav = await assistant.tts.synth(text, voice, assistant.settings().voiceSpeed, lang)
    toUi('noop')
    toBar(IPC.ttsPlay, { id: 'preview-' + Date.now(), wav, fx: assistant.settings().voiceFx, volume: assistant.settings().voiceVolume })
  })
  ipcMain.handle('ocr:langs', async () => {
    try {
      return await assistant.powershell(
        "Add-Type -AssemblyName System.Runtime.WindowsRuntime; [void][Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]; ([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }) -join ','"
      )
    } catch {
      return ''
    }
  })

  ipcMain.on(IPC.window, (e, action: string) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w) return
    if (action === 'minimize') w.minimize()
    else if (action === 'maximize') (w.isMaximized() ? w.unmaximize() : w.maximize())
    else if (action === 'close') w.close()
    else if (action === 'settings') openSettings('settings')
    else if (action === 'routines') openSettings('routines')
    else if (action === 'memory') openSettings('memory')
    else if (action === 'bar-hide') hideBar()
    else if (action === 'bar-blur') barWin?.isFocused() && barWin.blur()
  })
  // the bar reports the size of what it draws; the window follows it exactly (no invisible click-blocking area)
  ipcMain.on('bar:size', (_e, w: number, h: number, expanded: boolean) => {
    if (!(w > 0 && h > 0)) return
    barSize = { width: Math.ceil(w), height: Math.ceil(h) }
    barExpanded = !!expanded
    placeBar()
  })
  ipcMain.handle('bar:geom', () => barGeometry())

  // audio host → speech engine
  ipcMain.on(IPC.audioChunk, (_e, buf: ArrayBuffer) => assistant.speech.feed(buf))
  // the level meter only matters while Jarvis is listening: don't wake two renderers 20×/s for nothing
  ipcMain.on(IPC.micLevel, (_e, level: number) => {
    const st = assistant.state
    if (st === 'listening' || st === 'wake') toUi(IPC.micLevel, level)
  })
  ipcMain.on(IPC.ttsLevel, (_e, level: number) => toUi(IPC.ttsLevel, level))
  ipcMain.on(IPC.ttsEnded, (_e, id: string) => assistant.onPlayEnded(id))
}

// ---- dependency installer: one queue, so the launch-time auto install and the Setup button never race ----
let installChain: Promise<unknown> = Promise.resolve()
function installAssets(ids: string[], tries = 1) {
  const run = async () => {
    for (const id of ids) {
      if (listAssets(dataDir()).find((a) => a.id === id)?.installed) continue
      for (let n = 1; n <= tries; n++) {
        try {
          await installAsset(dataDir(), id, (p: SetupProgress) => toUi(IPC.modelProgress, p))
          break
        } catch (e) {
          console.error(`download failed (${n}/${tries})`, id, e)
          if (n < tries) await new Promise((r) => setTimeout(r, 3000 * n))
        }
      }
    }
    assistant.prewarmVoices()
    if (!assistant.speech.ready && !assistant.speech.missing().length) assistant.speech.start()
    assistant.emitStatus()
    const list = listAssets(dataDir())
    broadcast('assets:changed', list)
    return list
  }
  const p = installChain.then(run, run)
  installChain = p.catch(() => {})
  return p
}

/** Downloads every required model the app is missing, without waiting for the user; retries later while offline. */
async function autoInstall() {
  const missing = () => listAssets(dataDir()).filter((a) => a.required && !a.installed).map((a) => a.id)
  if (!missing().length) return
  console.log('[setup] auto-installing', missing().join(', '))
  await installAssets(missing(), 3)
  if (missing().length) setTimeout(() => void autoInstall(), 5 * 60_000)
}

function wireAssistantEvents() {
  // model switches made by the automatic fallback must show up in Settings too
  assistant.settingsStore.on('change', (next: Settings) => broadcast(IPC.settingsChanged, next))
  assistant.on('status', (s) => broadcast(IPC.status, s))
  assistant.on('chat', (item) => toUi(IPC.chat, item))
  assistant.on('permission', (r) => {
    toUi(IPC.permission, r)
    showBar({ expand: true }) // an approval card must never be missed: reveal the bar with its panel open
  })
  assistant.routines.on('change', () => toUi(IPC.routinesChanged))
  assistant.threads.on('change', () => toUi(IPC.threadsChanged, assistant.threads.state()))
  assistant.on('chatReset', () => toUi(IPC.chatReset))
  assistant.memory.on('change', () => toUi(IPC.memoryChanged))
  assistant.on('permissionClose', (id) => {
    toUi(IPC.permissionClose, id)
  })
  assistant.on('subtitle', (t: string) => toUi(IPC.subtitle, t))
  assistant.on('partial', (t: string) => toUi(IPC.transcript, t))
  // the HUD window also hosts the microphone and speech playback (one renderer process less)
  assistant.on('play', (req) => toBar(IPC.ttsPlay, req))
  assistant.on('stopPlayback', () => toBar(IPC.ttsStop))
  // wake word or hotkey: reveal the bar in its listening state, without taking focus from the app you are in
  assistant.on('wake', () => {
    toBar('audio:earcon', 'wake')
    showBar()
  })
  assistant.on('earcon', (kind: string) => toBar('audio:earcon', kind))
  // Ctrl+Shift tap: the bar opens with the text box focused (the one case where it takes the keyboard)
  assistant.on('quickType', () => showBar({ expand: true, focus: true }))
  assistant.on('reveal', () => showBar())
  // Esc with nothing to stop: close the open panel (the idle bar itself stays, so a stray Esc in another app can't hide it)
  assistant.on('escIdle', () => {
    if (barWin?.isVisible() && barExpanded) hideBar()
  })
  // anything you asked for (typed, spoken, a routine) brings the bar back if it was hidden
  assistant.on('chat', (item: any) => {
    if (item?.kind === 'user') showBar()
  })
}

async function debugPrompts(list: string[]) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  while (assistant.opencode.status !== 'ready') await wait(500)
  if (process.env.JARVIS_AUTOYES) assistant.on('permission', (r: any) => setTimeout(() => void assistant.replyPermission(r.id, r.options?.[0] ?? 'once'), 1800))
  assistant.on('chat', (it: any) => {
    if (it.kind === 'assistant' && !it.done) return
    const body = it.kind === 'tool' ? `${it.tool.tool} [${it.tool.status}] ${JSON.stringify(it.tool.input ?? {}).slice(0, 160)} -> ${(it.tool.output ?? '').slice(0, 700).split('\n').join(' | ')}` : it.text
    console.log(`[e2e] ${it.kind}: ${body}`)
  })
  if (process.env.JARVIS_ABORT_AFTER) setTimeout(() => { console.log('[e2e] *** ABORT'); void assistant.abortTask() }, Number(process.env.JARVIS_ABORT_AFTER))
  for (const p of list) {
    console.log('[e2e] >>> ' + p)
    if (p.startsWith('!')) {
      await assistant.handleCommand(p.slice(1), 'voice')
      await wait(3500)
      continue
    }
    await assistant.handleCommand(p, 'voice')
    await new Promise<void>((r) => assistant.opencode.once('turnEnd', () => setTimeout(r, 1500)))
  }
  console.log('[e2e] finished')
}

// the shortcut clicked again while Jarvis runs: bring the existing bar back (with its text box ready)
app.on('second-instance', () => showBar({ expand: true, focus: true }))
let cleanedUp = false
app.on('before-quit', (e) => {
  quitting = true
  if (cleanedUp) return
  // stop the agent server, speech, voice and Windows bridges before exiting so nothing is left in Task Manager
  e.preventDefault()
  cleanedUp = true
  tray?.destroy()
  tray = null
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.destroy()
  const dispose = assistant ? assistant.dispose().catch(() => {}) : Promise.resolve()
  void Promise.race([dispose, new Promise((r) => setTimeout(r, 4000))]).finally(() => app.exit(0))
})
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['media', 'audioCapture', 'clipboard-sanitized-write'].includes(permission)))
  session.defaultSession.setPermissionCheckHandler(() => true)
  assistant = new Assistant()
  wireIpc()
  wireAssistantEvents()
  // launched at sign-in (--hidden) or with "start hidden": wake word and hotkeys work, the bar appears when called
  const startHidden = process.argv.includes('--hidden') || assistant.settings().startHidden
  createBar(!startHidden)
  // first run only: the setup (speech models, agent) lives in the settings window
  if (!assistant.settings().setupDone) openSettings('settings')
  buildTray()
  // automated lifecycle tests only (scripts/test-bar.mjs): lets the test press the same buttons the tray offers
  if (process.env.JARVIS_TEST_HOOKS) (globalThis as any).__jarvisTest = { showBar, hideBar, openSettings, toggleListen: () => assistant.toggleListen(), state: () => assistant.status() }
  registerHotkey()
  applyAutoStart()
  await assistant.init()
  void autoInstall()
  updater.init(assistant.settings().autoUpdate)
  updater.on('state', (st) => broadcast('update:changed', st))
  if (process.env.JARVIS_TEST_WAIT) {
    await new Promise((r) => setTimeout(r, 4000))
    const c = assistant.mcp.computer
    const t0 = Date.now()
    const r = await c.waitStable({ timeoutSec: 12, epoch: c.begin() })
    console.log(`[wait-test] stable=${r.stable} waited=${r.waitedMs}ms total=${Date.now() - t0}ms title="${r.title}"`)
  }
  if (process.env.JARVIS_FEED) {
    // feed 16 kHz mono wav files through the real engine (worker + ASR child) and log what comes out
    const { readFileSync } = await import('fs')
    assistant.speech.on('event', (e: any) => {
      if (e.type !== 'partial') console.log('[feed]', JSON.stringify(e).slice(0, 260))
    })
    await new Promise((r) => setTimeout(r, 4000))
    for (const f of (process.env.JARVIS_FEED as string).split(';')) {
      const b = readFileSync(f)
      const pcm = new Int16Array(b.buffer.slice(b.byteOffset + 44, b.byteOffset + b.length - ((b.length - 44) % 2)))
      const all = new Float32Array(16000 * 2 + pcm.length)
      for (let i = 0; i < pcm.length; i++) all[16000 + i] = pcm[i] / 32768
      console.log('[feed] >>>', f)
      for (let o = 0; o < all.length; o += 1600) {
        assistant.speech.feed(all.slice(o, o + 1600).buffer)
        await new Promise((r) => setTimeout(r, 8))
      }
      await new Promise((r) => setTimeout(r, 4000))
    }
    console.log('[feed] done')
  }
  if (process.env.JARVIS_TEST_UPDATE) {
    // dev: walk the update window through available → downloading → downloaded with fake data
    const set = (p: object) => {
      updater.state = { ...updater.state, ...p }
      updater.emit('state', updater.state)
    }
    set({ status: 'available', version: '1.3.0', notes: '- Новый установщик\n- Окно обновлений в стиле Jarvis\n- Обновления ставятся тихо' })
    const snap = async (name: string) => {
      await new Promise((r) => setTimeout(r, 700))
      const img = await updateWin?.webContents.capturePage()
      if (img && process.env.JARVIS_TEST_UPDATE!.length > 2) writeFileSync(join(process.env.JARVIS_TEST_UPDATE!, `update-${name}.png`), img.toPNG())
    }
    showUpdateWindow()
    await new Promise((r) => setTimeout(r, 3000))
    await snap('available')
    for (let p = 0; p <= 100; p += 5) {
      set({ status: 'downloading', percent: p, bytesPerSecond: 24_000_000 })
      await new Promise((r) => setTimeout(r, 200))
      if (p === 60) await snap('downloading')
    }
    set({ status: 'downloaded' })
    await snap('downloaded')
  }
  if (process.env.JARVIS_TEST_OVERLAY) {
    // dev: show the "Jarvis is controlling the PC" overlay for 8 s (check that it stays see-through)
    await new Promise((r) => setTimeout(r, 4000))
    console.log('[overlay-test] on')
    await assistant.overlay.setControl(true, 'управляет компьютером · Ctrl+Alt+K — стоп')
    await new Promise((r) => setTimeout(r, 8000))
    await assistant.overlay.setControl(false)
    console.log('[overlay-test] off')
  }
  if (process.env.JARVIS_TEST_DOCS) {
    // dev / packaged self-test of the document toolkit: diagram, image search, deck, PDF, read back
    const out = process.env.JARVIS_TEST_DOCS
    const d = await import('./docs')
    const step = async (name: string, f: () => Promise<unknown>) => {
      try {
        console.log(`[docs-test] ${name}: ${String(await f()).split('\n')[0]}`)
      } catch (e: any) {
        console.log(`[docs-test] ${name}: FAIL ${e?.message || e}`)
      }
    }
    await step('diagram', async () => (await d.makeDiagram('flowchart LR\n  A["Голос"] --> B["Агент"] --> C["Документ"]', 'midnight', 1000, join(out, 'diagram.png'))).path)
    let img = ''
    await step('images', async () => ((img = (await d.findImages('Moscow Kremlin', 1, 'landscape'))[0].path), img))
    await step('deck', () => d.createDeck({ title: 'Self-test', theme: 'clean', slides: [{ layout: 'title' }, { layout: 'diagram', title: 'Схема', diagram: 'pie title Доли\n  "A" : 60\n  "B" : 40' }, { layout: 'image', title: 'Фото', image: img }] }, { path: join(out, 'self-test.pptx'), overwrite: true }))
    await step('pdf', () => d.createDocument({ title: 'Self-test', template: 'modern', blocks: [{ type: 'paragraph', text: 'PDF ok' }, { type: 'diagram', mermaid: 'flowchart TD\n  A --> B', caption: 'Схема' }] }, 'pdf', { path: join(out, 'self-test.pdf'), overwrite: true }))
    await step('read pdf', () => d.readDocument(join(out, 'self-test.pdf'), 200))
    await step('read pptx', () => d.readDocument(join(out, 'self-test.pptx'), 200))
    console.log('[docs-test] done')
  }
  if (process.env.JARVIS_TEST_CMD) {
    // dev: run typed commands through the real agent one after another ("cmd one;;cmd two") and log each turn's end
    await new Promise((r) => setTimeout(r, 5000))
    for (const cmd of process.env.JARVIS_TEST_CMD.split(';;')) {
      const t0 = Date.now()
      const done = new Promise<void>((r) => assistant.opencode.once('turnEnd', () => r()))
      console.log('[cmd-test] >>>', cmd)
      if (process.env.JARVIS_TEST_FAKE_LIMIT) {
        // pretend the free model just hit its quota (as opencode reports it) to exercise the free-model fallback
        assistant.opencode.once('turnStart', () =>
          setTimeout(() => (assistant.opencode as any).onRetry({ type: 'retry', message: 'Free usage exceeded, subscribe to Go', action: { reason: 'free_tier_limit' }, next: Date.now() + 3_600_000 }), 300)
        )
      }
      void assistant.handleCommand(cmd, 'text')
      await Promise.race([done, new Promise((r) => setTimeout(r, 15 * 60_000))])
      console.log(`[cmd-test] turn done in ${Math.round((Date.now() - t0) / 1000)} s`)
    }
    console.log('[cmd-test] all done')
  }
  if (process.env.JARVIS_TEST_SAY) {
    await new Promise((r) => setTimeout(r, 5000))
    const st = assistant.settings()
    console.log('[say-test] voices:', st.voiceRu, st.voiceEn)
    for (const line of ['Добрый вечер, сэр. Все системы работают в штатном режиме.', 'Good evening, sir. Everything is in order.']) {
      const t0 = Date.now()
      await assistant.say(line)
      console.log(`[say-test] "${line.slice(0, 24)}…" done in ${Date.now() - t0}ms`)
    }
  }
  if (process.env.JARVIS_TEST_ACK) {
    await new Promise((r) => setTimeout(r, 6000))
    for (const lang of ['ru', 'ru', 'en', 'en']) {
      const t0 = Date.now()
      await assistant.ack(lang)
      console.log(`[ack-test] ${lang} played in ${Date.now() - t0}ms`)
      await new Promise((r) => setTimeout(r, 400))
    }
  }
  if (process.env.JARVIS_TEST_CLONE) {
    const t0 = Date.now()
    assistant.xtts
      .synth('Добрый вечер, сэр.', 'ru', 1)
      .then((b) => console.log(`[clone-test] OK ${b.length} bytes in ${Date.now() - t0}ms`))
      .catch((e) => console.log('[clone-test] FAILED', e.message))
  }
  if (process.env.JARVIS_PROMO) {
    openSettings()
    void import('./promo').then((m) => m.runPromo({ win: () => settingsWin!, assistant, out: process.env.JARVIS_PROMO! }))
  }
  if (process.env.JARVIS_PROMPTS) void debugPrompts(JSON.parse(process.env.JARVIS_PROMPTS))
})

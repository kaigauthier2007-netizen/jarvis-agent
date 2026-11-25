// Lifecycle + memory test of the Jarvis bar under Xvfb (Linux). Usage: node test-bar.mjs <appdir> <outdir>
import { _electron as electron } from 'playwright-core'
import { execSync, spawn } from 'child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'fs'

const appDir = process.argv[2] || '/tmp/ja'
const out = process.argv[3] || '/tmp/bar-test'
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const ud = '/tmp/ud-new'
rmSync(ud, { recursive: true, force: true })
cpSync('/tmp/ud-tpl', ud, { recursive: true })
const log = []
const say = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(line)
  log.push(line)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const mem = (label) => {
  const r = execSync(`python3 /tmp/mem.py ${pid} "${label}"`).toString()
  say(r.trim())
  return r
}
let pass = 0,
  fail = 0
const check = (name, ok, extra = '') => {
  ok ? pass++ : fail++
  say(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
}

const app = await electron.launch({
  executablePath: '/tmp/ja/node_modules/electron/dist/electron',
  args: ['.', '--no-sandbox'],
  cwd: appDir,
  env: { ...process.env, DISPLAY: ':99', JARVIS_USERDATA: ud, JARVIS_TEST_HOOKS: '1' }
})
const pid = app.process().pid
app.process().stdout.on('data', (d) => writeFileSync(out + '/app.log', d, { flag: 'a' }))
app.process().stderr.on('data', (d) => writeFileSync(out + '/app.log', d, { flag: 'a' }))

const wins = () =>
  app.evaluate(({ BrowserWindow, screen }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      id: w.id,
      url: w.webContents.getURL().split('/').pop(),
      visible: w.isVisible(),
      focused: w.isFocused(),
      onTop: w.isAlwaysOnTop(),
      bounds: w.getBounds(),
      wa: screen.getPrimaryDisplay().workArea
    }))
  )
const bar = await app.firstWindow()
await bar.waitForSelector('.bar', { timeout: 20000 })
await wait(1500)

// ---------- 1. launch: only the bar
let w = await wins()
say('windows after launch:', w)
check('launch opens exactly one window (the bar)', w.length === 1 && w[0].url.startsWith('bar.html'))
check('bar is visible, always on top, not focused', w[0].visible && w[0].onTop && !w[0].focused)
const b0 = w[0].bounds
check('bar is at the top centre of the work area', b0.y === w[0].wa.y && Math.abs(b0.x + b0.width / 2 - (w[0].wa.x + w[0].wa.width / 2)) <= 1, JSON.stringify(b0))
const size0 = await bar.evaluate(() => {
  const r = document.querySelector('.bar')
  return { w: r.offsetWidth, h: r.offsetHeight }
})
check('window is exactly the size of the drawn bar (no invisible click-blocking area)', size0.w === b0.width && size0.h === b0.height, `${JSON.stringify(size0)} vs ${b0.width}x${b0.height}`)
await bar.screenshot({ path: out + '/1-collapsed.png' })
await wait(20000)
mem('NEW · 20 s after launch, idle, bar collapsed')

// ---------- 2. click the bar → panel
await bar.click('.bar.mini')
await bar.waitForSelector('.bar.open')
await wait(400)
w = await wins()
const size1 = await bar.evaluate(() => {
  const r = document.querySelector('.bar')
  return { w: r.offsetWidth, h: r.offsetHeight }
})
check('clicking the bar opens the panel and the window grows to fit it', size1.w === w[0].bounds.width && size1.h === w[0].bounds.height && size1.w === 600, JSON.stringify(w[0].bounds))
await bar.screenshot({ path: out + '/2-open-empty.png' })

// ---------- 3. type a request
await bar.click('.b-input input')
await bar.fill('.b-input input', 'What is 17 times 23? Answer in one short sentence.')
await bar.press('.b-input input', 'Enter')
let sawWorking = false
for (let i = 0; i < 40; i++) {
  const st = await app.evaluate(() => globalThis.__jarvisTest.state().state)
  if (st === 'thinking') {
    sawWorking = true
    break
  }
  await wait(250)
}
check('sending a typed request shows the working state', sawWorking)
await wait(1500)
await bar.screenshot({ path: out + '/3-working.png' })
mem('NEW · during a request (agent working)')
let answered = false
for (let i = 0; i < 120; i++) {
  const txt = await bar.evaluate(() => [...document.querySelectorAll('.m.jarvis, .m.sys')].map((e) => e.textContent).join(' | '))
  const st = await app.evaluate(() => globalThis.__jarvisTest.state().state)
  if (/391|ninety-one/i.test(txt) && st === 'idle') {
    answered = true
    break
  }
  await wait(1000)
}
check('the answer appears in the panel (17 × 23 = 391)', answered)
await bar.screenshot({ path: out + '/4-answer.png' })

// ---------- 4. stop a task
await bar.fill('.b-input input', 'Write a 600-word essay about the history of the bicycle.')
await bar.press('.b-input input', 'Enter')
for (let i = 0; i < 40; i++) {
  if ((await bar.$('.b-icon.stop.big')) !== null) break
  await wait(250)
}
await wait(2500)
const stopBtn = await bar.$('.b-icon.stop.big')
check('a stop button is shown while Jarvis works', !!stopBtn)
await bar.screenshot({ path: out + '/5-stop-visible.png' })
if (stopBtn) await stopBtn.click()
let stopped = false
for (let i = 0; i < 40; i++) {
  const st = await app.evaluate(() => globalThis.__jarvisTest.state().state)
  if (st === 'idle') {
    stopped = true
    break
  }
  await wait(250)
}
check('the stop button ends the task (state back to idle)', stopped)

// ---------- 5. microphone button
await bar.click('.b-icon.mic')
await wait(600)
let st = await app.evaluate(() => globalThis.__jarvisTest.state().state)
check('the mic button switches to listening', st === 'listening', st)
await bar.screenshot({ path: out + '/6-listening.png' })
await bar.keyboard.press('Escape')
await wait(600)
st = await app.evaluate(() => globalThis.__jarvisTest.state().state)
check('Esc while listening stops listening (bar stays)', st === 'idle' && (await wins())[0].visible, st)

// ---------- 6. history view + settings window on demand
await bar.click('.b-tools .b-icon[title="Chat history"]')
await wait(300)
check('history view lists chats', (await bar.$$('.b-thread')).length >= 1)
await bar.screenshot({ path: out + '/7-history.png' })
await bar.click('.b-tools .b-icon[title="Chat history"]')
const before = (await wins()).length
await bar.click('.b-tools .b-icon[title="Settings"]')
const sw = await app.waitForEvent('window', { timeout: 15000 })
await sw.waitForSelector('.app', { timeout: 15000 })
await wait(1500)
w = await wins()
check('Settings opens as a separate window only when asked', w.length === before + 1 && w.some((x) => x.url.startsWith('index.html?page=settings')))
await sw.screenshot({ path: out + '/8-settings.png' })
mem('NEW · Settings window open')
await sw.evaluate(() => window.close())
await wait(2500)
w = await wins()
check('closing Settings destroys it (nothing of the old dashboard stays loaded)', w.length === 1, JSON.stringify(w.map((x) => x.url)))
mem('NEW · after closing Settings')

// ---------- 7. hide + reopen
await bar.keyboard.press('Escape') // idle + focused → hide
await wait(500)
w = await wins()
check('Esc in the bar (nothing running) hides it', !w[0].visible)
const alive = await app.evaluate(() => !!globalThis.__jarvisTest)
check('hiding keeps Jarvis running', alive)
// shortcut clicked again: a second instance must hand over to this one and exit
const t0 = Date.now()
const second = spawn('/tmp/ja/node_modules/electron/dist/electron', ['.', '--no-sandbox'], { cwd: appDir, env: { ...process.env, DISPLAY: ':99', JARVIS_USERDATA: ud } })
const code = await new Promise((r) => second.on('exit', r))
await wait(800)
w = await wins()
check('launching again does not start a second Jarvis (second process exits)', code === 0, `exit ${code} after ${Date.now() - t0} ms`)
check('…and reveals the existing bar with its panel open', w.length === 1 && w[0].visible && (await bar.$('.bar.open')) !== null)
await bar.screenshot({ path: out + '/9-revealed.png' })
for (let i = 0; i < 10; i++) {
  await app.evaluate(() => globalThis.__jarvisTest.hideBar())
  await wait(300)
  await app.evaluate((_e, ex) => globalThis.__jarvisTest.showBar({ expand: ex }), i % 2 === 0)
  await wait(300)
}
await app.evaluate(() => globalThis.__jarvisTest.hideBar())
await wait(3000)
mem('NEW · after 10 hide/show cycles, bar hidden')
await app.evaluate(() => globalThis.__jarvisTest.showBar())
await wait(500)
w = await wins()
check('bar comes back after hide/show cycles', w[0].visible)
// hotkey path (same function the global hotkey calls): reveals the bar in listening state without taking focus
await app.evaluate(() => globalThis.__jarvisTest.hideBar())
await wait(300)
await app.evaluate(() => globalThis.__jarvisTest.toggleListen())
await wait(700)
w = await wins()
st = await app.evaluate(() => globalThis.__jarvisTest.state().state)
check('hotkey/wake activation reveals the bar in listening state, without focus', w[0].visible && !w[0].focused && st === 'listening', `visible=${w[0].visible} focused=${w[0].focused} state=${st}`)
await bar.screenshot({ path: out + '/10-hotkey-listening.png' })
await app.evaluate(() => globalThis.__jarvisTest.toggleListen())

// ---------- 8. quit: every Jarvis process ends
const tree = execSync(`ps -o pid= --ppid ${pid}; pgrep -f "${ud}" || true`).toString().trim().split(/\s+/).filter(Boolean)
const ocPid = execSync(`pgrep -f "opencode.*serve" || true`).toString().trim()
say('child pids before quit:', tree, 'opencode:', ocPid)
await app.evaluate(({ app }) => app.quit())
await wait(6000)
const leftovers = execSync(`ps -eo pid,args | grep -E "${ud}|opencode.*serve|asrChild|electron/dist/electron \\. " | grep -v grep || true`).toString().trim()
check('Quit ends Jarvis and all of its processes', !leftovers, leftovers)
say(`\n${pass} passed, ${fail} failed`)
writeFileSync(out + '/result.txt', log.join('\n'))
process.exit(0)

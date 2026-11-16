import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchInstant, duration, clock } from '../src/main/instant.ts'

const now = new Date(2026, 10, 16, 14, 5, 0) // Mon 2:05 PM
const m = (s: string) => matchInstant(s, now)
const hm = (t: number) => { const d = new Date(t); return `${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}` }

test('durations', () => {
  assert.equal(duration('10 minutes'), 600_000)
  assert.equal(duration('ten minutes'), 600_000)
  assert.equal(duration('twenty five minutes'), 1_500_000)
  assert.equal(duration('an hour and a half'), 5_400_000)
  assert.equal(duration('1 hour 30 minutes'), 5_400_000)
  assert.equal(duration('half an hour'), 1_800_000)
  assert.equal(duration('90 seconds'), 90_000)
  assert.equal(duration('a minute'), 60_000)
  assert.equal(duration('pizza'), null)
})

test('clock', () => {
  assert.equal(hm(clock('6', now)!), '16 18:00')
  assert.equal(hm(clock('6 am', now)!), '17 6:00')
  assert.equal(hm(clock('6:30pm', now)!), '16 18:30')
  assert.equal(hm(clock('2', now)!), '17 2:00')
  assert.equal(hm(clock('9', now, true)!), '17 9:00')
  assert.equal(hm(clock('noon', now)!), '17 12:00')
  assert.equal(hm(clock('six', now)!), '16 18:00')
})

test('timers and reminders', () => {
  assert.deepEqual(m('set a timer for 10 minutes'), { kind: 'timer', ms: 600_000, label: '' })
  assert.deepEqual(m('Jarvis, 5 minute timer'), { kind: 'timer', ms: 300_000, label: '' })
  assert.deepEqual(m('timer for 20 minutes for the pasta'), { kind: 'timer', ms: 1_200_000, label: 'the pasta' })
  assert.equal(m('cancel the timer')?.kind, 'timer_cancel')
  assert.equal(m('how much time is left')?.kind, 'timer_status')
  assert.equal(m('how much is left'), null)
  let r: any = m('remind me at 6 to call mom')
  assert.equal(r.kind, 'remind'); assert.equal(r.text, 'call mom'); assert.equal(hm(r.at), '16 18:00')
  r = m('remind me to stretch in 20 minutes')
  assert.equal(r.text, 'stretch'); assert.equal(r.at - now.getTime(), 1_200_000)
  r = m('remind me tomorrow at 9 to submit the HES 201 poster')
  assert.equal(r.text, 'submit the hes 201 poster'); assert.equal(hm(r.at), '17 9:00')
  r = m('remind me to go to practice at 6:30 pm')
  assert.equal(r.text, 'go to practice'); assert.equal(hm(r.at), '16 18:30')
  assert.equal(m('what are my reminders')?.kind, 'reminders_list')
  assert.equal(m('remind me about something'), null)
})

test('lists', () => {
  assert.deepEqual(m('add milk and eggs to my shopping list'), { kind: 'list_add', list: 'shopping', items: ['milk', 'eggs'] })
  assert.deepEqual(m('add finish the poster to my list'), { kind: 'list_add', list: 'to-do', items: ['finish the poster'] })
  assert.deepEqual(m("what's on my shopping list"), { kind: 'list_show', list: 'shopping' })
  assert.deepEqual(m('remove milk from my shopping list'), { kind: 'list_remove', list: 'shopping', item: 'milk' })
  assert.deepEqual(m('clear my list'), { kind: 'list_clear', list: 'to-do' })
})

test('open', () => {
  assert.deepEqual(m('open youtube'), { kind: 'open', target: 'https://www.youtube.com', label: 'youtube', site: true })
  assert.deepEqual(m('open my downloads'), { kind: 'open', target: 'downloads', label: 'downloads', folder: 'downloads' })
  assert.deepEqual(m('open chess.com'), { kind: 'open', target: 'https://www.chess.com', label: 'chess com', site: true })
  assert.deepEqual(m('go to lichess.org'), { kind: 'open', target: 'https://lichess.org', label: 'lichess.org', site: true })
  assert.deepEqual(m('open spotify'), { kind: 'open', target: 'spotify', label: 'spotify' })
  assert.deepEqual(m('launch the calculator app'), { kind: 'open', target: 'calculator', label: 'calculator' })
  assert.equal(m('open my last email from sam'), null)
  assert.equal(m('open youtube and search cats'), null)
  assert.equal(m('open the door'), null)
})

test('keys, windows, misc', () => {
  assert.deepEqual(m('new tab'), { kind: 'keys', keys: 'ctrl+t', scope: 'browser', say: 'New tab.' })
  assert.equal(m('close this tab')?.kind, 'keys')
  assert.equal((m('zoom in') as any).keys, 'ctrl+plus')
  assert.equal((m('go back') as any).keys, 'alt+left')
  assert.equal((m('scroll down') as any).keys, 'pagedown')
  assert.deepEqual(m('minimize this window'), { kind: 'window', action: 'minimize', say: 'Minimised.' })
  assert.deepEqual(m('turn on dark mode'), { kind: 'theme', dark: true })
  assert.deepEqual(m('find my resume'), { kind: 'find_file', query: 'resume', open: false })
  assert.deepEqual(m('open my exercise prescription essay'), { kind: 'find_file', query: 'exercise prescription', open: true })
  assert.equal(m('find my phone'), null)
  assert.deepEqual(m('find squat on this page'), { kind: 'find_on_page', text: 'squat' })
  assert.equal(m('what time is it')?.kind, 'time')
  assert.equal(m('take a screenshot')?.kind, 'screenshot')
  assert.equal(m('play a chess game against me'), null)
  assert.equal(m('write an email to my coach'), null)
})

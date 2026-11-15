import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findWake, stripWake, looseWakeGate, phraseScore, normalize } from '../src/shared/textmatch.ts'
import { speakable, splitSentences, detectLang } from '../src/main/tts.ts'

const ALIASES = ['джарвис', 'jarvis', 'джарви', 'джави', 'жарви']

test('wake word: accepts the common spellings', () => {
  for (const t of ['джарвис открой ютуб', 'Жарвис, привет', 'эй джарвис', 'Jarvis, open chrome', 'джар вис включи свет', 'Дервис, открой калькулятор', 'Джави, что ты умеешь']) {
    assert.ok(findWake(t, ALIASES), `should wake on: ${t}`)
  }
})

test('wake word: ignores ordinary speech', () => {
  for (const t of ['привет мир', 'сервис открой', 'чарльз открой', 'что у нас на обед', 'open the door']) {
    assert.equal(findWake(t, ALIASES), null, `should NOT wake on: ${t}`)
  }
})

test('stripWake removes the name and greeting and keeps the command', () => {
  assert.equal(stripWake('Джарвис, открой браузер и найди погоду', ALIASES).command, 'открой браузер и найди погоду')
  assert.equal(stripWake('Jarvis, open chrome', ALIASES).command, 'open chrome')
  assert.equal(stripWake('эй джарвис', ALIASES).command, '')
})

test('loose gate is forgiving enough for the streaming recogniser', () => {
  assert.ok(looseWakeGate('джаве открой', ALIASES))
  assert.ok(looseWakeGate('жаррис', ALIASES))
  assert.ok(!looseWakeGate('привет как дела', ALIASES))
})

test('phrase matching for routine triggers', () => {
  assert.ok(phraseScore('доброе утро', 'Доброе утро!') >= 0.95)
  assert.ok(phraseScore('доброе утро', 'добрый вечер') < 0.7)
  assert.equal(normalize('Ёлка, ЁЖ!'), 'елка еж')
})

test('speakable strips markdown, code, URLs and emoji', () => {
  assert.equal(speakable('Готово **сэр** `rm -rf` https://x.io/a 🎉'), 'Готово сэр rm -rf')
  assert.equal(speakable('```js\nconsole.log(1)\n```ok'), 'ok')
})

test('sentence splitting keeps short fragments together', () => {
  const s = splitSentences('Да. Хорошо. Сейчас сделаю, сэр. Готово!')
  assert.ok(s.length >= 1 && s.every((x) => x.length >= 6))
  assert.equal(detectLang('Открой браузер'), 'ru')
  assert.equal(detectLang('Open the browser'), 'en')
})

const EN_ALIASES = ['jarvis', 'джарвис', 'джарви', 'джави', 'жарви', 'джарвиз', 'джервис', 'джарвес', 'jervis', 'javis', 'jarvus', 'jarvas', 'jarviss', 'jarvi', 'jarvys', 'charvis', 'garvis', 'jarbis', 'jarves']
// the English path matches at the relaxed threshold minus 0.05 (sensitivity 0.6 → 0.75)
const EN_T = 1.0 - 0.6 * 0.2 - 0.08 - 0.05

test('wake word (English recogniser): accepts how it writes Jarvis', () => {
  for (const t of ['Jarvis, what time is it', 'Hey Jarvis open Spotify', 'Jervis play music', 'Javis', 'Jarvus, open chrome', 'Charvis what is the weather', 'Okay Jarvis', 'Jarvis.']) {
    assert.ok(stripWake(t, EN_ALIASES, 0.6, EN_T).hit, `should wake on: ${t}`)
  }
})

test('wake word (English recogniser): ignores ordinary English speech', () => {
  for (const t of ['open the door', 'what is the weather', 'Travis is coming over', 'I need a service', 'jars of jam', 'the car is red', 'harvest moon tonight', 'carpet cleaning', 'nervous about the test']) {
    assert.equal(stripWake(t, EN_ALIASES, 0.6, EN_T).hit, null, `should NOT wake on: ${t}`)
  }
})

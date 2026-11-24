import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanDictation, bigTaskReason } from '../src/shared/dictation.ts'

test('clean dictation', () => {
  assert.equal(cleanDictation('um so i think we should uh meet at five'), 'So I think we should meet at five.')
  assert.equal(cleanDictation('hello , world'), 'Hello, world')
  assert.equal(cleanDictation('see you there. thanks'), 'See you there. Thanks.')
  assert.equal(cleanDictation('Is it ready?'), 'Is it ready?')
  assert.equal(cleanDictation('  uh  '), '')
  assert.equal(cleanDictation('the umbrella is here'), 'The umbrella is here.')
})

test('big task detection', () => {
  assert.ok(bigTaskReason('research the best protein powders and write a report with sources'))
  assert.ok(bigTaskReason('make a 12 slide presentation about exercise prescription for older adults'))
  assert.ok(bigTaskReason('compare the top 10 laptops for students under 1500 dollars'))
  assert.equal(bigTaskReason('open youtube'), '')
  assert.equal(bigTaskReason('what is the weather like today in richmond'), '')
  assert.equal(bigTaskReason('write an email to my coach saying I will be late'), '')
  assert.equal(bigTaskReason('research this and make a report but do it here'), '')
})

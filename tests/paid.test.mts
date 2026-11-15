import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addUsage, budgetView, costUsd, describeBudget, freshUsage } from '../src/shared/paid.ts'

test('gpt-oss-120b cost: input, cached, output + reasoning', () => {
  const c = costUsd('groq/openai/gpt-oss-120b', { input: 1_000_000, output: 500_000, reasoning: 500_000, cache: { read: 1_000_000 } })
  assert.equal(Math.round(c * 1000) / 1000, 0.15 + 0.075 + 0.6)
})

test('usage resets each month and counts requests', () => {
  const nov = new Date(2026, 10, 15, 12)
  let u = addUsage(freshUsage(undefined, nov), 0.5, true, nov)
  u = addUsage(u, 0.25, false, nov)
  assert.equal(u.requests, 1)
  assert.equal(u.usd, 0.75)
  assert.equal(freshUsage(u, new Date(2026, 11, 1)).usd, 0)
})

test('pace estimate and cap', () => {
  const start = new Date(2026, 10, 10, 9)
  const now = new Date(2026, 10, 15, 9)
  const u = addUsage(freshUsage(undefined, start), 1, true, start) // $1 USD on the 10th
  const v = budgetView(u, 5, 1.4, now) // 1.40 CAD since midnight on the 10th (5.4 days) → 0.26/day → 13.8 days left → runs out Nov 29
  assert.equal(v.runsOut?.getDate(), 29)
  assert.match(describeBudget(v), /\$1\.40 of your \$5\.00 CAD/)
  const slow = budgetView(addUsage(freshUsage(undefined, start), 0.1, true, start), 5, 1.4, now)
  assert.equal(slow.runsOut, null)
  assert.ok(budgetView(addUsage(u, 2.6, true, now), 5, 1.4, now).over)
})

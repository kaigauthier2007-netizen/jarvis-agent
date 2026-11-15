/**
 * Monthly budget for the paid fast model (OpenRouter or Groq). Every finished model step reports its token counts; they are priced
 * here, added to this month's total, and once the total reaches the cap the paid model is blocked until the 1st of
 * next month (Jarvis falls back to the free models). The budget is in Canadian dollars; providers bill in US dollars, so
 * the Bank of Canada daily rate is fetched once a day.
 */
import type { PaidUsage } from './types'
export type { PaidUsage }

export interface Tokens {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

/** USD per 1M tokens (list prices, November 2026) */
export const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  // OpenRouter "nitro" = fastest host; counted at Cerebras' price (the dearest fast host)
  'openrouter/openai/gpt-oss-120b:nitro': { input: 0.35, cached: 0.35, output: 0.75 },
  'groq/openai/gpt-oss-120b': { input: 0.15, cached: 0.075, output: 0.6 },
  'groq/openai/gpt-oss-20b': { input: 0.075, cached: 0.037, output: 0.3 },
  'groq/qwen/qwen3.8-27b': { input: 0.8, cached: 0.8, output: 4 }
}

/** paid fast models Jarvis knows, best first (OpenRouter works today; Groq's paid plan is paused for new accounts) */
export const PAID_MODELS = ['openrouter/openai/gpt-oss-120b:nitro', 'groq/openai/gpt-oss-120b']

export function costUsd(model: string, t: Tokens, reported = 0): number {
  const p = PRICES[model]
  if (!p) return reported || 0
  const own = ((t.input ?? 0) * p.input + (t.cache?.read ?? 0) * p.cached + (t.cache?.write ?? 0) * p.input + ((t.output ?? 0) + (t.reasoning ?? 0)) * p.output) / 1e6
  return Math.max(own, reported || 0)
}

const pad = (n: number) => String(n).padStart(2, '0')
export const monthKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
export const dayKey = (d = new Date()) => `${monthKey(d)}-${pad(d.getDate())}`
export const nextMonthStart = (d = new Date()) => new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()

export function freshUsage(u: PaidUsage | undefined, now = new Date()): PaidUsage {
  return u && u.month === monthKey(now) ? u : { month: monthKey(now), usd: 0, requests: 0, days: {} }
}

export function addUsage(u: PaidUsage, usd: number, newRequest: boolean, now = new Date()): PaidUsage {
  const cur = freshUsage(u, now)
  const k = dayKey(now)
  return { ...cur, usd: cur.usd + usd, requests: cur.requests + (newRequest ? 1 : 0), days: { ...cur.days, [k]: (cur.days[k] ?? 0) + usd } }
}

export interface BudgetView {
  spentCad: number
  budgetCad: number
  pct: number
  requests: number
  perRequestCad: number
  /** spend per day so far this month */
  perDayCad: number
  /** date the budget runs out at this pace, or null if it lasts the month */
  runsOut: Date | null
  over: boolean
}

export function budgetView(u: PaidUsage | undefined, budgetCad: number, cadPerUsd: number, now = new Date()): BudgetView {
  const cur = freshUsage(u, now)
  const spentCad = cur.usd * cadPerUsd
  // pace since the first day it was used this month (so starting mid-month doesn't look artificially cheap)
  const first = Object.keys(cur.days).sort()[0]
  const firstStart = first ? new Date(+first.slice(0, 4), +first.slice(5, 7) - 1, +first.slice(8, 10)).getTime() : now.getTime()
  const perDay = spentCad / Math.max(1, (now.getTime() - firstStart) / 86_400_000)
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const left = budgetCad - spentCad
  let runsOut: Date | null = null
  if (left <= 0) runsOut = now
  else if (perDay > 0) {
    const d = new Date(now.getTime() + (left / perDay) * 86_400_000)
    if (d.getMonth() === now.getMonth() && d.getDate() < daysInMonth) runsOut = d
  }
  return {
    spentCad,
    budgetCad,
    pct: budgetCad > 0 ? Math.min(100, (spentCad / budgetCad) * 100) : 100,
    requests: cur.requests,
    perRequestCad: cur.requests ? spentCad / cur.requests : 0,
    perDayCad: perDay,
    runsOut,
    over: spentCad >= budgetCad * 0.98
  }
}

export function describeBudget(v: BudgetView): string {
  const $ = (n: number) => '$' + n.toFixed(2)
  const base = `You've used ${$(v.spentCad)} of your ${$(v.budgetCad)} CAD fast-model budget this month (${Math.round(v.pct)}%, ${v.requests} request${v.requests === 1 ? '' : 's'}).`
  if (v.over) return base + ' The cap is reached, so I am on the free models until the 1st.'
  if (!v.requests) return base
  if (v.runsOut) return base + ` At this pace it runs out around ${v.runsOut.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}.`
  return base + ' At this pace it lasts the whole month.'
}

/** Bank of Canada daily USD→CAD rate (falls back to the given value offline) */
export async function fetchCadPerUsd(fallback: number): Promise<number> {
  try {
    const r = await fetch('https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1', { signal: AbortSignal.timeout(8000) })
    const j: any = await r.json()
    const v = Number(j?.observations?.[0]?.FXUSDCAD?.v)
    return v > 1 && v < 2 ? v : fallback
  } catch {
    return fallback
  }
}

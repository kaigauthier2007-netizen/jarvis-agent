/** Nixi-style "clean" dictation: drop filler words, tidy spacing, capitalise, end with punctuation. Pure, no model. */
export function cleanDictation(raw: string): string {
  let t = ` ${String(raw || '')} `
  // fillers on their own (not inside words): um, uh, er, ah, hmm, "you know", "like," at a pause
  t = t.replace(/[\s,]+(?:u+m+|u+h+|e+r+m*|a+h+|h+m+|mm+)(?=[\s,.!?])/gi, ' ')
  t = t.replace(/[\s,]+(?:you know|i mean)[,]?(?=\s)/gi, ' ')
  t = t.replace(/\s+([,.!?;:])/g, '$1').replace(/([,.!?;:])(?=[^\s\d])/g, '$1 ')
  t = t.replace(/,{2,}/g, ',').replace(/\s{2,}/g, ' ').trim()
  t = t.replace(/^[,.;:\s]+/, '')
  if (!t) return ''
  t = t.charAt(0).toUpperCase() + t.slice(1)
  t = t.replace(/([.!?]\s+)([a-z])/g, (_m, p, c) => p + c.toUpperCase())
  t = t.replace(/\bi\b/g, 'I')
  if (!/[.!?…]$/.test(t)) t += t.split(/\s+/).length >= 3 ? '.' : ''
  return t
}

/**
 * Requests that are a better fit for Perplexity Computer than a fast desktop assistant: deep multi-source research,
 * long documents / decks / spreadsheets / websites, comparisons across many things, multi-step projects.
 * Returns a short reason, or '' for normal Jarvis work.
 */
export function bigTaskReason(text: string): string {
  const t = String(text || '').toLowerCase()
  if (t.length < 25) return ''
  if (/\b(perplexity|do it here|yourself)\b/.test(t)) return ''
  const research = /\b(research|deep dive|in-depth|literature review|sources?|citations?|cited|compare|comparison|analy[sz]e|analysis|market|competitors?)\b/.test(t)
  const deliverable = /\b(report|essay|paper|presentation|slide ?deck|slides|spreadsheet|dashboard|website|web app|landing page|business plan|study guide|itinerary|proposal|white ?paper)\b/.test(t)
  const make = /\b(write|make|create|build|draft|put together|prepare|generate|design|plan)\b/.test(t)
  const many = /\b(\d{2,}|all|every|each|top \d+|list of|dozens?|several)\b/.test(t)
  if (research && deliverable) return 'research plus a finished document'
  if (make && deliverable && (t.length > 60 || many)) return 'a long finished deliverable'
  if (research && many) return 'research across many sources'
  if (t.length > 280 && /\b(and then|after that|also|step)\b/.test(t)) return 'a long multi-step project'
  return ''
}

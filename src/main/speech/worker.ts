// Speech worker (runs in a worker_thread): the always-on part. It must stay tiny and never block.
//
//   mic 16 kHz  ->  Silero VAD
//                    └─ while speech is detected: a small streaming RU zipformer decodes live audio and the partial
//                       text is fuzzy-matched against the wake aliases (a cheap "did I hear the name?" gate)
//                    └─ when an utterance ends it is handed to the ASR child process (asr.ts) as a "job"; the heavy
//                       recognisers live there so their memory is freed when idle and decoding never stalls this loop.
import { parentPort } from 'worker_threads'
import { looseWakeGate } from '../../shared/textmatch'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sherpa = require('sherpa-onnx-node')

type Mode = 'wake' | 'command'

interface InitMsg {
  type: 'init'
  vad: string
  wakeDir: string
  aliases: string[]
  wakeEnabled: boolean
  patience?: 'quick' | 'normal' | 'relaxed'
}

const SR = 16000
const PREROLL = Math.floor(SR * 0.5)
// GigaAM decodes a minute of speech in one pass with no loss (benchmarked: 62 s, 99% identical to per-sentence), so long
// dictation is only limited by the timeout below
const MAX_UTTERANCE = SR * 75

let vad: any = null
let wakeRec: any = null
let aliases: string[] = []
let wakeEnabled = true
/** how long to wait through a pause before deciding the user is done: quick / normal / relaxed */
let patience: 'quick' | 'normal' | 'relaxed' = 'normal'
// the last word heard is a filler or a word that can't end a sentence ("um", "and", "the"…) → the user is still thinking.
// The live recogniser is a small Russian model, so English words may come out in Cyrillic: both spellings are listed.
const TRAILING = /(^|\s)(u+m+|u+h+|e+r+m*|h+m+|m{2,}|a+h+|so|and|but|or|like|the|a|an|to|of|for|with|in|on|my|your|is|are|that|then|because|if|which|what|when|maybe|i|you|we|can|could|would|please|э+|э+м+|а+м+|м{2,}|ну|и|а|но|или|что|как|чтобы|потому|ам|эн|зе|ту|ов|фо|виз|май|ай)$/i

let mode: Mode = 'wake'
let modeTimer: NodeJS.Timeout | null = null
let ring: Float32Array[] = []
let ringLen = 0

let inSpeech = false
let utt: Float32Array[] = []
let uttLen = 0
let stream: any = null
let wakeHit = false
let lastPartial = ''
let ignoreUntil = 0
// energy endpointing: VAD alone never ends an utterance while a movie / music is playing
let peak = 0
let quietRun = 0
let speechChunks = 0
// chunks since the VAD last heard a voice (silence as the VAD sees it, robust to background noise)
let vadQuiet = 0
let skippedSeg = false
const CHUNK_MS = (512 / SR) * 1000

const send = (m: any, transfer?: any[]) => parentPort!.postMessage(m, transfer as any)

function pushRing(chunk: Float32Array) {
  ring.push(chunk)
  ringLen += chunk.length
  while (ringLen - ring[0].length >= PREROLL) {
    ringLen -= ring[0].length
    ring.shift()
  }
}

function concat(chunks: Float32Array[], len: number) {
  const out = new Float32Array(len)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

function init(m: InitMsg) {
  try {
    aliases = m.aliases
    wakeEnabled = m.wakeEnabled
    if (m.patience) patience = m.patience
    vad = new sherpa.Vad(
      {
        sileroVad: { model: m.vad, threshold: 0.45, minSilenceDuration: 0.5, minSpeechDuration: 0.2, windowSize: 512, maxSpeechDuration: 75 },
        sampleRate: SR,
        numThreads: 1,
        debug: false
      },
      60
    )
    const d = m.wakeDir
    wakeRec = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: SR, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: `${d}/encoder.int8.onnx`, decoder: `${d}/decoder.onnx`, joiner: `${d}/joiner.int8.onnx` },
        tokens: `${d}/tokens.txt`,
        numThreads: 1,
        provider: 'cpu',
        debug: false
      },
      decodingMethod: 'greedy_search',
      enableEndpoint: false
    })
    send({ type: 'ready' })
  } catch (e: any) {
    send({ type: 'error', error: String(e?.stack || e) })
  }
}

function setMode(next: Mode, timeoutMs = 0, silent = false) {
  mode = next
  if (modeTimer) clearTimeout(modeTimer)
  modeTimer = null
  if (next === 'command' && timeoutMs > 0) {
    // Silence window: give up after `timeoutMs` without speech — but never cut the user off mid-sentence.
    const hardStop = Date.now() + timeoutMs + 70_000 // an utterance that never ends (noise/music) must not hold us forever
    const expire = () => {
      if (inSpeech && Date.now() < hardStop) {
        modeTimer = setTimeout(expire, 400)
        return
      }
      if (inSpeech) forceEnd('timeout')
      mode = 'wake'
      modeTimer = null
      send({ type: 'mode', mode: 'wake', timedOut: true })
    }
    modeTimer = setTimeout(expire, timeoutMs)
  }
  if (!silent) send({ type: 'mode', mode })
}

function startUtterance() {
  inSpeech = true
  peak = 0
  quietRun = 0
  speechChunks = 0
  vadQuiet = 0
  skippedSeg = false
  wakeHit = false
  lastPartial = ''
  utt = [...ring]
  uttLen = ringLen
  stream = wakeRec.createStream()
  for (const c of ring) stream.acceptWaveform({ sampleRate: SR, samples: c })
  send({ type: 'speech', on: true })
}

function feedWake(chunk: Float32Array) {
  if (!stream) return
  stream.acceptWaveform({ sampleRate: SR, samples: chunk })
  while (wakeRec.isReady(stream)) wakeRec.decode(stream)
  const text: string = wakeRec.getResult(stream).text || ''
  if (text && text !== lastPartial) {
    lastPartial = text
    send({ type: 'partial', text })
    if (!wakeHit && wakeEnabled && looseWakeGate(text, aliases)) {
      wakeHit = true
      send({ type: 'wake', text })
    }
  }
}

function endUtterance(segment?: Float32Array, reason = 'vad') {
  inSpeech = false
  const gateHit = wakeHit
  const partial = lastPartial
  const raw = segment && segment.length > SR * 0.3 ? segment : concat(utt, uttLen)
  const uttLenAtEnd = raw.length
  const samples = new Float32Array(raw) // own copy so its buffer can be transferred
  stream = null
  utt = []
  uttLen = 0
  send({ type: 'speech', on: false, reason, ms: Math.round((uttLenAtEnd / SR) * 1000), peak: Number(peak.toFixed(3)) })

  const commandMode = mode === 'command'
  if (!commandMode && (!wakeEnabled || samples.length > SR * 12)) return
  if (Date.now() < ignoreUntil) return
  send({ type: 'job', samples, commandMode, gateHit, partial }, [samples.buffer])
}

/** End the current utterance ourselves (energy / length based) and resync the VAD. */
function forceEnd(reason = 'energy') {
  if (!inSpeech) return
  endUtterance(undefined, reason)
  try {
    vad.reset()
  } catch {}
}

/** Silence needed before an utterance counts as finished. Longer requests and a trailing filler word get more room. */
function pauseMs(uttMs: number) {
  const [base, perMs, cap] = patience === 'quick' ? [520, 0.06, 1300] : patience === 'relaxed' ? [1300, 0.1, 2800] : [850, 0.08, 1900]
  let ms = mode === 'command' ? Math.min(cap, base + uttMs * perMs) : Math.min(cap * 0.7, base * 0.8 + uttMs * 0.05)
  if (TRAILING.test(lastPartial.trim())) ms = Math.min(ms + 1100, 3800)
  return ms
}

function rms(x: Float32Array) {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i] * x[i]
  return Math.sqrt(s / x.length)
}

let frameBuf = new Float32Array(0)

function onAudio(samples: Float32Array) {
  if (!vad || !wakeRec) return
  // sherpa VAD wants windowSize (512) aligned frames
  const merged = new Float32Array(frameBuf.length + samples.length)
  merged.set(frameBuf, 0)
  merged.set(samples, frameBuf.length)
  const n = Math.floor(merged.length / 512) * 512
  frameBuf = merged.slice(n)
  for (let off = 0; off < n; off += 512) {
    const copy = new Float32Array(merged.subarray(off, off + 512))
    vad.acceptWaveform(copy)
    const detected = vad.isDetected()
    if (!inSpeech) {
      pushRing(copy)
      if (detected) startUtterance()
    } else {
      utt.push(copy)
      uttLen += copy.length
      feedWake(copy)
      if (uttLen > MAX_UTTERANCE) vad.flush()
      // --- energy endpointing: the speaker is done when their level falls well below their own peak ---
      const e = rms(copy)
      peak = Math.max(peak * 0.997, e)
      speechChunks++
      const quiet = peak > 0.02 && e < Math.max(0.006, peak * 0.2)
      quietRun = quiet ? quietRun + 1 : 0
      vadQuiet = detected ? 0 : vadQuiet + 1
      // Adaptive patience: a short command ends quickly (low latency), while someone dictating a long request is given room
      // to breathe between clauses. The wake word / short phrases end sooner than free speech.
      const uttMs = speechChunks * CHUNK_MS
      const endMs = pauseMs(uttMs)
      const longEnough = uttMs > 600
      const cap = mode === 'command' ? 70_000 : 12_000
      if (((quietRun * CHUNK_MS >= endMs || (skippedSeg && vadQuiet * CHUNK_MS >= endMs)) && longEnough) || uttLen > (cap / 1000) * SR) {
        forceEnd()
        continue
      }
    }
    while (!vad.isEmpty()) {
      const seg = vad.front(false)
      vad.pop()
      if (!inSpeech) continue
      // the VAD closes a segment after ~0.5 s of silence; someone pausing to think hasn't finished yet
      const wait = pauseMs(speechChunks * CHUNK_MS)
      if (quietRun * CHUNK_MS < wait && vadQuiet * CHUNK_MS < wait && uttLen < MAX_UTTERANCE) {
        skippedSeg = true
        continue
      }
      // after skipped pauses the last VAD segment is only the tail: send the whole utterance
      endUtterance(skippedSeg ? undefined : seg.samples)
    }
  }
}

parentPort!.on('message', (m: any) => {
  switch (m.type) {
    case 'init':
      init(m)
      break
    case 'audio':
      onAudio(m.samples)
      break
    case 'mode':
      setMode(m.mode, m.timeoutMs || 0, !!m.silent)
      break
    case 'config':
      if (m.aliases) aliases = m.aliases
      if (typeof m.wakeEnabled === 'boolean') wakeEnabled = m.wakeEnabled
      if (m.patience) patience = m.patience
      break
    case 'speaking':
      if (!m.on) ignoreUntil = Date.now() + 250
      break
  }
})

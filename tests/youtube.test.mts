import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { firstVideo, matchYouTube } from '../src/main/youtube.ts'

test('youtube phrases', () => {
  assert.deepEqual(matchYouTube('open youtube and search for champions league highlights and click on the first video'), { query: 'champions league highlights', play: true })
  assert.deepEqual(matchYouTube('open youtube and search for premier league and click on the first video'), { query: 'premier league', play: true })
  assert.deepEqual(matchYouTube('search youtube for lofi beats'), { query: 'lofi beats', play: false })
  assert.deepEqual(matchYouTube('play messi goals on youtube'), { query: 'messi goals', play: true })
  assert.deepEqual(matchYouTube('Jarvis, open YouTube and search up chess openings.'), { query: 'chess openings', play: false })
  assert.equal(matchYouTube('comment on the first youtube video'), null)
  assert.equal(matchYouTube('open youtube'), null)
  assert.equal(matchYouTube('what time is it'), null)
})

test('first video from search data', () => {
  const v = firstVideo(readFileSync(new URL('./fixtures-yt.txt', import.meta.url), 'utf8'))
  assert.equal(v?.id, 'A-8UPN5wiRg')
  assert.match(v!.title, /Portugal vs Denmark/)
})

// Calendar (.ics) reading, school question matching and spoken answers — pure Node.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseIcs } from '../src/main/ics.ts'
import { matchSchool, rangeOf, describeEvents, describeDue, shortCourse, calendarTemplateUrl } from '../src/main/school.ts'

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:practice',
  'DTSTART;TZID=America/Vancouver:20261103T180000',
  'DTEND;TZID=America/Vancouver:20261103T193000',
  'RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261231T235959Z',
  'EXDATE;TZID=America/Vancouver:20261119T180000',
  'SUMMARY:Soccer practice',
  'LOCATION:Field 2',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:practice',
  'RECURRENCE-ID;TZID=America/Vancouver:20261117T180000',
  'DTSTART;TZID=America/Vancouver:20261117T190000',
  'DTEND;TZID=America/Vancouver:20261117T203000',
  'SUMMARY:Soccer practice (late)',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:lecture',
  'DTSTART:20261116T173000Z',
  'DTEND:20261116T190000Z',
  'SUMMARY:HES 201 lecture\\, room 101',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:allday',
  'DTSTART;VALUE=DATE:20261120',
  'DTEND;VALUE=DATE:20261121',
  'SUMMARY:Poster day',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:gone',
  'DTSTART:20261118T170000Z',
  'DTEND:20261118T180000Z',
  'STATUS:CANCELLED',
  'SUMMARY:Cancelled thing',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n')

test('ics: recurring weekly event with exdate and a moved occurrence', () => {
  const evs = parseIcs(ICS, new Date('2026-11-15T00:00:00Z'), new Date('2026-11-23T00:00:00Z'))
  const practice = evs.filter((e) => e.title.startsWith('Soccer'))
  // Tue 17 (moved to 19:00), Thu 19 (excluded) → only the moved one
  assert.equal(practice.length, 1)
  assert.equal(practice[0].title, 'Soccer practice (late)')
  assert.equal(practice[0].start.toISOString(), '2026-11-18T03:00:00.000Z') // 19:00 PST = 03:00 UTC next day
  assert.ok(evs.some((e) => e.title === 'HES 201 lecture, room 101'))
  assert.ok(evs.some((e) => e.title === 'Poster day' && e.allDay))
  assert.ok(!evs.some((e) => e.title.startsWith('Cancelled')))
})

test('ics: weekly rule keeps producing the right days and DST-correct times', () => {
  const evs = parseIcs(ICS, new Date('2026-11-01T00:00:00Z'), new Date('2026-11-08T00:00:00Z')).filter((e) => e.title === 'Soccer practice')
  // Nov 3 (Tue) and Nov 5 (Thu); DST ended Nov 1 → 18:00 PST = 02:00 UTC
  assert.deepEqual(evs.map((e) => e.start.toISOString()), ['2026-11-04T02:00:00.000Z', '2026-11-06T02:00:00.000Z'])
})

test('school: plain questions are matched, tasks are not', () => {
  const now = new Date(2026, 10, 15, 10, 0) // Sunday
  assert.equal(matchSchool("what's due this week", now)?.kind, 'due')
  assert.equal(matchSchool('Jarvis, do I have any assignments due tomorrow?', now)?.kind, 'due')
  assert.equal(matchSchool("what's on my calendar tomorrow", now)?.kind, 'calendar')
  assert.equal(matchSchool('what do i have today', now)?.kind, 'calendar')
  assert.equal(matchSchool('am I free on friday', now)?.kind, 'calendar')
  assert.equal(matchSchool('any new announcements', now)?.kind, 'announcements')
  assert.equal(matchSchool('what are my grades', now)?.kind, 'grades')
  assert.equal(matchSchool('add soccer practice to my calendar on thursday', now), null)
  assert.equal(matchSchool('help me write my HES 201 assignment', now), null)
  assert.equal(matchSchool('open canvas', now), null)
  assert.equal(matchSchool('play some music', now), null)
})

test('school: date ranges', () => {
  const now = new Date(2026, 10, 18, 14, 0) // Wednesday
  const tm = rangeOf('tomorrow', now)
  assert.equal(tm.from.getDate(), 19)
  assert.equal(tm.to.getDate(), 20)
  const wk = rangeOf('this week', now)
  assert.equal(wk.to.getDate(), 23) // through Sunday night
  const fri = rangeOf('on friday', now)
  assert.equal(fri.from.getDate(), 20)
  const nw = rangeOf('next week', now)
  assert.equal(nw.from.getDay(), 1)
  assert.equal(nw.from.getDate(), 23)
})

test('school: spoken answers', () => {
  const now = new Date(2026, 10, 18, 8, 0)
  const e = [{ title: 'Soccer practice', start: new Date(2026, 10, 18, 18, 0), end: new Date(2026, 10, 18, 19, 30), allDay: false }]
  assert.equal(describeEvents(e, 'today', now), 'Today you have 6 PM Soccer practice.')
  assert.equal(describeEvents([], 'tomorrow', now), 'Nothing on your calendar tomorrow.')
  const d = describeDue(
    [
      { title: 'Poster draft', course: 'HES 201', due: new Date(2026, 10, 19, 23, 59), type: 'assignment', done: false, missing: false },
      { title: 'Quiz 4', course: 'HMKN 190', due: new Date(2026, 10, 20, 12, 0), type: 'quiz', done: true, missing: false }
    ],
    'this week',
    now
  )
  assert.equal(d, 'Due this week: HES 201 Poster draft, tomorrow at 11:59 PM. 1 already submitted.')
  assert.equal(shortCourse('HES_O 201 001 2026W1 Foundations'), 'HES 201')
})

test('school: google calendar pre-filled event link', () => {
  const u = new URL(calendarTemplateUrl({ title: 'Soccer', start: '2026-11-19T18:00', location: 'Field 2' }))
  assert.equal(u.searchParams.get('action'), 'TEMPLATE')
  assert.equal(u.searchParams.get('dates'), '20261119T180000/20261119T190000')
  assert.equal(u.searchParams.get('location'), 'Field 2')
  const all = new URL(calendarTemplateUrl({ title: 'Poster day', start: '2026-11-20' }))
  assert.equal(all.searchParams.get('dates'), '20261120/20261121')
})

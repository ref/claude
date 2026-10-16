import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Snapshot, Window } from '../types'

const DAY_MS = 86_400_000
const WEEK_DAYS = 7
const STORE_KEY = 'paced'

const snapshot = atom({ plugin: 'usage-pacer', key: 'snapshot' } as const, null)

type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

// A muted traffic light: sage, amber, brick
const TONE = {
  ok: { terminal: 'green', svg: '#6f9a7a' },
  warn: { terminal: 'yellow', svg: '#c9a04e' },
  over: { terminal: 'red', svg: '#b8604a' },
} as const
type Tone = keyof typeof TONE

// ---------- math ----------

function toWindow(limit: RateLimit | undefined): Window | null {
  if (!limit) return null
  const ms = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  return { percent: limit.percentUsed, resetsAtMs: Number.isFinite(ms) ? ms : null }
}

/** 1..7: which day of the 7-day window we are in, counted back from its reset time. */
function dayOfWindow(resetsAtMs: number | null, nowMs: number): number {
  if (resetsAtMs === null) return WEEK_DAYS
  const daysLeft = (resetsAtMs - nowMs) / DAY_MS
  return Math.min(WEEK_DAYS, Math.max(1, WEEK_DAYS - Math.floor(daysLeft)))
}

function buildSnapshot(limits: readonly RateLimit[], nowMs: number, dailyPercent: number): Snapshot {
  const week = toWindow(limits.find(l => l.kind === 'seven_day'))
  const session = toWindow(limits.find(l => l.kind === 'five_hour'))
  const day = week ? dayOfWindow(week.resetsAtMs, nowMs) : 0
  const threshold = week ? Math.min(100, Math.round(day * dailyPercent * 10) / 10) : 100
  return {
    week,
    session,
    day,
    threshold,
    isOver: week ? week.percent > threshold : false,
    dailyPercent,
  }
}

function timeLeft(resetsAtMs: number | null, nowMs: number): string {
  if (resetsAtMs === null) return '?'
  const total = Math.max(0, Math.round((resetsAtMs - nowMs) / 60_000))
  const d = Math.floor(total / 1440)
  const h = Math.floor((total % 1440) / 60)
  const m = total % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`
  return `${m}m`
}

function pct(n: number): string {
  return `${Number.isInteger(n) ? n : n.toFixed(1)}%`
}

function toneOf(s: Snapshot): Tone {
  if (!s.week) return 'ok'
  if (s.isOver) return 'over'
  if (s.week.percent > s.threshold * 0.85) return 'warn'
  return 'ok'
}

// ---------- persistence ----------

async function loadPaced($: EngineInterface): Promise<string[]> {
  const saved = await $.store.get(STORE_KEY)
  return Array.isArray(saved) ? saved.filter((p): p is string => typeof p === 'string') : []
}

async function isCwdPaced($: EngineInterface): Promise<boolean> {
  const list = await loadPaced($)
  const cwd = await $.session.cwd()
  return list.includes(cwd)
}

async function setPaced($: EngineInterface, on: boolean): Promise<string> {
  const cwd = await $.session.cwd()
  const current = await loadPaced($)
  const list = on ? Array.from(new Set([...current, cwd])) : current.filter(p => p !== cwd)
  await $.store.set(STORE_KEY, list)
  $.ui.invalidate('ui.render')
  return cwd
}

/** Re-reads the account's rate limits and stores a fresh snapshot. */
async function refresh($: EngineInterface, dailyPercent: number): Promise<Snapshot> {
  const usage = await $.session.usage()
  const now = await $.clock.now()
  const next = buildSnapshot(usage.rateLimits, now, dailyPercent)
  await update($, snapshot, () => next)
  return next
}

// ---------- text ----------

function blockReason(s: Snapshot): string {
  const used = s.week ? pct(s.week.percent) : '?'
  return (
    `usage-pacer: this project is paced and the weekly limit is ahead of schedule ` +
    `(day ${s.day}/7: ${used} used, ${pct(s.threshold)} allowed). ` +
    `Stop here and end the turn. Do not retry or look for another way; the user will continue tomorrow or run /pacer off.`
  )
}

function statusText(s: Snapshot, paced: boolean, cwd: string, all: readonly string[], nowMs: number): string {
  const head = `${paced ? 'paced' : 'not paced'} · ${cwd}`
  const body = s.week
    ? `day ${s.day}/7 · used ${pct(s.week.percent)} · allowed ${pct(s.threshold)}` +
      `${s.isOver ? ' · OVER' : ' · ok'} · resets in ${timeLeft(s.week.resetsAtMs, nowMs)}` +
      (s.session ? `\n5h window · used ${pct(s.session.percent)} · resets in ${timeLeft(s.session.resetsAtMs, nowMs)}` : '')
    : 'no rate-limit reading yet (subscription plans only; appears after the first response)'
  const list = all.length
    ? `paced projects:\n${all.map(p => '  ' + p).join('\n')}`
    : 'no paced projects yet — run /pacer on inside one'
  return `${head}\n${body}\n${list}`
}

/** The right-hand caption: day, 5h window, time to the weekly reset. */
function caption(s: Snapshot, nowMs: number): string {
  const parts = [`day ${s.day}/7`]
  if (s.session) parts.push(`5h ${pct(s.session.percent)}`)
  if (s.week) parts.push(`resets ${timeLeft(s.week.resetsAtMs, nowMs)}`)
  return parts.join(' · ')
}

function headline(s: Snapshot): string {
  if (!s.week) return ''
  return s.isOver ? `PAUSED · ${pct(s.week.percent)} of ${pct(s.threshold)}` : `${pct(s.week.percent)} of ${pct(s.threshold)}`
}

// ---------- SVG row for the desktop ----------

const ROW_H = 22
const BAR_H = 14
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function rowSvg(s: Snapshot, W: number, nowMs: number): string {
  const week = s.week!
  const tone = TONE[toneOf(s)].svg
  const title = 'pacer'
  const head = headline(s)
  const cap = caption(s, nowMs)

  const titleW = 40
  const headW = Math.round(head.length * 6.4 + 8)
  const capW = Math.round(cap.length * 6.1 + 8)
  const BAR_X = 16 + titleW
  const BAR_W = Math.max(80, W - BAR_X - headW - capW - 24)
  const y0 = (ROW_H - BAR_H) / 2

  const fillW = Math.round((BAR_W * Math.min(100, week.percent)) / 100)
  const markX = Math.round((BAR_W * s.threshold) / 100)

  // Day ticks on the track, one per day of the week
  const ticks: string[] = []
  for (let d = 1; d < WEEK_DAYS; d++) {
    const x = Math.round((BAR_W * Math.min(100, d * s.dailyPercent)) / 100)
    ticks.push(`<rect x="${x}" y="${BAR_H / 2 - 3}" width="1" height="6" rx="0.5"/>`)
  }

  const headX = BAR_X + BAR_W + 10
  const capX = W - 8

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${ROW_H}" viewBox="0 0 ${W} ${ROW_H}">
<style>
.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e6e6e3}.tk{fill:#c9c9c5}.mk{fill:#3a3a3a}
@media (prefers-color-scheme: dark){.t{fill:#e8e8e6}.m{fill:#9a9a9a}.k{fill:#2a2a2a}.tk{fill:#4a4a4a}.mk{fill:#dadada}}
</style>
<circle cx="6" cy="${ROW_H / 2}" r="3.5" fill="${tone}"/>
<text class="t" x="16" y="${ROW_H / 2 + 4.5}" font-family="${FONT}" font-size="12.5" font-weight="500">${title}</text>
<g transform="translate(${BAR_X},${y0})">
<defs><clipPath id="c"><rect width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath></defs>
<rect class="k" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#c)">
<rect width="${fillW}" height="${BAR_H}" fill="${tone}"/>
<g class="tk">${ticks.join('')}</g>
</g>
<rect class="mk" x="${markX - 1}" y="-2" width="2" height="${BAR_H + 4}" rx="1"/>
</g>
<text x="${headX}" y="${ROW_H / 2 + 4.5}" font-family="${FONT}" font-size="12" font-weight="600" fill="${tone}" font-variant-numeric="tabular-nums">${xml(head)}</text>
<text class="m" x="${capX}" y="${ROW_H / 2 + 4.5}" text-anchor="end" font-family="${FONT}" font-size="11.5" font-variant-numeric="tabular-nums">${xml(cap)}</text>
</svg>`
}

// ---------- terminal fallback ----------

function barCells(width: number, percent: number, marker: number): { fill: string; rest: string; markAt: number } {
  const w = Math.max(8, width)
  const filled = Math.min(w, Math.round((Math.max(0, percent) / 100) * w))
  const markAt = Math.min(w - 1, Math.round((marker / 100) * w))
  return { fill: '█'.repeat(filled), rest: '░'.repeat(w - filled), markAt }
}

export const register: Register = (on, options) => {
  const dailyPercent = Number(options.daily_percent ?? 14.3)
  const blockTools = options.block_tools !== false

  let turnId: string | null = null
  let abortedTurn: string | null = null
  let wasOver = false
  let nowMs = Date.now()

  on('session.start', async ($, e, next) => {
    await refresh($, dailyPercent)
    nowMs = await $.clock.now()
    // Keep the countdown in the band current
    $.clock.every(60_000, async () => {
      nowMs = await $.clock.now()
      $.ui.invalidate('ui.render')
    })
    try {
      await $.command.register({
        name: 'pacer',
        description: 'Pace this project against the weekly limit: on, off, status',
        argumentHint: '[on|off|status]',
        immediate: true,
      })
    } catch {
      // Already registered by a previous load; nothing to do
    }
    return next(e)
  })

  // /clear, /resume and /branch reset $.state, so load it again
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await refresh($, dailyPercent)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    nowMs = await $.clock.now()
    const s = buildSnapshot(e.rateLimits, nowMs, dailyPercent)
    await update($, snapshot, () => s)
    if (s.isOver && !wasOver && (await isCwdPaced($)) && s.week) {
      $.ui.toast(`Weekly limit ahead of schedule: ${pct(s.week.percent)} used, ${pct(s.threshold)} allowed. This project is paused.`)
    }
    wasOver = s.isOver
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    turnId = e.turnId
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!(await isCwdPaced($))) return next(e)
    const s = await refresh($, dailyPercent)
    if (!s.isOver || !s.week) return next(e)
    $.ui.toast(`Paused: ${pct(s.week.percent)} of the week used, ${pct(s.threshold)} allowed on day ${s.day}.`)
    return { drop: blockReason(s) }
  }).catch(($, e, next) => {
    // A broken pacer must never lock the person out of their own session
    $.ui.log(`pacer check failed (${next.error.kind}); the prompt went through`)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!blockTools) return next(e)
    if (!(await isCwdPaced($))) return next(e)
    const s = (await read($, snapshot)) ?? (await refresh($, dailyPercent))
    if (!s.isOver || !s.week) return next(e)
    if (turnId && abortedTurn !== turnId) {
      abortedTurn = turnId
      $.ui.toast(`Weekly limit ahead of schedule (${pct(s.week.percent)} > ${pct(s.threshold)}). Stopping this turn.`)
      void $.turn.abort({ turnId }).catch(() => {})
    }
    return { deny: blockReason(s) }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'pacer' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()

    if (arg === 'on' || arg === 'off') {
      const cwd = await setPaced($, arg === 'on')
      await refresh($, dailyPercent)
      return { text: arg === 'on' ? `pacing ${cwd}` : `no longer pacing ${cwd}` }
    }

    const s = await refresh($, dailyPercent)
    nowMs = await $.clock.now()
    const cwd = await $.session.cwd()
    const all = await loadPaced($)
    return { text: statusText(s, all.includes(cwd), cwd, all, nowMs) }
  })

  // ---------- the band above the prompt ----------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await isCwdPaced($))) return next(e)
    const s = await read($, snapshot)
    if (!s || !s.week) return next(e)

    // Keep the other mods' bands beneath this row; the engine's own placeholder is never nested
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const tone = toneOf(s)

    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      // About 8 CSS px per reported column
      const width = Math.max(320, Math.min(1400, (e.props.bodyColumns || 100) * 8 - 32))
      return (
        <Box flexDirection="column">
          <Svg source={rowSvg(s, width, nowMs)} alt={`pacer: ${headline(s)}, ${caption(s, nowMs)}`} width={width} height={ROW_H} />
          {below}
        </Box>
      )
    }

    const head = headline(s)
    const cap = caption(s, nowMs)
    const width = Math.max(10, Math.min(40, e.props.bodyColumns - head.length - cap.length - 14))
    const { fill, rest, markAt } = barCells(width, s.week.percent, s.threshold)
    const cells = fill + rest
    const before = cells.slice(0, markAt)
    const after = cells.slice(markAt + 1)
    const filledBefore = Math.min(fill.length, before.length)
    const filledAfter = Math.max(0, fill.length - markAt - 1)
    const color = TONE[tone].terminal

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={color}>●</Text>
          <Text>pacer</Text>
          <Box>
            <Text color={color}>{before.slice(0, filledBefore)}</Text>
            <Text dimColor>{before.slice(filledBefore)}</Text>
            <Text bold>│</Text>
            <Text color={color}>{after.slice(0, filledAfter)}</Text>
            <Text dimColor>{after.slice(filledAfter)}</Text>
          </Box>
          <Text color={color} bold>{head}</Text>
          <Text dimColor>{cap}</Text>
        </Box>
        {below}
      </Box>
    )
  })
}

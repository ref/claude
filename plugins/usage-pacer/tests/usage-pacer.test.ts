import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const CWD = '/home/me/pet-project'
const NOW = Date.parse('2026-10-16T12:00:00Z')

type Usage = { percentUsed: number; daysLeft: number }

// Stand in for the engine: a clock, a store, the session's cwd and its rate limits
function world(on: On, usage: Usage, paced: readonly string[] = [CWD]) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { paced: [...paced] })
  on('session.cwd', () => ({ value: CWD }))
  on('session.usage', () => ({
    value: {
      context: { window: 200_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 10, resetsAt: new Date(NOW + 3_600_000).toISOString() },
        {
          kind: 'seven_day',
          percentUsed: usage.percentUsed,
          resetsAt: new Date(NOW + usage.daysLeft * 86_400_000).toISOString(),
        },
      ],
    },
  }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('turn.abort', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: 'ran' }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('ui.invalidate', () => ({ value: undefined }))
  return clock
}

test('a paced project under its daily share lets prompts and tools through', async ($, on) => {
  // Day 3 of the window (4.5 days left): 42.9% allowed, 30% used
  world(on, { percentUsed: 30, daysLeft: 4.5 })

  const entered = await $.prompt.submit({ text: 'hello' })
  expect(entered.drop).toBeUndefined()

  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(ran.deny).toBeUndefined()
})

test('a paced project ahead of schedule has its prompt dropped and tools denied', async ($, on) => {
  // Day 2 (5.5 days left): 28.6% allowed, 40% used
  world(on, { percentUsed: 40, daysLeft: 5.5 })

  const entered = await $.prompt.submit({ text: 'hello' })
  expect(entered.drop).toContain('ahead of schedule')
  expect(entered.drop).toContain('28.6%')

  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(ran.deny).toContain('ahead of schedule')
})

test('an unpaced project is never blocked, however far ahead the week is', async ($, on) => {
  world(on, { percentUsed: 95, daysLeft: 6.5 }, [])

  const entered = await $.prompt.submit({ text: 'hello' })
  expect(entered.drop).toBeUndefined()

  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(ran.deny).toBeUndefined()
})

test('/pacer on marks the current directory and /pacer off clears it', async ($, on) => {
  world(on, { percentUsed: 95, daysLeft: 6.5 }, [])

  const on1 = await $.command.run({ command: 'pacer', args: 'on' })
  expect(on1.text).toContain(`pacing ${CWD}`)
  expect((await $.command.run({ command: 'pacer', args: 'status' })).text).toContain(`  ${CWD}`)

  const blocked = await $.prompt.submit({ text: 'hello' })
  expect(blocked.drop).toContain('ahead of schedule')

  const off = await $.command.run({ command: 'pacer', args: 'off' })
  expect(off.text).toContain('no longer pacing')
  expect((await $.command.run({ command: 'pacer', args: 'status' })).text).toContain('no paced projects yet')

  const entered = await $.prompt.submit({ text: 'hello' })
  expect(entered.drop).toBeUndefined()
})

test('/pacer status reports the day, the usage and the allowance', async ($, on) => {
  world(on, { percentUsed: 40, daysLeft: 5.5 })

  const status = await $.command.run({ command: 'pacer', args: 'status' })
  expect(status.text).toContain('day 2/7')
  expect(status.text).toContain('used 40%')
  expect(status.text).toContain('allowed 28.6%')
  expect(status.text).toContain('OVER')
})

test('the band above the prompt shows the pace for a paced project only', async ($, on) => {
  world(on, { percentUsed: 30, daysLeft: 4.5 })
  await $.prompt.submit({ text: 'warm up' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'usage-pacer',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 80 },
    })
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: /30% of 42\.9%/ })).toBeDefined()
    } else {
      expect(await ui.find({ type: 'Svg' })).toBeDefined()
    }
    await ui.unmount()
  }
})

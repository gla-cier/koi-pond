import { expect, mock, test } from 'claude-code/testing'

const band = (props: Record<string, unknown>) =>
  ({ component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 120, ...props } }) as any
const emptyBand = () => ({ type: 'Box', props: {}, children: [] }) as any

test('the pond fills the band on the terminal and falls back to a line elsewhere', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, emptyBand)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'koi-pond', surface, ...band({}) })
    if (surface === 'terminal') {
      const pond = await ui.find({ type: 'Raster', key: 'pond' } as any)
      expect(pond).toBeDefined()
      // the band's width less one cell of padding each side, six rows of braille
      expect((pond as any).props.columns).toBe(118)
      expect((pond as any).props.rows).toBe(6)
    } else {
      expect(await ui.find({ type: 'Text', text: /koi pond/ })).toBeDefined()
    }
    await ui.unmount()
  }
})

test('a short band gets the one-line pond', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, emptyBand)
  const ui = await $.ui.mount({ plugin: 'koi-pond', surface: 'terminal', ...band({ maxRows: 3 }) })
  expect(await ui.find({ type: 'Raster', key: 'pond' } as any)).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /koi pond/ })).toBeDefined()
  await ui.unmount()
})

test('a survey gets the band to itself', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, emptyBand)
  const ui = await $.ui.mount({ plugin: 'koi-pond', surface: 'terminal', ...band({ hasSurvey: true }) })
  expect(await ui.find({ type: 'Raster', key: 'pond' } as any)).toBeUndefined()
  await ui.unmount()
})

const holder = {
  name: 'holder',
  tier: 'append',
  register(on: any) {
    on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
      const { Box, Text, Button } = $.ui.resolve(e)
      return Box({ children: [
        Text({ children: '⚠ Blast Radius · rm -rf build' }),
        Button({ key: 'proceed', label: 'Proceed', onPress: () => {} }),
      ] })
    })
  },
} as any

test('a band with buttons beneath it is left alone', { plugins: [holder] }, async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, emptyBand)
  const ui = await $.ui.mount({ plugin: 'koi-pond', surface: 'terminal', ...band({}) })
  expect(await ui.find({ type: 'Raster', key: 'pond' } as any)).toBeUndefined()
  expect(await ui.find({ plugin: 'holder', type: 'Button', key: 'proceed' } as any)).toBeDefined()
  await ui.unmount()
})

test('the rows option sets the pond height', { options: { rows: 4 } }, async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, emptyBand)
  const ui = await $.ui.mount({ plugin: 'koi-pond', surface: 'terminal', ...band({ maxRows: 4 }) })
  const pond = await ui.find({ type: 'Raster', key: 'pond' } as any)
  expect(pond).toBeDefined()
  expect((pond as any).props.rows).toBe(4)
  await ui.unmount()
})

test('a blank row sits under the band, and one over it, when there is room for them', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, emptyBand)
  for (const [maxRows, top, bottom] of [[8, 1, 1], [7, 0, 1], [6, 0, 0]] as const) {
    const ui = await $.ui.mount({ plugin: 'koi-pond', surface: 'terminal', ...band({ maxRows }) })
    const box = await ui.find({ type: 'Box' } as any)
    expect((box as any).props.paddingTop).toBe(top)
    expect((box as any).props.paddingBottom).toBe(bottom)
    expect((await ui.find({ type: 'Raster', key: 'pond' } as any) as any).props.rows).toBe(6)
    await ui.unmount()
  }
})

const glyphs = (pond: any) => {
  const bytes = Uint8Array.from(atob(pond.props.cells), (c: string) => c.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  const out: number[][] = []
  for (let k = 0; k < words.length; k += 3) out.push([words[k]!, words[k + 1]!, words[k + 2]!])
  return out
}

test('the pixels option draws the koi in half blocks', { options: { fish: 'pixels' } }, async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, emptyBand)
  const ui = await $.ui.mount({ plugin: 'koi-pond', surface: 'terminal', ...band({}) })
  const cells = glyphs(await ui.find({ type: 'Raster', key: 'pond' } as any))
  // koi in half blocks: some cells carry two colours, upper glyph over lower background
  expect(cells.some(([g, , bg]) => g === 0x2580 && bg !== 0x01000000)).toBe(true)
  expect(cells.some(([g]) => g >= 0x2800 && g <= 0x28ff)).toBe(false)
  await ui.unmount()
})

test('the koi are drawn in braille by default', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, emptyBand)
  const ui = await $.ui.mount({ plugin: 'koi-pond', surface: 'terminal', ...band({}) })
  const cells = glyphs(await ui.find({ type: 'Raster', key: 'pond' } as any))
  expect(cells.some(([g]) => g > 0x2800 && g <= 0x28ff)).toBe(true)
  expect(cells.every(([, , bg]) => bg === 0x01000000)).toBe(true) // braille keeps the terminal's background
  await ui.unmount()
})

for (const fish of ['pixels', 'dots'] as const) {
  test(`the tank view lays gravel along the bottom (${fish})`, { options: { view: 'tank', fish } }, async ($, on) => {
    on('ui.render', { component: 'AbovePrompt' }, emptyBand)
    const ui = await $.ui.mount({ plugin: 'koi-pond', surface: 'terminal', ...band({}) })
    const pond = await ui.find({ type: 'Raster', key: 'pond' } as any)
    const cells = glyphs(pond)
    const cols = (pond as any).props.columns
    const bottom = cells.slice(-cols)
    expect(bottom.filter(([g]) => g !== 0x20).length).toBe(cols)
    await ui.unmount()
  })

  test(`the tank has glass at both ends (${fish})`, { options: { view: 'tank', fish } }, async ($, on) => {
    on('ui.render', { component: 'AbovePrompt' }, emptyBand)
    const ui = await $.ui.mount({ plugin: 'koi-pond', surface: 'terminal', ...band({}) })
    const pond = await ui.find({ type: 'Raster', key: 'pond' } as any)
    const cells = glyphs(pond)
    const cols = (pond as any).props.columns
    for (let r = 0; r < cells.length / cols; r += 1) {
      expect(cells[r * cols]![0]).not.toBe(0x20)
      expect(cells[r * cols + cols - 1]![0]).not.toBe(0x20)
    }
    await ui.unmount()
  })
}

test('past 80% night falls on the pond and the moon lies on the water, over the koi', async ($, on) => {
  // the test answers $.session.usage beneath the plugin: 270k of a 300k window
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: 270_000, window: 300_000, percent: 90 } } }) as any)
  on('ui.render', { component: 'AbovePrompt' }, emptyBand)
  const { text } = (await $.command.run({ command: 'koi' } as any)) as any // /koi takes a reading
  expect(text).toMatch(/90%: asleep/)
  const ui = await $.ui.mount({ plugin: 'koi-pond', surface: 'terminal', ...band({}) })
  const pond = await ui.find({ type: 'Raster', key: 'pond' } as any)
  const cells = glyphs(pond)
  const cols = (pond as any).props.columns
  const rows = (pond as any).props.rows
  // the moon's core, where the plugin puts it: 64% across, 42% down, full braille, pale
  const [g, fg] = cells[Math.floor(rows * 0.42) * cols + Math.floor(cols * 0.64)]!
  expect(g).toBe(0x28ff)
  // full moonlight: the moon's colour 90% of the way from the dark ground
  const want = [[0x16, 0xe9], [0x18, 0xe6], [0x1c, 0xd2]].map(([a, m]) => Math.round(a! + (m! - a!) * 0.9))
  const got = [(fg! >> 16) & 255, (fg! >> 8) & 255, fg! & 255]
  got.forEach((c, k) => expect(Math.abs(c - want[k]!)).toBeLessThan(3))
  await ui.unmount()
})

const moonCore = (pond: any) => {
  const cells = glyphs(pond)
  const cols = pond.props.columns
  const rows = pond.props.rows
  return cells[Math.floor(rows * 0.42) * cols + Math.floor(cols * 0.64)]!
}

test('/koi night previews the night without touching the reading, and /koi live ends it', async ($, on) => {
  // a nearly empty context: only the preview can bring the night
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: 3_000, window: 300_000, percent: 1 } } }) as any)
  on('ui.render', { component: 'AbovePrompt' }, emptyBand)
  const ui = await $.ui.mount({ plugin: 'koi-pond', surface: 'terminal', ...band({}) })
  expect(moonCore(await ui.find({ type: 'Raster', key: 'pond' } as any))[0]).not.toBe(0x28ff)
  const night = (await $.command.run({ command: 'koi', args: 'night' } as any)) as any
  expect(night.text).toMatch(/Night falls/)
  expect(moonCore(await ui.find({ type: 'Raster', key: 'pond' } as any))[0]).toBe(0x28ff)
  // the report stays true, and names the preview
  const report = (await $.command.run({ command: 'koi' } as any)) as any
  expect(report.text).toMatch(/1%: fresh/)
  expect(report.text).toMatch(/Previewing night/)
  const live = (await $.command.run({ command: 'koi', args: 'live' } as any)) as any
  expect(live.text).toMatch(/night preview is over/)
  expect(moonCore(await ui.find({ type: 'Raster', key: 'pond' } as any))[0]).not.toBe(0x28ff)
  await ui.unmount()
})

test('/koi feed drops food in on demand', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, emptyBand)
  const ui = await $.ui.mount({ plugin: 'koi-pond', surface: 'terminal', ...band({}) })
  const fed = (await $.command.run({ command: 'koi', args: 'feed' } as any)) as any
  expect(fed.text).toMatch(/Food drops in/)
  await ui.unmount()
  const usage = (await $.command.run({ command: 'koi', args: 'nonsense' } as any)) as any
  expect(usage.text).toMatch(/\/koi feed/)
})

test('a tree drawn beneath the band keeps its place under the koi', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: 'meter 42%' })
  })
  const ui = await $.ui.mount({ plugin: 'koi-pond', surface: 'terminal', ...band({}) })
  expect(await ui.find({ type: 'Raster', key: 'pond' } as any)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /meter 42%/ })).toBeDefined()
  await ui.unmount()
})

test('the pond stops idleMinutes after the last sign of life, and the next one starts it again', { options: { idleMinutes: 0.05 } }, async ($, on) => {
  // three seconds of quiet (0.05 min) stand in for the five minutes the default gives
  const clock = mock.clock(on)
  let paints = 0 // one $.ui.blit per tick while the pond is drawn; the test takes each one
  on('ui.blit', () => (paints += 1, { value: {} }) as any)
  on('ui.render', { component: 'AbovePrompt' }, emptyBand)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'koi-pond', surface: 'terminal', ...band({}) })
  const painted = async (ms: number) => {
    const before = paints
    await clock.advance(ms)
    return paints - before
  }
  expect(await painted(1_000)).toBeGreaterThanOrEqual(3) // 4 a second while awake
  await clock.advance(3_000)
  expect(await painted(2_000)).toBe(0) // a still pond: the timer is gone
  await $.turn.start({ text: 'hello', turnId: 't1' })
  expect(await painted(1_000)).toBeGreaterThanOrEqual(3) // and back at full rate
  await clock.advance(3_000)
  expect(await painted(2_000)).toBe(0)
  await ui.unmount()
})

test('fps sets the tick: 10 a second paints about ten times in a second', { options: { fps: '10', idleMinutes: 0 } }, async ($, on) => {
  const clock = mock.clock(on)
  let paints = 0
  on('ui.blit', () => (paints += 1, { value: {} }) as any)
  on('ui.render', { component: 'AbovePrompt' }, emptyBand)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'koi-pond', surface: 'terminal', ...band({}) })
  paints = 0
  await clock.advance(1_000)
  expect(paints).toBeGreaterThanOrEqual(9)
  expect(paints).toBeLessThanOrEqual(11)
  await ui.unmount()
})

test('while a turn runs the rate drops to workingFps, and the chosen rate comes back when it completes', { options: { fps: '60', workingFps: '10', idleMinutes: 0 } }, async ($, on) => {
  const clock = mock.clock(on)
  let paints = 0
  on('ui.blit', () => (paints += 1, { value: {} }) as any)
  on('ui.render', { component: 'AbovePrompt' }, emptyBand)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'koi-pond', surface: 'terminal', ...band({}) })
  const painted = async (ms: number) => {
    const before = paints
    await clock.advance(ms)
    return paints - before
  }
  expect(await painted(1_000)).toBeGreaterThanOrEqual(50) // the chosen 60 while idle
  await $.turn.start({ text: 'build it', turnId: 't1' })
  expect(await painted(1_000)).toBeLessThanOrEqual(11) // 10 while the turn runs
  await $.turn.complete({ turnId: 't1', answer: 'done', reason: 'answer', durationMs: 1_000 } as any)
  expect(await painted(1_000)).toBeGreaterThanOrEqual(50) // and back to 60
  await ui.unmount()
})

test('workingFps same keeps the chosen rate through a turn', { options: { fps: '60', workingFps: 'same', idleMinutes: 0 } }, async ($, on) => {
  const clock = mock.clock(on)
  let paints = 0
  on('ui.blit', () => (paints += 1, { value: {} }) as any)
  on('ui.render', { component: 'AbovePrompt' }, emptyBand)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'koi-pond', surface: 'terminal', ...band({}) })
  await $.turn.start({ text: 'build it', turnId: 't1' })
  paints = 0
  await clock.advance(1_000)
  expect(paints).toBeGreaterThanOrEqual(50)
  await ui.unmount()
})

test('workingFps defaults to 4 while a turn runs', { options: { fps: '60', idleMinutes: 0 } }, async ($, on) => {
  const clock = mock.clock(on)
  let paints = 0
  on('ui.blit', () => (paints += 1, { value: {} }) as any)
  on('ui.render', { component: 'AbovePrompt' }, emptyBand)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'koi-pond', surface: 'terminal', ...band({}) })
  await $.turn.start({ text: 'build it', turnId: 't1' })
  paints = 0
  await clock.advance(1_000)
  expect(paints).toBeLessThanOrEqual(5)
  expect(paints).toBeGreaterThanOrEqual(3)
  await ui.unmount()
})

// The caret: prompt.edit as the composer raises it, the box's own answer beneath.
const edit = (text: string, at: number, inputText: string) => ({ origin: { kind: 'composer' }, text, cursor: at, start: at, end: at, inputText }) as any
const theBox = (on: any) => on('prompt.edit', (_: any, e: any) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
const litDots = (cells: number[][], cols: number, rows: number[], from: number, to: number, bright = 0) => {
  let n = 0
  for (const r of rows) for (let c = from; c <= to; c++) {
    const [g, fg] = cells[r * cols + c]!
    const lum = (((fg! >> 16) & 255) + ((fg! >> 8) & 255) + (fg! & 255)) / 3
    if (g! > 0x2800 && g! <= 0x28ff && lum > bright) for (let b = g! - 0x2800; b; b >>= 1) n += b & 1
  }
  return n
}

test('typing passes through untouched: the box is what the editor made it', async ($, on) => {
  theBox(on)
  on('ui.render', { component: 'AbovePrompt' }, emptyBand)
  const ui = await $.ui.mount({ plugin: 'koi-pond', surface: 'terminal', ...band({}) })
  const box = (await $.prompt.edit(edit('fix th', 6, 'e'))) as any
  expect(box.text).toBe('fix the')
  expect(box.cursor).toBe(7)
  await ui.unmount()
})

test('a koi comes to look where you type, by the bottom edge over the caret', { options: { idleMinutes: 0 } }, async ($, on) => {
  const clock = mock.clock(on)
  theBox(on)
  on('ui.render', { component: 'AbovePrompt' }, emptyBand)
  const ui = await $.ui.mount({ plugin: 'koi-pond', surface: 'terminal', ...band({}) })
  let text = ''
  for (const ch of 'the koi should come and look at what i am typing here, ok') {
    await $.prompt.edit(edit(text, text.length, ch))
    text += ch
    await clock.advance(150)
  }
  const pond = (await ui.find({ type: 'Raster', key: 'pond' } as any)) as any
  const col = 2 + text.length // "> " then the draft
  // a koi's bright body in the bottom two rows, just behind the caret
  expect(litDots(glyphs(pond), pond.props.columns, [4, 5], col - 14, col + 1, 150)).toBeGreaterThan(20)
  await ui.unmount()
})

test('asleep, a keystroke still rings the water over the caret', { options: { idleMinutes: 0 } }, async ($, on) => {
  const clock = mock.clock(on)
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: 270_000, window: 300_000, percent: 90 } } }) as any)
  theBox(on)
  on('ui.render', { component: 'AbovePrompt' }, emptyBand)
  await $.command.run({ command: 'koi' } as any)
  const ui = await $.ui.mount({ plugin: 'koi-pond', surface: 'terminal', ...band({}) })
  await clock.advance(8_000) // the koi settle (30 s of pond clock nears the test's 5 s limit)
  const ring = async () => {
    const pond = (await ui.find({ type: 'Raster', key: 'pond' } as any)) as any
    return litDots(glyphs(pond), pond.props.columns, [5], 1, 6)
  }
  const before = await ring()
  await $.prompt.edit(edit('', 0, 'a'))
  await clock.advance(250)
  expect(await ring()).toBeGreaterThan(before)
  await ui.unmount()
})

test('/koi day previews daylight in a full session, and the koi read it as fresh', async ($, on) => {
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: 228_000, window: 300_000, percent: 76 } } }) as any)
  on('ui.render', { component: 'AbovePrompt' }, emptyBand)
  const day = (await $.command.run({ command: 'koi', args: 'day' } as any)) as any
  expect(day.text).toMatch(/Daylight on the koi for a minute/)
  const report = (await $.command.run({ command: 'koi' } as any)) as any
  expect(report.text).toMatch(/76%: drowsy/) // the reading stays true
  expect(report.text).toMatch(/Previewing day/)
  const live = (await $.command.run({ command: 'koi', args: 'live' } as any)) as any
  expect(live.text).toMatch(/day preview is over/)
})

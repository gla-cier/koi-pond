import { expect, test } from 'claude-code/testing'

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

const glyphs = (pond: any) => {
  const bytes = Uint8Array.from(atob(pond.props.cells), (c: string) => c.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  const out: number[][] = []
  for (let k = 0; k < words.length; k += 3) out.push([words[k]!, words[k + 1]!, words[k + 2]!])
  return out
}

test('the pond draws its koi in half blocks by default', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, emptyBand)
  const ui = await $.ui.mount({ plugin: 'koi-pond', surface: 'terminal', ...band({}) })
  const cells = glyphs(await ui.find({ type: 'Raster', key: 'pond' } as any))
  // koi in half blocks: some cells carry two colours, upper glyph over lower background
  expect(cells.some(([g, , bg]) => g === 0x2580 && bg !== 0x01000000)).toBe(true)
  expect(cells.some(([g]) => g >= 0x2800 && g <= 0x28ff)).toBe(false)
  await ui.unmount()
})

test('the fish option draws them in braille instead', { options: { fish: 'dots' } }, async ($, on) => {
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
}

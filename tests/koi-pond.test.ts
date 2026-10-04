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

test('the fish option switches the koi to block glyphs', { options: { fish: 'blocks' } }, async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, emptyBand)
  const ui = await $.ui.mount({ plugin: 'koi-pond', surface: 'terminal', ...band({}) })
  const pond = await ui.find({ type: 'Raster', key: 'pond' } as any)
  expect(pond).toBeDefined()
  const bytes = Uint8Array.from(atob((pond as any).props.cells), (c: string) => c.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  let block = 0
  for (let k = 0; k < words.length; k += 3) if (words[k]! >= 0x2580 && words[k]! <= 0x259f) block += 1
  expect(block > 0).toBe(true)
  await ui.unmount()
})

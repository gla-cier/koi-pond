// Koi Pond: koi across the band above the prompt, in one of two views.
//
// pond (default): seen from above, the way koi are judged. Each koi's body
//   follows its own wake, so it swims with its whole length and a U-turn curls
//   it round into the next lane; lily pads float over them, deeper koi are
//   dimmer and pass beneath, and food dropped on a finished turn draws them in.
// tank: seen from the side through the glass, with the varieties' side
//   markings, a dorsal fin and the fins beneath, gravel, swaying weed and a
//   bubbler; food flakes sink from the surface on a finished turn.
//
// Two ways to draw either (userConfig `fish`): pixels, half blocks with two
// colours a cell, steady markings at a solid grain; or dots, braille 2x4 a cell
// with one colour a cell, finer and stippled. The band is one Raster.
//
// prompt.submit  -> the koi speed up (Claude is working)
// turn.complete  -> reads the context window; food and a ripple (pond) or
//                   flakes (tank), and a soft bloop (userConfig `sound`)
// a ticker       -> moves everything and repaints the Raster in place
//                   ($.ui.blit), falling back to a band redraw when refused;
//                   fps (userConfig, default 4) sets how often; it stops
//                   idleMinutes (3) after the last prompt, turn,
//                   model request, press or input, leaving the fish still,
//                   and the next one restarts it
// ui.render      -> draws the band; yields to a survey and to any other
//                   plugin's band that has controls; one-line text fallback
//                   where there is no Raster or the band is too short
// prompt.edit    -> the pond follows the caret: a koi comes to look where you
//                   type, koi near it lean in, keystrokes ring the water
// context tiers  -> under 50%: cruising; 50-80%: slow; 80%+: the koi settle
//                   and rest (time to /compact)

import type { Register } from 'claude-code'

// Frames a second (userConfig `fps`, one of FPS_PRESETS). Motion is in seconds,
// so the rate only sets how smooth the pond looks, and what it costs: the
// awake CPU scales with it (about 13% of a core a session at 4, 21-26% at 10;
// 60 is for laughs, around a whole core). The surface shows about sixty frames
// a second and folds blits between them, so 60 is as fast as it ever shows.
// The world is braille dots, so a frame only shows something new once a mover
// has crossed a dot: cruising koi do 2-2.6 dots/s, working koi 4-6, a koi
// rushing food up to 10, the dragonfly's dart 28. 28 is the functional max;
// in pixels (half blocks, two dots a sample) everything halves, so 14.
const FPS_PRESETS = [2, 4, 6, 10, 14, 28, 60] as const
const DEFAULT_FPS = 4
// While Claude works a turn can run for an hour and each model request keeps
// the pond awake, so a high rate would burn the whole turn. workingFps
// (userConfig, one of the presets or 'same'; default 4) is the most the pond
// runs at until the turn completes; the chosen rate comes back for the pond's
// own idle window.
const DEFAULT_WORKING_FPS = 4
let fps = DEFAULT_FPS
let workingFps: number | null = DEFAULT_WORKING_FPS // null: same as fps
let busy = false // a turn is running
let tickMs = 1000 / DEFAULT_FPS
const rateNow = () => (busy && workingFps !== null ? Math.min(fps, workingFps) : fps)
const MIN_ROWS = 4
const MAX_ROWS = 8
const DEFAULT = 0x01000000 // the terminal's own colour
const NONE = -1
const EYE = -2 // an eye: an unlit dot in braille, a dark pixel in blocks
const COL = {
  white: 0xf4efe4,
  red: 0xe2542c, // the hi of kohaku, showa, tancho
  orange: 0xf07c2a, // the hi of the hi utsuri, a warmer orange-red
  black: 0x505050, // the sumi: a dark grey that reads on dark themes
  gold: 0xe9c046,
  sheen: 0xfff4be,
  water: 0x2b5a75,
  ripple: 0x5c93ad,
  pad: 0x4caf5a,
  padDark: 0x3a8f48,
  flower: 0xf4a3b8,
  pellet: 0xb08052,
  eye: 0x111114,
  weed: 0x3f8f4a,
  weedDark: 0x2f7a3c,
  bubble: 0x9ccbe0,
  surface: 0x3c6f8a,
}
const GRAVEL = [0x8a7a62, 0x6e6252, 0xa39377, 0x5a524a, 0x7d7468]

type Phase = 'idle' | 'working' | 'happy'
type View = 'pond' | 'tank'
type Draw = 'pixels' | 'dots'
type Tier = { key: 'fresh' | 'drowsy' | 'asleep'; color: string }
type Reading = { tokens: number; window: number; percent: number; source: string }

let rows = 6
let sound = true
let algaeOn = false // opt-in: algae grows in the tank over the session
let view: View = 'pond'
let draw: Draw = 'pixels'
let waterDots = false
let caretKoi = true // userConfig `caret`: a koi comes to look where you type (pond)
let ground = 0x16181c // what see-through fins and deep koi fade toward: the theme's background, roughly
let phase: Phase = 'idle'
let now = 0 // pond time in ms: the ticks so far, whatever their rate
let happyUntil = 0
let reading: Reading | null = null
// /koi night and /koi dusk: the percent the drawing reads for a minute, until a
// frame on the tank's clock; the reading itself stays true, so /koi still reports it
let preview: { name: 'night' | 'dusk'; percent: number; until: number } | null = null
const PREVIEW_MS = 60_000 // a preview lasts a minute
const HAPPY_MS = 2_500 // the koi come to eat for two and a half seconds
const DEFAULT_IDLE_MINUTES = 3 // how long the pond moves after the last sign of life
let awakeMs = DEFAULT_IDLE_MINUTES * 60_000 // 0: never stops
let ticker: { cancel: () => void } | null = null
let idleMs = 0 // pond time since the last prompt, turn, step, press or input
let cols = 0
let requestId: string | null = null
let mounted = false
let rnd = mulberry32(0x9e3779b9)

// The ticker: moves everything and repaints, fps times a second (capped while
// a turn runs), until the session has been quiet for idleMinutes; then it
// cancels itself and the last frame stays on screen (a still pond costs
// nothing). wake() restarts it. Time is kept in ms so a rate change mid-run
// leaves the idle stop, the feeding and the previews where they were.
type Ticking = Parameters<typeof repaint>[0] & { clock: { every: (ms: number, fn: () => void) => { cancel: () => void } } }
function startTicker($: Ticking) {
  ticker?.cancel()
  tickMs = 1000 / rateNow()
  ticker = $.clock.every(tickMs, () => {
    idleMs += tickMs
    if (awakeMs > 0 && idleMs >= awakeMs) {
      ticker?.cancel()
      ticker = null
      return
    }
    now += tickMs
    if (phase === 'happy' && now >= happyUntil) phase = 'idle'
    if (preview && now >= preview.until) {
      preview = null // the minute is up: back to the real reading
      $.ui.invalidate('ui.render')
    }
    if (!mounted || cols === 0) return
    step(tickMs / 1000) // full rate asleep too: the moon shimmers, a sleeper visits it (in the tank, drifts), the dragonfly flies
    void repaint($)
  })
}

// A sign of life: the clock runs for another idleMinutes, starting again if it had stopped.
function wake($: Ticking) {
  idleMs = 0
  if (!ticker) startTicker($)
}

// The turn began or ended: if that changes the rate, restart at the new one.
function setBusy($: Ticking, on: boolean) {
  busy = on
  if (ticker && tickMs !== 1000 / rateNow()) startTicker($)
}

export const register: Register = (on, options) => {
  sound = options?.sound !== false
  algaeOn = options?.algae === true
  view = options?.view === 'tank' ? 'tank' : 'pond'
  draw = options?.fish === 'pixels' ? 'pixels' : 'dots'
  waterDots = options?.water === 'dots'
  caretKoi = options?.caret !== false
  const wanted = Number(options?.rows)
  rows = Number.isFinite(wanted) ? Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.round(wanted))) : 6
  const rate = Number(options?.fps)
  fps = (FPS_PRESETS as readonly number[]).includes(rate) ? rate : DEFAULT_FPS
  const working = options?.workingFps
  const workingRate = Number(working)
  workingFps = working === 'same' ? null : (FPS_PRESETS as readonly number[]).includes(workingRate) ? workingRate : DEFAULT_WORKING_FPS
  tickMs = 1000 / rateNow()
  const idle = Number(options?.idleMinutes)
  awakeMs = Number.isFinite(idle) && idle >= 0 ? idle * 60_000 : DEFAULT_IDLE_MINUTES * 60_000

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    phase = 'idle'
    busy = false
    now = 0
    preview = null
    algaeT = 0 // a new session, a clean tank
    await takeReading($)
    try {
      await $.command.register({ name: 'koi', description: 'How full the koi think the context is; /koi feed drops food in; /koi night or /koi dusk previews the dark for a minute, /koi day ends it' })
    } catch {
      // the band still works without the command
    }
    try {
      const theme = (await $.config.list()).find(row => row.key === 'theme')
      if (String(theme?.value ?? '').includes('light')) ground = 0xf7f7f5
    } catch {
      // keep the dark ground
    }
    wake($)
    return result
  })

  // After a compaction the context is nearly empty again: read it now, so the
  // koi wake and the tank lights up without waiting for the next turn to end.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) await takeReading($)
    return result
  })

  on('command.run', { command: 'koi' }, async ($, e) => {
    wake($)
    const arg = String(e?.args ?? '').trim().toLowerCase()
    if (arg === 'night' || arg === 'dusk') {
      preview = { name: arg, percent: arg === 'night' ? 90 : 65, until: now + PREVIEW_MS }
      $.ui.invalidate('ui.render')
      return { text: arg === 'night' ? 'Night falls on the koi for a minute (a preview; the context is unchanged). /koi day ends it.' : 'Dusk on the koi for a minute (a preview; the context is unchanged). /koi day ends it.' }
    }
    if (arg === 'feed') {
      phase = 'happy'
      happyUntil = now + HAPPY_MS
      dropFood($)
      $.ui.invalidate('ui.render')
      return { text: cols > 0 ? 'Food drops in; the koi come to eat.' : 'No pond on screen to feed right now.' }
    }
    if (arg === 'day') {
      const was = preview
      preview = null
      $.ui.invalidate('ui.render')
      return { text: was ? `The ${was.name} preview is over; the koi follow the context again.` : 'No preview running; the koi follow the context.' }
    }
    if (arg) return { text: 'Usage: /koi (the reading), /koi feed (drop food), /koi night or /koi dusk (a minute\'s preview), /koi day (end it).' }
    await takeReading($)
    const showing = preview ? ` Previewing ${preview.name} for ${Math.max(1, Math.ceil((preview.until - now) / 1000))}s more (/koi day ends it).` : ''
    if (!reading) return { text: `No context reading yet.${showing}` }
    const k = (n: number) => `${Math.round(n / 1000)}k`
    const tier = tierFor(reading.percent).key
    const against = reading.source === 'model' ? "the model's whole window (no auto-compact window reported)" : `the auto-compact window (set by: ${reading.source})`
    return { text: `${k(reading.tokens)} of ${k(reading.window)}, ${reading.percent}%: ${tier}. Measured against ${against}.${showing}` }
  })

  // Signs of life: each one keeps the pond moving for another idleMinutes,
  // and starts it again once it has stopped. A model request inside a long
  // turn counts, so the koi keep darting while Claude works.
  on('prompt.change', ($, e, next) => (wake($), next(e)))

  // Where you type: the caret in the box the edit or move leaves, as a band column.
  on('prompt.edit', async ($, e, next) => {
    wake($)
    const box = await next(e)
    if (caretKoi && view === 'pond' && cols > 0) caretAt(caretColumn(box.text, box.cursor), e.inputText !== '' || e.end > e.start)
    return box
  })
  on('turn.start', ($, e, next) => (wake($), setBusy($, true), next(e)))
  on('turn.step', async function* ($, e, next) {
    wake($)
    return yield* next(e)
  })
  on('ui.press', ($, e, next) => (wake($), next(e)))
  on('ui.input', ($, e, next) => (wake($), next(e)))

  on('prompt.submit', ($, e, next) => {
    wake($)
    if (!e.turnId) phase = 'working'
    setBusy($, true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    wake($)
    const result = await next(e)
    if (e.agentId) return result
    setBusy($, false)
    await takeReading($)
    if (e.isAborted) {
      phase = 'idle'
    } else {
      phase = 'happy'
      happyUntil = now + HAPPY_MS
      dropFood($)
    }
    $.ui.invalidate('ui.render')
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    let below: unknown = undefined
    try {
      below = await next(e)
    } catch {
      // nothing beneath answers; draw as if the band were empty
    }
    if (e.props.hasSurvey || hasButton(below)) {
      mounted = false
      return below as never
    }
    const table = $.ui.resolve(e) as Record<string, (props: Record<string, unknown>) => unknown>
    const { Box, Text, Raster } = table
    const working = phase === 'working' || e.props.isWorking
    const tier = tierFor(shownPercent())
    const bodyColumns = e.props.bodyColumns ?? 80
    const fits = e.surface === 'terminal' && typeof Raster === 'function' && (e.props.maxRows ?? 1) >= rows && bodyColumns >= 30
    if (!fits) {
      mounted = false
      const word = working ? 'koi darting' : tier.key === 'asleep' ? 'koi resting · time to /compact' : tier.key === 'drowsy' ? 'koi drifting slowly' : view === 'tank' ? 'koi tank' : 'koi pond'
      return Box({ flexDirection: 'row', paddingX: 1, children: [
        Text({ color: working ? 'cyan' : tier.color, bold: true, children: `≋ ${word}` }),
      ] })
    }
    resize(Math.max(20, Math.min(512, bodyColumns - 2)))
    requestId = e.requestId
    mounted = true
    // a blank row under the water, between the band and the token counter, where
    // there's room; then one over it too, where there's room for both
    const room = (e.props.maxRows ?? 1) - rows
    const pond = Box({ flexDirection: 'row', paddingX: 1, paddingTop: room >= 2 ? 1 : 0, paddingBottom: room >= 1 ? 1 : 0, children: [
      Raster({ key: 'pond', columns: cols, rows, cells: cellsFor() }),
    ] })
    // whatever a hook beneath drew (a meter, a note) keeps its place under the koi
    return hasContent(below) ? Box({ flexDirection: 'column', children: [pond, below] }) : pond
  })
}

// ---- shared -----------------------------------------------------------------

function speedFactor(): number {
  if (phase === 'working') return 2.2
  const tier = tierFor(shownPercent()).key
  return tier === 'asleep' ? 0 : tier === 'drowsy' ? 0.45 : 1
}

function resize(next: number) {
  if (next === cols) return
  const prev = cols
  cols = next
  if (view === 'pond') resizePond(prev)
  else resizeTank(prev)
}

function step(dt: number) {
  if (view === 'pond') stepPond(dt)
  else stepTank(dt)
}

function feed() {
  if (view === 'pond') feedPond()
  else feedTank()
}

// Food in, with the bloop: a finished turn and /koi feed both drop it this way.
function dropFood($: { audio: { play: (args: { asset: string }) => Promise<unknown> } }) {
  if (cols > 0) feed()
  if (sound) {
    $.audio.play({ asset: 'assets/bloop.wav' }).catch(() => {
      // no player on this platform, or the clip was refused: the food still falls
    })
  }
}

const mix = (a: number, b: number, t: number): number => {
  const ch = (s: number) => Math.round(((a >> s) & 255) + (((b >> s) & 255) - ((a >> s) & 255)) * t)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}
const shade = (a: number, k: number): number => {
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(((a >> s) & 255) * k)))
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

// ---- the sample grid ----------------------------------------------------------
//
// A view paints samples: braille dots (cols*2 by rows*4) or block pixels (cols
// by rows*2). Each sample keeps a colour, the layer on top there and a key that
// groups like colours, so a braille cell can take its top layer's commonest.

type Grid = { w: number; h: number; col: Int32Array; layer: Int16Array; key: Int32Array }

function makeGrid(w: number, h: number): Grid {
  return { w, h, col: new Int32Array(w * h).fill(NONE), layer: new Int16Array(w * h).fill(-1), key: new Int32Array(w * h) }
}

function put(g: Grid, x: number, y: number, c: number, layer: number, key: number) {
  if (x < 0 || y < 0 || x >= g.w || y >= g.h) return
  const i = y * g.w + x
  if (layer < g.layer[i]!) return
  g.col[i] = c
  g.layer[i] = layer
  g.key[i] = key
}

function putEmpty(g: Grid, x: number, y: number, c: number, layer: number, key: number) {
  if (x < 0 || y < 0 || x >= g.w || y >= g.h || g.layer[y * g.w + x]! >= 0) return
  put(g, x, y, c, layer, key)
}

const L_WATER = 0
const L_WEED = 2
const L_BUBBLE = 3
const L_FISH = 10 // plus the koi's place in the draw order
// The tank's koi stand in front of everything in it (weed, decor, gravel, food,
// glass, moonlight), so in braille no tank item ever takes a cell from a koi and
// repaints part of it; only a splash or gulp at the surface is drawn over them.
const L_TANK_FISH = 100 // plus the koi's place in the draw order
const L_SPLASH = 200
const L_GRAVEL = 60
const L_PAD = 80
const L_FOOD = 90
const L_RIPPLE = 95

function cellsFor(): string {
  const g = draw === 'dots' ? makeGrid(cols * 2, rows * 4) : makeGrid(cols, rows * 2)
  if (view === 'pond') paintPond(g)
  else paintTank(g)
  return base64(new Uint8Array((draw === 'dots' ? braille(g) : blocks(g)).buffer))
}

// Braille: one colour a cell. Only the top layer's dots show in a cell, so a
// koi in front hides the one behind cleanly, coloured by their commonest key.
const ORDER: [number, number][] = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]]

function braille(g: Grid): Uint32Array {
  const words = new Uint32Array(cols * rows * 3)
  let w = 0
  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      let top = -1
      for (const [dx, dy] of ORDER) top = Math.max(top, g.layer[(cy * 4 + dy) * g.w + cx * 2 + dx]!)
      let bits = 0
      const votes = new Map<number, { n: number; r: number; gr: number; b: number }>()
      if (top >= 0) {
        ORDER.forEach(([dx, dy], k) => {
          const i = (cy * 4 + dy) * g.w + cx * 2 + dx
          const c = g.col[i]!
          if (g.layer[i] !== top || c < 0) return
          bits |= 1 << k
          const v = votes.get(g.key[i]!) ?? { n: 0, r: 0, gr: 0, b: 0 }
          v.n += 1
          v.r += (c >> 16) & 255
          v.gr += (c >> 8) & 255
          v.b += c & 255
          votes.set(g.key[i]!, v)
        })
      }
      let col = DEFAULT
      if (bits) {
        const win = [...votes.values()].sort((a, b) => b.n - a.n)[0]!
        col = (Math.round(win.r / win.n) << 16) | (Math.round(win.gr / win.n) << 8) | Math.round(win.b / win.n)
      }
      words[w++] = bits ? 0x2800 + bits : 0x20
      words[w++] = col
      words[w++] = DEFAULT
    }
  }
  return words
}

// Half blocks: each cell two square pixels, the upper the glyph's colour and
// the lower the cell's background, so every pixel has its own.
function blocks(g: Grid): Uint32Array {
  const words = new Uint32Array(cols * rows * 3)
  let w = 0
  const read = (i: number) => {
    const c = g.col[i]!
    return c === EYE ? COL.eye : c
  }
  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      const t = read(cy * 2 * g.w + cx)
      const b = read((cy * 2 + 1) * g.w + cx)
      if (t >= 0 && b >= 0) {
        words[w++] = t === b ? 0x2588 : 0x2580
        words[w++] = t
        words[w++] = t === b ? DEFAULT : b
      } else if (t >= 0) {
        words[w++] = 0x2580
        words[w++] = t
        words[w++] = DEFAULT
      } else if (b >= 0) {
        words[w++] = 0x2584
        words[w++] = b
        words[w++] = DEFAULT
      } else {
        words[w++] = 0x20
        words[w++] = DEFAULT
        words[w++] = DEFAULT
      }
    }
  }
  return words
}

// ---- the pond: koi from above ---------------------------------------------------
//
// World units are braille dots (square), cols*2 by rows*4, in both drawings.

type TopVariety = 'kohaku' | 'showa' | 'shiro' | 'tancho' | 'ogon' | 'hiutsuri'
type PondKoi = {
  v: TopVariety
  dir: 1 | -1
  x: number
  y: number
  th: number // heading, radians, y down
  L: number
  Wd: number // half-width at the shoulders
  speed: number
  wander: number
  phase: number // of the swimming wave, advanced by distance swum
  flap: number
  depth: number // 0 at the surface; deeper koi are dimmer and pass beneath
  depthTo: number
  uturn: number // -1 or 1 while turning, 0 otherwise
  turned: number
  surfaced: boolean
  trail: [number, number][] // the head's wake, oldest first, half a dot apart
  bed: number // which pad this koi sleeps under, and on which side
}
type Pellet = { x: number; y: number; age: number }
type Ripple = { x: number; y: number; age: number }
type Drop = { x: number; y: number; age: number; hello?: boolean } // hello: the moon visitor's bubble, breaking the surface over the moon
type Fly = { mode: 'away' | 'in' | 'perched' | 'out'; x: number; y: number; tx: number; ty: number; wait: number; th: number }

// wet: how hard it is raining, eased 0..1; ct: the caustics' own clock
const pond = { fish: [] as PondKoi[], pellets: [] as Pellet[], ripples: [] as Ripple[], drops: [] as Drop[], t: 0, rainAcc: 0, wet: 0, ct: 0 }
const fly: Fly = { mode: 'away', x: -10, y: 4, tx: 0, ty: 0, wait: 4, th: 0 }
// The moon visitor: on a sleeping night, now and then one koi slips out from
// under its pad to the moon. Which koi (by index), how long it has been out, the
// wait for the next; how silver it has gone (glow, from afar; contact, into the
// moon); its breach and its five hello bubbles; and its way home (leaving,
// turned, sinkT, straight, fade).
const visit = { i: -1, t: 0, wait: 8, bubbled: false, glow: 0, bubbles: 0, bubT: 0, arrived: false, leaveAt: 0, stillT: 0, contact: 0, d: 1e9, leaving: false, leaveT: 0, lx: 0, ly: 0, turned: false, fade: 1, sinkT: 0, straight: false, straightT: 0, ex: 0, ey: 0, entered: false, inMoon: false, fullAt: false, bx: 0, by: 0, bw: 0 }
// The caret: where you type, as prompt.edit tells it. A koi comes to look
// (quick by day, lazy at dusk, nobody asleep); from LEAN_MIN_COLS the koi within
// LEAN_SPAN of the band around it lean in; each keystroke rings the water over
// it, asleep too; asleep, now and then the sleeper nearest it stirs. x in dots;
// t: seconds since the last edit or caret move; picked: the follower, by index.
const CARET_LINGER = 1.5 // seconds the pull lasts after the last edit or move
const LEAN_MIN_COLS = 110 // narrower, the window would be most of the pond
const LEAN_SPAN = 0.3 // the lean's window, as a share of the band's width
const PROMPT_LEFT = 2 // columns before the draft's first character: "> "
const TWITCH_S = 1.1
const caret = { x: 0, t: 99, picked: -1, tapT: 0 }
// the sleeper that stirs: which koi, how long it has left, the rest before another
const twitch = { i: -1, t: 0, cool: 0 }
// The order the pond fills as the band widens.
const POND_ROSTER: TopVariety[] = ['kohaku', 'showa', 'tancho', 'shiro', 'ogon', 'hiutsuri']

const blob = (s: number, u: number, s0: number, u0: number, rs: number, ru: number) => ((s - s0) / rs) ** 2 + ((u - u0) / ru) ** 2 < 1

// A variety's colour on the back at s (0 nose .. 1 tail tip), u (-1..1 across),
// and a key that tells its colours apart for the braille vote.
const TOP: Record<TopVariety, { fin: number; motoguro?: boolean; sheen?: boolean; body: (s: number, u: number) => [number, number] }> = {
  kohaku: { fin: COL.white, body(s, u) {
    const hi = blob(s, u, 0.12, 0, 0.085, 0.95) || blob(s, u, 0.37, 0.15 * Math.sin(s * 30), 0.11, 1.15) || blob(s, u, 0.6, -0.25, 0.07, 0.95)
    return hi && s > 0.035 ? [COL.red, 1] : [COL.white, 0] // sandan: three steps, a white nose
  } },
  showa: { fin: COL.black, motoguro: true, body(s, u) {
    if (blob(s, u, 0.1, 0.15, 0.08, 0.95) || blob(s, u, 0.42, -0.35, 0.1, 0.9) || blob(s, u, 0.64, 0.3, 0.06, 0.8)) return [COL.red, 1]
    if (blob(s, u, 0.27, 0.55, 0.06, 0.6) || blob(s, u, 0.55, 0.55, 0.05, 0.55)) return [COL.white, 2]
    return [COL.black, 0]
  } },
  shiro: { fin: COL.white, motoguro: true, body(s, u) {
    const sumi = (Math.abs(s - 0.1 - 0.05 * u) < 0.025 && u < 0.4) // menware across the head
      || blob(s, u, 0.3, -0.55, 0.07, 0.75) || blob(s, u, 0.48, 0.45, 0.08, 0.85) || blob(s, u, 0.68, -0.3, 0.06, 0.8)
    return sumi ? [COL.black, 1] : [COL.white, 0]
  } },
  tancho: { fin: COL.white, body(s, u) {
    return blob(s, u, 0.11, 0, 0.065, 0.62) ? [COL.red, 1] : [COL.white, 0] // one red crown
  } },
  ogon: { fin: COL.gold, sheen: true, body() {
    return [COL.gold, 0]
  } },
  hiutsuri: { fin: COL.black, motoguro: true, body(s, u) {
    return blob(s, u, 0.16, -0.1, 0.09, 0.9) || blob(s, u, 0.5, 0.25, 0.12, 0.95) ? [COL.orange, 1] : [COL.black, 0]
  } },
}

function halfWidth(s: number, Wd: number): number {
  if (s < 0.24) return Wd * Math.sqrt(Math.max(0, 1 - ((0.24 - s) / 0.24) ** 2))
  if (s <= 0.8) return Wd - (Wd - 0.9) * ((s - 0.24) / 0.56) ** 1.35
  return 0
}

function resizePond(prev: number) {
  const W = cols * 2
  const H = rows * 4
  const want = Math.max(2, Math.min(6, Math.round(cols / 24)))
  if (prev > 0) {
    const ratio = cols / prev
    for (const f of pond.fish) {
      f.x = Math.min(W - 2, Math.max(1, f.x * ratio))
      f.trail = straightTrail(f)
    }
  }
  while (pond.fish.length < want) {
    const i = pond.fish.length
    const v = POND_ROSTER[i % POND_ROSTER.length]!
    const small = v === 'ogon'
    const dir: 1 | -1 = i % 2 ? 1 : -1
    const f: PondKoi = {
      v, dir,
      x: W * ((i * 0.37 + 0.2) % 1),
      y: 5 + ((i * 0.43 + 0.15) % 1) * (H - 10),
      th: dir > 0 ? 0 : Math.PI,
      L: small ? 18 : 26,
      Wd: small ? 2.9 : 4,
      speed: 0.85 + rnd() * 0.3,
      wander: 0,
      phase: rnd() * 6,
      flap: rnd() * 6,
      depth: rnd() * 0.5,
      depthTo: rnd() * 0.6,
      uturn: 0,
      turned: 0,
      surfaced: false,
      trail: [],
      bed: i,
    }
    f.trail = straightTrail(f)
    pond.fish.push(f)
  }
  if (pond.fish.length > want) pond.fish = pond.fish.slice(0, want)
}

function straightTrail(f: PondKoi): [number, number][] {
  const out: [number, number][] = []
  for (let k = f.L * 2 + 4; k >= 0; k -= 1) out.push([f.x - Math.cos(f.th) * k * 0.5, f.y - Math.sin(f.th) * k * 0.5])
  return out
}

function stepPond(dt: number) {
  pond.t += dt
  caret.t += dt
  caret.tapT -= dt
  twitch.t -= dt
  twitch.cool -= dt
  if (!typing()) caret.picked = -1
  const sub = 4
  for (let n = 0; n < sub; n += 1) {
    for (const f of pond.fish) swim(f, dt / sub)
  }
  pond.ripples = pond.ripples.filter(r => (r.age += dt) < 1.6)
  for (const q of pond.pellets) {
    q.age += dt
    q.x += Math.sin(pond.t * 0.7 + q.y) * 0.4 * dt
  }
  pond.pellets = pond.pellets.filter(q => q.age < 30)
  // rain on the pond while Claude works
  const W = cols * 2
  const H = rows * 4
  if (phase === 'working') {
    pond.rainAcc += (dt * (W * H)) / 900 // drops a second, by the pond's area
    while (pond.rainAcc >= 1) {
      pond.rainAcc -= 1
      pond.drops.push({ x: rnd() * W, y: rnd() * H, age: 0 })
    }
  }
  pond.drops = pond.drops.filter(d => (d.age += dt) < 0.9)
  // the caustics keep their own clock: slow and calm, quicker in rain, easing
  // between; half blocks are coarser, so their clock runs slower to look as calm
  pond.wet += ((phase === 'working' ? 1 : 0) - pond.wet) * Math.min(1, dt * 0.8)
  pond.ct += dt * (draw === 'dots' ? 1 : 0.45) * (1 + 1.25 * pond.wet)
  stepVisit(dt)
  stepFly(dt)
}

// The moon visitor's clock and light; swim steers it.
function stepVisit(dt: number) {
  if (speedFactor() > 0 || !pond.fish.length) {
    visit.i = -1 // awake: the koi swim, nobody visits
    visit.glow = 0
    visit.contact = 0
    visit.leaving = false
    return
  }
  const vf = pond.fish[visit.i]
  const [mx, my] = moonAt()
  const vd = vf ? Math.hypot(mx - vf.x, my - vf.y) : 1e9
  // a silver back from 28 dots out, growing as it comes; then from where the
  // moon's glints end (about 1.8 of its radii out) its head eases the whole of
  // it into moonlit white, full right at the rim of the moon itself
  const e = vf ? Math.hypot((vf.x - mx) / 7.5, (vf.y - my) / 5) : 1e9
  visit.inMoon = e < 1.8
  const r = Math.max(0, Math.min(1, (1.8 - e) / 0.8))
  const touch = r * r * (3 - 2 * r) // smooth in, smooth out
  const close = Math.max(Math.max(0, Math.min(1, (28 - vd) / 14.5)) * 0.8, visit.inMoon ? 0.8 + 0.2 * touch : 0)
  if (visit.leaving) {
    // on its way home it keeps its full silver through the turn, the glide, the
    // sink and the dart's turn; only once it has straightened out on its swim
    // for the pad does it go back to its own dark, over about a second
    if (visit.straight) visit.straightT += dt
    const ft = !visit.straight || visit.straightT < 0.15 ? 1 : Math.max(0, 1 - (visit.straightT - 0.15) / 0.9)
    visit.fade += (ft - visit.fade) * Math.min(1, dt * 6)
  } else {
    visit.contact += (touch - visit.contact) * Math.min(1, dt * 6)
    visit.glow += (close - visit.glow) * Math.min(1, dt * 2.5) // silvering as it nears the moon
  }
  visit.d = vd
  if (visit.i < 0) {
    visit.wait -= dt
    if (visit.wait <= 0) {
      visit.i = Math.floor(rnd() * pond.fish.length)
      visit.t = 0
      visit.bubbled = false
      visit.arrived = false
      visit.glow = 0
      visit.contact = 0
      visit.leaving = false
      visit.turned = false
      visit.fade = 1
      visit.sinkT = 0
      visit.straight = false
      visit.straightT = 0
      visit.entered = false
      visit.fullAt = false
      visit.bubbles = 0
      visit.stillT = 0
    }
  } else if ((visit.t += dt) > (visit.bubbled ? visit.leaveAt : 45)) { // time to get there from the farthest pad of a wide pond, stop and say hello
    const f = pond.fish[visit.i]!
    if (!visit.leaving) {
      visit.leaving = true // first the turn for home, still lit
      visit.leaveT = 0
      visit.lx = f.x
      visit.ly = f.y
    } else {
      visit.leaveT += dt
      if (Math.hypot(f.x - visit.lx, f.y - visit.ly) >= 4 || visit.leaveT > 2.5) visit.turned = true // two braille cells' width (four dots) out of its float
      if (visit.fade < 0.03 || visit.leaveT > 15) {
        visit.i = -1 // dark now: the pad logic takes it the rest of the way
        visit.leaving = false
        visit.glow = 0
        visit.contact = 0
        visit.fade = 1
        visit.wait = 14 + rnd() * 16
      }
    }
  }
}

function swim(f: PondKoi, h: number) {
  const W = cols * 2
  const H = rows * 4
  const factor = speedFactor()
  let v = 2.3 * f.speed * factor
  let food: Pellet | null = null
  if (factor > 0 && !f.uturn) {
    let best = 120
    for (const q of pond.pellets) {
      const d = Math.hypot(q.x - f.x, q.y - f.y)
      if (d < best) {
        best = d
        food = q
      }
    }
  }
  if (factor === 0 && pond.fish[visit.i] === f && visit.leaving) {
    // turning for home, still lit until it has swum two braille cells' width out
    // of its float; then a glide, a sink, and a dart for its pad
    const ps = padsFor()
    const p = ps[f.bed % ps.length]!
    let turn = Math.atan2(p[1] - f.y, p[0] - f.x) - f.th
    while (turn > Math.PI) turn -= 2 * Math.PI
    while (turn < -Math.PI) turn += 2 * Math.PI
    if (!visit.turned) {
      f.th += Math.max(-1.6 * h, Math.min(1.6 * h, turn)) // only partway round while lit
      v = 5.5
    } else {
      // then a glide that slows as it sinks, the reflection closing over it,
      // and only then does it pick up speed for its pad
      visit.sinkT += h
      const k = visit.sinkT
      if (k > 0.8) f.depthTo = 0.7 // a beat of gliding at the surface, then down
      if (k < 2.2) {
        f.th += Math.max(-2 * h, Math.min(2 * h, turn))
        v = 6.5 - 2.5 * (k / 2.2) // easing off as it glides out of the reflection and goes down
      } else {
        f.th += Math.max(-3 * h, Math.min(3 * h, turn))
        v = 4 + 6 * Math.min(1, (k - 2.2) / 1.5) // and away
        if (Math.abs(turn) < 0.25 || k > 4.5) visit.straight = true // set on its line for the pad (or long enough trying)
      }
    }
  } else if (factor === 0 && pond.fish[visit.i] === f) {
    // out from under its pad, slow, up to the surface and into the moon
    const [mx, my] = moonAt()
    f.depthTo = 0.05
    const dm = Math.hypot(mx - f.x, my - f.y)
    if (!visit.entered && dm < 17) {
      // the moment it crosses into the reflection: its one glide carries it on
      // across, to rest on the far side of the moon from where it came in
      visit.entered = true
      visit.ex = (mx - f.x) / dm
      visit.ey = (my - f.y) / dm
    }
    const tx = visit.entered ? mx + visit.ex * 7.5 : mx
    const ty = visit.entered ? my + visit.ey * 3.5 : my
    const d = Math.hypot(tx - f.x, ty - f.y)
    if (visit.contact > 0.97 && !visit.fullAt) {
      visit.fullAt = true // fully lit here
      visit.bx = f.x
      visit.by = f.y
      visit.bw = 0.45 * d // about halfway on to where it comes to rest
    }
    if (visit.fullAt && !visit.arrived && Math.hypot(f.x - visit.bx, f.y - visit.by) >= visit.bw) {
      visit.arrived = true
      pond.ripples.push({ x: mx, y: my, age: 0.15 }) // the moon trembles as it breaches, halfway between fully lit and at rest
    }
    let turn = Math.atan2(ty - f.y, tx - f.x) - f.th
    while (turn > Math.PI) turn -= 2 * Math.PI
    while (turn < -Math.PI) turn += 2 * Math.PI
    if (d > 3 && visit.stillT === 0) {
      f.th += Math.max(-2 * h, Math.min(2 * h, turn))
      v = Math.min(7, 1.2 + d * 0.35) * Math.max(0.3, Math.cos(turn))
    } else {
      // at rest on the moon: glide to a stop, hold still a moment, then a string
      // of bubbles, a hello to the moon, and only then home
      visit.stillT += h
      v = 0.9 * Math.max(0, 1 - visit.stillT / 1.6)
      if (visit.stillT > 3.2 && visit.bubbles < 5 && (visit.bubT += h) > 0.5) {
        visit.bubT = 0
        visit.bubbles += 1
        pond.drops.push({ x: f.x + Math.cos(f.th) * 1.2 + (rnd() - 0.5) * 1, y: f.y + Math.sin(f.th) * 1.2 + (rnd() - 0.5) * 0.8, age: 0, hello: true }) // at its mouth
        if (visit.bubbles === 5) {
          visit.bubbled = true
          visit.leaveAt = visit.t + 1 // a beat after the last bubble, it turns for home
        }
      }
    }
  } else if (factor === 0) {
    f.depthTo = 0.7 // resting: sink, and swim to sleep under a pad
    // Koi share a pad two by two, side by side and facing opposite ways. The body
    // follows the head's wake, so a koi lines up behind the pad first, then swims
    // in along that line: it ends with its body under the pad, not across it.
    const ps = padsFor()
    const p = ps[f.bed % ps.length]!
    const side = Math.floor(f.bed / ps.length) % 2
    const rx = side ? -1 : 1 // the way it faces asleep
    const ty = p[1] + (side ? 2 : -2)
    const along = (f.x - p[0]) * rx
    const lined = Math.abs(f.y - ty) < 2.5 && along > -f.L * 0.7 && along < f.L * 0.45 + 3 && Math.cos(f.th) * rx > 0.7 // short of its spot: from past the pad it goes round again, not to sleep in open water
    const tx = p[0] + rx * (lined ? f.L * 0.45 : -f.L * 0.5)
    const d = Math.hypot(tx - f.x, ty - f.y)
    if (d > 1 && !(lined && along >= f.L * 0.45 - 1)) {
      let turn = Math.atan2(ty - f.y, tx - f.x) - f.th
      while (turn > Math.PI) turn -= 2 * Math.PI
      while (turn < -Math.PI) turn += 2 * Math.PI
      f.th += Math.max(-5 * h, Math.min(5 * h, turn))
      v = Math.min(28, 2 + d * 1.5) * Math.max(0.25, Math.cos(turn)) // quick, so a short night still finds them in bed
    }
    if (twitch.t > 0 && pond.fish[twitch.i] === f) {
      // a sleeper stirs at the typing without waking: a swish of the tail out
      // from under its pad (see stirOf in spine) and a flick of the fins
      f.phase += h * 9
      f.flap += h * 10
    }
  } else if (!food && follows(f)) {
    // come and look: swim to just above the caret, along the band's bottom
    // edge, and hang there with the head tipped toward the text; creep along
    // as the caret moves, and turn round when it goes back
    f.uturn = 0
    const tx = caret.x
    const ty = H - 4.5
    const gap = Math.hypot(tx - f.x, ty - f.y)
    let turn = (gap > 4 ? Math.atan2(ty - f.y, tx - f.x) : Math.atan2(0.45, Math.cos(f.th) >= 0 ? 1 : -1)) - f.th
    while (turn > Math.PI) turn -= 2 * Math.PI
    while (turn < -Math.PI) turn += 2 * Math.PI
    const quick = tierFor(shownPercent()).key === 'fresh' // quick by day, lazy at dusk
    const rate = gap > 4 ? (quick ? 3.4 : 1.5) : 1.2
    f.th += Math.max(-rate * h, Math.min(rate * h, turn))
    const pace = Math.max(1, Math.min(1.6, factor)) // dusk is lazy, not lazy and slowed too: it still plainly comes
    v = gap > 4 ? Math.min(quick ? 20 : 11, 1.5 + gap * (quick ? 0.8 : 0.35)) * Math.max(0.3, Math.cos(turn)) * pace : gap * 0.6
    f.dir = Math.cos(f.th) >= 0 ? 1 : -1
    f.depthTo = Math.min(f.depthTo, 0.12) // up near the surface, to see
  } else if (f.uturn) {
    v *= 1.5 // a koi powers through a turn
    f.th += f.uturn * (v / 5) * h
    f.turned += (v / 5) * h
    if (f.turned >= Math.PI) {
      f.uturn = 0
      f.dir = f.dir === 1 ? -1 : 1
      f.th = f.dir > 0 ? 0 : Math.PI
    }
  } else {
    let want: number
    if (food) {
      const gap = Math.hypot(food.x - f.x, food.y - f.y)
      v *= gap > 14 ? 1.7 : 0.8
      want = Math.atan2(food.y - f.y, food.x - f.x)
      if (gap < 3.4) {
        pond.pellets.splice(pond.pellets.indexOf(food), 1)
        pond.ripples.push({ x: f.x, y: f.y, age: 0.6 })
      }
    } else {
      f.wander += (rnd() - 0.5) * 1.2 * h
      f.wander *= 0.995
      let vy = Math.sin(f.wander) * 0.45
      if (f.y < 6) vy += (6 - f.y) * 0.18
      if (f.y > H - 6) vy -= (f.y - (H - 6)) * 0.18
      if (leans(f)) vy += (H - 9 - f.y) * 0.035 // near the caret: drift down toward the prompt
      for (const g of pond.fish) {
        // traffic sense: ease aside from a koi just ahead
        if (g === f) continue
        const dx = g.x - f.x
        const dy = g.y - f.y
        const d = Math.hypot(dx, dy)
        if (d < 9 && Math.sign(dx) === f.dir) vy -= Math.sign(dy || 1) * (9 - d) * 0.06
      }
      want = Math.atan2(vy, f.dir)
    }
    let d = want - f.th
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    const maxTurn = (food ? 3.2 : 0.9) * h
    f.th += Math.max(-maxTurn, Math.min(maxTurn, d))
    if (!food) f.dir = Math.cos(f.th) > 0 ? 1 : -1
    const nearEdge = (f.dir < 0 && f.x < 16) || (f.dir > 0 && f.x > W - 16)
    const away = leans(f) && !food && Math.sign(caret.x - f.x) === -f.dir && Math.abs(caret.x - f.x) > 8 // swimming out of the window: likelier to turn back
    if (nearEdge || (!food && rnd() < (away ? 0.006 : phase === 'working' ? 0.0012 : 0.0004))) {
      // a U-turn comes out a lane over, toward the side with room: a two-way road
      f.uturn = (f.y < H / 2 ? 1 : -1) * f.dir
      f.turned = 0
    }
  }
  f.x = Math.max(1, Math.min(W - 1, f.x + Math.cos(f.th) * v * h))
  f.y = Math.max(2.5, Math.min(H - 2.5, f.y + Math.sin(f.th) * v * h))
  f.phase += v * h * 0.42
  f.flap += h * (food ? 9 : factor === 0 ? 1 : 4)
  const last = f.trail[f.trail.length - 1]!
  if (Math.hypot(f.x - last[0], f.y - last[1]) >= 0.5) {
    f.trail.push([f.x, f.y])
    if (f.trail.length > 120) f.trail.splice(0, f.trail.length - 120)
  }
  if (factor > 0 && rnd() < h / 14) f.depthTo = rnd() < 0.25 ? 0 : rnd() * 0.7
  if (phase === 'working') f.depthTo = Math.max(f.depthTo, 0.5) // in the rain the koi keep deeper
  f.depth +=(f.depthTo - f.depth) * Math.min(1, h * 0.5)
  if (f.depth < 0.04 && !f.surfaced) {
    f.surfaced = true // rising to the surface leaves a ring
    pond.ripples.push({ x: f.x, y: f.y, age: 0.4 })
  }
  if (f.depth > 0.15) f.surfaced = false
}

// The spine: points along the koi's own wake, so a turn curls the whole body,
// with a travelling wave across it that grows toward the tail. [x, y, s].
function spine(f: PondKoi): [number, number, number][] {
  const N = 30
  const pts: [number, number, number][] = []
  const tr = f.trail
  let i = tr.length - 1
  let acc = 0
  for (let k = 0; k <= N; k += 1) {
    const want = (k / N) * f.L
    while (i > 0 && acc + Math.hypot(tr[i]![0] - tr[i - 1]![0], tr[i]![1] - tr[i - 1]![1]) < want) {
      acc += Math.hypot(tr[i]![0] - tr[i - 1]![0], tr[i]![1] - tr[i - 1]![1])
      i -= 1
    }
    const a = tr[i]!
    const b = tr[Math.max(0, i - 1)]!
    const seg = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1
    const r = Math.min(1, (want - acc) / seg)
    pts.push([a[0] + (b[0] - a[0]) * r, a[1] + (b[1] - a[1]) * r, k / N])
  }
  const swimming = speedFactor() > 0 ? 1 : 0.25 + stirOf(f) // a sleeper's wave is a quarter of a swimmer's, but for a stir
  return pts.map((p, k) => {
    const a = pts[Math.max(0, k - 1)]!
    const b = pts[Math.min(N, k + 1)]!
    const l = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1
    const tx = (a[0] - b[0]) / l
    const ty = (a[1] - b[1]) / l
    const s = p[2]
    const off = swimming * 0.95 * (0.12 + s * s * 1.4) * Math.sin(f.phase - s * 5.2)
    return [p[0] - ty * off, p[1] + tx * off, s]
  })
}

// Where q lies in a koi's own frame: s along it, n across (dots). Past either
// end the frame runs on, so nothing is drawn beyond the nose or the tail tip.
function locate(sp: [number, number, number][], qx: number, qy: number): [number, number] {
  let best = 1e9
  let bs = 0
  let bn = 0
  for (let k = 0; k < sp.length - 1; k += 1) {
    const a = sp[k]!
    const b = sp[k + 1]!
    const ex = b[0] - a[0]
    const ey = b[1] - a[1]
    const ll = ex * ex + ey * ey || 1
    const raw = ((qx - a[0]) * ex + (qy - a[1]) * ey) / ll
    const t = Math.max(0, Math.min(1, raw))
    const cx = a[0] + ex * t
    const cy = a[1] + ey * t
    const d = (qx - cx) ** 2 + (qy - cy) ** 2
    if (d < best) {
      best = d
      const free = (k === 0 && raw < 0) || (k === sp.length - 2 && raw > 1) ? raw : t
      bs = a[2] + (b[2] - a[2]) * free
      bn = Math.sign(ex * (qy - a[1]) - ey * (qx - a[0])) * Math.sqrt(d)
    }
  }
  return [bs, bn]
}

// A koi's colour at q, with its vote key, or null where it is not.
function topKoiAt(f: PondKoi, sp: [number, number, number][], qx: number, qy: number): [number, number] | null {
  const [s, n] = locate(sp, qx, qy)
  const V = TOP[f.v]
  const an = Math.abs(n)
  const w = halfWidth(s, f.Wd)
  let col: number
  let key: number
  let fin = false
  if (s > 0.002 && s <= 0.8 && an <= w + 0.35) {
    if (s > 0.045 && s < 0.1 && Math.abs(an - w * 0.62) < 0.5 && f.Wd > 3) return [EYE, 9]
    const u = n / Math.max(0.6, w)
    ;[col, key] = V.body(s, u)
    if (V.sheen) {
      const band = Math.cos((s - ((pond.t * 0.18) % 1.6) + 0.3) * 9) // light running down the scales
      if (band > 0.7) col = mix(col, COL.sheen, (band - 0.7) * 2)
    }
    const edge = Math.max(0, (Math.abs(u) - 0.5) / 0.5)
    col = shade(col, 1.04 - 0.3 * edge * edge) // rounded: the flanks fall away into shadow
  } else if (s > 0.74 && s <= 1) {
    const tt = (s - 0.74) / 0.26
    const half = 0.8 + 2.9 * tt ** 0.8 // the tail: a fan widening to the tip, forked
    if (an > half || (tt > 0.7 && an < (tt - 0.7) * 5)) return null
    col = V.fin
    key = 5
    fin = true
  } else {
    const fs = (s - 0.2) / 0.16 // pectoral fins, swept back and flapping
    if (fs < 0 || fs > 1) return null
    const w0 = halfWidth(s, f.Wd)
    const reach = (2.9 + 0.5 * Math.sin(f.flap)) * (1 - fs) ** 0.8
    if (an < w0 || an > w0 + reach) return null
    const root = V.motoguro && an < w0 + 1.2
    col = root ? COL.black : V.fin
    key = root ? 6 : 5
    fin = true
  }
  if (fin) col = mix(col, ground, 0.48) // fins and tail are see-through
  if (f.depth > 0) col = mix(col, ground, f.depth * 0.55)
  return [col, key]
}

function paintPond(g: Grid) {
  const s = g.w === cols * 2 ? 1 : 2 // dots per sample
  const W = cols * 2
  const H = rows * 4
  if (waterDots) {
    for (let y = 2; y < H; y += 8) for (let x = (y * 3) % 8; x < W; x += 8) put(g, Math.floor(x / s), Math.floor(y / s), COL.water, L_WATER, 4000)
  }
  const light = lightLevel() // the tank's curve: the pond dims as the context fills
  const night = Math.max(0, Math.min(1, (0.75 - light) / 0.35)) // 0 lit .. 1 night
  caustics(g, s, light, night)
  if (night > 0) moon(g, s, night)
  // deepest first, so a koi nearer the surface passes over
  const order = [...pond.fish].sort((a, b) => b.depth - a.depth || a.L - b.L)
  order.forEach((f, z) => {
    const sp = spine(f)
    let x0 = 1e9
    let y0 = 1e9
    let x1 = -1e9
    let y1 = -1e9
    for (const p of sp) {
      x0 = Math.min(x0, p[0])
      y0 = Math.min(y0, p[1])
      x1 = Math.max(x1, p[0])
      y1 = Math.max(y1, p[1])
    }
    const pad = f.Wd + 4
    for (let gy = Math.max(0, Math.floor((y0 - pad) / s)); gy <= Math.min(g.h - 1, Math.ceil((y1 + pad) / s)); gy += 1) {
      for (let gx = Math.max(0, Math.floor((x0 - pad) / s)); gx <= Math.min(g.w - 1, Math.ceil((x1 + pad) / s)); gx += 1) {
        const hit = topKoiAt(f, sp, (gx + 0.5) * s, (gy + 0.5) * s)
        if (hit) put(g, gx, gy, hit[0], pond.fish[visit.i] === f && (visit.leaving ? visit.fade > 0.5 : visit.inMoon) ? L_MOON + 1 : L_FISH + z, (z + 1) * 16 + hit[1]) // the visitor, at the surface, lies over the moon's reflection
      }
    }
  })
  // lily pads float over the koi
  for (const [cx, cy, r, flower] of padsFor()) {
    for (let gy = Math.floor((cy - r) / s); gy <= Math.ceil((cy + r) / s); gy += 1) {
      for (let gx = Math.floor((cx - 1.1 * r) / s); gx <= Math.ceil((cx + 1.1 * r) / s); gx += 1) {
        const x = (gx + 0.5) * s - cx
        const y = (gy + 0.5) * s - cy
        if ((x / (1.1 * r)) ** 2 + (y / r) ** 2 > 1) continue
        const ang = Math.atan2(y, x)
        if (Math.abs(ang) < 0.32 && x > 0) continue // the notch, a wedge to the centre
        let c = Math.abs(Math.sin(ang * 4)) < 0.18 ? COL.padDark : COL.pad // veins
        const bloom = 0.38 - 0.2 * night // at night the flower closes to a bud
        if (flower && (x + 0.35 * r) ** 2 + (y + 0.2 * r) ** 2 < (bloom * r) ** 2) c = night > 0.5 ? NIGHT_COL.bud : COL.flower
        put(g, gx, gy, c, L_PAD, c === COL.flower ? 1001 : 1000) // the closed bud keys as the leaf, so the moon's wash takes it with the leaf
      }
    }
  }
  for (const q of pond.pellets) put(g, Math.floor(q.x / s), Math.floor(q.y / s), COL.pellet, L_FOOD, 2000)
  for (const r of pond.ripples) {
    const rad = 1 + r.age * 7
    const c = mix(ground, COL.ripple, 1 - r.age / 1.6)
    for (let a = 0; a < 360; a += 4) {
      const x = r.x + rad * Math.cos((a * Math.PI) / 180)
      const y = r.y + rad * Math.sin((a * Math.PI) / 180)
      putEmpty(g, Math.floor(x / s), Math.floor(y / s), c, L_RIPPLE, 3000) // over the moon a ring shatters the reflection instead (see moon)
    }
  }
  for (const d of pond.drops) {
    // a raindrop: a dot, then a small ring that widens and fades, on open water;
    // a visitor's hello bubble breaks the surface over the moon too, never over the koi
    const drop = d.hello ? putOverMoon : putEmpty
    if (d.age < 0.15) {
      drop(g, Math.floor(d.x / s), Math.floor(d.y / s), NIGHT_COL.drop, L_RIPPLE, 3001)
      continue
    }
    const c = mix(ground, COL.ripple, 0.9 - d.age)
    const rad = 0.8 + d.age * (s === 1 ? 4.5 : 5)
    for (let a = 0; a < 360; a += s === 1 ? 20 : 30) {
      const x = d.x + rad * Math.cos((a * Math.PI) / 180)
      const y = d.y + rad * Math.sin((a * Math.PI) / 180) * 0.8
      drop(g, Math.floor(x / s), Math.floor(y / s), c, L_RIPPLE, 3001)
    }
  }
  if (fly.mode !== 'away') dragonfly(g, s)
  if (light < 1) {
    // dusk to night: everything darkens toward a night blue, but for the moon and
    // its light, which are drawn for the night already, and the dragonfly, dimmed less
    for (let i = 0; i < g.col.length; i += 1) {
      const c = g.col[i]!
      const k = g.key[i]!
      if (c < 0 || k === KEY_MOON || k === KEY_GLINT || k === KEY_CAUSTIC) continue
      g.col[i] = k === KEY_FLY || k === KEY_WING ? mix(c, ground, (1 - light) * 0.4) : mix(ground, mix(c, 0x1a2c4a, (1 - light) * 0.55), 0.25 + light * 0.75)
    }
  }
  if (night > 0) pondMoonlight(g, s, night, order)
}

function feedPond() {
  const W = cols * 2
  const H = rows * 4
  const x = 20 + rnd() * Math.max(1, W - 40)
  const y = 5 + rnd() * Math.max(1, H - 10)
  pond.ripples.push({ x, y, age: 0 })
  for (let i = 0; i < 5; i += 1) {
    pond.pellets.push({ x: x + (rnd() - 0.5) * 10, y: Math.max(2, Math.min(H - 2, y + (rnd() - 0.5) * 6)), age: 0 })
  }
}

// ---- the pond and the caret --------------------------------------------------------

const typing = () => caretKoi && caret.t < CARET_LINGER

function follows(f: PondKoi): boolean {
  return typing() && caret.picked >= 0 && pond.fish[caret.picked] === f
}

// the lean's window, in dots, or null when the band is too narrow, nobody
// types, or the koi are asleep
function leanWindow(): [number, number] | null {
  if (!typing() || cols < LEAN_MIN_COLS || speedFactor() === 0) return null
  const half = cols * LEAN_SPAN
  return [caret.x - half, caret.x + half]
}

function leans(f: PondKoi): boolean {
  const w = leanWindow()
  return !!w && f.x >= w[0] && f.x <= w[1] && !follows(f)
}

// how much more a stirring sleeper's body waves, swelling and fading
function stirOf(f: PondKoi): number {
  return twitch.t > 0 && pond.fish[twitch.i] === f ? 1.2 * Math.sin((Math.PI * twitch.t) / TWITCH_S) : 0
}

// The caret is over band column `col`; typed: an edit, not just a move.
function caretAt(col: number, typed: boolean) {
  caret.x = Math.max(1, Math.min(cols * 2 - 1, col * 2 + 1))
  const was = typing()
  caret.t = 0
  if (!was || caret.picked < 0) {
    // the koi nearest the spot comes
    let best = Infinity
    pond.fish.forEach((f, i) => {
      const d = Math.hypot(f.x - caret.x, f.y - (rows * 4 - 4.5))
      if (d < best) {
        best = d
        caret.picked = i
      }
    })
  }
  if (!typed) return
  if (speedFactor() === 0 && twitch.cool <= 0) {
    // asleep: the sleeper nearest the caret stirs, if one is within the lean's reach
    let best = cols * LEAN_SPAN
    twitch.i = -1
    pond.fish.forEach((f, i) => {
      const d = Math.abs(f.x - caret.x)
      if (d < best && i !== visit.i) {
        best = d
        twitch.i = i
      }
    })
    if (twitch.i >= 0) {
      twitch.t = TWITCH_S
      twitch.cool = 3 + rnd() * 2 // now and then, not at every key
      const f = pond.fish[twitch.i]!
      pond.drops.push({ x: f.x + Math.cos(f.th) * 1.5, y: f.y + Math.sin(f.th) * 1.5, age: 0 }) // and one small bubble at its mouth
    }
  }
  if (caret.tapT <= 0) {
    caret.tapT = 0.22 // a fingertip on the water, four or five a second at most
    pond.drops.push({ x: caret.x, y: rows * 4 - 1.5, age: 0 })
  }
}

// The band column over the caret, the draft wrapping at the band's width
// after PROMPT_LEFT: its place in its own line, wrapped.
function caretColumn(text: string, at: number): number {
  const wrap = Math.max(1, cols - PROMPT_LEFT)
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  return PROMPT_LEFT + ((at - lineStart) % wrap)
}

// ---- the pond's weather: night, rain, caustics and a dragonfly ----------------------

const NIGHT_COL = { bud: 0xc77d92, drop: 0x9cc7da, moon: 0xe9e6d2, glint: 0xb9c2c8, moonlit: 0xa8b8c8, daylight: 0x3f7488, wing: 0xd6e8ef, silver: 0xdce6f4, visitor: 0xf7faff }
const KEY_CAUSTIC = 4100
const KEY_MOON = 7700
const KEY_GLINT = 7701
const KEY_FLY = 7800
const KEY_WING = 7801
// The moon's reflection is on the surface, so a koi passes under it: above the
// koi, below pads, food and rings.
const L_MOON = 75
// Above everything: braille shows only a cell's top layer, so the dragonfly wins
// its cells whole, wings included; the body a layer up, so it stays blue.
const L_FLY = 98

// [x, y, radius, flowering], in dots
function padsFor(): [number, number, number, boolean][] {
  const W = cols * 2
  const H = rows * 4
  const pads: [number, number, number, boolean][] = [[W - 17, 7, 5.6, true], [13, H - 7, 5, false]]
  if (W > 110) pads.push([Math.floor(W * 0.46), H - 7, 5.4, true])
  return pads
}

// In open water between the pads, clear of where the koi sleep.
const moonAt = (): [number, number] => [cols * 2 * 0.64, rows * 4 * 0.42]

// Light on the pond floor: the bright seams where three slow waves meet, under
// the koi. By moonlight they turn silver and faint, strongest beneath the moon.
function caustics(g: Grid, s: number, light: number, night: number) {
  const t = pond.ct
  const [mx, my] = moonAt()
  const day = mix(ground, NIGHT_COL.daylight, s === 1 ? 0.22 + 0.18 * light : 0.14 + 0.12 * light)
  for (let gy = 0; gy < g.h; gy += 1) {
    for (let gx = 0; gx < g.w; gx += 1) {
      const x = (gx + 0.5) * s
      const y = (gy + 0.5) * s
      const v = Math.sin(x * 0.21 + t * 0.6) + Math.sin(y * 0.37 - t * 0.45 + x * 0.08) + Math.sin((x + y) * 0.13 + t * 0.35)
      if (Math.abs(v - 0.9) >= (s === 1 ? 0.07 : 0.045)) continue
      let c = day
      if (night > 0) {
        const near = Math.exp(-Math.hypot((x - mx) * 0.6, y - my) / 14)
        c = mix(day, mix(ground, NIGHT_COL.moonlit, (s === 1 ? 0.14 : 0.09) + (s === 1 ? 0.3 : 0.22) * near), night)
      }
      put(g, gx, gy, c, 1, KEY_CAUSTIC)
    }
  }
}

// The moon on the water: a pale oval, broken into slivers by the ripples: a ring
// that crosses it bends its edge and cuts gaps between slivers that settle back.
function moon(g: Grid, s: number, night: number) {
  const [cx, cy] = moonAt()
  const rx = 7.5
  const ry = 5
  const bright = mix(ground, NIGHT_COL.moon, 0.35 + 0.55 * night)
  const dim = mix(ground, NIGHT_COL.glint, 0.2 + 0.35 * night)
  for (let gy = Math.floor((cy - ry - 3) / s); gy <= Math.ceil((cy + ry + 3) / s); gy += 1) {
    for (let gx = Math.floor((cx - rx - 8) / s); gx <= Math.ceil((cx + rx + 8) / s); gx += 1) {
      const x = (gx + 0.5) * s
      const y = (gy + 0.5) * s
      const st = stir(x, y)
      if (st > 0.27 && Math.sin(y * 3.1 + x * 0.7 + pond.t * 5) > 0.2) continue // shattered, a gap between slivers
      const u = (x + Math.sin(y * 1.3 + pond.t * 1.6) * (0.9 + 3.1 * st) - cx) / rx
      const v = (y - cy) / ry
      const rr = u * u + v * v
      if (rr < 1) put(g, gx, gy, rr < 0.45 ? bright : mix(bright, ground, 0.35), L_MOON, KEY_MOON)
      else if (Math.abs(v) < 1.2 && u * u < 3.2 && Math.sin(y * 2.1 + pond.t * 2 + x * 0.4) > 0.55) put(g, gx, gy, dim, L_MOON, KEY_GLINT) // glints trailing off
    }
  }
}

// Every 10 to 25 seconds a dragonfly darts in, perches on a pad, and darts off.
// Dragonflies hunt by day and roost by dark: as dusk comes on it flies off the
// nearer edge and stays away until the light comes back.
function stepFly(dt: number) {
  const W = cols * 2
  const H = rows * 4
  if (lightLevel() < 0.75) {
    if (fly.mode === 'away') {
      fly.wait = Math.max(fly.wait, 4) // back a few seconds after the light is
      return
    }
    if (fly.mode !== 'out') {
      fly.mode = 'out'
      fly.tx = fly.x < W / 2 ? -10 : W + 10
      fly.ty = fly.y
    }
  }
  if (fly.mode === 'away') {
    fly.wait -= dt
    if (fly.wait > 0) return
    const pads = padsFor()
    const p = pads[Math.floor(rnd() * pads.length)]!
    fly.x = rnd() < 0.5 ? -6 : W + 6
    fly.y = 2 + rnd() * (H - 4)
    fly.tx = p[0] + (rnd() - 0.5) * p[2]
    fly.ty = p[1] + (rnd() - 0.5) * p[2] * 0.6
    fly.mode = 'in'
    return
  }
  if (fly.mode === 'perched') {
    fly.wait -= dt
    if (fly.wait <= 0) {
      fly.mode = 'out'
      fly.tx = rnd() < 0.5 ? -10 : W + 10
      fly.ty = rnd() * H
    }
    return
  }
  // dart, hang in the air, dart again
  const dx = fly.tx - fly.x
  const dy = fly.ty - fly.y
  const d = Math.hypot(dx, dy)
  const v = 28 * (Math.sin(pond.t * 5) > -0.3 ? 1 : 0.1)
  fly.th = Math.atan2(dy, dx)
  if (d < v * dt + 0.3) {
    fly.x = fly.tx
    fly.y = fly.ty
    fly.mode = fly.mode === 'in' ? 'perched' : 'away'
    fly.wait = fly.mode === 'perched' ? 3 + rnd() * 4 : 10 + rnd() * 14
    return
  }
  fly.x += (dx / d) * v * dt
  fly.y += (dy / d) * v * dt + Math.sin(pond.t * 9) * 0.6 * dt
}

// A dragonfly from above: a long blue body, four glassy wings.
function dragonfly(g: Grid, s: number) {
  const L = s === 1 ? 7 : 6
  const flying = fly.mode !== 'perched'
  const cx = Math.cos(fly.th)
  const sy = Math.sin(fly.th)
  const flick = flying ? Math.sin(pond.t * 60) : fly.wait % 1.4 < 0.12 ? 1 : 0 // perched, a flick now and then
  const wing = mix(ground, NIGHT_COL.wing, flying ? 0.62 : 0.75)
  for (let k = 0; k <= L; k += 1) {
    const x = fly.x - cx * k * (s === 1 ? 1 : 1.2)
    const y = fly.y - sy * k * (s === 1 ? 1 : 1.2)
    put(g, Math.floor(x / s), Math.floor(y / s), k <= 1 ? 0x2e7d9a : k < 3 ? 0x3d9ec0 : 0x4bb3d6, L_FLY + 1, KEY_FLY)
  }
  const bx = fly.x - cx * 2.2
  const by = fly.y - sy * 2.2
  for (const side of [-1, 1]) {
    for (const [back, len] of [[0, 4.5], [1.6, 4]] as [number, number][]) {
      const sweep = 0.35 * side * (flick > 0 ? 1 : 0.6)
      for (let k = 1; k <= len; k += 1) {
        const ox = -sy * side * k + cx * (sweep * k - back)
        const oy = cx * side * k + sy * (sweep * k - back)
        put(g, Math.floor((bx + ox) / s), Math.floor((by + oy) / s), wing, L_FLY, KEY_WING)
        if (s === 1) put(g, Math.floor(bx + ox - cx * 0.9), Math.floor(by + oy - sy * 0.9), wing, L_FLY, KEY_WING) // two dots deep, so a wing holds its cell
      }
    }
  }
}

// How much the rings and drops stir the water at (x, y): 0 calm .. 1 a ring right here.
function stir(x: number, y: number): number {
  let a = 0
  for (const r of pond.ripples) {
    const off = Math.abs(Math.hypot(x - r.x, y - r.y) - (1 + r.age * 7))
    if (off < 2.5) a += (1 - off / 2.5) * (1 - r.age / 1.6)
  }
  for (const d of pond.drops) {
    if (d.age < 0.15) continue
    const off = Math.abs(Math.hypot(x - d.x, (y - d.y) / 0.8) - (0.8 + d.age * 4.8))
    if (off < 2) a += (1 - off / 2) * (0.9 - d.age)
  }
  return Math.min(1, a)
}

// A hello bubble's ring: over the moon's reflection and open water, under the
// visitor (a layer above the moon) and the pads.
function putOverMoon(g: Grid, x: number, y: number, c: number, layer: number, key: number) {
  if (x < 0 || y < 0 || x >= g.w || y >= g.h || g.layer[y * g.w + x]! > L_MOON) return
  put(g, x, y, c, layer, key)
}

// Moonlight, painted over the dimmed pond as the tank does it: only what is
// already there, silvered, and with a key of its own, so where its dots are the
// most in a braille cell, the cell goes silver whole, as the dragonfly takes its
// cells. The visitor silvers (the other koi sleep under the pads, dark), rings
// near the moon catch it, and each pad is washed from the moon's side.
const SILVER_PART = 15 // a koi's own silver key, beside its body, fin and eye keys
const KEY_RIM = 1002
function pondMoonlight(g: Grid, s: number, night: number, order: PondKoi[]) {
  const [mx, my] = moonAt()
  const vk = pond.fish[visit.i]
  const z = vk ? order.indexOf(vk) : -1
  if (vk && z >= 0 && visit.glow > 0) {
    // from dark to a soft silver back down its middle, widening as it comes
    // into the moon until it is silver whole, fins and tail too
    const sp = spine(vk)
    const lo = (z + 1) * 16
    const glow = visit.glow
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
    for (const p of sp) {
      x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1])
    }
    const pad = vk.Wd + 4 // as wide as the koi is drawn: fin and tail tips included
    for (let gy = Math.max(0, Math.floor((y0 - pad) / s)); gy <= Math.min(g.h - 1, Math.ceil((y1 + pad) / s)); gy += 1) {
      for (let gx = Math.max(0, Math.floor((x0 - pad) / s)); gx <= Math.min(g.w - 1, Math.ceil((x1 + pad) / s)); gx += 1) {
        const i = gy * g.w + gx
        const part = g.key[i]! - lo
        if (part < 0 || part >= 16 || g.col[i]! < 0) continue // not this koi on top
        if ((visit.inMoon && visit.contact > 0.9) || visit.leaving) {
          // nearly full in the moon: every dot of it, eye, fins and tail too, lit as
          // one part, so braille's one colour a cell can never fall to an unlit
          // flank and show a hole; fading to its own dark colours on the way home
          g.col[i] = mix(g.col[i]!, mix(NIGHT_COL.silver, NIGHT_COL.visitor, visit.contact * visit.fade), (0.7 + 0.3 * visit.contact) * visit.fade)
          g.key[i] = lo + SILVER_PART
          continue
        }
        if (part === 9) continue // the eye
        const lit = visit.contact
        const fin = part === 5 || part === 6
        if (fin && lit <= 0) continue
        const [sv, n] = locate(sp, (gx + 0.5) * s, (gy + 0.5) * s)
        if (fin || sv > 0.74) {
          if (lit > 0) {
            g.col[i] = mix(g.col[i]!, mix(NIGHT_COL.silver, NIGHT_COL.visitor, lit), Math.min(1, 0.85 * lit * glow + 0.15 * lit))
            g.key[i] = lo + SILVER_PART
          }
          continue
        }
        if (sv < 0.05) continue
        const u = Math.abs(n) / Math.max(0.6, halfWidth(sv, vk.Wd))
        if (u > (s === 1 ? 0.6 : 0.7) + 0.9 * lit) continue // into the moon: every body dot, edges too, so no dim speckle
        if (glow < 0.15) continue
        g.col[i] = mix(g.col[i]!, mix(NIGHT_COL.silver, NIGHT_COL.visitor, lit), Math.min(1, 0.25 + 0.3 * glow + 0.45 * lit)) // softer than the moon until it is in it
        g.key[i] = lo + SILVER_PART
      }
    }
  }
  if (vk && visit.contact > 0) {
    // it parts the reflection: calm water round it, the rest of the moon a touch dimmer
    const sp = spine(vk)
    const gap = 1.8 * visit.contact * visit.fade // dots of calm water between the koi and the reflection
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
    for (const p of sp) {
      x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1])
    }
    const pad = vk.Wd + 6
    for (let gy = Math.max(0, Math.floor((y0 - pad) / s)); gy <= Math.min(g.h - 1, Math.ceil((y1 + pad) / s)); gy += 1) {
      for (let gx = Math.max(0, Math.floor((x0 - pad) / s)); gx <= Math.min(g.w - 1, Math.ceil((x1 + pad) / s)); gx += 1) {
        const i = gy * g.w + gx
        const k = g.key[i]!
        if (k !== KEY_MOON && k !== KEY_GLINT) continue // the reflection only
        const [sv, n] = locate(sp, (gx + 0.5) * s, (gy + 0.5) * s)
        const tt = Math.max(0, (sv - 0.74) / 0.26)
        const half = sv > 0.74 ? 0.8 + 2.9 * tt ** 0.8 : halfWidth(Math.max(0, sv), vk.Wd) + (sv > 0.2 && sv < 0.36 ? 2.9 : 0) // body, tail fan, pectoral fins
        if (sv < -0.08 || sv > 1.08 || Math.abs(n) - half > gap) {
          g.col[i] = mix(g.col[i]!, ground, 0.2 * visit.contact)
          continue
        }
        g.col[i] = NONE // parted: no moon dots in the koi's gaps or round its edge
        g.layer[i] = -1
        g.key[i] = 0
      }
    }
  }
  // the water never covers the visitor: braille shows a cell's top layer only, so
  // a ring dot in a cell the koi shares would hide the koi's dots there; in any
  // cell with the visitor in it, the rings give way
  if (vk && (visit.inMoon || visit.leaving) && s === 1) {
    for (let cy = 0; cy < rows; cy += 1) for (let cx = 0; cx < cols; cx += 1) {
      let koi = false
      for (let dy = 0; dy < 4 && !koi; dy += 1) for (let dx = 0; dx < 2; dx += 1) if (g.layer[(cy * 4 + dy) * g.w + cx * 2 + dx] === L_MOON + 1) koi = true
      if (!koi) continue
      for (let dy = 0; dy < 4; dy += 1) for (let dx = 0; dx < 2; dx += 1) {
        const i = (cy * 4 + dy) * g.w + cx * 2 + dx
        if (g.key[i] === 3000 || g.key[i] === 3001) { g.col[i] = NONE; g.layer[i] = -1; g.key[i] = 0 }
      }
    }
  }
  // moonlit rings: food rings, rises and raindrops catch the moon as they pass near it
  for (let i = 0; i < g.col.length; i += 1) {
    const k = g.key[i]!
    if ((k !== 3000 && k !== 3001) || g.col[i]! < 0) continue
    const x = ((i % g.w) + 0.5) * s
    const y = (Math.floor(i / g.w) + 0.5) * s
    const nm = Math.exp(-Math.hypot((x - mx) * 0.55, y - my) / 21)
    g.col[i] = mix(g.col[i]!, NIGHT_COL.silver, Math.min(0.92, 1.8 * nm) * night)
  }
  // the pads: moonlight washed across each whole leaf from the moon's side, no rim
  // and no unlit core: full at the edge toward the moon, fading evenly across the
  // leaf to nothing a little past its middle; where it falls the notch is closed over
  const light = lightLevel()
  for (const [cx, cy, r] of padsFor()) {
    const ax = mx - cx
    const ay = my - cy
    const al = Math.hypot(ax, ay) || 1
    for (let gy = Math.floor((cy - r) / s); gy <= Math.ceil((cy + r) / s); gy += 1) {
      for (let gx = Math.floor((cx - 1.1 * r) / s); gx <= Math.ceil((cx + 1.1 * r) / s); gx += 1) {
        if (gx < 0 || gy < 0 || gx >= g.w || gy >= g.h) continue
        const i = gy * g.w + gx
        const x = (gx + 0.5) * s - cx
        const y = (gy + 0.5) * s - cy
        const rr = Math.sqrt((x / (1.1 * r)) ** 2 + (y / r) ** 2)
        const ang = Math.atan2(y, x)
        const across = (x * ax + y * ay) / (al * 1.1 * r) // -1 the far edge .. 1 the edge toward the moon
        if (rr <= 1 && x > 0 && Math.abs(ang) < 0.32 && g.layer[i]! < L_PAD && across > -0.35) {
          g.col[i] = mix(ground, mix(COL.pad, 0x1a2c4a, (1 - light) * 0.55), 0.25 + light * 0.75) // the leaf, dimmed as the night dims it
          g.layer[i] = L_PAD
          g.key[i] = 1000
        }
        if (g.key[i] !== 1000) continue // the leaf and its closed bud only: not a koi, ring or dragonfly over it
        const fade = Math.max(0, Math.min(1, (across + 0.35) / 1.2)) ** 1.4
        if (fade <= 0) continue
        const glint = rr > 0.7 && Math.sin(ang * 3 - pond.t * 0.9) > 0.85 ? 0.08 : 0
        const lit = 0.85 * fade + glint
        g.col[i] = mix(g.col[i]!, NIGHT_COL.silver, Math.min(0.92, lit) * night)
        if (lit > 0.3) g.key[i] = KEY_RIM // the faint end blends into the leaf, so the fade carries into braille
      }
    }
  }
}

// ---- the tank: koi from the side -------------------------------------------------
//
// World units are the samples themselves: dots (cols*2 by rows*4) or pixels
// (cols by rows*2). In dots a cell has one colour, so a koi's markings are
// authored in whole cells and its body always fills the same two cell rows
// (see tankY); in pixels every pixel has its own colour, so the markings are
// drawn finely, hanging from the back as real koi carry them.

type SideVariety = 'kohaku' | 'showa' | 'hiutsuri' | 'shiro' | 'ogon'
type TankKoi = {
  pattern: SideVariety
  x: number // head, in samples
  yBase: number
  home: number // the lane it is settling into
  L: number
  Hh: number
  dir: 1 | -1 // -1 swims left (head at the left)
  speed: number // samples a second while cruising
  phase: number
  wave: number
  depth: number // how far from the glass: dimmer and behind
  turning: number // seconds left in a turn
  task: 'swim' | 'forage' | 'gulp'
  taskT: number
  drift: number // seconds left in a sleeping drift
  driftV: number
}
type Part = 'body' | 'fin' | 'tail'
type SideDot = { x: number; y: number; part: Part | 'eye' }
type Flake = { x: number; y: number; age: number; settled: number }
type Bubble = { x: number; y: number; wob: number; size: number }
type Pop = { x: number; age: number }
type Puff = { x: number; y: number; vx: number; vy: number; age: number }
type Splash = { x: number; age: number }

const SNAIL_SPEED = 1.2 // columns a second, in dots
const ALGAE_FULL_S = 75 * 60 // algae is fully grown after an hour and a quarter
let algaeT = 0 // seconds the tank has run this session
const tank = { fish: [] as TankKoi[], flakes: [] as Flake[], bubbles: [] as Bubble[], pops: [] as Pop[], puffs: [] as Puff[], splashes: [] as Splash[], t: 0, nextBubble: 0 }
const TURN_S = 1.5

// The roster, in the order the tank fills as the band widens; sizes in dots.
const TANK_ROSTER: { pattern: SideVariety; L: number; Hh: number; lane: number }[] = [
  { pattern: 'kohaku', L: 26, Hh: 6, lane: 0.42 },
  { pattern: 'showa', L: 26, Hh: 6, lane: 0.7 },
  { pattern: 'hiutsuri', L: 22, Hh: 4.6, lane: 0.17 },
  { pattern: 'shiro', L: 24, Hh: 6, lane: 0.33 },
  { pattern: 'ogon', L: 14, Hh: 4, lane: 0.88 },
]

const BASE: Record<SideVariety, number> = { kohaku: COL.white, showa: COL.orange, hiutsuri: COL.black, shiro: COL.white, ogon: COL.gold }
const MARK: Record<SideVariety, number> = { kohaku: COL.orange, showa: COL.black, hiutsuri: COL.orange, shiro: COL.black, ogon: COL.gold }

// For dots: each variety as a two-row mosaic of cells, back over belly, one
// character per cell column from the head: 'x' the marking, '.' the ground.
const MOSAIC: Record<SideVariety, [string, string]> = {
  kohaku: ['.xx.xx.x.', '.........'], // sandan: three red steps along the back
  showa: ['.x..x.xx.', '....x..x.'], // menware on the head, a wrap, a saddle that reaches the belly
  hiutsuri: ['.xx.xxx.', '.x...xx.'], // two orange wraps on black
  shiro: ['.x.xx.x.', '...x..x.'], // shiro utsuri: black head stroke and wraps on white
  ogon: ['', ''],
}

function mosaicAt(pattern: SideVariety, k: number, rank: number): number | null {
  if (pattern === 'ogon') return COL.gold
  const row = MOSAIC[pattern][rank]
  if (row === undefined || k < 0 || k >= row.length) return null
  return row[k] === 'x' ? MARK[pattern] : BASE[pattern]
}

// For pixels: a patch hanging from the back, as koi markings do: pinched to the
// dorsal edge at both ends, deepest in the middle. t runs 0..1 along the body,
// u -1..1 from back to belly; depth 1 wraps the whole body.
function saddle(t: number, u: number, t0: number, t1: number, depth: number, slant = 0): boolean {
  const tt = t + slant * u
  if (tt < t0 || tt > t1) return false
  const p = (tt - t0) / (t1 - t0)
  return u <= -1 + 2 * depth * Math.sin(Math.PI * p) ** 0.6
}

// The fine colour of a variety at a point in the fish's frame (x from the
// head, y down from the centre line, in samples).
function sidePaint(pattern: SideVariety, L: number, Hh: number, x: number, y: number): number {
  const half = Hh / 2
  const bodyL = L * 0.7
  const base = BASE[pattern]
  const t = x / bodyL
  const u = Math.max(-1, Math.min(1, y / half))
  if (t > 1) return base
  switch (pattern) {
    case 'kohaku':
      return saddle(t, u, 0.06, 0.3, 0.55) || saddle(t, u, 0.4, 0.64, 0.85) || saddle(t, u, 0.72, 0.95, 0.6) ? COL.orange : base
    case 'showa': {
      const stripe = t + 0.25 * u >= 0.1 && t + 0.25 * u <= 0.19 && u <= 0.35 // menware: the stripe down the head
      if (stripe || saddle(t, u, 0.4, 0.56, 1) || saddle(t, u, 0.74, 0.88, 0.55)) return COL.black
      return u > 0.45 && t > 0.5 && t < 0.72 ? COL.white : base // a white belly patch: showa is three colours
    }
    case 'shiro': {
      const stripe = t + 0.25 * u >= 0.1 && t + 0.25 * u <= 0.19 && u <= 0.35
      return stripe || saddle(t, u, 0.37, 0.52, 1, 0.1) || saddle(t, u, 0.7, 0.85, 1, 0.1) ? COL.black : base
    }
    case 'hiutsuri':
      return saddle(t, u, 0.12, 0.36, 0.8) || saddle(t, u, 0.52, 0.82, 0.95) ? COL.orange : base
    default:
      return base
  }
}

// A koi from the side, facing left, head at the origin, body along +x: a
// rounded head, the body tapering to the tail, a slanted gap before the forked
// tail, a dorsal fin along the back, the pectoral, pelvic and anal fins
// beneath, and the eye.
const shapeCache = new Map<string, SideDot[]>()

function sideShape(L: number, Hh: number, wag: number, flap: number): SideDot[] {
  const key = `${L},${Hh},${wag.toFixed(1)},${flap.toFixed(1)}`
  const hit = shapeCache.get(key)
  if (hit) return hit
  const half = Hh / 2
  const bodyL = L * 0.7
  const cut = (y: number) => bodyL - 1 + 0.45 * y // the slanted separator before the tail
  const dots: SideDot[] = []
  const seen = new Set<string>()
  const add = (x: number, y: number, part: Part) => {
    const k = `${x},${y}`
    if (seen.has(k)) return
    seen.add(k)
    dots.push({ x, y, part })
  }
  const top: number[] = []
  for (let x = 0; x <= Math.floor(bodyL); x += 1) {
    const t = x / bodyL
    const h = t < 0.3 ? half * Math.sqrt(Math.max(0, 1 - ((0.3 - t) / 0.3) ** 2)) : (half - 0.8) * (1 - ((t - 0.3) / 0.7) ** 1.3) + 0.8
    const hh = Math.round(h)
    top[x] = hh
    for (let y = -hh; y <= hh; y += 1) if (x <= cut(y)) add(x, y, 'body')
  }
  const tailStart = bodyL + 1
  for (let x = Math.floor(bodyL) - 2; x <= L; x += 1) {
    const t = Math.max(0, Math.min(1, (x - tailStart) / Math.max(1, L - tailStart)))
    const spread = 0.8 + t * (half - 0.5)
    const bend = wag * t * t * half
    for (const lobe of [-1, 1]) {
      const yc = lobe * spread * 0.85 + bend
      for (let y = Math.floor(yc - 0.5); y <= Math.ceil(yc + 0.5); y += 1) {
        if (x >= Math.floor(cut(y)) + 2) add(x, y, 'tail') // exactly one unlit dot behind the body
      }
    }
  }
  const at = (t: number) => Math.round(bodyL * t)
  const edge = (x: number) => top[Math.max(0, Math.min(top.length - 1, x))] ?? 0
  // dorsal fin: rising from the shoulder, two rows tall at the front, one behind
  for (let x = at(0.34); x <= at(0.72); x += 1) {
    add(x, -edge(x) - 1, 'fin')
    if (x <= at(0.48)) add(x, -edge(x) - 2, 'fin')
  }
  // pectoral fin: swept back below the gill, swinging with the stroke
  const swing = Math.round(flap)
  for (let i = 0; i < 2; i += 1) {
    for (let x = at(0.22) + i + swing; x <= at(0.22) + i + 2 + swing; x += 1) add(x, edge(at(0.22)) + 1 + i, 'fin')
  }
  // pelvic and anal fins, smaller, further back
  add(at(0.5), edge(at(0.5)) + 1, 'fin')
  add(at(0.5) + 1, edge(at(0.5)) + 1, 'fin')
  add(at(0.5) + 1, edge(at(0.5)) + 2, 'fin')
  add(at(0.75), edge(at(0.75)) + 1, 'fin')
  add(at(0.75) + 1, edge(at(0.75)) + 1, 'fin')
  const ex = Math.round(bodyL * 0.09)
  for (const d of dots) if (d.y === -1 && (d.x === ex || d.x === ex + 1) && d.part === 'body') d.part = 'eye'
  if (shapeCache.size > 512) shapeCache.clear()
  shapeCache.set(key, dots)
  return dots
}

// For pixels: koi drawn by hand, a pixel at a time, facing left with the nose
// at x 0 and the centre line at y 0. b body, E eye, d dorsal fin, p pectoral
// (it swings with the stroke), v pelvic, a anal, t tail (it swishes).
type Sprite = { rows: string[]; top: number; bodyL: number; half: number }
const BIG: Sprite = { top: -3, bodyL: 17, half: 2.5, rows: [
  '......ddd.............',
  '....bbbbbbbbdd......tt',
  '..bEbbbbbbbbbbbb...ttt',
  '.bbbbbbbbbbbbbbbbbttt.',
  'bbbbbbbbbbbbbbbbb..ttt',
  '.bbbbbbbbbbbbbb.....tt',
  '...pp....vv..a........',
] }
const SMALL: Sprite = { top: -2, bodyL: 11, half: 2, rows: [
  '.....dd.......',
  '..bEbbbbbb..tt',
  '.bbbbbbbbbbtt.',
  'bbbbbbbbbbb.tt',
  '..bbbbbbb...tt',
  '...pp..v......',
] }

const spriteCache = new Map<string, SideDot[]>()

function spriteDots(sp: Sprite, wag: number, flap: number): SideDot[] {
  const w = Math.round(wag)
  const f = flap > 0 ? 1 : 0
  const key = `${sp.bodyL},${w},${f}`
  const hit = spriteCache.get(key)
  if (hit) return hit
  const dots: SideDot[] = []
  const width = sp.rows[0]!.length
  const tailStart = sp.rows.reduce((m, r) => Math.min(m, r.indexOf('t') < 0 ? m : r.indexOf('t')), width)
  sp.rows.forEach((r, i) => {
    for (let x = 0; x < r.length; x += 1) {
      const ch = r[x]!
      const y = sp.top + i
      if (ch === '.') continue
      if (ch === 't') dots.push({ x, y: y + Math.round((w * (x - tailStart + 1)) / (width - tailStart)), part: 'tail' })
      else if (ch === 'p') dots.push({ x: x + f, y, part: 'fin' })
      else if (ch === 'E') dots.push({ x, y, part: 'eye' })
      else dots.push({ x, y, part: ch === 'b' ? 'body' : 'fin' })
    }
  })
  spriteCache.set(key, dots)
  return dots
}

// A turning koi, seen nearly end-on: a filled oval, no tail, fins or eye, that
// shrinks through the turn and grows back out.
function endOn(L: number, Hh: number, s: number): SideDot[] {
  const half = Hh / 2
  const len = Math.max(4, L * 0.7 * s)
  const dots: SideDot[] = []
  for (let x = 0; x <= Math.ceil(len); x += 1) {
    for (let y = -Math.ceil(half); y <= Math.ceil(half); y += 1) {
      if (((x - len / 2) / (len / 2)) ** 2 + (y / half) ** 2 <= 1) dots.push({ x: x / s, y, part: 'body' })
    }
  }
  return dots
}

const snap = () => draw === 'dots'
const tankW = () => (snap() ? cols * 2 : cols)
const tankH = () => (snap() ? rows * 4 : rows * 2)
// Lanes are centre lines: in dots one a cell row apart, so a body fills two
// whole cell rows; in pixels one a pixel apart, between the dorsal fin's room
// at the surface and the fins' and gravel's at the bottom.
const LANE = () => (snap() ? 4 : 1)
const maxLane = () => (snap() ? rows - 3 : Math.max(0, tankH() - 10)) // the bottom row is the gravel's and a resting koi's
const laneY = (lane: number) => 4 + Math.max(0, Math.min(maxLane(), lane)) * LANE()
const laneOf = (y: number) => Math.max(0, Math.min(maxLane(), Math.round((y - 4) / LANE())))

function resizeTank(prev: number) {
  const W = tankW()
  const H = tankH()
  const want = Math.max(2, Math.min(5, Math.round(cols / 36)))
  if (prev > 0) {
    const ratio = cols / prev
    for (const f of tank.fish) f.x = Math.min(W - 2, Math.max(1, f.x * ratio))
  }
  while (tank.fish.length < want) {
    const i = tank.fish.length
    const slot = TANK_ROSTER[i % TANK_ROSTER.length]!
    const sprite = slot.L < 20 ? SMALL : BIG
    const lane = laneOf(slot.lane * H)
    tank.fish.push({
      pattern: slot.pattern,
      x: Math.floor(W * ((i * 0.37 + 0.2) % 1)),
      yBase: laneY(lane),
      home: laneY(lane),
      L: snap() ? slot.L : sprite.rows[0]!.length,
      Hh: snap() ? slot.Hh : sprite.half * 2,
      dir: i % 2 === 0 ? -1 : 1,
      speed: (1.2 + rnd() * 1.2) * (snap() ? 1 : 0.5),
      phase: rnd() * Math.PI * 2,
      wave: 0.5 + rnd() * 0.5,
      depth: i === 0 ? 0 : rnd() * 0.35,
      turning: 0,
      task: 'swim',
      taskT: 0,
      drift: 0,
      driftV: 0,
    })
  }
  if (tank.fish.length > want) tank.fish = tank.fish.slice(0, want)
}

// A U-turn comes out one lane over, like turning on a two-way road: up or down,
// whichever has room, preferring the lane fewer koi are swimming the new way in.
function uTurnLane(f: TankKoi): number {
  const lane = laneOf(f.home)
  const heading = f.dir === 1 ? -1 : 1
  const choices = [lane - 1, lane + 1].filter(r => r >= 0 && r <= maxLane())
  if (choices.length === 0) return lane
  const traffic = (r: number) => tank.fish.filter(g => g !== f && g.dir === heading && Math.abs(laneOf(g.home) - r) < 2).length
  const best = Math.min(...choices.map(traffic))
  const open = choices.filter(r => traffic(r) === best)
  return open[Math.floor(rnd() * open.length)]!
}

function stepTank(dt: number) {
  tank.t += dt
  algaeT += dt
  const W = tankW()
  const H = tankH()
  const factor = speedFactor()
  const sink = snap() ? 1.2 : 0.6
  for (const f of tank.fish) {
    if (f.turning > 0) {
      // the end-on oval glides across into its new lane during the turn
      f.yBase += ((f.home - f.yBase) * dt) / f.turning
      const before = f.turning
      f.turning = Math.max(0, f.turning - dt)
      if (before > TURN_S / 2 && f.turning <= TURN_S / 2) f.dir = f.dir === 1 ? -1 : 1
      continue
    }
    if (factor === 0) {
      // resting: sink gently to the gravel and hold still
      const floor = H - f.Hh / 2 - (snap() ? 3 : 2)
      if (f.yBase < floor) f.yBase = Math.min(floor, f.yBase + 2 * dt)
      // asleep: now and then a koi drifts a little along the gravel and lets one bubble go
      if (f.yBase >= floor - 0.5) {
        if (f.drift > 0) {
          f.drift -= dt
          f.x = Math.max(4, Math.min(W - 4, f.x + f.driftV * dt))
        } else if (rnd() < dt / 9) {
          f.drift = 2.5
          f.driftV = (rnd() < 0.5 ? -1 : 1) * (snap() ? 1.2 : 0.6)
          tank.bubbles.push({ x: f.x - f.dir, y: fishCentre(f) - 1, wob: rnd() * 6, size: 1 })
        }
      }
      continue
    }
    // food: the nearest flake ahead draws a koi up or down to it
    let target: Flake | null = null
    for (const q of tank.flakes) {
      if (q.settled > 0) continue
      const ahead = (q.x - f.x) * (f.dir === -1 ? -1 : 1)
      if (ahead > -2 && ahead < 60 && (!target || Math.abs(q.x - f.x) < Math.abs(target.x - f.x))) target = q
    }
    let pace = 1
    if (!target) {
      f.taskT -= dt
      if (f.task === 'swim' && f.taskT <= 0 && phase !== 'working' && rnd() < dt / 10) {
        f.task = rnd() < 0.6 ? 'forage' : 'gulp'
        f.taskT = 6
        f.home = f.task === 'forage' ? laneY(maxLane()) + (snap() ? 2 : 1) : laneY(0) - (snap() ? 1 : 0)
      } else if (f.task !== 'swim' && f.taskT <= 0) {
        f.task = 'swim'
        f.taskT = 8
        f.home = laneY(laneOf(H * 0.45))
      }
      if (f.task !== 'swim') pace = 0.45
      const there = Math.abs(f.yBase - f.home) < 1
      if (there && f.task === 'forage' && rnd() < dt * 3) {
        const nose = f.x + f.dir * 1
        tank.puffs.push({ x: nose, y: H - 2, vx: (rnd() - 0.5) * 3, vy: -3 - rnd() * 3, age: 0 })
      }
      if (there && f.task === 'gulp' && rnd() < dt * 1.2) tank.pops.push({ x: f.x, age: 0 })
    }
    if (target) {
      f.home = Math.max(laneY(0), Math.min(laneY(maxLane()), target.y))
      pace = 1.5
      if (Math.abs(target.x - f.x) < 2.5 && Math.abs(target.y - fishCentre(f)) < f.Hh / 2 + 1) {
        tank.flakes.splice(tank.flakes.indexOf(target), 1)
        tank.bubbles.push({ x: f.x, y: fishCentre(f) - 1, wob: rnd() * 6, size: 1 })
      }
    } else {
      // traffic sense: a koi closing on another at the same depth and heading eases off
      for (const g of tank.fish) {
        if (g === f || g.dir !== f.dir) continue
        if (Math.abs(g.yBase - f.yBase) > (f.Hh + g.Hh) / 2) continue
        const gap = f.dir === -1 ? f.x - (g.x + g.L) : g.x - g.L - f.x
        if (gap > 0 && gap < 10) pace = Math.min(pace, 0.4)
      }
    }
    f.x += f.dir * f.speed * factor * pace * dt
    const margin = 4
    const nearEdge = (f.dir === -1 && f.x < margin) || (f.dir === 1 && f.x > W - margin)
    if (nearEdge || (!target && rnd() < dt / 30)) {
      f.turning = TURN_S
      f.home = laneY(uTurnLane(f))
    }
    if (Math.abs(f.yBase - f.home) > 0.1) f.yBase += (f.home - f.yBase) * Math.min(1, dt * (target ? 3 : 2))
  }
  const bed = H - (snap() ? 3 : 2)
  for (const q of tank.flakes) {
    q.age += dt
    if (q.y >= bed) {
      q.settled += dt // on the gravel: left alone, and gone in a few seconds
      continue
    }
    q.y = Math.min(bed, q.y + sink * dt * (q.age < 2 ? 0.2 : 1)) // they float a moment, then sink
    q.x += Math.sin(q.age * 4 + q.x) * (snap() ? 2.4 : 1.2) * dt // a flake flutters as it sinks
  }
  tank.flakes = tank.flakes.filter(q => q.settled < 6)
  // the bubbler, on the right, and any bubbles a koi let go
  tank.nextBubble -= dt
  if (tank.nextBubble <= 0) {
    tank.nextBubble = 0.35 + rnd() * 0.5
    tank.bubbles.push({ x: W - (snap() ? 7 : 4), y: H - (snap() ? 3 : 2), wob: rnd() * 6, size: rnd() < 0.35 ? 2 : 1 })
  }
  const rise = snap() ? 7 : 3.5
  for (const b of tank.bubbles) {
    b.y -= rise * dt
    b.wob += dt * 5
  }
  // a bubble pops at the surface
  for (const b of tank.bubbles) if (b.y <= 1.5) tank.pops.push({ x: b.x, age: 0 })
  tank.bubbles = tank.bubbles.filter(b => b.y > 1.5)
  for (const p of tank.pops) p.age += dt
  tank.pops = tank.pops.filter(p => p.age < 0.35)
  for (const p of tank.puffs) {
    p.age += dt
    p.x += p.vx * dt
    p.y += p.vy * dt
    p.vy += 3 * dt
  }
  tank.puffs = tank.puffs.filter(p => p.age < 1.2)
  for (const p of tank.splashes) p.age += dt
  tank.splashes = tank.splashes.filter(p => p.age < 0.9)
}

function fishCentre(f: TankKoi): number {
  return tankY(f).hy
}

// Where a koi's head sits and, in dots, the cell row holding its back. In dots
// the body always fills the same two cell rows, so the back is one row of
// cells and the belly the next however it moves, and a marking cannot creep
// between them; the weave bobs it within the slack those eight dot rows leave.
function tankY(f: TankKoi): { hy: number; row: number } {
  const H = tankH()
  if (f.turning > 0) return { hy: Math.round(f.yBase), row: 0 }
  if (!snap()) return { hy: Math.round(f.yBase + 0.9 * Math.sin(tank.t * f.wave + f.phase)), row: 0 }
  const hh = Math.round(f.Hh / 2)
  const slack = Math.max(0, 8 - (2 * hh + 1))
  const row = Math.max(0, Math.min(rows - 2, Math.round(f.yBase / 4 - 1)))
  const bob = Math.round(slack * (0.5 + 0.5 * Math.sin(tank.t * f.wave + f.phase)))
  return { hy: Math.min(H - 1, row * 4 + bob + hh), row }
}

function paintTank(g: Grid) {
  const W = g.w
  const H = g.h
  const t = tank.t
  const light = lightLevel()
  // light through the surface: slow diagonal shafts, while the tank is lit
  if (light > 0.7) {
    for (let y = 1; y < H * 0.8; y += 1) for (let x = 0; x < W; x += 1) {
      if (Math.sin(x * 0.29 + y * 0.5 - t * 0.7) > 0.97 && Math.sin(x * 0.045 - t * 0.15 + y * 0.02) > 0.6) put(g, x, y, mix(ground, 0x3a6a80, 0.35), 1, 4002)
    }
  }
  // the surface: a faint line that shimmers
  for (let x = 0; x < W; x += 1) if (Math.sin(x * 0.7 + t * 2.4) + Math.sin(x * 0.23 - t * 1.1) > 0.9) put(g, x, 0, COL.surface, L_WATER, 4001)
  // weed, swaying from the gravel; the koi swim in front of it
  const clumps = [Math.floor(W * 0.08), Math.floor(W * 0.57)]
  if (W > 140) clumps.push(Math.floor(W * 0.32))
  clumps.forEach((cx, c) => {
    for (let b = 0; b < 3; b += 1) {
      const tall = H * (0.55 + 0.15 * ((b + c) % 3))
      const x0 = cx + b * (snap() ? 2 : 1) - 1
      for (let y = 0; y < tall; y += 1) {
        const sway = Math.sin(t * 0.9 + c + b * 1.3 + y * 0.18) * (y / tall) * (snap() ? 2.2 : 1.2)
        const leaf = b === 1 ? COL.weedDark : COL.weed
        put(g, Math.round(x0 + sway), H - 1 - y, mix(leaf, ground, 0.35), L_WEED, 5000 + b) // these stand at the back
      }
    }
  })
  decor(g)
  for (const b of tank.bubbles) {
    const bx = Math.round(b.x + Math.sin(b.wob) * 0.8)
    const by = Math.round(b.y)
    put(g, bx, by, COL.bubble, L_BUBBLE, 5100)
    if (b.size === 2 && snap()) {
      put(g, bx + 1, by, COL.bubble, L_BUBBLE, 5100)
      put(g, bx, by - 1, COL.bubble, L_BUBBLE, 5100)
      put(g, bx + 1, by - 1, 0xd8eef7, L_BUBBLE, 5100)
    }
  }
  for (const p of tank.pops) {
    const s = Math.round(1 + p.age * (snap() ? 9 : 5))
    put(g, Math.round(p.x) - s, 1, 0xc4e3f0, L_SPLASH, 5101)
    put(g, Math.round(p.x) + s, 1, 0xc4e3f0, L_SPLASH, 5101)
  }
  for (const p of tank.puffs) put(g, Math.round(p.x), Math.round(p.y), GRAVEL[2]!, 59, 6001)
  splashes(g)
  // koi, furthest from the glass first, then smaller before bigger
  const order = [...tank.fish].sort((a, b) => b.depth - a.depth || a.L - b.L)
  const factor = speedFactor()
  order.forEach((f, z) => {
    const progress = f.turning > 0 ? 1 - f.turning / TURN_S : 0
    const squeeze = f.turning > 0 ? Math.max(0.3, Math.abs(Math.cos(progress * Math.PI))) : 1
    const beat = t * (3 + f.speed * (snap() ? 1 : 2))
    const wag = factor === 0 ? 0 : 0.7 * Math.sin(beat + f.phase) * Math.min(1, factor)
    const flap = factor === 0 ? 0 : Math.sin(beat * 0.5 + f.phase) * 0.6
    const sprite = f.L < 20 ? SMALL : BIG
    const face = squeeze < 0.55 // mid-turn, the koi faces out of the glass
    const dots = face ? faceOn(f.Hh, flap) : squeeze < 1 ? endOn(f.L, f.Hh, squeeze) : snap() ? sideShape(f.L, f.Hh, wag, flap) : spriteDots(sprite, wag * 1.4, flap)
    const paintL = snap() ? f.L : sprite.bodyL / 0.7 // the length the side markings are laid along
    const hx = Math.round(f.x)
    const { hy, row } = tankY(f)
    const layer = L_TANK_FISH + z
    // pitch: nose down to forage or dive, up to gulp or rise; a shear along the body
    let pitch = 0
    if (f.turning === 0) {
      pitch = Math.max(-1, Math.min(1, (f.home - f.yBase) * 0.35))
      if (Math.abs(f.home - f.yBase) < 1 && f.task === 'forage') pitch = 0.7
      if (Math.abs(f.home - f.yBase) < 1 && f.task === 'gulp') pitch = -0.6
    }
    const mid = (snap() ? f.L : sprite.bodyL) * 0.45
    for (const d of dots) {
      const X = face ? hx + d.x : f.dir === -1 ? Math.round(hx + d.x * (squeeze < 1 ? squeeze : 1)) : Math.round(hx - d.x * (squeeze < 1 ? squeeze : 1))
      const Y = hy + d.y - (squeeze === 1 ? Math.round(pitch * (mid - d.x) * (snap() ? 0.14 : 0.1)) : 0)
      if (d.part === 'eye') {
        put(g, X, Y, EYE, layer, (z + 1) * 16 + 9)
        continue
      }
      let c: number
      let key = (z + 1) * 16
      if (d.part === 'body') {
        c = sidePaint(f.pattern, paintL, f.Hh, face ? paintL * 0.7 * 0.14 : d.x, d.y)
        if (snap() && squeeze === 1) {
          // one colour a cell: read the mosaic by the cell's column from the head
          // (the even one of its two dot columns, so each mosaic column lands in
          // exactly one cell) and by back or belly row. A pitched koi reads its
          // row from the level body, so its markings stay on it as it noses up or
          // down rather than falling back to fine paint that cells re-vote dot by dot.
          const a = f.dir === -1 ? Math.floor(X / 2) * 2 - hx : hx - Math.floor(X / 2) * 2
          const lx = a % 2 === 0 ? a : f.dir === -1 ? a + 1 : a - 1
          c = mosaicAt(f.pattern, lx / 2, Math.floor((hy + d.y) / 4) - row) ?? c
        } else if (!snap()) {
          const u = d.y / (f.Hh / 2)
          c = shade(c, u < -0.5 ? 0.9 : u > 0.6 ? 1.06 : 1) // a darker back, a paler belly
        }
        key += c === BASE[f.pattern] ? 0 : 1
      } else {
        const root = (f.pattern === 'showa' || f.pattern === 'shiro') && d.part === 'fin' && d.y > 0 && d.x <= Math.round(paintL * 0.7 * 0.22) + 2
        c = mix(root ? COL.black : BASE[f.pattern], ground, 0.45) // see-through fins and tail; motoguro at the pectoral root
        key += root ? 6 : 5
      }
      if (f.depth > 0) c = mix(c, ground, f.depth * 0.5)
      put(g, X, Y, c, layer, key)
    }
  })
  // gravel along the bottom, behind a resting koi's belly
  for (let x = 0; x < W; x += 1) {
    const n = Math.abs(Math.sin(x * 12.9898) * 43758.5453) % 1
    const c = GRAVEL[Math.floor(n * GRAVEL.length)]!
    put(g, x, H - 1, c, L_GRAVEL, 6000 + Math.floor(n * 3))
    if (snap() && n > 0.45) put(g, x, H - 2, GRAVEL[(Math.floor(n * 10) + 1) % GRAVEL.length]!, L_GRAVEL, 6000 + Math.floor(n * 3))
  }
  for (const q of tank.flakes) put(g, Math.round(q.x), Math.round(q.y), Math.sin(q.age * 7 + q.x) > 0 ? 0xe0a868 : COL.pellet, L_FOOD, 2000)
  if (algaeOn) algae(g)
  glass(g)
  snail(g)
  if (light < 1) {
    for (let i = 0; i < g.col.length; i += 1) {
      const c = g.col[i]!
      if (c >= 0) g.col[i] = mix(ground, mix(c, 0x1a2c4a, (1 - light) * 0.55), 0.25 + light * 0.75)
    }
  }
  if (light < 0.5) moonlight(g)
}

const hash = (x: number, y: number) => Math.abs(Math.sin(x * 127.1 + y * 311.7) * 43758.5453) % 1

// Night: moonlight, painted over the dimmed tank. A pale moon shimmering on the
// surface, a silver rim along the top of each koi, and cool glints that come and
// go on the gravel. The rim is the koi's own top, silvered (the reference
// mock's way): never a line of its own above the fish, so it cannot float.
function moonlight(g: Grid) {
  const W = g.w
  const H = g.h
  const t = tank.t
  const dots = snap()
  const mx = Math.floor(W * 0.72)
  const half = dots ? 5 : 3
  for (let x = mx - half; x <= mx + half; x += 1) {
    const edge = Math.abs(x - mx) / half
    if (edge > 0.5 && Math.sin(t * 2.2 + x * 1.7) < 0) continue // the reflection breaks up at its ends
    put(g, x, 0, edge < 0.5 ? 0xf2f6fc : 0xc9d6e8, 95, 7300)
    if (edge < 0.6 && Math.sin(t * 1.6 + x * 2.3) > 0.1) put(g, x, 1, 0x8fa3bf, 95, 7301)
  }
  const isFish = (x: number, y: number) => y >= 0 && g.layer[y * W + x]! >= L_TANK_FISH && g.layer[y * W + x]! < L_SPLASH
  // the koi's own top samples, silvered: one in pixels, two dot rows in dots. In
  // dots the silver keeps the koi's keys, so it blends into the cell's one colour
  // and the back of each koi glows pale under the moon, as the mock had it.
  const rim = dots ? 2 : 1
  for (let x = 0; x < W; x += 1) for (let y = 1; y < H; y += 1) {
    const i = y * W + x
    if (!isFish(x, y) || g.col[i]! < 0) continue
    let edge = false
    for (let d = 1; d <= rim; d += 1) if (y - d >= 0 && !isFish(x, y - d)) edge = true
    if (edge) g.col[i] = mix(g.col[i]!, 0xdce6f4, dots ? 0.7 : 0.6)
  }
  for (let x = 1; x < W - 1; x += 1) {
    if (hash(x, 11) > (dots ? 0.1 : 0.14)) continue
    if (Math.sin(t * 1.3 + x * 4.1) < 0.4) continue
    put(g, x, H - 1, 0xc4d4ea, 99, 7310)
  }
}

// Algae (opt-in), grown over the session's real time and unevenly: green
// creeping up the glass at both ends in tendrils, a clumpy film along the bottom
// of the glass that the snail grazes a clean trail through, odd clumps out on
// the glass, and moss tufts on the stone, the driftwood and the gravel. Each
// part starts at its own point, so it never grows in step.
const MOSS = 0x4f8f3a
const MOSS_TIP = 0x7dbb4e
function algae(g: Grid) {
  const W = g.w
  const H = g.h
  const grown = Math.min(1, algaeT / ALGAE_FULL_S)
  const stage = (from: number) => Math.max(0, Math.min(1, (grown - from) / (1 - from)))
  const dots = snap()
  // tendrils up the glass at each end: some columns shoot up, most stay low, and the tips wander
  const ends = stage(0)
  const ew = dots ? 3 : 2
  if (ends > 0) for (const side of [0, 1]) for (let e = 0; e < ew; e += 1) {
    const x0 = side ? W - 2 - e : 1 + e
    const shoot = hash(x0, 7) > 0.6 ? 1.35 : 0.55 + 0.35 * hash(x0, 9)
    const reach = Math.min(H - 3, ends * (H - 2) * shoot * (1 - e * 0.22))
    for (let y = H - 2; y >= H - 2 - reach; y -= 1) {
      const up = (H - 2 - y) / Math.max(1, reach)
      const x = x0 + (up > 0.5 && dots ? Math.round(Math.sin(y * 0.8 + x0) * (side ? -1 : 1)) : 0)
      const tip = up > 0.8
      if (tip && hash(x, y) < 0.4) continue
      put(g, x, y, tip ? MOSS_TIP : mix(MOSS, ground, 0.15 * e), 96, 7200 + (tip ? 1 : 0))
    }
  }
  // the film along the bottom of the glass: thick in clumps, thin between, ragged on top
  const film = stage(0.25)
  const sx = Math.floor((tank.t * SNAIL_SPEED * (dots ? 1 : 0.5)) % (W - 8)) + 3
  const sy = H - (dots ? 4 : 3)
  if (film > 0) for (let x = ew + 1; x < W - ew - 1; x += 1) {
    const clump = 0.5 + 0.5 * Math.sin(x * (dots ? 0.11 : 0.22) + Math.sin(x * (dots ? 0.037 : 0.074)) * 3)
    const fh = Math.round(film * (dots ? 5 : 2.5) * clump * (0.6 + 0.4 * hash(x, 2)))
    for (let y = H - 1 - fh; y < H - 1; y += 1) {
      if (x >= 3 && x < sx && Math.abs(y - sy) <= (dots ? 1 : 0)) continue // grazed behind the snail
      const top = y === H - 1 - fh
      if (top && hash(x, y) < 0.5) continue
      put(g, x, y, mix(MOSS, ground, top ? 0.5 : 0.35), 9, 7210)
    }
  }
  // a few clumps out on the glass, each starting at its own time
  for (let c = 0; c < 4; c += 1) {
    const size = stage(0.4 + c * 0.12) * (dots ? 3.2 : 1.6) * (0.7 + 0.5 * hash(c, 21))
    if (size < 0.6) continue
    const cx = Math.floor(W * (0.12 + 0.76 * hash(c, 23)))
    const cy = Math.floor(H * (0.5 + 0.35 * hash(c, 29)))
    const span = Math.ceil(size * 1.6)
    for (let y = cy - span; y <= cy + span; y += 1) for (let x = cx - span; x <= cx + span; x += 1) {
      const dx = (x - cx) / 1.2
      const dy = y - cy
      const a = Math.atan2(dy, dx)
      const r = size * (0.75 + 0.3 * Math.sin(3 * a + c * 2) + 0.2 * Math.sin(5 * a + c)) // lumpy, not an oval
      const d = Math.hypot(dx, dy) / r
      if (d > 1 || hash(x, y) < d * d) continue // thinning toward the edge
      put(g, x, y, mix(d < 0.5 ? MOSS_TIP : MOSS, ground, 0.45), 9, 7230)
    }
  }
  // moss tufts on the stone and the driftwood (the decor's own geometry) and on the gravel
  const tufts = stage(0.15)
  const k = dots ? 1 : 0.5
  const tuft = (x: number, y: number, chance: number, layer: number) => {
    if (hash(x, 3) > chance) return
    const tall = 1 + Math.floor(hash(x, 5) * (dots ? 3 : 1.6) * tufts)
    for (let i = 0; i < tall; i += 1) put(g, x, y - i, i === tall - 1 ? MOSS_TIP : MOSS, layer, 7220 + (i === tall - 1 ? 1 : 0))
  }
  if (tufts > 0) {
    const sx0 = Math.floor(W * 0.24)
    const rw = 7 * k + 1
    const rh = 3.4 * k + 1
    for (let x = Math.floor(sx0 - rw); x <= sx0 + rw; x += 1) {
      const u = (x - sx0) / rw
      if (u * u >= 1) continue
      tuft(x, Math.floor(H - 1 - rh * Math.sqrt(1 - u * u)), tufts * 0.9, 9)
    }
    const wx = Math.floor(W * 0.68)
    const len = Math.round(16 * k)
    for (let i = 0; i < len; i += 1) tuft(wx + i, H - 3 - Math.round((i / len) * 3 * k + Math.sin(i * 0.9) * 0.4), tufts * 0.8, 9)
    for (let x = ew + 1; x < W - ew - 1; x += 1) tuft(x, H - (dots ? 3 : 2), tufts * 0.22, 61)
  }
}

function feedTank() {
  const W = tankW()
  const x = 10 + rnd() * Math.max(1, W - 20)
  for (let i = 0; i < 5; i += 1) tank.flakes.push({ x: x + (rnd() - 0.5) * (snap() ? 14 : 7), y: 1, age: rnd() * 0.5, settled: 0 })
  tank.splashes.push({ x, age: 0 })
}

// Food landing: a dimple in the surface, droplets thrown out and falling back,
// and a ring spreading either way.
function splashes(g: Grid) {
  const k = snap() ? 2 : 1
  for (const p of tank.splashes) {
    const x = Math.round(p.x)
    const a = p.age
    if (a < 0.25) put(g, x, 0, 0x0e2230, L_SPLASH, 5110) // the dimple
    if (a < 0.5) for (const side of [-1, 0, 1]) {
      const dx = Math.round(side * (0.5 + a * 7 * k))
      const dy = Math.max(0, Math.round(-1 + a * a * 18 * k)) // up, then back down
      put(g, x + dx, Math.min(2 * k, dy), 0xe8f6fb, L_SPLASH, 5111)
    }
    const r = Math.round(1 + a * 10 * k)
    const fade = mix(0xc4e3f0, ground, Math.min(1, a / 0.9))
    put(g, x - r, 1, fade, L_SPLASH, 5112)
    put(g, x + r, 1, fade, L_SPLASH, 5112)
  }
}

// ---- the tank's light, decor, glass and snail ----------------------------------

// The tank light follows the context window: full under 50%, dimming to 80%,
// then night: lights out, a blue dark, the koi asleep on the gravel.
function lightLevel(): number {
  const percent = shownPercent()
  return percent < 50 ? 1 : percent < 80 ? 1 - ((percent - 50) / 30) * 0.6 : 0.32
}

// A koi seen face-on, the middle of a U-turn: round, two eyes, fins out each side.
function faceOn(Hh: number, flap: number): SideDot[] {
  const r = Hh / 2 + 0.4
  const dots: SideDot[] = []
  const rx = snap() ? r * 0.9 : r * 0.85
  for (let y = -Math.ceil(r); y <= Math.ceil(r); y += 1) {
    for (let x = -Math.ceil(rx); x <= Math.ceil(rx); x += 1) {
      if ((x / rx) ** 2 + (y / r) ** 2 > 1) continue
      const eye = y === -1 && Math.abs(x) === Math.max(1, Math.round(rx * 0.5))
      dots.push({ x, y, part: eye ? 'eye' : 'body' })
    }
  }
  const out = Math.ceil(rx) + 1
  const lift = flap > 0 ? 0 : 1
  for (const s of [-1, 1]) {
    dots.push({ x: s * out, y: 1 + lift, part: 'fin' })
    dots.push({ x: s * (out + 1), y: 2 + lift, part: 'fin' })
  }
  return dots
}

// A river stone and a piece of driftwood on the gravel, a weed clump in front
// of the koi, so they pass behind it.
function decor(g: Grid) {
  const W = g.w
  const H = g.h
  const k = snap() ? 1 : 0.5
  const sx = Math.floor(W * 0.24)
  const rw = 7 * k + 1
  const rh = 3.4 * k + 1
  for (let y = Math.floor(H - 1 - rh); y < H - 1; y += 1) for (let x = Math.floor(sx - rw); x <= sx + rw; x += 1) {
    const u = (x - sx) / rw
    const v = (y - (H - 1)) / rh
    if (u * u + v * v > 1) continue
    put(g, x, y, v < -0.55 && u < 0 ? 0x8b9097 : u > 0.3 ? 0x5d6168 : 0x72777e, 8, 5200)
  }
  const wx = Math.floor(W * 0.68)
  const len = Math.round(16 * k)
  for (let i = 0; i < len; i += 1) {
    const x = wx + i
    const y = H - 2 - Math.round((i / len) * 3 * k + Math.sin(i * 0.9) * 0.4)
    put(g, x, y, i % 4 === 0 ? 0x5a4130 : 0x6e5038, 8, 5201)
    if (snap()) put(g, x, y + 1, 0x4d3828, 8, 5201)
  }
  const fx = Math.floor(W * 0.86)
  for (let b = 0; b < 2; b += 1) {
    const tall = H * (0.62 + 0.18 * b)
    for (let y = 0; y < tall; y += 1) {
      const sway = Math.sin(tank.t * 0.8 + b * 2 + y * 0.2) * (y / tall) * (snap() ? 2.6 : 1.4)
      put(g, Math.round(fx + b * (snap() ? 3 : 1) + sway), H - 1 - y, b ? 0x4fae5c : 0x45a050, 70, 5300 + b)
    }
  }
}

// The glass: its two side edges, and a glint in the top corners.
function glass(g: Grid) {
  for (let y = 0; y < g.h; y += 1) {
    put(g, 0, y, 0x3a4854, 97, 7000)
    put(g, g.w - 1, y, 0x3a4854, 97, 7000)
  }
  const glint = snap() ? [[2, 2], [3, 1], [3, 2], [4, 1]] : [[1, 1], [2, 1]]
  for (const [x, y] of glint) put(g, x!, y!, 0x9fb5c6, 97, 7001)
  for (const [x, y] of glint) put(g, g.w - 1 - x!, y!, 0x6f8494, 97, 7001)
}

// A snail on the front glass, crossing the tank over the session.
function snail(g: Grid) {
  const W = g.w
  const H = g.h
  const x = Math.floor((tank.t * SNAIL_SPEED * (snap() ? 1 : 0.5)) % (W - 8)) + 3
  const y = H - (snap() ? 4 : 3)
  const shell = 0xb0703a
  const swirl = 0x7d4a24
  const foot = 0xa8a294
  if (snap()) {
    for (const [dx, dy, c] of [[0, 0, shell], [1, 0, swirl], [2, 0, shell], [0, -1, shell], [1, -1, shell], [2, -1, swirl], [1, -2, shell], [3, 1, foot], [-1, 1, foot], [0, 1, foot], [1, 1, foot], [2, 1, foot], [4, 0, foot], [4, -1, foot]] as [number, number, number][]) put(g, x + dx, y + dy, c, 98, 7100 + (c === foot ? 1 : 0))
  } else {
    for (const [dx, dy, c] of [[0, 0, shell], [1, 0, swirl], [0, -1, shell], [1, -1, shell], [2, 1, foot], [0, 1, foot], [1, 1, foot], [3, 0, foot]] as [number, number, number][]) put(g, x + dx, y + dy, c, 98, 7100)
  }
}

// ---- repaint ------------------------------------------------------------------

async function repaint($: { ui: { blit: (args: Record<string, unknown>) => Promise<{ deny?: string }>; invalidate: (e: 'ui.render') => void } }) {
  const cells = cellsFor()
  if (requestId) {
    try {
      const r = await $.ui.blit({ requestId, key: 'pond', columns: cols, rows, cells })
      if (!r.deny) return
    } catch {
      // fall through to a redraw
    }
  }
  $.ui.invalidate('ui.render')
}

// ---- yielding ---------------------------------------------------------------

function hasButton(tree: unknown): boolean {
  if (!tree || typeof tree !== 'object') return false
  const node = tree as { type?: unknown; children?: unknown }
  if (node.type === 'Button' || node.type === 'Input' || node.type === 'Select') return true
  const kids = Array.isArray(node.children) ? node.children : node.children ? [node.children] : []
  return kids.some(hasButton)
}

// Whether a tree beneath draws anything: text, a raster or an image, not an empty box.
function hasContent(tree: unknown): boolean {
  if (typeof tree === 'string') return tree.trim() !== ''
  if (typeof tree === 'number') return true
  if (!tree || typeof tree !== 'object') return false
  if (Array.isArray(tree)) return tree.some(hasContent)
  const node = tree as { type?: unknown; props?: { children?: unknown; text?: unknown }; children?: unknown; text?: unknown }
  if (node.type === 'Raster' || node.type === 'Image') return true
  return hasContent(node.text) || hasContent(node.props?.text) || hasContent(node.children) || hasContent(node.props?.children)
}

// ---- state ------------------------------------------------------------------

type Context = { tokens?: number; window: number; percent?: number; breakdown?: { totalTokens: number; rawMaxTokens: number; percentage: number; autocompactSource?: string } }
// Measured against the compaction window when one is set (autoCompactWindow,
// /autocompact): the window the session actually fills before it compacts, not
// the model's whole limit. A summary breakdown is estimated locally, no request.
async function takeReading($: { session: { usage: (args?: { breakdown?: 'summary' }) => Promise<{ context: Context }> } }) {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    if (!context || !context.window) return
    const b = context.breakdown
    if (b && b.rawMaxTokens) {
      reading = { tokens: b.totalTokens, window: b.rawMaxTokens, percent: Math.round(b.percentage), source: b.autocompactSource ?? 'unknown' }
      return
    }
    const tokens = context.tokens ?? 0
    const percent = Math.round(context.percent ?? (tokens / context.window) * 100)
    reading = { tokens, window: context.window, percent, source: 'model' }
  } catch {
    // keep the last reading
  }
}

// The percent the drawing reads: a running preview's, else the real reading's.
function shownPercent(): number {
  return preview ? preview.percent : reading?.percent ?? 0
}

function tierFor(percent: number): Tier {
  if (percent >= 80) return { key: 'asleep', color: 'red' }
  if (percent >= 50) return { key: 'drowsy', color: 'yellow' }
  return { key: 'fresh', color: 'green' }
}

function mulberry32(a: number): () => number {
  let s = a >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function base64(bytes: Uint8Array): string {
  const anyBytes = bytes as unknown as { toBase64?: () => string }
  if (typeof anyBytes.toBase64 === 'function') return anyBytes.toBase64()
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += abc[(n >> 18) & 63]! + abc[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? abc[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? abc[n & 63]! : '='
  }
  return out
}

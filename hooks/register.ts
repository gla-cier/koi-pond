// Koi Pond: a braille pond across the band above the prompt.
//
// The band is one Raster of braille cells (2x4 dots each, one colour per
// cell, the terminal's own background), as wide as the band and ROWS tall.
// Koi are drawn from a small shape routine every tick, so they swim, fishtail,
// wag and turn; lily pads and a sparse field of water dots stay put. No text:
// the status line already carries the context figures.
//
// prompt.submit  -> the koi speed up (Claude is working)
// turn.complete  -> reads the context window; a ripple ring spreads and a
//                   soft bloop plays (userConfig `sound`)
// a 250 ms ticker-> moves the fish and repaints the Raster in place ($.ui.blit),
//                   falling back to a band redraw when the blit is refused
// ui.render      -> draws the band; yields to a survey and to any other
//                   plugin's band that has controls; one-line text fallback
//                   where there is no Raster or the band is too short
// context tiers  -> under 50%: cruising; 50-80%: slow; 80%+: the koi settle on
//                   the bottom and rest (time to /compact)

import type { Register } from 'claude-code'

const TICK_MS = 250
const HAPPY_TICKS = 10
const MIN_ROWS = 4
const MAX_ROWS = 8
const DEFAULT = 0x01000000 // the terminal's own colour
const COL = {
  water: 0x2b5a75,
  ripple: 0x5c93ad,
  white: 0xf6f1e7,
  orange: 0xf07c2a,
  black: 0x505050, // the black of the marks and the hi utsuri: a dark grey that reads on dark themes
  pad: 0x4caf5a,
  padDark: 0x3a8f48,
  flower: 0xf4a3b8,
  gold: 0xe8c04a, // the ogon
}
const NONE = -1
// Quadrant glyph by mask: 1 upper-left, 2 upper-right, 4 lower-left, 8 lower-right.
const QUADRANT = [0x20, 0x2598, 0x259d, 0x2580, 0x2596, 0x258c, 0x259e, 0x259b, 0x2597, 0x259a, 0x2590, 0x259c, 0x2584, 0x2599, 0x259f, 0x2588]

type Phase = 'idle' | 'working' | 'happy'
type Pattern = 'kohaku' | 'showa' | 'hiutsuri' | 'shiro' | 'ogon'
type Fish = {
  x: number // head position in dots
  yBase: number // centre line the fish weaves around
  home: number // the lane it is settling into: a centre line on a cell-row boundary
  L: number
  Hh: number
  dir: 1 | -1 // -1 swims left (head at the left), +1 swims right
  speed: number // dots per tick while cruising
  phase: number
  seed: number
  pattern: Pattern
  wave: number // radians per tick of the fishtail course
  amp: number // dots of weave
  turning: number // ticks left in a turn, 0 when swimming straight
}
type Ripple = { x: number; y: number; t0: number }
type Reading = { tokens: number; window: number; percent: number }
type Dot = { x: number; y: number; lit: boolean; col: number }
// colourAt reads the variety's pattern at a point in the fish's own frame: x
// along the body from the head, y down from the centre line, in dots
type Shape = { dots: Dot[]; base: number; colourAt: (x: number, y: number) => number }
// A koi as drawn this frame: where its head is and which way it faces, so a
// cell's colour can be read off the shape at the cell's centre.
// row is the cell row holding the back; the belly is the row below it.
type Drawn = { dir: 1 | -1; hx: number; hy: number; row: number; turning: boolean; shape: Shape; pattern: Pattern }

let rows = 6
let sound = true
let blocks = false // fish as solid quadrant blocks over braille water
let waterDots = false // the sparse dot field; off, the pond is the terminal's own background
let phase: Phase = 'idle'
let frame = 0
let happyUntil = 0
let reading: Reading | null = null
let ticker: { cancel: () => void } | null = null
let cols = 0
let fish: Fish[] = []
let ripples: Ripple[] = []
let requestId: string | null = null
let mounted = false
let rnd = mulberry32(0x9e3779b9)

// The roster, in the order the pond fills as the band widens; sizes in dots.
// Hh 4.6 is a
// 5-dot-tall body (the rows round), like the ogon's 4.
const ROSTER: { pattern: Pattern; L: number; Hh: number; lane: number }[] = [
  { pattern: 'kohaku', L: 26, Hh: 6, lane: 0.42 }, // white, two or three orange steps along the back
  { pattern: 'showa', L: 26, Hh: 6, lane: 0.7 }, // orange, black head stripe and two wraps
  { pattern: 'hiutsuri', L: 22, Hh: 4.6, lane: 0.17 }, // black, two orange wraps
  { pattern: 'shiro', L: 24, Hh: 6, lane: 0.33 }, // shiro utsuri: white, black wraps
  { pattern: 'ogon', L: 14, Hh: 4, lane: 0.88 }, // small, solid gold
]
let drawn: Drawn[] = []
let own = new Int16Array(0) // per dot: 0 water or pad, else 1 + index into `drawn`

export const register: Register = (on, options) => {
  sound = options?.sound !== false
  blocks = options?.fish === 'blocks'
  waterDots = options?.water === 'dots'
  const wanted = Number(options?.rows)
  rows = Number.isFinite(wanted) ? Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.round(wanted))) : 6

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    phase = 'idle'
    frame = 0
    await takeReading($)
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => {
      frame += 1
      if (phase === 'happy' && frame >= happyUntil) {
        phase = 'idle'
      }
      if (!mounted || cols === 0) {
        return
      }
      const resting = tierFor(reading?.percent ?? 0).key === 'asleep' && phase === 'idle' && ripples.length === 0
      if (resting && frame % 4 !== 0) {
        return // a resting pond breathes once a second
      }
      step()
      void repaint($)
    })
    return result
  })

  on('prompt.submit', ($, e, next) => {
    if (!e.turnId) {
      phase = 'working'
      }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) {
      return result
    }
    await takeReading($)
    if (e.isAborted) {
      phase = 'idle'
    } else {
      phase = 'happy'
      happyUntil = frame + HAPPY_TICKS
      if (cols > 0) {
        ripples.push({ x: 8 + Math.floor(rnd() * Math.max(1, cols * 2 - 16)), y: 4 + Math.floor(rnd() * Math.max(1, rows * 4 - 8)), t0: frame })
      }
      if (sound) {
        $.audio.play({ asset: 'assets/bloop.wav' }).catch(() => {
          // no player on this platform, or the clip was refused: the ripple still shows
        })
      }
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
    const tier = tierFor(reading?.percent ?? 0)
    const bodyColumns = e.props.bodyColumns ?? 80
    const fits = e.surface === 'terminal' && typeof Raster === 'function' && (e.props.maxRows ?? 1) >= rows && bodyColumns >= 30
    if (!fits) {
      mounted = false
      const word = working ? 'koi darting' : tier.key === 'asleep' ? 'koi resting · time to /compact' : tier.key === 'drowsy' ? 'koi drifting slowly' : 'koi pond'
      return Box({ flexDirection: 'row', paddingX: 1, children: [
        Text({ color: working ? 'cyan' : tier.color, bold: true, children: `≋ ${word}` }),
      ] })
    }
    resize(Math.max(20, Math.min(512, bodyColumns - 2)))
    requestId = e.requestId
    mounted = true
    return Box({ flexDirection: 'row', paddingX: 1, children: [
      Raster({ key: 'pond', columns: cols, rows, cells: cellsFor() }),
    ] })
  })
}

// ---- the pond ---------------------------------------------------------------

function resize(next: number) {
  if (next === cols) {
    return
  }
  const prev = cols
  cols = next
  const W = cols * 2
  const H = rows * 4
  const want = Math.max(2, Math.min(5, Math.round(cols / 36))) // room to swim: 3 koi at 100 cells, 4 at 150
  if (prev > 0 && fish.length > 0) {
    const ratio = W / (prev * 2)
    for (const f of fish) f.x = Math.min(W - 2, Math.max(1, f.x * ratio))
  }
  while (fish.length < want) {
    const i = fish.length
    const slot = ROSTER[i % ROSTER.length]!
    const { L, Hh } = slot
    const dir: 1 | -1 = i % 2 === 0 ? -1 : 1
    fish.push({
      x: Math.floor(W * ((i * 0.37 + 0.2) % 1)),
      yBase: laneY(Math.round(slot.lane * H / 4 - 1)),
      home: laneY(Math.round(slot.lane * H / 4 - 1)),
      L, Hh, dir,
      speed: 0.3 + rnd() * 0.3,
      phase: rnd() * Math.PI * 2,
      seed: 1 + Math.floor(rnd() * 1000),
      pattern: slot.pattern,
      wave: 0.05 + rnd() * 0.05,
      amp: Hh > 6 ? 0.8 + rnd() * 0.7 : 1.2 + rnd() * 1.2,
      turning: 0,
    })
  }
  if (fish.length > want) {
    fish = fish.slice(0, want)
  }
}

function speedFactor(): number {
  if (phase === 'working') return 2.2
  const tier = tierFor(reading?.percent ?? 0).key
  return tier === 'asleep' ? 0 : tier === 'drowsy' ? 0.45 : 1
}

function step() {
  const W = cols * 2
  const H = rows * 4
  const factor = speedFactor()
  const turnChance = (phase === 'working' ? 5 : 1) / 320
  for (const f of fish) {
    if (f.turning > 0) {
      // the end-on oval glides across into its new lane during the turn
      f.yBase += (f.home - f.yBase) / f.turning
      f.turning -= 1
      if (f.turning === 3) f.dir = f.dir === 1 ? -1 : 1
      continue
    }
    if (factor === 0) {
      // resting: sink gently to the bottom and hold still
      const floor = H - f.Hh / 2 - 2
      if (f.yBase < floor) f.yBase = Math.min(floor, f.yBase + 0.25)
      continue
    }
    // traffic sense: a koi closing on another at the same depth and heading eases off
    let pace = 1
    for (const g of fish) {
      if (g === f || g.dir !== f.dir) continue
      if (Math.abs(g.yBase - f.yBase) > (f.Hh + g.Hh) / 2) continue
      const ahead = f.dir === -1 ? f.x - (g.x + g.L) : g.x - g.L - f.x // gap from my head to its tail
      if (ahead > 0 && ahead < 10) pace = Math.min(pace, 0.4)
    }
    f.x += f.dir * f.speed * factor * pace
    const margin = 4
    const nearEdge = (f.dir === -1 && f.x < margin) || (f.dir === 1 && f.x > W - margin)
    if (nearEdge || rnd() < turnChance) {
      f.turning = 6
      f.home = laneY(uTurnRow(f))
    }
    if (Math.abs(f.yBase - f.home) > 0.1) f.yBase += (f.home - f.yBase) * 0.2
  }
  ripples = ripples.filter(r => frame - r.t0 < 9)
}

// The cell row holding a koi's back when its centre line is at y, and back.
function rowOf(y: number): number {
  return Math.max(0, Math.min(rows - 2, Math.round(y / 4 - 1)))
}

function laneY(row: number): number {
  return Math.max(0, Math.min(rows - 2, row)) * 4 + 4
}

// A U-turn comes out one lane over, like turning on a two-way road: up or down
// a cell row, whichever has room, preferring the lane fewer koi are already
// swimming the new way in.
function uTurnRow(f: Fish): number {
  const row = rowOf(f.home)
  const heading = f.dir === 1 ? -1 : 1
  const choices = [row - 1, row + 1].filter(r => r >= 0 && r <= rows - 2)
  if (choices.length === 0) return row
  const traffic = (r: number) => fish.filter(g => g !== f && g.dir === heading && Math.abs(rowOf(g.home) - r) < 2).length
  const best = Math.min(...choices.map(traffic))
  const open = choices.filter(r => traffic(r) === best)
  return open[Math.floor(rnd() * open.length)]!
}

// Where a koi's head sits, in dots, and the cell row holding its back. The body
// always fills the same two cell rows, so the back is one row of cells and the
// belly the next however the fish moves, and a marking cannot creep between
// them; the weave bobs it within whatever slack those eight dot rows leave.
function fishY(f: Fish): { hy: number; row: number } {
  const H = rows * 4
  const hh = Math.round(f.Hh / 2)
  const slack = Math.max(0, 8 - (2 * hh + 1))
  const row = rowOf(f.yBase)
  if (f.turning > 0) return { hy: Math.round(f.yBase), row } // the oval moves freely; its cells are not read off the mosaic
  const bob = Math.round(slack * (0.5 + 0.5 * Math.sin(frame * f.wave + f.phase)))
  return { hy: Math.min(H - 1, row * 4 + bob + hh), row }
}

function scene(): Int32Array {
  const W = cols * 2
  const H = rows * 4
  const buf = new Int32Array(W * H).fill(NONE)
  own = new Int16Array(W * H)
  drawn = []
  if (waterDots) {
    for (let y = 0; y < H; y += 4) {
      for (let x = 0; x < W; x += 4) buf[y * W + x] = COL.water
    }
  }
  for (const r of ripples) {
    const age = frame - r.t0
    const rad = age * 0.75 + 1
    for (let a = 0; a < 360; a += 5) {
      const x = Math.round(r.x + 2 * rad * Math.cos((a * Math.PI) / 180))
      const y = Math.round(r.y + rad * Math.sin((a * Math.PI) / 180))
      if (x >= 0 && x < W && y >= 0 && y < H && buf[y * W + x] === NONE) buf[y * W + x] = COL.ripple
    }
  }
  // lily pads first: with the band this shallow a pad over a koi reads as a bite
  // out of the fish, so the koi pass over the pads
  lily(buf, W, H, W - 12, 4, 3, true)
  lily(buf, W, H, 9, 3, 2, false)
  if (W > 110) lily(buf, W, H, Math.floor(W * 0.45), H - 4, 3, true)
  if (W > 200) lily(buf, W, H, Math.floor(W * 0.62), 3, 2, false)
  const factor = speedFactor()
  // z-order: smaller koi are drawn first, so a bigger fish always passes over a smaller one
  for (const f of [...fish].sort((a, b) => a.L - b.L)) {
    const progress = f.turning > 0 ? (6 - f.turning) / 6 : 0
    const squeeze = f.turning > 0 ? Math.max(0.3, Math.abs(Math.cos(progress * Math.PI))) : 1
    const wag = factor === 0 ? 0 : 0.7 * Math.sin(frame * (0.5 + f.speed * 1.5) + f.phase) * Math.min(1, factor)
    const full = koiShape(f.L, f.Hh, wag, f.pattern)
    const shape = squeeze < 1 ? foreshorten(full, squeeze, f.L, f.Hh) : full // a turn: a solid oval, shrinking then growing back
    const hx = Math.round(f.x)
    const { hy, row } = fishY(f)
    drawn.push({ dir: f.dir, hx, hy, row, turning: squeeze < 1, shape, pattern: f.pattern })
    const id = drawn.length
    for (const d of shape.dots) {
      const X = f.dir === -1 ? hx + d.x : hx - d.x
      const Y = hy + d.y
      if (X < 0 || X >= W || Y < 0 || Y >= H) continue
      const k = Y * W + X
      buf[k] = d.lit ? d.col : NONE // opaque: a gap hides whatever is beneath
      own[k] = d.lit ? id : 0
    }
  }
  return buf
}

function lily(buf: Int32Array, W: number, H: number, cx: number, cy: number, r: number, flower: boolean) {
  for (let y = -r; y <= r; y += 1) {
    for (let x = -2 * r; x <= 2 * r; x += 1) {
      if ((x / (2 * r)) ** 2 + (y / r) ** 2 > 1) continue
      if (x > r && Math.abs(y) < 1) continue // the notch
      const X = cx + x
      const Y = cy + y
      if (X >= 0 && X < W && Y >= 0 && Y < H) {
        buf[Y * W + X] = (x + y) % 3 === 0 ? COL.padDark : COL.pad
        own[Y * W + X] = 0
      }
    }
  }
  if (flower) {
    for (let y = -1; y <= 1; y += 1) {
      for (let x = -2; x <= 2; x += 1) {
        if (Math.abs(x) + Math.abs(y) > 2) continue
        const X = cx + x
        const Y = cy + y
        if (X >= 0 && X < W && Y >= 0 && Y < H) {
          buf[Y * W + X] = COL.flower
          own[Y * W + X] = 0
        }
      }
    }
  }
}

// A turning koi, seen nearly end-on: a filled oval in the fish's colours, no
// tail, fins or eye, that shrinks through the turn and grows back out.
function foreshorten(shape: Shape, s: number, L: number, Hh: number): Shape {
  const half = Hh / 2
  const len = Math.max(4, L * 0.7 * s)
  const dots: Dot[] = []
  const inside = (x: number, y: number) => ((x - len / 2) / (len / 2)) ** 2 + (y / half) ** 2 <= 1
  for (let x = 0; x <= Math.ceil(len); x += 1) {
    for (let y = -Math.ceil(half); y <= Math.ceil(half); y += 1) {
      if (!inside(x, y)) continue
      dots.push({ x, y, lit: true, col: shape.colourAt(x / s, y) })
    }
  }
  return { dots, base: shape.base, colourAt: (x, y) => shape.colourAt(x / s, y) }
}

// ---- varieties --------------------------------------------------------------

const BASE: Record<Pattern, number> = { kohaku: COL.white, showa: COL.orange, hiutsuri: COL.black, shiro: COL.white, ogon: COL.gold }
const MARK: Record<Pattern, number> = { kohaku: COL.orange, showa: COL.black, hiutsuri: COL.orange, shiro: COL.black, ogon: COL.gold }

// Markings are authored in whole cells, because a cell carries one colour: a
// marking drawn finer than a cell is resampled as the fish slides a dot at a
// time and flickers. A koi's body always sits in two cell rows (see scene), so
// a variety is a two-row mosaic, back over belly, one character per cell column
// from the head: 'x' the marking, '.' the ground.
const MOSAIC: Record<Pattern, [string, string]> = {
  kohaku: ['.xx.xx.x.', '.........'], // sandan: three red steps along the back
  showa: ['.x..x.xx.', '....x..x.'], // menware on the head, a wrap, a saddle that reaches the belly
  hiutsuri: ['.xx.xxx.', '.x...xx.'], // two orange wraps on black
  shiro: ['.x.xx.x.', '...x..x.'], // shiro utsuri: black head stroke and wraps on white
  ogon: ['', ''],
}

// The colour of a variety at a dot in the fish's frame, read off the mosaic.
// Cells inside the body read the mosaic directly (cellsFor); this serves the
// dots themselves, the fins and the turning oval.
function varietyPaint(pattern: Pattern, L: number, Hh: number): (x: number, y: number) => number {
  const half = Hh / 2
  const bodyL = L * 0.7
  const fx = Math.floor(bodyL * 0.3)
  const base = BASE[pattern]
  const wraps = pattern === 'showa' || pattern === 'shiro'
  return (x, y) => {
    if (Math.abs(y) > half) return wraps && x >= fx + 1 && x <= fx + 3 ? COL.black : base // pectoral fins; motoguro at the root
    if (x > bodyL) return base // the tail
    return mosaicAt(pattern, Math.floor(x / 2), y <= 0 ? 0 : 1) ?? base
  }
}

// One cell of a variety's mosaic, or null past the body.
function mosaicAt(pattern: Pattern, k: number, rank: number): number | null {
  const row = MOSAIC[pattern][rank]
  if (pattern === 'ogon') return COL.gold
  if (row === undefined || k < 0 || k >= row.length) return null
  return row[k] === 'x' ? MARK[pattern] : BASE[pattern]
}

// A koi facing left, head at the origin, body along +x. Unlit dots are the eye
// and the slanted gap before the tail, nothing else: they clear what is beneath.
const shapeCache = new Map<string, Shape>()

function koiShape(L: number, Hh: number, wag: number, pattern: Pattern): Shape {
  const key = `${L},${Hh},${wag.toFixed(2)},${pattern}`
  const hit = shapeCache.get(key)
  if (hit) return hit
  const half = Hh / 2
  const bodyL = L * 0.7
  const colourAt = varietyPaint(pattern, L, Hh)
  const cut = (y: number) => bodyL - 1 + 0.45 * y // the slanted separator before the tail
  const dots: Dot[] = []
  const seen = new Set<string>()
  const put = (x: number, y: number) => {
    const k = `${x},${y}`
    if (seen.has(k)) return
    seen.add(k)
    dots.push({ x, y, lit: true, col: colourAt(x, y) })
  }
  for (let x = 0; x <= Math.floor(bodyL); x += 1) {
    const t = x / bodyL
    const h = t < 0.3 ? half * Math.sqrt(Math.max(0, 1 - ((0.3 - t) / 0.3) ** 2)) : (half - 0.8) * (1 - ((t - 0.3) / 0.7) ** 1.3) + 0.8
    const hh = Math.round(h)
    for (let y = -hh; y <= hh; y += 1) {
      if (x <= cut(y)) put(x, y)
    }
  }
  const tailStart = bodyL + 1
  for (let x = Math.floor(bodyL) - 2; x <= L; x += 1) {
    const t = Math.max(0, Math.min(1, (x - tailStart) / Math.max(1, L - tailStart)))
    const spread = 0.8 + t * (half - 0.5)
    const bend = wag * t * t * half
    for (const lobe of [-1, 1]) {
      const yc = lobe * spread * 0.85 + bend
      for (let y = Math.floor(yc - 0.5); y <= Math.ceil(yc + 0.5); y += 1) {
        if (x >= Math.floor(cut(y)) + 2) put(x, y) // exactly one unlit dot behind the body
      }
    }
  }
  const fx = Math.floor(bodyL * 0.3)
  for (const lobe of [-1, 1]) {
    for (let i = 0; i < 2; i += 1) {
      const y = lobe * (Math.round(half) + 1 + i) // pectoral fins one dot off the flank
      for (let x = fx + 1 + i; x < fx + 4 + i; x += 1) put(x, y)
    }
  }
  const ex = Math.round(bodyL * 0.09)
  for (const d of dots) {
    if (d.y === -1 && (d.x === ex || d.x === ex + 1)) d.lit = false // the eye
  }
  const shape: Shape = { dots, base: BASE[pattern], colourAt }
  if (shapeCache.size > 256) shapeCache.clear()
  shapeCache.set(key, shape)
  return shape
}

// ---- cells ------------------------------------------------------------------

type Tier = { key: 'fresh' | 'drowsy' | 'asleep'; color: string }

function cellsFor(): string {
  const W = cols * 2
  const buf = scene()
  const words = new Uint32Array(cols * rows * 3)
  const ORDER: [number, number][] = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]]
  let i = 0
  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      let bits = 0
      let fishBits = 0
      let top = 0 // who is on top in this cell: 0 none or a lily pad, else 1 + fish index
      const PAD = 1 << 20
      const counts = new Map<number, number>()
      const rank = (at: number, c: number) => (c === COL.pad || c === COL.padDark || c === COL.flower ? 0 : (own[at] ?? 0)) // pads beneath fish
      // first pass: who is on top here
      ORDER.forEach(([dx, dy]) => {
        const at = (cy * 4 + dy) * W + cx * 2 + dx
        const c = buf[at] ?? NONE
        if (c === NONE || c === COL.water || c === COL.ripple) return
        top = Math.max(top, rank(at, c))
      })
      // second pass: only the top one's dots are drawn, so a koi in front hides
      // the one behind cleanly instead of recolouring its dots
      ORDER.forEach(([dx, dy], k) => {
        const at = (cy * 4 + dy) * W + cx * 2 + dx
        const c = buf[at] ?? NONE
        if (c === NONE) return
        if (c === COL.water || c === COL.ripple) { bits |= 1 << k; return }
        if (rank(at, c) !== top) return
        bits |= 1 << k
        fishBits |= 1 << k
        counts.set(c, (counts.get(c) ?? 0) + 1)
      })
      let col = DEFAULT
      if (counts.size > 0) {
        bits = fishBits // water dots do not show through a koi's cell
        const d = top > 0 && top < PAD ? drawn[top - 1] : undefined
        // one colour per cell: a body cell reads the koi's mosaic by the cell's
        // column from the head (the even one of its two dot columns, so each
        // mosaic column lands in exactly one cell) and by back or belly row.
        // Fins, tail and the turning oval take their dots' commonest colour.
        const a = d ? (d.dir === -1 ? cx * 2 - d.hx : d.hx - cx * 2) : 0
        const lx = a % 2 === 0 ? a : d?.dir === -1 ? a + 1 : a - 1
        const cell = d && !d.turning ? mosaicAt(d.pattern, lx / 2, cy - d.row) : null
        col = cell ?? [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0]
      } else if (bits) {
        col = (bits & ~waterMask(buf, W, cx, cy)) ? COL.ripple : COL.water
      }
      if (blocks && counts.size > 0) {
        // a koi cell as a 2x2 block: each quadrant lit when either of its two dots is
        const q = (bits & 0b000011 ? 1 : 0) | (bits & 0b011000 ? 2 : 0) | (bits & 0b1000100 ? 4 : 0) | (bits & 0b10100000 ? 8 : 0)
        words[i++] = QUADRANT[q] ?? 0x20
      } else {
        words[i++] = bits ? 0x2800 + bits : 0x20
      }
      words[i++] = col
      words[i++] = DEFAULT
    }
  }
  return base64(new Uint8Array(words.buffer))
}

function waterMask(buf: Int32Array, W: number, cx: number, cy: number): number {
  const ORDER: [number, number][] = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]]
  let m = 0
  ORDER.forEach(([dx, dy], k) => {
    if (buf[(cy * 4 + dy) * W + cx * 2 + dx] === COL.water) m |= 1 << k
  })
  return m
}

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

// ---- state ------------------------------------------------------------------

async function takeReading($: { session: { usage: () => Promise<{ context: { tokens?: number; window: number; percent?: number } }> } }) {
  try {
    const { context } = await $.session.usage()
    if (!context || !context.window) return
    const tokens = context.tokens ?? 0
    const percent = Math.round(context.percent ?? (tokens / context.window) * 100)
    reading = { tokens, window: context.window, percent }
  } catch {
    // keep the last reading
  }
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

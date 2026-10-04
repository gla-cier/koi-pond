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
  black: 0x505050, // the black marks: a dark grey fill that reads on dark themes
  pad: 0x4caf5a,
  padDark: 0x3a8f48,
  flower: 0xf4a3b8,
  stroke: 0x7c7c7c, // the one-dot stroke where a black mark meets the water
}
const NONE = -1
// Quadrant glyph by mask: 1 upper-left, 2 upper-right, 4 lower-left, 8 lower-right.
const QUADRANT = [0x20, 0x2598, 0x259d, 0x2580, 0x2596, 0x258c, 0x259e, 0x259b, 0x2597, 0x259a, 0x2590, 0x259c, 0x2584, 0x2599, 0x259f, 0x2588]

type Phase = 'idle' | 'working' | 'happy'
type Pattern = 'kohaku' | 'tancho' | 'sanke' | 'showa'
type Fish = {
  x: number // head position in dots
  yBase: number // centre line the fish weaves around
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
type Dot = { x: number; y: number; lit: boolean; col: number; edge: boolean }
type Mark = { cx: number; cy: number; rx: number; ry: number; col: number; inset: 0 | 1 | 2 }
type Shape = { dots: Dot[]; marks: Mark[]; base: number }
// A koi as drawn this frame: where its head is and which way it faces, so a
// cell's colour can be read off the shape at the cell's centre.
type Drawn = { dir: 1 | -1; hx: number; hy: number; shape: Shape; pattern: Pattern }

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
let drawn: Drawn[] = []
let own = new Int16Array(0) // per dot: 0 water or pad, else 1 + index into `drawn`
let edg = new Uint8Array(0) // per dot: 1 where a koi's silhouette edge is

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
  // two big koi on their own lanes, small ones along the top and bottom, a medium one mid-water
  const patterns: Pattern[] = ['kohaku', 'showa', 'tancho', 'sanke', 'kohaku', 'showa']
  const sizes: [number, number][] = [[38, 10], [36, 10], [18, 4], [16, 4], [24, 5], [20, 5]]
  const lanes = [0.3, 0.72, 0.1, 0.92, 0.5, 0.2]
  while (fish.length < want) {
    const i = fish.length
    const [L, Hh] = sizes[i % sizes.length] ?? [24, 6]
    const dir: 1 | -1 = i % 2 === 0 ? -1 : 1
    const lane = lanes[i % lanes.length] ?? 0.5
    fish.push({
      x: Math.floor(W * ((i * 0.37 + 0.2) % 1)),
      yBase: Math.max(Hh / 2 + 1, Math.min(H - Hh / 2 - 1, lane * H)),
      L, Hh, dir,
      speed: 0.3 + rnd() * 0.3,
      phase: rnd() * Math.PI * 2,
      seed: 1 + Math.floor(rnd() * 1000),
      pattern: patterns[i % patterns.length] ?? 'kohaku',
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
    }
    const lanes = [0.3, 0.72, 0.1, 0.92, 0.5, 0.2]
    const homeY = Math.max(f.Hh / 2 + 1, Math.min(H - f.Hh / 2 - 1, (lanes[fish.indexOf(f) % lanes.length] ?? 0.5) * H))
    if (Math.abs(f.yBase - homeY) > 0.1) f.yBase += (homeY - f.yBase) * 0.02
  }
  ripples = ripples.filter(r => frame - r.t0 < 9)
}

function fishY(f: Fish): number {
  return f.yBase + f.amp * Math.sin(frame * f.wave + f.phase)
}

function scene(): Int32Array {
  const W = cols * 2
  const H = rows * 4
  const buf = new Int32Array(W * H).fill(NONE)
  own = new Int16Array(W * H)
  edg = new Uint8Array(W * H)
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
  lily(buf, W, H, W - 14, 5, 4, true)
  lily(buf, W, H, 9, 3, 2, false)
  if (W > 110) lily(buf, W, H, Math.floor(W * 0.45), H - 4, 4, true)
  if (W > 200) lily(buf, W, H, Math.floor(W * 0.62), 4, 3, false)
  const factor = speedFactor()
  // z-order: smaller koi are drawn first, so a bigger fish always passes over a smaller one
  for (const f of [...fish].sort((a, b) => a.L - b.L)) {
    const progress = f.turning > 0 ? (6 - f.turning) / 6 : 0
    const squeeze = f.turning > 0 ? Math.max(0.3, Math.abs(Math.cos(progress * Math.PI))) : 1
    const wag = factor === 0 ? 0 : 0.7 * Math.sin(frame * (0.5 + f.speed * 1.5) + f.phase) * Math.min(1, factor)
    const full = koiShape(f.L, f.Hh, wag, f.seed, f.pattern)
    const shape = squeeze < 1 ? foreshorten(full, squeeze, f.L, f.Hh) : full // a turn: a solid oval, shrinking then growing back
    const hx = Math.round(f.x)
    const hy = Math.round(fishY(f))
    drawn.push({ dir: f.dir, hx, hy, shape, pattern: f.pattern })
    const id = drawn.length
    for (const d of shape.dots) {
      const X = f.dir === -1 ? hx + d.x : hx - d.x
      const Y = hy + d.y
      if (X < 0 || X >= W || Y < 0 || Y >= H) continue
      const k = Y * W + X
      buf[k] = d.lit ? d.col : NONE // opaque: a gap hides whatever is beneath
      own[k] = d.lit ? id : 0
      edg[k] = d.lit && d.edge ? 1 : 0
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
      const edge = !inside(x + 1, y) || !inside(x - 1, y) || !inside(x, y + 1) || !inside(x, y - 1)
      dots.push({ x, y, lit: true, col: shape.base, edge })
    }
  }
  return { dots, base: shape.base, marks: shape.marks.map(m => ({ ...m, cx: m.cx * s, rx: Math.max(1, m.rx * s) })) }
}

// A koi facing left, head at the origin, body along +x. Dots carry a colour and
// whether they are lit; unlit dots are the eye, the slanted gap before the tail,
// nothing else: they clear what is beneath them.
const shapeCache = new Map<string, Shape>()

function koiShape(L: number, Hh: number, wag: number, seed: number, pattern: Pattern): Shape {
  const key = `${L},${Hh},${wag.toFixed(2)},${seed},${pattern}`
  const hit = shapeCache.get(key)
  if (hit) return hit
  const half = Hh / 2
  const bodyL = L * 0.7
  const base = pattern === 'showa' ? COL.orange : COL.white // showa: orange body, black spots
  const cut = (y: number) => bodyL - 1 + 0.45 * y // the slanted separator
  type Kind = 'body' | 'tail' | 'fin' | 'patch' | 'eye' | 'halo' | 'hole' | 'stroke'
  const kinds = new Map<string, { x: number; y: number; kind: Kind; col: number }>()
  const put = (x: number, y: number, kind: Kind, col: number, keep = false) => {
    const k = `${x},${y}`
    if (keep && kinds.has(k)) return
    kinds.set(k, { x, y, kind, col })
  }
  for (let x = 0; x <= Math.floor(bodyL); x += 1) {
    const t = x / bodyL
    const h = t < 0.3 ? half * Math.sqrt(Math.max(0, 1 - ((0.3 - t) / 0.3) ** 2)) : (half - 0.8) * (1 - ((t - 0.3) / 0.7) ** 1.3) + 0.8
    const hh = Math.round(h)
    for (let y = -hh; y <= hh; y += 1) {
      if (x <= cut(y)) put(x, y, 'body', base)
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
        if (x >= Math.floor(cut(y)) + 2) put(x, y, 'tail', base, true) // exactly one unlit dot behind the body
      }
    }
  }
  const fx = Math.floor(bodyL * 0.3)
  for (const lobe of [-1, 1]) {
    for (let i = 0; i < 2; i += 1) {
      const y = lobe * (Math.round(half) + i) // fins attached to the flank
      for (let x = fx + 1 + i; x < fx + 4 + i; x += 1) put(x, y, 'fin', base, true)
    }
  }
  const INSIDE = new Set<Kind>(['body', 'patch', 'hole', 'stroke'])
  const isBody = (x: number, y: number) => INSIDE.has(kinds.get(`${x},${y}`)?.kind as Kind)
  const isEdge = (x: number, y: number) => !isBody(x + 1, y) || !isBody(x - 1, y) || !isBody(x, y + 1) || !isBody(x, y - 1)
  const r = mulberry32(seed)
  const deepEdge = (x: number, y: number) => isEdge(x, y) || isEdge(x + 1, y) || isEdge(x - 1, y) || isEdge(x, y + 1) || isEdge(x, y - 1)
  const marks: Mark[] = []
  if (pattern === 'showa') {
    const n = L < 24 ? 1 : 2
    for (let i = 0; i < n; i += 1) {
      const cx = bodyL * (0.25 + 0.5 * r())
      const cy = (r() - 0.5) * half * 0.6
      marks.push({ cx, cy, rx: Math.max(3, L * 0.12), ry: Math.max(2.5, half * 1.1), col: COL.black, inset: 0 })
    }
  } else if (pattern === 'tancho') {
    marks.push({ cx: bodyL * 0.18, cy: -0.5, rx: 3.2, ry: 2.2, col: COL.orange, inset: 0 })
  } else {
    const n = L < 24 ? 1 : 2
    for (let i = 0; i < n; i += 1) {
      const cx = bodyL * (0.3 + 0.45 * r())
      const cy = (r() - 0.5) * half * 0.7
      const black = pattern === 'sanke' && i === n - 1
      marks.push({ cx, cy, rx: Math.max(3, L * 0.12), ry: Math.max(1.5, half * 0.6), col: black ? COL.black : COL.orange, inset: pattern === 'sanke' ? 1 : 0 })
    }
  }
  for (const m of marks) {
    for (const d of kinds.values()) {
      if (d.kind !== 'body') continue
      if (((d.x - m.cx) / m.rx) ** 2 + ((d.y - m.cy) / m.ry) ** 2 > 1) continue
      if (m.inset === 1 && isEdge(d.x, d.y)) continue // the white rim stays white
      if (m.inset === 2 && deepEdge(d.x, d.y)) continue // black stays two dots inside the orange
      d.kind = 'patch'
      d.col = m.col
    }
  }
  // where a black mark reaches the silhouette, that dot is a grey stroke one
  // dot wide; the rest of the mark is lit black (cellsFor keeps it to cells of
  // its own, so the stroke and the body never share a cell with black)
  for (const d of kinds.values()) {
    if (d.kind === 'patch' && d.col === COL.black && isEdge(d.x, d.y)) {
      d.kind = 'stroke'
      d.col = COL.stroke
    }
  }
  const ex = Math.round(bodyL * 0.09)
  for (const x of [ex, ex + 1]) {
    const d = kinds.get(`${x},-1`)
    if (d && d.kind === 'body') d.kind = 'eye'
  }
  const dots: Dot[] = []
  for (const d of kinds.values()) {
    const silhouette = d.kind === 'tail' || d.kind === 'fin' || isEdge(d.x, d.y)
    dots.push({ x: d.x, y: d.y, lit: d.kind !== 'eye' && d.kind !== 'halo' && d.kind !== 'hole', col: d.col, edge: silhouette })
  }
  const shape: Shape = { dots, marks, base }
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
      let blackBits = 0
      let top = 0 // who is on top in this cell: 0 none or a lily pad, else 1 + fish index
      let stroke = false
      let edge = false
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
        if (c === COL.black) blackBits |= 1 << k
        counts.set(c, (counts.get(c) ?? 0) + 1)
        if (top < PAD && edg[at]) edge = true
        if (c === COL.stroke) stroke = true
      })
      let col = DEFAULT
      if (counts.size > 0) {
        bits = fishBits // water dots do not show through a koi's cell
        // in a waterline cell the black dots go unlit so the one-dot grey stroke
        // stands alone; everywhere else black is a solid fill and the cell takes
        // whichever colour the pattern has at its centre
        if (stroke) bits &= ~blackBits
        if (top > 0 && top < PAD) {
          // one colour per cell: read the koi's pattern at the cell's centre, so a
          // marking is a steady shape that travels with the fish instead of a
          // count of dots that flips as the fish crosses cell boundaries
          const d = drawn[top - 1]!
          const cxDot = cx * 2 + 0.5
          const cyDot = cy * 4 + 1.5
          const lx = d.dir === -1 ? cxDot - d.hx : d.hx - cxDot
          const ly = cyDot - d.hy
          col = d.shape.base
          for (const m of d.shape.marks) {
            if (((lx - m.cx) / m.rx) ** 2 + ((ly - m.cy) / m.ry) ** 2 <= 1) col = m.col
          }
          if (stroke) col = COL.stroke // the grey edge where a black mark meets the water
          else if (d.pattern === 'sanke' && edge && col !== d.shape.base) col = d.shape.base // the sanke's rim stays white
        } else {
          col = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0]
        }
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

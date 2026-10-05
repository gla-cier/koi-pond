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
// a 100 ms ticker-> moves everything and repaints the Raster in place
//                   ($.ui.blit), falling back to a band redraw when refused
// ui.render      -> draws the band; yields to a survey and to any other
//                   plugin's band that has controls; one-line text fallback
//                   where there is no Raster or the band is too short
// context tiers  -> under 50%: cruising; 50-80%: slow; 80%+: the koi settle
//                   and rest (time to /compact)

import type { Register } from 'claude-code'

const TICK_MS = 100
const DT = TICK_MS / 1000
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
type Reading = { tokens: number; window: number; percent: number }

let rows = 6
let sound = true
let view: View = 'pond'
let draw: Draw = 'pixels'
let waterDots = false
let ground = 0x16181c // what see-through fins and deep koi fade toward: the theme's background, roughly
let phase: Phase = 'idle'
let frame = 0
let happyUntil = 0
let reading: Reading | null = null
let ticker: { cancel: () => void } | null = null
let cols = 0
let requestId: string | null = null
let mounted = false
let rnd = mulberry32(0x9e3779b9)

export const register: Register = (on, options) => {
  sound = options?.sound !== false
  view = options?.view === 'tank' ? 'tank' : 'pond'
  draw = options?.fish === 'dots' ? 'dots' : 'pixels'
  waterDots = options?.water === 'dots'
  const wanted = Number(options?.rows)
  rows = Number.isFinite(wanted) ? Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.round(wanted))) : 6

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    phase = 'idle'
    frame = 0
    await takeReading($)
    try {
      const theme = (await $.config.list()).find(row => row.key === 'theme')
      if (String(theme?.value ?? '').includes('light')) ground = 0xf7f7f5
    } catch {
      // keep the dark ground
    }
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => {
      frame += 1
      if (phase === 'happy' && frame >= happyUntil) phase = 'idle'
      if (!mounted || cols === 0) return
      const resting = tierFor(reading?.percent ?? 0).key === 'asleep' && phase === 'idle' && !busy()
      if (resting && frame % 4 !== 0) return // a resting pond breathes slower
      step(resting ? DT * 4 : DT)
      void repaint($)
    })
    return result
  })

  on('prompt.submit', ($, e, next) => {
    if (!e.turnId) phase = 'working'
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    await takeReading($)
    if (e.isAborted) {
      phase = 'idle'
    } else {
      phase = 'happy'
      happyUntil = frame + 25
      if (cols > 0) feed()
      if (sound) {
        $.audio.play({ asset: 'assets/bloop.wav' }).catch(() => {
          // no player on this platform, or the clip was refused: the food still falls
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
      const word = working ? 'koi darting' : tier.key === 'asleep' ? 'koi resting · time to /compact' : tier.key === 'drowsy' ? 'koi drifting slowly' : view === 'tank' ? 'koi tank' : 'koi pond'
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

// ---- shared -----------------------------------------------------------------

function speedFactor(): number {
  if (phase === 'working') return 2.2
  const tier = tierFor(reading?.percent ?? 0).key
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

function busy(): boolean {
  return view === 'pond' ? pond.ripples.length > 0 || pond.pellets.length > 0 : tank.flakes.length > 0
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
}
type Pellet = { x: number; y: number; age: number }
type Ripple = { x: number; y: number; age: number }

const pond = { fish: [] as PondKoi[], pellets: [] as Pellet[], ripples: [] as Ripple[], t: 0 }
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
  if (factor === 0) {
    f.depthTo = 0.7 // resting: sink and hang still
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
    if (nearEdge || (!food && rnd() < (phase === 'working' ? 0.0012 : 0.0004))) {
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
  f.depth += (f.depthTo - f.depth) * Math.min(1, h * 0.5)
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
  const swimming = speedFactor() > 0 ? 1 : 0.25
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
        if (hit) put(g, gx, gy, hit[0], L_FISH + z, (z + 1) * 16 + hit[1])
      }
    }
  })
  // lily pads float over the koi
  const pads: [number, number, number, boolean][] = [[W - 17, 7, 5.6, true], [13, H - 7, 5, false]]
  if (W > 110) pads.push([Math.floor(W * 0.46), H - 7, 5.4, true])
  for (const [cx, cy, r, flower] of pads) {
    for (let gy = Math.floor((cy - r) / s); gy <= Math.ceil((cy + r) / s); gy += 1) {
      for (let gx = Math.floor((cx - 1.1 * r) / s); gx <= Math.ceil((cx + 1.1 * r) / s); gx += 1) {
        const x = (gx + 0.5) * s - cx
        const y = (gy + 0.5) * s - cy
        if ((x / (1.1 * r)) ** 2 + (y / r) ** 2 > 1) continue
        const ang = Math.atan2(y, x)
        if (Math.abs(ang) < 0.32 && x > 0) continue // the notch, a wedge to the centre
        let c = Math.abs(Math.sin(ang * 4)) < 0.18 ? COL.padDark : COL.pad // veins
        if (flower && (x + 0.35 * r) ** 2 + (y + 0.2 * r) ** 2 < (0.38 * r) ** 2) c = COL.flower
        put(g, gx, gy, c, L_PAD, c === COL.flower ? 1001 : 1000)
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
      putEmpty(g, Math.floor(x / s), Math.floor(y / s), c, L_RIPPLE, 3000)
    }
  }
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
}
type Part = 'body' | 'fin' | 'tail'
type SideDot = { x: number; y: number; part: Part | 'eye' }
type Flake = { x: number; y: number; age: number; settled: number }
type Bubble = { x: number; y: number; wob: number; size: number }
type Pop = { x: number; age: number }
type Puff = { x: number; y: number; vx: number; vy: number; age: number }

const SNAIL_SPEED = 1.2 // columns a second, in dots
const tank = { fish: [] as TankKoi[], flakes: [] as Flake[], bubbles: [] as Bubble[], pops: [] as Pop[], puffs: [] as Puff[], t: 0, nextBubble: 0 }
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
    put(g, Math.round(p.x) - s, 1, 0xc4e3f0, 96, 5101)
    put(g, Math.round(p.x) + s, 1, 0xc4e3f0, 96, 5101)
  }
  for (const p of tank.puffs) put(g, Math.round(p.x), Math.round(p.y), GRAVEL[2]!, 59, 6001)
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
    const layer = L_FISH + z
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
        if (snap() && squeeze === 1 && pitch === 0) {
          // one colour a cell: read the mosaic by the cell's column from the head
          // (the even one of its two dot columns, so each mosaic column lands in
          // exactly one cell) and by back or belly row
          const a = f.dir === -1 ? Math.floor(X / 2) * 2 - hx : hx - Math.floor(X / 2) * 2
          const lx = a % 2 === 0 ? a : f.dir === -1 ? a + 1 : a - 1
          c = mosaicAt(f.pattern, lx / 2, Math.floor(Y / 4) - row) ?? c
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
  // gravel along the bottom, in front of a resting koi's belly
  for (let x = 0; x < W; x += 1) {
    const n = Math.abs(Math.sin(x * 12.9898) * 43758.5453) % 1
    const c = GRAVEL[Math.floor(n * GRAVEL.length)]!
    put(g, x, H - 1, c, L_GRAVEL, 6000 + Math.floor(n * 3))
    if (snap() && n > 0.45) put(g, x, H - 2, GRAVEL[(Math.floor(n * 10) + 1) % GRAVEL.length]!, L_GRAVEL, 6000 + Math.floor(n * 3))
  }
  for (const q of tank.flakes) put(g, Math.round(q.x), Math.round(q.y), Math.sin(q.age * 7 + q.x) > 0 ? 0xe0a868 : COL.pellet, L_FOOD, 2000)
  glass(g)
  snail(g)
  if (light < 1) {
    for (let i = 0; i < g.col.length; i += 1) {
      const c = g.col[i]!
      if (c >= 0) g.col[i] = mix(ground, mix(c, 0x1a2c4a, (1 - light) * 0.55), 0.25 + light * 0.75)
    }
  }
}

function feedTank() {
  const W = tankW()
  const x = 10 + rnd() * Math.max(1, W - 20)
  for (let i = 0; i < 5; i += 1) tank.flakes.push({ x: x + (rnd() - 0.5) * (snap() ? 14 : 7), y: 1, age: rnd() * 0.5, settled: 0 })
}

// ---- the tank's light, decor, glass and snail ----------------------------------

// The tank light follows the context window: full under 50%, dimming to 80%,
// then night: lights out, a blue dark, the koi asleep on the gravel.
function lightLevel(): number {
  const percent = reading?.percent ?? 0
  return percent < 50 ? 1 : percent < 80 ? 1 - ((percent - 50) / 30) * 0.4 : 0.32
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

# koi-pond

Koi across the band above the prompt in Claude Code. A pond seen from above, or a tank seen from the side. The koi swim while you type, dart while Claude works, settle as the context window fills, and come to eat when a turn finishes, with a soft bloop. Zero tokens, no network: the plugin reads the session's own usage figures and draws them.

- **pond** (default): koi seen from above, each body following its own wake, lily pads over them, food on the water, rain rings while Claude works, a dragonfly by day. Dusk from 50% of the context window, night from 80%, with a moon on the water and the koi asleep under the pads. One koi comes to look where you type.
- **tank**: koi seen from the side behind glass, with gravel, weed, a stone, driftwood, a bubbler and a snail. Flakes flutter as they sink. The tank dims as the context fills.

## Install

In a Claude Code session:

```
/plugin install koi-pond --marketplace gla-cier/koi-pond
```

Answer `y` to add the marketplace, then pick a scope (`user` keeps it across projects). The band needs a terminal at least 30 columns wide with 4 rows to spare above the prompt; elsewhere it draws one line of text.

## Commands

- `/koi` says how full the koi think the context is, and which window they measure against.
- `/koi feed` drops food in.
- `/koi night`, `/koi dusk`, `/koi day` preview that light for a minute (as at 90%, 65% and 20%) without touching the reading; `/koi live` ends it.

## Options

Set them with `/plugin configure koi-pond`.

| Option | Default | What it does |
|---|---|---|
| `view` | `pond` | `pond` from above, `tank` from the side. |
| `fish` | `dots` | `dots`: braille, finer. `pixels`: half blocks, steadier markings. |
| `rows` | `6` | Height of the band in rows, 4 to 8. |
| `water` | `clear` | `dots` adds a sparse field of dim blue dots (pond). |
| `sound` | on | A soft bloop when a turn finishes. |
| `caret` | on | A koi comes to look where you type; each keystroke rings the water (pond). |
| `algae` | off | Tank only: algae grows over the session and the snail grazes it. |
| `idleMinutes` | `3` | Minutes after the last sign of life before the pond stops moving. `0` never stops. Fractions work. |
| `fps` | `4` | Frames a second while awake: 2, 4, 6, 10, 14, 28 or 60. The koi swim at the same speed at any rate; higher is smoother and costs more CPU. 28 is the functional max in dots, 14 in pixels; 60 is for laughs. |
| `workingFps` | `4` | The most frames a second while Claude is working a turn, or `same` for no cap. |

The world is drawn in braille dots and nothing moves faster than the dragonfly's 28 dots a second, so above 28 fps no two frames differ. CPU per session: about 13% of a core at 4 fps, 21-26% at 10, around a whole core at 60, and nothing once the pond has stopped.

## Terminal

The terminal font must cover the whole Braille Patterns block (U+2800 to U+28FF) and the block elements. A font missing them falls back glyph by glyph to another face, and the koi come out as boxes, gaps or misaligned dots. Beyond coverage, glyphs vary by font: a monospace face with dense round braille dots and block elements drawn to the full line box looks best. Ghostty, iTerm2, kitty and WezTerm all render the band well.

## Development

```
claude plugin validate .
claude plugin test .
```

`idle-throttle.md` records the CPU work: the idle stop, the frame rate presets and the working-turn cap, with the measurements behind them.

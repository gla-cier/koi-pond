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

## Updating

Installing clones this repo into Claude Code's plugin cache and runs the pond from that copy, so new versions don't reach you on their own. Turn auto-update on once, right after installing:

1. Run `/plugin` and move to the **Marketplaces** tab (not Plugins). Select `koi-pond` and choose **Enable auto-update**. It is off by default for marketplaces like this one.
2. From then on Claude Code fetches new versions in the background shortly after a session starts and prints `Plugin updated: koi-pond · Run /reload-plugins to apply`. Run `/reload-plugins` when you see it, or just start your next session.

Without auto-update, `/plugin update koi-pond@koi-pond` fetches the latest by hand, followed by the same `/reload-plugins`. On its own, `/reload-plugins` only re-reads what is already on disk. The **Mark for update** item on the plugin's own page in the Plugins tab does not apply here, since the pond is delivered by its marketplace; update the marketplace instead.

## Commands

One slash command, `/koi`, with a few words after it.

- **`/koi`**: the reading. Prints how many tokens the session has used out of the window the koi measure against, the percentage, and the koi's mood: `fresh` under 50%, `drowsy` from 50%, `asleep` from 80%. It also says which window that is: the auto-compact window when Claude Code reports one, otherwise the model's whole context. If a preview is running it says how many seconds are left.
- **`/koi feed`**: drops food on the water (or flakes into the tank). The koi rush to it and eat. Purely cosmetic; nothing about the session changes.
- **`/koi night`**, **`/koi dusk`**, **`/koi day`**: a one-minute preview of that light, as if the context were at 90%, 65% or 20%. The reading is untouched; this is for seeing the moon, the dusk colours, or a fresh pond when your session is already deep. The preview ends on its own after a minute.
- **`/koi live`**: ends a preview early and returns the koi to the real reading.

## Options

Set them with `/plugin configure koi-pond`. Saving reloads the plugin on the spot.

### What you see

- **`view`** (`pond` or `tank`, default `pond`). `pond` looks down on the water: koi with wakes, lily pads, food on the surface, rain rings while Claude works, a dragonfly by day, a moon at night. `tank` looks in through the glass from the side: gravel, weed, a stone, driftwood, a bubbler, a snail, and flakes that flutter as they sink.
- **`fish`** (`dots` or `pixels`, default `dots`). `dots` draws everything in braille, the finest grid a terminal offers, with one colour per cell and a stippled look. `pixels` uses half-block characters: coarser, two colours per cell, so a koi's markings sit steady instead of shimmering. Try both; fonts differ.
- **`rows`** (4 to 8, default `6`). Height of the band in terminal rows. More rows give the koi more water and more lanes; fewer leave more room for the conversation.
- **`water`** (`clear` or `dots`, default `clear`). `clear` uses the terminal's own background as the water. `dots` scatters a sparse field of dim blue dots across the pond, which reads as water on very dark themes. Pond only.

### What happens

- **`sound`** (on or off, default on). A soft bloop when a turn finishes, as the koi come to eat. The sound is a 260 ms synthesized tone shipped with the plugin.
- **`caret`** (on or off, default on). Pond only. A koi comes to look at the spot above where you are typing: quick by day, lazy at dusk. From 110 columns wide, the koi near the caret lean toward it. Each keystroke rings the water over it, and at night a sleeping koi near it stirs without waking.
- **`algae`** (on or off, default off). Tank only. Algae slowly grows on the glass and the decor over a session and the snail grazes it. Fresh each session.

### How hard it works

The pond costs no tokens, but drawing it costs CPU. These three settings decide how much.

- **`idleMinutes`** (default `1.5`). Minutes after the last sign of life (a prompt, a turn, a model request, a keypress) before the pond stops moving and the koi hold still. The next sign of life starts it again. `0` keeps it moving all session. Fractions work: `0.5` is thirty seconds, `0.1` is six.
- **`fps`** (`2`, `4`, `6`, `10`, `14`, `28` or `60`, default `10`). Frames per second while the pond is awake. The koi swim at the same speed at any rate; a higher rate is smoother and costs more CPU, so pair a high one with a short idle stop. What each preset buys:
  - `2`: enough for drowsy koi only.
  - `4`: catches every position of a cruising koi.
  - `6`: the faster koi while Claude works look smooth.
  - `10`: the rush to food looks smooth. The default.
  - `14`: the functional maximum in `pixels` mode, where each sample is two dots tall so every speed halves.
  - `28`: the functional maximum in `dots` mode. Nothing moves finer than a braille dot and nothing moves faster than the dragonfly's 28 dots a second, so above this no two frames differ.
  - `60`: for laughs. The same picture as 28, for about a whole core.
- **`workingFps`** (the same presets, or `same`, default `4`). A ceiling on the frame rate while Claude is working a turn. Every model request keeps the pond awake, so a long turn at a high `fps` would burn a core the whole way; this caps it. Your chosen `fps` returns when the turn completes. `same` removes the cap.

Rough CPU per session, pond view, eight rows: about 13% of a core at 4 fps, 21 to 26% at 10, around a whole core at 60, and nothing once the pond has stopped.

## Terminal

The terminal font must cover the whole Braille Patterns block (U+2800 to U+28FF) and the block elements. A font missing them falls back glyph by glyph to another face, and the koi come out as boxes, gaps or misaligned dots. Beyond coverage, glyphs vary by font: a monospace face with dense round braille dots and block elements drawn to the full line box looks best. Ghostty, iTerm2, kitty and WezTerm all render the band well.

## Development

```
claude plugin validate .
claude plugin test .
```

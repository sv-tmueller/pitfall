# Pitfall

A trap platformer where the level lies to you between attempts.

[Play in your browser](https://pitfall-fawn.vercel.app) | [Source](https://github.com/sv-tmueller/pitfall)

## What is this?

Pitfall is a trap platformer inspired by the genre popularized by *Level Devil*: short levels, instant death, and traps disguised as normal level geometry. The difference is that the level itself is not fixed. Between attempts, traps and level elements mutate, and the game denies that anything changed. You have to notice the mutation, not just react fast enough.

Three guardrails keep it fair:

1. Mutations apply at level start only. The level never changes under your feet mid-run.
2. Every mutated element is on screen and readable before you can commit to it. The lie is about memory, never about reaction time.
3. A mutation may never make a level unsolvable.

## Features

- 45 original levels across three worlds, each escalating in mechanical complexity and willingness to lie
- 12 trap types: vanishing floors, emerging spikes, crushers, shifting walls, fake exits, and more
- 12 gameplay mechanics: gravity inversion, bombs, levers, jetpack, buzzsaws, springs, rotating arms, moving terrain, control inversion, camera trolls, fake UI, and teleporters
- Attempt-keyed level mutations with a deterministic resolver
- Unreliable HUD that quietly drifts counters and a denial system that insists nothing changed
- Speedrun timer, replay recording, and a stats screen showing the true figures
- Level editor, validation harness, and PWA support for offline play
- Privacy-friendly analytics (cookieless, no personal data)
- Accessibility: reduced motion, colorblind-safe palette, remappable keys
- 1235 tests, strict TypeScript, zero runtime dependencies

## Inspiration and originality

All code, art, audio, and level designs in this repository are original. Nothing here is copied, decompiled, or derived from *Level Devil* or any other game.

## Stack

Vanilla TypeScript and Canvas2D, built with Vite, tested with Vitest.

The game targets a fixed 320x180 backbuffer scaled to the viewport, on a deterministic fixed-step 60 Hz simulation driven by a seeded PRNG. The mutation system depends on that determinism: a run has to be reproducible from its seed, and the validation harness replays attempts exactly.

## Build, run, test

```
npm install
npm run dev          # start the Vite dev server
npm run build        # production build to dist/
npm run build:atlas  # regenerate assets/atlas.png + atlas.json (Node 22.6+)
npm test             # run the Vitest suite (1235 tests)
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
```

## License

© 2026 Thomas Mueller. All rights reserved. Source shown for reference only. See [LICENSE](LICENSE).

# Visual identity

Pitfall's palette, rendering rules, typography and tile grammar. This document is the spec;
`src/render/palette.ts`, `src/render/atlas.ts` and `src/tools/build-atlas.ts` implement it.

## Palette

Six named hex tokens, no more. Five neutrals form a single value ramp; `lethal` is the only
saturated color the game ever draws.

| Token    | Hex       | Rule                                                                                                                    |
| -------- | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `void`   | `#05050a` | Backbuffer clear color. Nothing is drawn in it.                                                                         |
| `night`  | `#12121c` | The body of every solid collidable tile. The mass of the world.                                                         |
| `dusk`   | `#24243a` | Background scenery, parallax, inert or disabled states. Never collidable, never lethal.                                 |
| `edge`   | `#4a4a63` | The lit top surface of solids, the whole body of one-way platforms, structural outlines. Reads as "you can stand here". |
| `bone`   | `#e6e6f0` | The player, the exit interior, all text, all UI. The player-trust color.                                                |
| `lethal` | `#ff2e3c` | Anything that kills, at the moment it is being honest. Nothing else, ever.                                              |

The palette is exported as a TypeScript constant, `PALETTE` in `src/render/palette.ts`, so code
and art cannot drift apart. Any new game color literal belongs there; the only exception is the
letterbox bars' `background: #000` in `index.html`, which are outside the world and not part of
this palette.

The exit is deliberately not given its own accent hue. A second saturated color would dilute the
signal that red means death; the exit reads through shape and `bone` instead.

## The silhouette rule and the lying device

The world reads in near-black. One hot accent, `lethal`, is reserved exclusively for anything
that kills. This is a gameplay device, not decoration.

The game lies **by omission, never by commission**. `lethal` is never used for something
harmless, not once, not on the title screen, not in UI. That absolute rule is what makes the
accent trustworthy in the first few minutes.

Because the accent means death, and only ever means death, the game can lie by withholding it:
a hazard that has not revealed itself yet is invisible in plain sight. A hazard can be authored
to render as ordinary terrain until it fires, so its absence carries no information while its
presence carries total information.

A consequence worth stating explicitly: a dormant hazard has no sprite of its own. It is drawn
with whatever terrain tile disguises it. There is deliberately no "suspicious-looking spike" art,
because any distinguishing pixel leaks the trap. This is why the atlas has `hazard.spikes` and no
dormant variant.

The `title.mark` uses `bone` and `edge` only, no `lethal`. Even the gas lamp flame in the mark is
`bone`, so the player's first ever encounter with red is a thing that kills them.

## Typography (documented, not implemented)

No glyph atlas ships in this package; this fixes the grammar so a later font generator has no
freedom to drift.

- Uppercase-only ASCII, 5x7 glyph in a 6x8 cell (1 px right and bottom spacing).
- Line height 8 px. Word space 3 px, narrower than the 6 px advance.
- `floor(320 / 6) = 53` characters per line at the internal resolution.
- Text is drawn in `bone` on `void`, only into the 320x180 backbuffer, and is never scaled by a
  non-integer factor.

## Tile grammar

- 16 px tiles. `320 / 16 = 20` columns. `180 / 16 = 11.25` rows, so row 11 is only 4 px tall on
  screen. Level authoring must never place a required affordance in that clipped strip.
- Nothing may extend past its 16x16 cell. No overhangs, no sub-tile decoration. Collision is
  discrete AABB on the same grid, and art that lies about geometry defeats the silhouette rule.
- Only two solid tile frames exist for now (`tile.solid.top`, `tile.solid.fill`). A fuller
  autotile set is deferred to the tilemap issue on purpose.

## The atlas generator

An agent cannot draw pixel art in any meaningful sense, so the artwork is generated rather than
hand-drawn. `src/tools/build-atlas.ts` builds `assets/atlas.png` and `assets/atlas.json` from the
palette and from shape definitions expressed as ASCII-art strings in `src/tools/atlas-art.ts`,
run through `npm run build:atlas`. Both the generator and its output are committed, so the
renderer can load the atlas directly without running a build step first.

This approach was chosen deliberately over hand-authored art: the output is crude but
intentional, it regenerates whenever the palette changes, it is original by construction, and it
is reviewable as code (an ASCII grid in a diff) rather than as an opaque binary.

### Layout

Frames are packed in array declaration order, left to right, wrapping to a new row when a frame
would exceed the atlas width of 128 px, row height taken as the tallest frame placed in that row.
Player frames are 16x24 (the sprite extends 8 px above a 16x16 AABB for head and hair); every
other frame is 16x16. Eight player frames fill row one exactly (`8 * 16 = 128`px); the six tile
and mark frames start row two. The atlas is **128 x 40**.

| name              | x   | y   | w   | h   | origin |
| ----------------- | --- | --- | --- | --- | ------ |
| `player.idle.0`   | 0   | 0   | 16  | 24  | 0, 8   |
| `player.idle.1`   | 16  | 0   | 16  | 24  | 0, 8   |
| `player.run.0`    | 32  | 0   | 16  | 24  | 0, 8   |
| `player.run.1`    | 48  | 0   | 16  | 24  | 0, 8   |
| `player.run.2`    | 64  | 0   | 16  | 24  | 0, 8   |
| `player.run.3`    | 80  | 0   | 16  | 24  | 0, 8   |
| `player.jump`     | 96  | 0   | 16  | 24  | 0, 8   |
| `player.fall`     | 112 | 0   | 16  | 24  | 0, 8   |
| `tile.solid.top`  | 0   | 24  | 16  | 16  | 0, 0   |
| `tile.solid.fill` | 16  | 24  | 16  | 16  | 0, 0   |
| `tile.oneway`     | 32  | 24  | 16  | 16  | 0, 0   |
| `hazard.spikes`   | 48  | 24  | 16  | 16  | 0, 0   |
| `exit.door`       | 64  | 24  | 16  | 16  | 0, 0   |
| `title.mark`      | 80  | 24  | 16  | 16  | 0, 0   |

The region x 96-127, y 24-39 is unused and fully transparent.

`origin` is the pixel offset from the frame's top-left to the entity's AABB top-left; the
renderer draws at `(body.x - origin.x, body.y - origin.y)`. The player art assumes a 16x16 AABB:
the 16x24 sprite's feet align with the AABB bottom, and the extra 8 rows above are head and hair.
If a later milestone changes the AABB, only `origin.y` changes.

There is zero padding and zero extrusion between frames. The renderer samples 1:1 with
`imageSmoothingEnabled = false` and blits the 320x180 backbuffer at an integer scale, so there is
no filtering and therefore no texture bleed to guard against with a gutter.

### Art representation

Every frame is authored as an array of strings, one per row, one character per pixel:

```
'.' transparent   'v' void   'n' night   'd' dusk   'e' edge   'b' bone   'x' lethal
```

Frame width and height are derived from the string data, so the data cannot disagree with the
declared layout.

### Manifest

`assets/atlas.json` mirrors the layout table above: `version`, `image`, `width`, `height`, and a
`frames` object keyed by name (`x`, `y`, `w`, `h`, `origin`). Key order follows the declaration
order of the frames, which is what keeps the file's insertion order meaningful; every key
contains a dot so none is parsed as an integer-like property, which is what keeps that order
stable across JS engines.

### Determinism

The generator has no `Date.now`, no `Math.random`, no `performance.now`, and does no filesystem
reads at generation time (the art is source code). It writes only IHDR, PLTE, tRNS, IDAT and IEND
chunks, no `tIME`, `tEXt` or `pHYs`, so nothing in the file records when or where it was made.
Running the generator twice produces byte-identical output.

### Encoding

`src/tools/png.ts` hand-rolls an indexed (color type 3, bit depth 4) PNG encoder, including a
single stored (uncompressed) deflate block, rather than depending on a PNG library or
`zlib.deflateSync`. This keeps the output byte-identical across every Node build forever;
`zlib.deflateSync` output can otherwise change between zlib and zlib-ng builds, which would make
a committed-artifact byte-equality test flake between CI and a developer machine. It also means
the PNG format itself enforces the palette: an indexed PNG physically cannot contain a color
outside `PLTE`.

### Regeneration

`npm run build:atlas` runs `src/tools/build-atlas.ts` with Node's built-in TypeScript type
stripping and requires **Node 22.6 or newer**. This repository's `engines.node` field still
declares `>=20.19.0` and is deliberately left unchanged: the committed `assets/atlas.png` and
`assets/atlas.json` are the contract that ships, and regenerating them is a maintainer action, not
part of the normal install or build path. Node 20 has no type stripping and cannot run the
generator; anyone running the build step needs Node 22.6+.

## Provenance

All art, audio, and level design data in this repository is original work created for this
project. None of it is third-party material, and none of it is traced or derived from any other
source.

Specifically for this package: the artwork in `assets/atlas.png` is generated by
`src/tools/build-atlas.ts` from shape definitions written for this project in
`src/tools/atlas-art.ts`. No external image, font, or palette was used as a source, and the
committed `assets/atlas.png` and `assets/atlas.json` are outputs of that generator and nothing
else.

See [`../../LICENSE`](../../LICENSE) for license terms.

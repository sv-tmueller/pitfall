import atlasManifest from '../assets/atlas.json';
import type { AtlasManifest } from './render/atlas';
import { loadAtlas } from './render/atlas-loader';
import type { BlitContext } from './render/batcher';
import { BASE_HEIGHT, BASE_WIDTH, computeCanvasLayout } from './scale';
import { attachClickConfirm, attachKeyboardInput, createKeyboardInput } from './engine/input';
import { createRafTicker } from './engine/loop';
import { createApp, formatBootError } from './game/app';
import { createAccessibilitySettings, getEffectsIntensity } from './accessibility/accessibility';
import { createLocalStorage } from './save/storage';
import { MVP_LEVELS, MVP_SEQUENCE } from './levels/mvp';
import { WORLD2_LEVELS, WORLD2_SEQUENCE } from './levels/world2';
import { WORLD3_LEVELS, WORLD3_SEQUENCE } from './levels/world3';

// The full 45-level campaign: MVP (15) + World 2 (15) + World 3 (15),
// played in authored order. Each sequence slug maps to its raw JSON source
// in the corresponding level catalog. The app shell indexes this list by
// absolute position when it saves and restores progress.
const SOURCES: readonly unknown[] = [
  ...MVP_SEQUENCE.map((id) => MVP_LEVELS[id]),
  ...WORLD2_SEQUENCE.map((id) => WORLD2_LEVELS[id]),
  ...WORLD3_SEQUENCE.map((id) => WORLD3_LEVELS[id]),
];

async function loadAtlasBitmap(): Promise<ImageBitmap> {
  const url = new URL('../assets/atlas.png', import.meta.url);
  const response = await fetch(url);
  // A failed request still resolves fetch, so status must be checked
  // explicitly. Otherwise the decode below turns a 404 body into an opaque
  // decoder error.
  if (!response.ok) {
    throw new Error(`atlas request failed with status ${response.status}`);
  }
  const blob = await response.blob();
  return createImageBitmap(blob);
}

/** Write a readable message into the DOM fallback container. */
function showBootError(error: unknown): void {
  const message = formatBootError(error);
  const container = document.querySelector<HTMLElement>('#boot-error');
  if (container !== null) {
    container.textContent = message;
    container.hidden = false;
  }
  console.error(message, error);
}

function bootstrap(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  atlasBitmap: ImageBitmap,
): void {
  const manifest = atlasManifest as unknown as AtlasManifest;
  const atlas = loadAtlas(manifest, atlasBitmap);

  // Backbuffer at the fixed internal resolution; the visible canvas is an
  // integer-scaled blit of this, keeping scaling logic in one place.
  const backbuffer = document.createElement('canvas');
  backbuffer.width = BASE_WIDTH;
  backbuffer.height = BASE_HEIGHT;

  const backCtxRaw = backbuffer.getContext('2d');
  if (!backCtxRaw) {
    throw new Error('2d context unavailable on the backbuffer');
  }
  // Adapt CanvasRenderingContext2D to the narrower BlitContext interface.
  // fillStyle is wider on the DOM type (string | CanvasGradient | CanvasPattern),
  // so assignments from BlitContext's string-typed fillStyle are safe but
  // require erasing the union for assignment-compatibility.
  const backCtx: BlitContext = backCtxRaw as unknown as BlitContext;

  const input = createKeyboardInput();
  attachKeyboardInput(input, window);
  // A canvas click presses and releases the confirm binding, so a trackpad
  // player reaches the same polled confirm edge as the keyboard.
  attachClickConfirm(input, canvas);

  // Reduced motion: honor the OS/browser preference. Under reduced motion
  // the effects intensity is 0 (no shake, no particles, no hit-stop).
  const prefersReducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const accessibility = createAccessibilitySettings(prefersReducedMotion);
  const effectsIntensity = getEffectsIntensity(accessibility);

  const app = createApp({
    sources: SOURCES,
    atlas,
    input,
    storage: createLocalStorage(),
    blit: backCtx,
    ticker: createRafTicker(),
    effectsIntensity,
    present: () => {
      const layout = computeCanvasLayout({
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      });

      canvas.width = layout.deviceWidth;
      canvas.height = layout.deviceHeight;
      canvas.style.width = `${layout.cssWidth}px`;
      canvas.style.height = `${layout.cssHeight}px`;
      canvas.style.left = `${layout.offsetX}px`;
      canvas.style.top = `${layout.offsetY}px`;

      // Reset after every resize since changing canvas.width/height clears the context.
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(backbuffer, 0, 0, canvas.width, canvas.height);
    },
  });

  // Focus policy: losing the window or hiding the tab pauses play so the
  // player does not die (or buffer input) while looking away. Unpausing is an
  // explicit keypress, so returning to the tab never resumes on its own.
  window.addEventListener('blur', () => app.handleBlur());
  document.addEventListener('visibilitychange', () => {
    app.handleVisibilityChange(document.hidden);
  });

  app.start();
}

const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas');
if (!canvas) {
  showBootError(new Error('missing #game-canvas element'));
} else {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    showBootError(new Error('2d context unavailable on #game-canvas'));
  } else {
    loadAtlasBitmap()
      .then((bitmap) => bootstrap(canvas, ctx, bitmap))
      .catch((err: unknown) => {
        showBootError(err);
      });
  }
}

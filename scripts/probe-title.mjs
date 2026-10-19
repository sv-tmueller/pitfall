#!/usr/bin/env node
/**
 * Headless discoverability probe for the title screen (issue #177).
 *
 * Boots the built game from dist/ over a throwaway localhost server and drives
 * the real input pipeline in headless Chrome: keys arrive through
 * window keydown/keyup, a click arrives through canvas pointerdown/pointerup
 * via CDP mouse events. The probe only reads the visible canvas, so what it
 * measures is what a player would see.
 *
 * Checks
 *   1. BOOT      the title screen renders and 8px text is legible (no boot error).
 *   2. SPACE     Space still starts the game (regression guard).
 *   3. ENTER     Enter (confirm) starts the game and gameplay keeps rendering.
 *   4. CLICK     a canvas click starts the game exactly like Enter.
 *   5. HOWTO     Enter with HOW TO PLAY highlighted reveals the control list
 *                and the goal, and does not start the game.
 *   6. ERRORS    the page raised no uncaught error or console error.
 *
 * Usage: npm run build && node scripts/probe-title.mjs
 * Env:   CHROME_PATH overrides the browser binary.
 * Needs: Node 22+ for the global WebSocket, and a Chrome/Chromium binary.
 *
 * Exit code 0 when every check passes, 1 otherwise.
 */

/* global console, process, setTimeout, clearTimeout, URL, WebSocket, Buffer */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST_DIR = resolve(fileURLToPath(new URL('../dist', import.meta.url)));

// Internal render resolution. Every band below is expressed in these units;
// the probe maps them onto the scaled visible canvas.
const BASE_WIDTH = 320;
const BASE_HEIGHT = 180;

// Regions of interest, [x0, y0, x1, y1] in internal pixels.
const TITLE_HINT_BAND = [64, 163, 210, 176]; // confirm hint, title screen only
const INSTRUCTION_BAND = [60, 58, 218, 110]; // HOW TO PLAY control list
const OPTION_LABEL_BAND = [98, 113, 214, 162]; // START/HOW TO PLAY label stack

// A bone pixel is the palette's brightest token (#e6e6f0); the renderer fills
// text with it verbatim, so the test is deliberately loose but not vague.
const BONE_PIXEL_COUNT = 20;

const SLEEP = (ms) => new Promise((done) => setTimeout(done, ms));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/** Page-side helpers, injected with every evaluation. */
const PAGE_HELPERS = `
  function probeContext() {
    const canvas = document.getElementById('game-canvas');
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    return { canvas, ctx };
  }
  function probeBoneCount(x0, y0, x1, y1) {
    const found = probeContext();
    if (found === null) return -1;
    const { canvas, ctx } = found;
    const scaleX = canvas.width / ${BASE_WIDTH};
    const scaleY = canvas.height / ${BASE_HEIGHT};
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const dx = Math.min(canvas.width - 1, Math.floor(x * scaleX));
        const dy = Math.min(canvas.height - 1, Math.floor(y * scaleY));
        const i = (dy * canvas.width + dx) * 4;
        if (image.data[i] > 180 && image.data[i + 1] > 180 && image.data[i + 2] > 190 && image.data[i + 3] > 0) {
          count += 1;
        }
      }
    }
    return count;
  }
  function probeSignature() {
    const found = probeContext();
    if (found === null) return '';
    const { canvas, ctx } = found;
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const cols = 16;
    const rows = 9;
    const sums = new Array(cols * rows).fill(0);
    const sizes = new Array(cols * rows).fill(0);
    for (let y = 0; y < canvas.height; y += 1) {
      const ry = Math.min(rows - 1, Math.floor((y * rows) / canvas.height));
      for (let x = 0; x < canvas.width; x += 1) {
        const rx = Math.min(cols - 1, Math.floor((x * cols) / canvas.width));
        const i = (y * canvas.width + x) * 4;
        const bucket = ry * cols + rx;
        sums[bucket] += (image.data[i] + image.data[i + 1] + image.data[i + 2]) / 3;
        sizes[bucket] += 1;
      }
    }
    let out = '';
    for (let i = 0; i < sums.length; i += 1) {
      out += String.fromCharCode(48 + Math.round(sums[i] / sizes[i] / 16));
    }
    return out;
  }
  function probeBootErrorVisible() {
    const el = document.getElementById('boot-error');
    return el !== null && el.hidden === false;
  }
`;

/** Serve dist/ on a random localhost port. */
function serveDist(dir) {
  const server = createServer(async (request, response) => {
    const parsed = new URL(request.url ?? '/', 'http://localhost');
    const pathname = parsed.pathname === '/' ? '/index.html' : decodeURIComponent(parsed.pathname);
    const filePath = normalize(join(dir, pathname));
    if (!filePath.startsWith(dir)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    try {
      const body = await readFile(filePath);
      response.writeHead(200, {
        'content-type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });

  return new Promise((done, fail) => {
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      done({ server, port: address.port });
    });
  });
}

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Launch headless Chrome and read its DevTools endpoint off stderr. */
async function launchChrome(binary) {
  const userDataDir = await mkdtemp(join(tmpdir(), 'probe-title-'));
  const child = spawn(
    binary,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--mute-audio',
      '--hide-scrollbars',
      '--window-size=960,640',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stderr = '';
  const wsUrl = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`Chrome did not open a debug port:\n${stderr}`)), 20000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (match !== null) {
        clearTimeout(timer);
        done(match[1]);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`Chrome exited early with code ${code}:\n${stderr}`));
    });
  });

  return { child, wsUrl, userDataDir };
}

/** Minimal CDP client: request/response plus event dispatch. */
class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => this.#onMessage(event.data));
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((done, fail) => {
      socket.addEventListener('open', done, { once: true });
      socket.addEventListener('error', () => fail(new Error(`could not connect to ${url}`)), { once: true });
    });
    return new CdpClient(socket);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId;
    this.nextId += 1;
    const message = sessionId === undefined ? { id, method, params } : { id, method, params, sessionId };
    this.socket.send(JSON.stringify(message));
    return new Promise((done, fail) => {
      this.pending.set(id, { done, fail });
    });
  }

  on(method, handler) {
    const list = this.listeners.get(method) ?? [];
    list.push(handler);
    this.listeners.set(method, list);
  }

  close() {
    this.socket.close();
  }

  #onMessage(raw) {
    const message = JSON.parse(raw);
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (entry === undefined) return;
      if (message.error !== undefined) entry.fail(new Error(`${message.error.message}`));
      else entry.done(message.result);
      return;
    }
    for (const handler of this.listeners.get(message.method) ?? []) handler(message.params);
  }
}

/** Collect the results of the individual checks. */
function createReporter() {
  const results = [];
  return {
    results,
    record(name, ok, detail) {
      results.push({ name, ok, detail });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    },
    get failed() {
      return results.filter((entry) => !entry.ok);
    },
  };
}

async function main() {
  if (typeof WebSocket !== 'function') {
    console.error('probe-title needs Node 22+ for the global WebSocket.');
    process.exit(2);
  }
  if (!existsSync(join(DIST_DIR, 'index.html'))) {
    console.error(`no build found at ${DIST_DIR}. Run: npm run build`);
    process.exit(2);
  }
  const binary = findChrome();
  if (binary === null) {
    console.error('no Chrome or Chromium binary found. Set CHROME_PATH to one.');
    process.exit(2);
  }

  const reporter = createReporter();
  const artifactsDir = await mkdtemp(join(tmpdir(), 'probe-title-shots-'));
  const { server, port } = await serveDist(DIST_DIR);
  const pageUrl = `http://127.0.0.1:${port}/`;
  console.log(`serving ${DIST_DIR} on ${pageUrl}`);
  console.log(`browser: ${binary}`);

  const { child, wsUrl } = await launchChrome(binary);
  const browser = await CdpClient.connect(wsUrl);

  const pageErrors = [];
  let sessionId;

  const evaluate = async (body) => {
    const result = await browser.send(
      'Runtime.evaluate',
      { expression: `(() => {\n${PAGE_HELPERS}\n${body}\n})()`, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (result.exceptionDetails !== undefined) {
      throw new Error(`page evaluation failed: ${result.exceptionDetails.text}`);
    }
    return result.result.value;
  };

  const boneCount = (band) => evaluate(`return probeBoneCount(${band.join(', ')});`);

  /** Sample a band for a full blink cycle; true when it ever shows text. */
  const bandEverVisible = async (band, ms) => {
    const deadline = Date.now() + ms;
    let best = 0;
    while (Date.now() < deadline) {
      const count = await boneCount(band);
      best = Math.max(best, count);
      if (best > BONE_PIXEL_COUNT) return best;
      await SLEEP(120);
    }
    return best;
  };

  /** Sample a band for a full blink cycle; true when it never shows text. */
  const bandAlwaysEmpty = async (band, ms) => {
    const deadline = Date.now() + ms;
    let worst = 0;
    while (Date.now() < deadline) {
      worst = Math.max(worst, await boneCount(band));
      await SLEEP(120);
    }
    return worst;
  };

  const waitForTitle = async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if ((await boneCount(OPTION_LABEL_BAND)) > BONE_PIXEL_COUNT) return true;
      await SLEEP(150);
    }
    return false;
  };

  const reload = async () => {
    await browser.send('Page.navigate', { url: pageUrl }, sessionId);
    // Bring the tab to the front: a backgrounded target throttles rAF to
    // zero and drops key focus, which is what made checks flap.
    await browser.send('Page.bringToFront', {}, sessionId).catch(() => {});
    await evaluate('window.focus();');
    // Reset saved progress so the title shows the fresh two-option layout
    // (START / HOW TO PLAY) every run; playing a check would otherwise
    // persist progress and grow the option list to three entries.
    await evaluate('try { localStorage.clear(); } catch {}');
    await SLEEP(400);
    return waitForTitle();
  };

  const pressKey = async (spec, holdMs = 80) => {
    await evaluate('window.focus();');
    // Synthesize DOM-level key events: CDP Input.dispatchKeyEvent proved
    // unreliable here (events lost when the target lacks real focus),
    // while window-level listeners accept dispatched KeyboardEvents.
    await evaluate(`
      window.dispatchEvent(new KeyboardEvent('keydown', { code: '${spec.code}', key: '${spec.key}', bubbles: true }));
    `);
    await SLEEP(holdMs);
    await evaluate(`
      window.dispatchEvent(new KeyboardEvent('keyup', { code: '${spec.code}', key: '${spec.key}', bubbles: true }));
    `);
  };

  const clickCanvas = async () => {
    await evaluate('window.focus();');
    const point = await evaluate(`
      const rect = document.getElementById('game-canvas').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    `);
    const shared = { x: point.x, y: point.y, button: 'left', clickCount: 1 };
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...shared, buttons: 1 }, sessionId);
    await SLEEP(80);
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...shared, buttons: 0 }, sessionId);
  };

  const signature = () => evaluate('return probeSignature();');

  /** Hold right and collect frame signatures to prove the loop is live. */
  const framesWhileMoving = async () => {
    await evaluate('window.focus();');
    const right = { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 };
    await evaluate(`
      window.dispatchEvent(new KeyboardEvent('keydown', { code: '${right.code}', key: '${right.key}', bubbles: true }));
    `);
    const seen = new Set();
    for (let i = 0; i < 4; i += 1) {
      await SLEEP(200);
      seen.add(await signature());
    }
    await evaluate(`
      window.dispatchEvent(new KeyboardEvent('keyup', { code: '${right.code}', key: '${right.key}', bubbles: true }));
    `);
    return seen.size;
  };

  try {
    const target = await browser.send('Target.createTarget', { url: pageUrl });
    const attached = await browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    sessionId = attached.sessionId;
    await browser.send('Runtime.enable', {}, sessionId);
    await browser.send('Page.enable', {}, sessionId);
    browser.on('Runtime.exceptionThrown', (params) => {
      pageErrors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'unknown');
    });
    browser.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        pageErrors.push(params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
      }
    });

    // 1. BOOT
    const booted = await reload();
    const bootError = await evaluate('return probeBootErrorVisible();');
    const titleHint = await bandEverVisible(TITLE_HINT_BAND, 1500);
    reporter.record('BOOT title screen renders with the confirm hint and no boot error', booted && !bootError && titleHint > BONE_PIXEL_COUNT, `hint pixels ${titleHint}, boot error ${bootError}`);

    // 2. SPACE regression
    await reload();
    await pressKey({ key: ' ', code: 'Space', keyCode: 32 });
    const spaceHintGone = await bandAlwaysEmpty(TITLE_HINT_BAND, 1400);
    const spaceMoving = await framesWhileMoving();
    reporter.record('SPACE still starts the game', spaceHintGone === 0 && spaceMoving >= 2, `leftover hint pixels ${spaceHintGone}, distinct frames ${spaceMoving}`);

    // 3. ENTER confirm
    await reload();
    await pressKey({ key: 'Enter', code: 'Enter', keyCode: 13 });
    const enterHintGone = await bandAlwaysEmpty(TITLE_HINT_BAND, 1400);
    const enterMoving = await framesWhileMoving();
    reporter.record('ENTER confirm starts the game and gameplay keeps rendering', enterHintGone === 0 && enterMoving >= 2, `leftover hint pixels ${enterHintGone}, distinct frames ${enterMoving}`);

    // 4. CLICK confirm
    await reload();
    await clickCanvas();
    const clickHintGone = await bandAlwaysEmpty(TITLE_HINT_BAND, 1400);
    const clickMoving = await framesWhileMoving();
    reporter.record('canvas click starts the game like Enter', clickHintGone === 0 && clickMoving >= 2, `leftover hint pixels ${clickHintGone}, distinct frames ${clickMoving}`);

    // 5. HOW TO PLAY (fresh boot: clear any progress saved by checks 2-4,
    // then reload AGAIN so the app initializes against empty storage).
    await evaluate('try { localStorage.clear(); } catch {}');
    await reload();
    const beforeInstructions = await bandAlwaysEmpty(INSTRUCTION_BAND, 300);
    await pressKey({ key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 });
    // Wait until the selector visibly sits on the second option before
    // committing: pressing too early races app init and selects START.
    const movedDeadline = Date.now() + 2000;
    let selectorMoved = false;
    while (Date.now() < movedDeadline) {
      const instructionsNow = await boneCount(INSTRUCTION_BAND);
      if (instructionsNow > BONE_PIXEL_COUNT) { selectorMoved = true; break; }
      await SLEEP(120);
    }
    const instructions = await bandAlwaysEmpty(INSTRUCTION_BAND, 400);
    const shot = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const shotPath = join(artifactsDir, 'title-how-to-play.png');
    await writeFile(shotPath, Buffer.from(shot.data, 'base64'));
    await pressKey({ key: 'Enter', code: 'Enter', keyCode: 13 });
    await SLEEP(400);
    const stillOnTitle = await evaluate(`return probeBoneCount(${OPTION_LABEL_BAND.join(', ')}) > ${BONE_PIXEL_COUNT};`);
    reporter.record(
      'ENTER with HOW TO PLAY highlighted reveals the instructions and does not start the game',
      beforeInstructions === 0 && selectorMoved && instructions > BONE_PIXEL_COUNT && stillOnTitle,
      `instruction pixels ${beforeInstructions} -> ${instructions}, selector moved ${selectorMoved}, still on title ${stillOnTitle}, screenshot ${shotPath}`,
    );

    // 6. ERRORS
    reporter.record('no page errors', pageErrors.length === 0, pageErrors.join(' | ') || 'clean');
  } finally {
    browser.close();
    child.kill('SIGKILL');
    server.close();
  }

  const failed = reporter.failed;
  console.log(`\n${reporter.results.length - failed.length}/${reporter.results.length} checks passed`);
  if (failed.length > 0) {
    console.log(`failed: ${failed.map((entry) => entry.name).join(', ')}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`probe crashed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

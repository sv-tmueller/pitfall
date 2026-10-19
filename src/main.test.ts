// @vitest-environment jsdom
//
// Boot-path smoke test for src/main.ts. This file opts into the jsdom
// environment per file with the pragma above; vite.config.ts keeps 'node' as
// the global default. main.ts has top-level side effects, so every case
// re-imports it after vi.resetModules().

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from './game/app';

const FAKE_2D = {} as unknown as CanvasRenderingContext2D;
const originalGetContext = HTMLCanvasElement.prototype.getContext;

function bootContainer(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#boot-error');
}

beforeEach(() => {
  document.body.innerHTML =
    '<canvas id="game-canvas"></canvas><div id="boot-error" hidden></div>';
  // PITFALL: jsdom returns null from getContext('2d') without the canvas
  // package, which would divert boot into the '2d context unavailable' branch
  // before fetch is ever consulted. Stub the prototype before importing
  // main.ts so the atlas request path is the one under test.
  HTMLCanvasElement.prototype.getContext =
    (() => FAKE_2D) as unknown as typeof originalGetContext;
  // Boot stays in flight by default: cases that only exercise a seam should
  // not pick up a stray asynchronous boot error.
  vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})));
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('boot path', () => {
  it('reports a failed atlas request into the DOM fallback', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response),
    );

    vi.resetModules();
    await import('./main');

    await vi.waitFor(() => {
      expect(bootContainer()?.hidden).toBe(false);
    });
    expect(bootContainer()?.textContent).toContain('atlas request failed with status 404');
    expect(consoleError).toHaveBeenCalled();
  });
});

describe('showBootError', () => {
  it('formats the message, unhides the container, and logs it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
    const { showBootError } = await import('./main');
    const container = bootContainer();
    expect(container).not.toBeNull();

    showBootError(new Error('atlas request failed with status 500'));

    expect(container?.textContent).toBe(
      'Pitfall could not start. atlas request failed with status 500',
    );
    expect(container?.hidden).toBe(false);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      'Pitfall could not start. atlas request failed with status 500',
      expect.any(Error),
    );
  });

  it('does not throw when the container is absent', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    document.body.innerHTML = '<canvas id="game-canvas"></canvas>';
    vi.resetModules();
    const { showBootError } = await import('./main');

    expect(() => showBootError(new Error('container gone'))).not.toThrow();
    expect(bootContainer()).toBeNull();
    expect(consoleError).toHaveBeenCalledWith(
      'Pitfall could not start. container gone',
      expect.any(Error),
    );
  });
});

describe('wireFocusPolicy', () => {
  interface Recorded {
    blurs: number;
    visibility: boolean[];
  }

  function fakeApp(): { app: App; record: Recorded } {
    const record: Recorded = { blurs: 0, visibility: [] };
    const app = {
      handleBlur: () => {
        record.blurs += 1;
      },
      handleVisibilityChange: (hidden: boolean) => {
        record.visibility.push(hidden);
      },
    } as unknown as App;
    return { app, record };
  }

  it('routes window blur and document visibility changes to the app', async () => {
    vi.resetModules();
    const { wireFocusPolicy } = await import('./main');
    const { app, record } = fakeApp();

    wireFocusPolicy(window, document, app);
    window.dispatchEvent(new Event('blur'));
    document.dispatchEvent(new Event('visibilitychange'));

    expect(record.blurs).toBe(1);
    expect(record.visibility).toEqual([document.hidden]);
  });

  it('registers one listener per call, so bootstrap must call it once', async () => {
    vi.resetModules();
    const { wireFocusPolicy } = await import('./main');
    const { app, record } = fakeApp();

    wireFocusPolicy(window, document, app);
    window.dispatchEvent(new Event('blur'));
    expect(record.blurs).toBe(1);

    // The seam does not dedupe: a second registration doubles delivery, so
    // bootstrap calls it exactly once per app.
    wireFocusPolicy(window, document, app);
    window.dispatchEvent(new Event('blur'));
    expect(record.blurs).toBe(3);
  });
});

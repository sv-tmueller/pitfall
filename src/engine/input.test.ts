import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BINDINGS,
  attachClickConfirm,
  attachKeyboardInput,
  createKeyboardInput,
  type ConfirmEventSource,
  type ConfirmPointerEventType,
  type InputAction,
  type KeyEventLike,
  type KeyEventSource,
} from './input';

type Listener = (event: KeyEventLike) => void;

function createStubEventSource(): KeyEventSource & {
  emit(type: 'keydown' | 'keyup' | 'blur', event: KeyEventLike): void;
  listenerCount(type: 'keydown' | 'keyup' | 'blur'): number;
} {
  const listeners = new Map<'keydown' | 'keyup' | 'blur', Set<Listener>>([
    ['keydown', new Set()],
    ['keyup', new Set()],
    ['blur', new Set()],
  ]);

  return {
    addEventListener(type, listener) {
      listeners.get(type)?.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type, event) {
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

function keyEvent(code: string, modifiers: Partial<KeyEventLike> = {}): KeyEventLike {
  return {
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...modifiers,
  };
}

describe('createKeyboardInput core edges', () => {
  it('reports pressed for exactly one sample after a key goes down', () => {
    const input = createKeyboardInput();

    input.keyDown('ArrowRight');
    const first = input.sample();
    expect(first.pressed.right).toBe(true);
    expect(first.held.right).toBe(true);

    const second = input.sample();
    expect(second.pressed.right).toBe(false);
    expect(second.held.right).toBe(true);
  });

  it('collapses repeated downs for the same code within one frame into a single pressed edge', () => {
    const input = createKeyboardInput();

    input.keyDown('ArrowRight');
    input.keyDown('ArrowRight');
    input.keyDown('ArrowRight');
    const first = input.sample();
    expect(first.pressed.right).toBe(true);

    const second = input.sample();
    expect(second.pressed.right).toBe(false);
  });

  it('registers both press and release when a key goes down then up between two samples', () => {
    const input = createKeyboardInput();

    input.keyDown('ArrowRight');
    input.keyUp('ArrowRight');
    const snapshot = input.sample();

    expect(snapshot.pressed.right).toBe(true);
    expect(snapshot.released.right).toBe(true);
    expect(snapshot.held.right).toBe(false);
  });

  it('registers both press and release when a key goes up then down between two samples', () => {
    const input = createKeyboardInput();
    input.keyDown('ArrowRight');
    input.sample();

    input.keyUp('ArrowRight');
    input.keyDown('ArrowRight');
    const snapshot = input.sample();

    expect(snapshot.pressed.right).toBe(true);
    expect(snapshot.released.right).toBe(true);
    expect(snapshot.held.right).toBe(true);
  });
});

describe('createKeyboardInput multi-code actions and blur', () => {
  it('keeps held true and fires no extra edges when rolling between two codes bound to one action', () => {
    const input = createKeyboardInput();

    input.keyDown('ArrowLeft');
    input.sample();

    input.keyDown('KeyA');
    input.keyUp('ArrowLeft');
    const rollSnapshot = input.sample();

    expect(rollSnapshot.held.left).toBe(true);
    expect(rollSnapshot.pressed.left).toBe(false);
    expect(rollSnapshot.released.left).toBe(false);

    input.keyUp('KeyA');
    const releaseSnapshot = input.sample();

    expect(releaseSnapshot.held.left).toBe(false);
    expect(releaseSnapshot.released.left).toBe(true);
  });

  it('clears held and emits released for actions that were held on blur', () => {
    const input = createKeyboardInput();
    input.keyDown('ArrowRight');
    input.sample();

    input.blur();
    const snapshot = input.sample();

    expect(snapshot.held.right).toBe(false);
    expect(snapshot.released.right).toBe(true);
  });

  it('still reports pressed for a key that goes down then blurs within one window', () => {
    const input = createKeyboardInput();

    input.keyDown('ArrowRight');
    input.blur();
    const snapshot = input.sample();

    expect(snapshot.pressed.right).toBe(true);
    expect(snapshot.released.right).toBe(true);
    expect(snapshot.held.right).toBe(false);
  });

  it('leaves everything false and isBound false for an unbound code', () => {
    const input = createKeyboardInput();

    input.keyDown('KeyZ');
    const snapshot = input.sample();

    expect(input.isBound('KeyZ')).toBe(false);
    for (const action of [
      'left',
      'right',
      'jump',
      'restart',
      'pause',
      'confirm',
    ] satisfies InputAction[]) {
      expect(snapshot.held[action]).toBe(false);
      expect(snapshot.pressed[action]).toBe(false);
      expect(snapshot.released[action]).toBe(false);
    }
  });

  it('reports every action false before any input is given', () => {
    const input = createKeyboardInput();

    const snapshot = input.sample();

    for (const action of [
      'left',
      'right',
      'jump',
      'restart',
      'pause',
      'confirm',
    ] satisfies InputAction[]) {
      expect(snapshot.held[action]).toBe(false);
      expect(snapshot.pressed[action]).toBe(false);
      expect(snapshot.released[action]).toBe(false);
    }
  });
});

describe('DEFAULT_BINDINGS', () => {
  it('never binds the same code to two different actions', () => {
    const seen = new Map<string, InputAction>();

    for (const [action, codes] of Object.entries(DEFAULT_BINDINGS) as Array<
      [InputAction, readonly string[]]
    >) {
      for (const code of codes) {
        expect(seen.has(code)).toBe(false);
        seen.set(code, action);
      }
    }
  });

  it('covers movement with arrows and WASD, jump with space and up, and restart with R', () => {
    expect(DEFAULT_BINDINGS.left).toEqual(expect.arrayContaining(['ArrowLeft', 'KeyA']));
    expect(DEFAULT_BINDINGS.right).toEqual(expect.arrayContaining(['ArrowRight', 'KeyD']));
    expect(DEFAULT_BINDINGS.jump).toEqual(expect.arrayContaining(['Space', 'ArrowUp']));
    expect(DEFAULT_BINDINGS.restart).toEqual(expect.arrayContaining(['KeyR']));
  });

  it('binds confirm to both Enter keys and leaves jump untouched (AC-1)', () => {
    expect(DEFAULT_BINDINGS.confirm).toEqual(['Enter', 'NumpadEnter']);
    expect(DEFAULT_BINDINGS.jump).not.toContain('Enter');
    expect(DEFAULT_BINDINGS.jump).not.toContain('NumpadEnter');
  });
});

describe('attachKeyboardInput', () => {
  it('prevents default for a bound code and not for an unbound one', () => {
    const input = createKeyboardInput();
    const source = createStubEventSource();
    attachKeyboardInput(input, source);

    const bound = keyEvent('ArrowRight');
    source.emit('keydown', bound);
    expect(bound.preventDefault).toHaveBeenCalledOnce();

    const unbound = keyEvent('KeyZ');
    source.emit('keydown', unbound);
    expect(unbound.preventDefault).not.toHaveBeenCalled();
  });

  it('ignores a keydown carrying a modifier and does not prevent it, but still processes its keyup', () => {
    const input = createKeyboardInput();
    const source = createStubEventSource();
    attachKeyboardInput(input, source);

    const metaDown = keyEvent('KeyR', { metaKey: true });
    source.emit('keydown', metaDown);
    expect(metaDown.preventDefault).not.toHaveBeenCalled();
    expect(input.sample().held.restart).toBe(false);

    source.emit('keydown', keyEvent('KeyR'));
    source.emit('keyup', keyEvent('KeyR', { metaKey: true }));
    const snapshot = input.sample();
    expect(snapshot.pressed.restart).toBe(true);
    expect(snapshot.released.restart).toBe(true);
  });

  it('clears held when the source emits blur', () => {
    const input = createKeyboardInput();
    const source = createStubEventSource();
    attachKeyboardInput(input, source);

    source.emit('keydown', keyEvent('ArrowRight'));
    input.sample();

    source.emit('blur', keyEvent(''));
    const snapshot = input.sample();
    expect(snapshot.held.right).toBe(false);
    expect(snapshot.released.right).toBe(true);
  });

  it('removes all listeners on detach so a later keydown changes nothing', () => {
    const input = createKeyboardInput();
    const source = createStubEventSource();
    const detach = attachKeyboardInput(input, source);

    detach();
    expect(source.listenerCount('keydown')).toBe(0);
    expect(source.listenerCount('keyup')).toBe(0);
    expect(source.listenerCount('blur')).toBe(0);

    source.emit('keydown', keyEvent('ArrowRight'));
    expect(input.sample().held.right).toBe(false);
  });
});

describe('InputSnapshot immutability', () => {
  it('freezes the snapshot and its held, pressed, and released records', () => {
    const input = createKeyboardInput();

    const snapshot = input.sample();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.held)).toBe(true);
    expect(Object.isFrozen(snapshot.pressed)).toBe(true);
    expect(Object.isFrozen(snapshot.released)).toBe(true);
  });

  it('returns a distinct object identity from each sample call', () => {
    const input = createKeyboardInput();

    const first = input.sample();
    const second = input.sample();

    expect(first).not.toBe(second);
    expect(first.held).not.toBe(second.held);
    expect(first.pressed).not.toBe(second.pressed);
    expect(first.released).not.toBe(second.released);
  });
});

function createStubClickSource(): ConfirmEventSource & {
  emit(type: ConfirmPointerEventType): void;
  listenerCount(type: ConfirmPointerEventType): number;
  capturedIds(): number[];
} {
  const listeners = new Map<ConfirmPointerEventType, Set<(event: Event) => void>>([
    ['pointerdown', new Set()],
    ['pointerup', new Set()],
    ['pointercancel', new Set()],
    ['blur', new Set()],
    ['lostpointercapture', new Set()],
  ]);
  const captured: number[] = [];

  return {
    addEventListener(type, listener) {
      listeners.get(type)?.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type) {
      for (const listener of listeners.get(type) ?? []) {
        listener(new Event(type));
      }
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
    capturedIds() {
      return [...captured];
    },
    setPointerCapture(pointerId: number) {
      captured.push(pointerId);
    },
  };
}

describe('confirm action', () => {
  it('reports a pressed edge for Enter and clears it on the next sample', () => {
    const input = createKeyboardInput();

    input.keyDown('Enter');
    const first = input.sample();
    expect(first.pressed.confirm).toBe(true);
    expect(first.held.confirm).toBe(true);

    const second = input.sample();
    expect(second.pressed.confirm).toBe(false);
    expect(second.held.confirm).toBe(true);
  });

  it('reports a pressed edge for NumpadEnter as well', () => {
    const input = createKeyboardInput();

    input.keyDown('NumpadEnter');
    expect(input.sample().pressed.confirm).toBe(true);
  });

  it('leaves the jump action unaffected by Enter', () => {
    const input = createKeyboardInput();

    input.keyDown('Enter');
    const snapshot = input.sample();

    expect(snapshot.held.jump).toBe(false);
    expect(snapshot.pressed.jump).toBe(false);
  });
});

describe('attachClickConfirm', () => {
  it('turns a pointerdown into a confirm edge on the next sample', () => {
    const input = createKeyboardInput();
    const source = createStubClickSource();
    attachClickConfirm(input, source);

    source.emit('pointerdown');
    const snapshot = input.sample();

    expect(snapshot.pressed.confirm).toBe(true);
    expect(snapshot.held.confirm).toBe(true);
  });

  it('releases the confirm action on pointerup', () => {
    const input = createKeyboardInput();
    const source = createStubClickSource();
    attachClickConfirm(input, source);

    source.emit('pointerdown');
    input.sample();
    source.emit('pointerup');
    const snapshot = input.sample();

    expect(snapshot.held.confirm).toBe(false);
    expect(snapshot.released.confirm).toBe(true);
    expect(snapshot.pressed.confirm).toBe(false);
  });

  it('releases a held click when the element blurs', () => {
    const input = createKeyboardInput();
    const source = createStubClickSource();
    attachClickConfirm(input, source);

    source.emit('pointerdown');
    input.sample();
    source.emit('blur');

    expect(input.sample().held.confirm).toBe(false);
  });

  it('releases a held click when the pointer is cancelled mid-press', () => {
    const input = createKeyboardInput();
    const source = createStubClickSource();
    attachClickConfirm(input, source);

    source.emit('pointerdown');
    input.sample();
    source.emit('pointercancel');

    expect(input.sample().held.confirm).toBe(false);
  });

  it('does not swallow the next confirm after a cancelled click', () => {
    const input = createKeyboardInput();
    const source = createStubClickSource();
    attachClickConfirm(input, source);

    // Pointerdown then pointercancel (release lost outside the canvas).
    source.emit('pointerdown');
    source.emit('pointercancel');
    input.sample();

    // The next physical Enter must still register a pressed edge.
    input.keyDown('Enter');
    expect(input.sample().pressed.confirm).toBe(true);
    input.keyUp('Enter');
  });

  it('grabs pointer capture on pointerdown so a mouse release off-canvas still arrives', () => {
    const input = createKeyboardInput();
    const source = createStubClickSource();
    attachClickConfirm(input, source);

    source.emit('pointerdown');
    expect(source.capturedIds()).toHaveLength(1);

    // Capture revoked by the browser: the release must still fire.
    source.emit('lostpointercapture');
    expect(input.sample().held.confirm).toBe(false);
  });

  it('stays clear of every other action', () => {
    const input = createKeyboardInput();
    const source = createStubClickSource();
    attachClickConfirm(input, source);

    source.emit('pointerdown');
    const snapshot = input.sample();

    for (const action of [
      'left',
      'right',
      'jump',
      'restart',
      'pause',
    ] satisfies InputAction[]) {
      expect(snapshot.pressed[action]).toBe(false);
      expect(snapshot.held[action]).toBe(false);
    }
  });

  it('removes all listeners on detach so a later click changes nothing', () => {
    const input = createKeyboardInput();
    const source = createStubClickSource();
    const detach = attachClickConfirm(input, source);

    detach();
    expect(source.listenerCount('pointerdown')).toBe(0);
    expect(source.listenerCount('pointerup')).toBe(0);
    expect(source.listenerCount('blur')).toBe(0);

    source.emit('pointerdown');
    expect(input.sample().held.confirm).toBe(false);
  });
});

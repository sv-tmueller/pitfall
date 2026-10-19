export type InputAction = 'left' | 'right' | 'jump' | 'restart' | 'pause' | 'confirm';

const ACTIONS: readonly InputAction[] = ['left', 'right', 'jump', 'restart', 'pause', 'confirm'];

export interface InputSnapshot {
  readonly held: Readonly<Record<InputAction, boolean>>;
  readonly pressed: Readonly<Record<InputAction, boolean>>;
  readonly released: Readonly<Record<InputAction, boolean>>;
}

export type KeyBindings = Readonly<Record<InputAction, readonly string[]>>;

export const DEFAULT_BINDINGS: KeyBindings = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  jump: ['Space', 'ArrowUp'],
  restart: ['KeyR'],
  pause: ['KeyP', 'Escape'],
  confirm: ['Enter', 'NumpadEnter'],
};

/**
 * Code the pointer bridge presses. It is the first entry of the default
 * confirm binding, so a click arrives at the same action as a keyboard
 * confirm. Kept here rather than read off {@link DEFAULT_BINDINGS} because
 * {@link attachClickConfirm} receives an input, not its binding table.
 */
const CONFIRM_POINTER_CODE = 'Enter';

export interface KeyboardInput {
  keyDown(code: string): void;
  keyUp(code: string): void;
  blur(): void;
  isBound(code: string): boolean;
  sample(): InputSnapshot;
}

function emptyRecord(): Record<InputAction, boolean> {
  const record = {} as Record<InputAction, boolean>;
  for (const action of ACTIONS) {
    record[action] = false;
  }
  return record;
}

export function createKeyboardInput(bindings: KeyBindings = DEFAULT_BINDINGS): KeyboardInput {
  const codeToAction = new Map<string, InputAction>();
  for (const action of ACTIONS) {
    for (const code of bindings[action]) {
      codeToAction.set(code, action);
    }
  }

  const downCodes = new Set<string>();
  const held = emptyRecord();
  const pressed = emptyRecord();
  const released = emptyRecord();

  function isActionHeld(action: InputAction): boolean {
    for (const code of bindings[action]) {
      if (downCodes.has(code)) {
        return true;
      }
    }
    return false;
  }

  function recomputeHeld(action: InputAction): void {
    const next = isActionHeld(action);
    if (next === held[action]) {
      return;
    }
    held[action] = next;
    if (next) {
      pressed[action] = true;
    } else {
      released[action] = true;
    }
  }

  function setCode(code: string, isDown: boolean): void {
    const action = codeToAction.get(code);
    if (action === undefined) {
      return;
    }
    if (isDown) {
      downCodes.add(code);
    } else {
      downCodes.delete(code);
    }
    recomputeHeld(action);
  }

  return {
    keyDown(code: string): void {
      setCode(code, true);
    },
    keyUp(code: string): void {
      setCode(code, false);
    },
    blur(): void {
      for (const code of [...downCodes]) {
        setCode(code, false);
      }
    },
    isBound(code: string): boolean {
      return codeToAction.has(code);
    },
    // Call once per simulation step, never once per substep: with the max
    // 5 substeps clamp, a catch-up burst would otherwise consume each edge
    // on its first substep and starve the later substeps of it.
    sample(): InputSnapshot {
      const snapshot: InputSnapshot = Object.freeze({
        held: Object.freeze({ ...held }),
        pressed: Object.freeze({ ...pressed }),
        released: Object.freeze({ ...released }),
      });
      for (const action of ACTIONS) {
        pressed[action] = false;
        released[action] = false;
      }
      return snapshot;
    },
  };
}

export interface KeyEventLike {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  preventDefault(): void;
}

export interface KeyEventSource {
  addEventListener(
    type: 'keydown' | 'keyup' | 'blur',
    listener: (event: KeyEventLike) => void,
  ): void;
  removeEventListener(
    type: 'keydown' | 'keyup' | 'blur',
    listener: (event: KeyEventLike) => void,
  ): void;
}

export function attachKeyboardInput(input: KeyboardInput, source: KeyEventSource): () => void {
  function onKeyDown(event: KeyEventLike): void {
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    if (input.isBound(event.code)) {
      event.preventDefault();
    }
    input.keyDown(event.code);
  }

  function onKeyUp(event: KeyEventLike): void {
    if (input.isBound(event.code)) {
      event.preventDefault();
    }
    input.keyUp(event.code);
  }

  function onBlur(): void {
    input.blur();
  }

  source.addEventListener('keydown', onKeyDown);
  source.addEventListener('keyup', onKeyUp);
  source.addEventListener('blur', onBlur);

  return function detach(): void {
    source.removeEventListener('keydown', onKeyDown);
    source.removeEventListener('keyup', onKeyUp);
    source.removeEventListener('blur', onBlur);
  };
}

// Compile-time proof that attachKeyboardInput(input, window) needs no cast:
// window satisfies KeyEventSource without any runtime code here.
type AssertAssignable<T extends U, U> = T;
export type WindowIsAKeyEventSource = AssertAssignable<Window & typeof globalThis, KeyEventSource>;

export type ConfirmPointerEventType =
  | 'pointerdown'
  | 'pointerup'
  | 'pointercancel'
  | 'blur'
  | 'lostpointercapture';

export interface ConfirmEventSource {
  addEventListener(type: ConfirmPointerEventType, listener: (event: Event) => void): void;
  removeEventListener(type: ConfirmPointerEventType, listener: (event: Event) => void): void;
  /**
   * Routes the eventual pointerup to this element even when the pointer
   * travels off it (mouse released in the letterbox margin, pen lifted
   * outside the canvas). Absent for the window-level test stub.
   */
  setPointerCapture?(pointerId: number): void;
}

/**
 * Bridge a pointer press on `element` into the confirm action.
 *
 * pointerdown presses the confirm code and pointerup (or blur) releases it,
 * so the click surfaces as a `pressed.confirm` edge in the NEXT
 * {@link KeyboardInput.sample} instead of acting immediately. That keeps the
 * polled path identical to the keyboard: the edge is consumed by the shell's
 * once-per-step sample and drained on the transition frame, exactly like a
 * key press. The bridge therefore never calls sample() itself.
 *
 * Release safety: a press abandoned mid-click must not strand the confirm
 * code held, or the next real confirm is swallowed by the still-asserted
 * key. Mouse pointers released outside the canvas deliver NEITHER pointerup
 * NOR pointercancel (there is no implicit capture for mouse), so pointerdown
 * grabs pointer capture when available; pointercancel and
 * lostpointercapture cover touch/pen interruption and browsers revoking the
 * grab. Together every abandonment path reaches a release.
 */
export function attachClickConfirm(input: KeyboardInput, element: ConfirmEventSource): () => void {
  function onPointerDown(event: Event): void {
    const pointerId = (event as PointerEvent).pointerId;
    element.setPointerCapture?.(pointerId);
    input.keyDown(CONFIRM_POINTER_CODE);
  }

  function onPointerUp(): void {
    input.keyUp(CONFIRM_POINTER_CODE);
  }

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointerup', onPointerUp);
  element.addEventListener('pointercancel', onPointerUp);
  element.addEventListener('lostpointercapture', onPointerUp);
  element.addEventListener('blur', onPointerUp);

  return function detach(): void {
    element.removeEventListener('pointerdown', onPointerDown);
    element.removeEventListener('pointerup', onPointerUp);
    element.removeEventListener('pointercancel', onPointerUp);
    element.removeEventListener('lostpointercapture', onPointerUp);
    element.removeEventListener('blur', onPointerUp);
  };
}

// Compile-time proof that attachClickConfirm(input, canvas) needs no cast:
// HTMLCanvasElement satisfies ConfirmEventSource without any runtime code here.
export type CanvasIsAConfirmEventSource = AssertAssignable<HTMLCanvasElement, ConfirmEventSource>;

import type { FlightInputState } from './FlightController';
import { ZERO_INPUT } from './FlightController';

export interface FlightInput {
  attach(): void;
  detach(): void;
  poll(): FlightInputState;
}

const MOUSE_LOOK_SENSITIVITY = 0.003;
const TOUCH_LOOK_SENSITIVITY = 0.05;
const TOUCH_STICK_RADIUS = 60;

export class KeyboardMouseInput implements FlightInput {
  private keys = new Set<string>();
  private mouseDX = 0;
  private mouseDY = 0;
  private dragging = false;
  private readonly canvas: HTMLElement;

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;
  }

  attach(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('blur', this.onBlur);
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('blur', this.onBlur);
    this.keys.clear();
    this.dragging = false;
    this.mouseDX = 0;
    this.mouseDY = 0;
  }

  poll(): FlightInputState {
    const k = this.keys;
    const state: FlightInputState = {
      thrustForward: (k.has('w') ? 1 : 0) - (k.has('s') ? 1 : 0),
      thrustRight: (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0),
      thrustRadial: (k.has('r') ? 1 : 0) - (k.has('f') ? 1 : 0),
      lookYaw: this.mouseDX * MOUSE_LOOK_SENSITIVITY,
      lookPitch: -this.mouseDY * MOUSE_LOOK_SENSITIVITY,
      boost: k.has('shift'),
      brake: k.has(' '),
    };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return state;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    this.keys.add(e.key.toLowerCase());
    if (['w', 'a', 's', 'd', 'r', 'f', ' '].includes(e.key.toLowerCase())) e.preventDefault();
  };
  private onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.key.toLowerCase()); };
  private onMouseDown = (e: MouseEvent) => { if (e.button === 0) this.dragging = true; };
  private onMouseUp = () => { this.dragging = false; };
  private onMouseMove = (e: MouseEvent) => {
    if (!this.dragging) return;
    this.mouseDX += e.movementX;
    this.mouseDY += e.movementY;
  };
  private onBlur = () => { this.keys.clear(); this.dragging = false; };
}

interface TouchStick {
  identifier: number;
  originX: number;
  originY: number;
  dx: number;
  dy: number;
  base: HTMLElement;
  knob: HTMLElement;
}

export class TouchInput implements FlightInput {
  private parent: HTMLElement;
  private container!: HTMLElement;
  private leftStick: TouchStick | null = null;
  private rightStick: TouchStick | null = null;
  private leftBase!: HTMLElement;
  private leftKnob!: HTMLElement;
  private rightBase!: HTMLElement;
  private rightKnob!: HTMLElement;
  private btnUp!: HTMLElement;
  private btnDown!: HTMLElement;
  private btnBoost!: HTMLElement;
  private btnBrake!: HTMLElement;
  private radialUp = false;
  private radialDown = false;
  private boostHeld = false;
  private brakeHeld = false;

  constructor(parent: HTMLElement) {
    this.parent = parent;
  }

  attach(): void {
    this.buildDOM();
    window.addEventListener('touchstart', this.onTouchStart, { passive: false });
    window.addEventListener('touchmove', this.onTouchMove, { passive: false });
    window.addEventListener('touchend', this.onTouchEnd);
    window.addEventListener('touchcancel', this.onTouchEnd);
  }

  detach(): void {
    window.removeEventListener('touchstart', this.onTouchStart);
    window.removeEventListener('touchmove', this.onTouchMove);
    window.removeEventListener('touchend', this.onTouchEnd);
    window.removeEventListener('touchcancel', this.onTouchEnd);
    if (this.container.parentElement) this.container.parentElement.removeChild(this.container);
    this.leftStick = null;
    this.rightStick = null;
    this.radialUp = false;
    this.radialDown = false;
    this.boostHeld = false;
    this.brakeHeld = false;
  }

  poll(): FlightInputState {
    const ly = this.leftStick ? this.leftStick.dy / TOUCH_STICK_RADIUS : 0;
    const lx = this.leftStick ? this.leftStick.dx / TOUCH_STICK_RADIUS : 0;
    const rx = this.rightStick ? this.rightStick.dx / TOUCH_STICK_RADIUS : 0;
    const ry = this.rightStick ? this.rightStick.dy / TOUCH_STICK_RADIUS : 0;
    return {
      thrustForward: clamp(-ly, -1, 1),
      thrustRight: clamp(lx, -1, 1),
      thrustRadial: (this.radialUp ? 1 : 0) - (this.radialDown ? 1 : 0),
      lookYaw: clamp(rx, -1, 1) * TOUCH_LOOK_SENSITIVITY,
      lookPitch: clamp(-ry, -1, 1) * TOUCH_LOOK_SENSITIVITY,
      boost: this.boostHeld,
      brake: this.brakeHeld,
    };
  }

  private buildDOM(): void {
    const c = document.createElement('div');
    c.id = 'moonflight-touch';
    c.style.cssText = [
      'position:fixed',
      'inset:0',
      'pointer-events:none',
      'z-index:9',
      'touch-action:none',
      'user-select:none',
      '-webkit-user-select:none',
    ].join(';');

    this.leftBase = makeStickBase('left:24px;bottom:24px');
    this.leftKnob = makeStickKnob();
    this.leftBase.appendChild(this.leftKnob);
    c.appendChild(this.leftBase);

    this.rightBase = makeStickBase('right:24px;bottom:24px');
    this.rightKnob = makeStickKnob();
    this.rightBase.appendChild(this.rightKnob);
    c.appendChild(this.rightBase);

    this.btnUp = makeButton('UP', 'left:50%;bottom:140px;transform:translateX(-100%) translateX(-8px)');
    this.btnDown = makeButton('DN', 'left:50%;bottom:140px;transform:translateX(8px)');
    this.btnBoost = makeButton('BOOST', 'left:50%;bottom:80px;transform:translateX(-100%) translateX(-8px);min-width:70px');
    this.btnBrake = makeButton('BRAKE', 'left:50%;bottom:80px;transform:translateX(8px);min-width:70px');
    c.appendChild(this.btnUp);
    c.appendChild(this.btnDown);
    c.appendChild(this.btnBoost);
    c.appendChild(this.btnBrake);

    this.bindHold(this.btnUp, (v) => { this.radialUp = v; });
    this.bindHold(this.btnDown, (v) => { this.radialDown = v; });
    this.bindHold(this.btnBoost, (v) => { this.boostHeld = v; });
    this.bindHold(this.btnBrake, (v) => { this.brakeHeld = v; });

    this.parent.appendChild(c);
    this.container = c;
  }

  private bindHold(el: HTMLElement, set: (v: boolean) => void): void {
    const down = (e: Event) => { e.preventDefault(); set(true); el.style.background = 'rgba(120,180,255,0.45)'; };
    const up = () => { set(false); el.style.background = 'rgba(20,20,30,0.55)'; };
    el.addEventListener('touchstart', down, { passive: false });
    el.addEventListener('touchend', up);
    el.addEventListener('touchcancel', up);
    el.addEventListener('mousedown', down);
    el.addEventListener('mouseup', up);
    el.addEventListener('mouseleave', up);
  }

  private onTouchStart = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      const target = t.target as HTMLElement | null;
      if (target && (target.closest('#moonflight-ui') || target.closest('button'))) continue;
      const isLeft = t.clientX < window.innerWidth / 2;
      if (isLeft && !this.leftStick) {
        this.leftStick = this.startStick(t, this.leftBase, this.leftKnob);
        e.preventDefault();
      } else if (!isLeft && !this.rightStick) {
        this.rightStick = this.startStick(t, this.rightBase, this.rightKnob);
        e.preventDefault();
      }
    }
  };

  private onTouchMove = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      this.updateStick(t, this.leftStick);
      this.updateStick(t, this.rightStick);
    }
  };

  private onTouchEnd = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (this.leftStick && t.identifier === this.leftStick.identifier) {
        this.endStick(this.leftStick);
        this.leftStick = null;
      }
      if (this.rightStick && t.identifier === this.rightStick.identifier) {
        this.endStick(this.rightStick);
        this.rightStick = null;
      }
    }
  };

  private startStick(t: Touch, base: HTMLElement, knob: HTMLElement): TouchStick {
    base.style.left = `${t.clientX - 50}px`;
    base.style.right = '';
    base.style.bottom = '';
    base.style.top = `${t.clientY - 50}px`;
    base.style.opacity = '0.85';
    knob.style.transform = 'translate(-50%, -50%)';
    return { identifier: t.identifier, originX: t.clientX, originY: t.clientY, dx: 0, dy: 0, base, knob };
  }

  private updateStick(t: Touch, s: TouchStick | null): void {
    if (!s || t.identifier !== s.identifier) return;
    let dx = t.clientX - s.originX;
    let dy = t.clientY - s.originY;
    const mag = Math.hypot(dx, dy);
    if (mag > TOUCH_STICK_RADIUS) {
      dx *= TOUCH_STICK_RADIUS / mag;
      dy *= TOUCH_STICK_RADIUS / mag;
    }
    s.dx = dx;
    s.dy = dy;
    s.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }

  private endStick(s: TouchStick): void {
    s.base.style.opacity = '0.5';
    s.knob.style.transform = 'translate(-50%, -50%)';
    s.dx = 0;
    s.dy = 0;
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function makeStickBase(positionCss: string): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed',
    positionCss,
    'width:100px',
    'height:100px',
    'border-radius:50%',
    'background:rgba(20,20,30,0.45)',
    'border:1.5px solid rgba(255,255,255,0.18)',
    'opacity:0.5',
    'pointer-events:none',
    'backdrop-filter:blur(6px)',
    'transition:opacity 0.15s',
  ].join(';');
  return el;
}

function makeStickKnob(): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:absolute',
    'left:50%',
    'top:50%',
    'transform:translate(-50%, -50%)',
    'width:44px',
    'height:44px',
    'border-radius:50%',
    'background:rgba(180,200,255,0.55)',
    'border:1.5px solid rgba(255,255,255,0.4)',
  ].join(';');
  return el;
}

function makeButton(label: string, positionCss: string): HTMLElement {
  const el = document.createElement('button');
  el.textContent = label;
  el.style.cssText = [
    'position:fixed',
    positionCss,
    'min-width:48px',
    'height:44px',
    'padding:0 12px',
    'background:rgba(20,20,30,0.55)',
    'backdrop-filter:blur(8px)',
    'color:#e8e8ea',
    'border:1px solid rgba(255,255,255,0.18)',
    'border-radius:10px',
    'font:600 12px/1 system-ui,sans-serif',
    'letter-spacing:0.6px',
    'pointer-events:auto',
    'touch-action:none',
    'user-select:none',
    '-webkit-user-select:none',
    '-webkit-tap-highlight-color:transparent',
  ].join(';');
  return el;
}

export class CombinedInput implements FlightInput {
  constructor(private inputs: FlightInput[]) {}
  attach(): void { for (const i of this.inputs) i.attach(); }
  detach(): void { for (const i of this.inputs) i.detach(); }
  poll(): FlightInputState {
    const acc = { ...ZERO_INPUT };
    for (const i of this.inputs) {
      const s = i.poll();
      acc.thrustForward += s.thrustForward;
      acc.thrustRight += s.thrustRight;
      acc.thrustRadial += s.thrustRadial;
      acc.lookYaw += s.lookYaw;
      acc.lookPitch += s.lookPitch;
      acc.boost = acc.boost || s.boost;
      acc.brake = acc.brake || s.brake;
    }
    acc.thrustForward = clamp(acc.thrustForward, -1, 1);
    acc.thrustRight = clamp(acc.thrustRight, -1, 1);
    acc.thrustRadial = clamp(acc.thrustRadial, -1, 1);
    return acc;
  }
}

/**
 * Moon Flight HUD: altitude, velocity, attitude, and fuel readouts plus
 * landing/crash end-screen. Pure DOM consumer of FlightState; owns its own
 * container and styling.
 */
import type { FlightState } from './FlightController';

export class FlightHUD {
  private container: HTMLElement | null = null;
  private altEl!: HTMLElement;
  private velEl!: HTMLElement;
  private boostEl!: HTMLElement;
  private reticle!: HTMLElement;
  private parent: HTMLElement;

  constructor(parent: HTMLElement) {
    this.parent = parent;
  }

  attach(): void {
    if (this.container) return;
    const c = document.createElement('div');
    c.id = 'moonflight-hud';
    c.style.cssText = [
      'position:fixed',
      'inset:0',
      'pointer-events:none',
      'z-index:8',
      'font:500 11px/1.3 system-ui,sans-serif',
      'color:#e8e8ea',
      'letter-spacing:0.6px',
    ].join(';');

    const readout = document.createElement('div');
    readout.style.cssText = [
      'position:absolute',
      'top:16px',
      'left:16px',
      'padding:10px 14px',
      'background:rgba(20,20,30,0.55)',
      'backdrop-filter:blur(8px)',
      'border:1px solid rgba(255,255,255,0.15)',
      'border-radius:10px',
      'min-width:140px',
    ].join(';');
    this.altEl = makeRow('ALT', '— km');
    this.velEl = makeRow('VEL', '— m/s');
    readout.appendChild(this.altEl);
    readout.appendChild(this.velEl);
    c.appendChild(readout);

    this.boostEl = document.createElement('div');
    this.boostEl.textContent = 'BOOST';
    this.boostEl.style.cssText = [
      'position:absolute',
      'top:16px',
      'right:124px',
      'padding:6px 10px',
      'background:rgba(120,180,255,0.85)',
      'color:#001428',
      'font:700 11px/1 system-ui,sans-serif',
      'letter-spacing:1px',
      'border-radius:8px',
      'opacity:0',
      'transition:opacity 0.12s',
    ].join(';');
    c.appendChild(this.boostEl);

    this.reticle = document.createElement('div');
    this.reticle.style.cssText = [
      'position:absolute',
      'top:50%',
      'left:50%',
      'width:3px',
      'height:3px',
      'border-radius:50%',
      'background:rgba(255,255,255,0.55)',
      'transform:translate(-50%, -50%)',
    ].join(';');
    c.appendChild(this.reticle);

    this.parent.appendChild(c);
    this.container = c;
  }

  detach(): void {
    if (this.container?.parentElement) this.container.parentElement.removeChild(this.container);
    this.container = null;
  }

  update(state: FlightState): void {
    if (!this.container) return;
    setRowValue(this.altEl, formatAltitude(state.altitudeKm));
    setRowValue(this.velEl, formatSpeed(state.speedKmS));
    this.boostEl.style.opacity = state.boost ? '1' : '0';
  }
}

function makeRow(label: string, value: string): HTMLElement {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;justify-content:space-between;gap:18px';
  const l = document.createElement('span');
  l.textContent = label;
  l.style.cssText = 'opacity:0.6';
  const v = document.createElement('span');
  v.textContent = value;
  v.dataset.role = 'value';
  v.style.cssText = 'font-variant-numeric:tabular-nums';
  row.appendChild(l);
  row.appendChild(v);
  return row;
}

function setRowValue(row: HTMLElement, value: string): void {
  const v = row.querySelector('[data-role="value"]') as HTMLElement | null;
  if (v) v.textContent = value;
}

function formatAltitude(km: number): string {
  if (km < 1) return `${(km * 1000).toFixed(0)} m`;
  if (km < 100) return `${km.toFixed(2)} km`;
  return `${km.toFixed(1)} km`;
}

function formatSpeed(kmS: number): string {
  const ms = kmS * 1000;
  if (ms < 1000) return `${ms.toFixed(0)} m/s`;
  return `${kmS.toFixed(2)} km/s`;
}

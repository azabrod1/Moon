/**
 * Device-orientation ("gyro") steering for the Planetarium flight controls.
 *
 * Owns the `deviceorientation` listener and the iOS permission flow, and
 * exposes a normalized `{ yaw, pitch }` in [-1, 1] that `processInput` folds
 * into the flight axes. Narrow interface: `yaw`/`pitch` getters, `toggle()`,
 * `attach()`/`detach()` for the mode lifecycle, `enabled`, and `statusLabel()`.
 */
import * as THREE from 'three';

interface GyroAxes {
  yawDeg: number;
  pitchDeg: number;
}

export class GyroSteering {
  private enabledFlag = false;
  private attached = false;
  private availability: 'unknown' | 'granted' | 'denied' | 'unavailable' = 'unknown';
  private baseline: GyroAxes | null = null;
  private screenAngle = 0;
  private yawValue = 0;
  private pitchValue = 0;
  private lastEventMs: number | null = null;

  /**
   * @param notify   show a transient status message to the user
   * @param onChange refresh the gyro toggle/label UI after a state change
   */
  constructor(
    private readonly notify: (message: string) => void,
    private readonly onChange: () => void,
  ) {
    this.handleDeviceOrientation = this.handleDeviceOrientation.bind(this);
  }

  get yaw(): number { return this.yawValue; }
  get pitch(): number { return this.pitchValue; }
  get enabled(): boolean { return this.enabledFlag; }

  /** Re-attach the listener on mode (re)activation if gyro is enabled. */
  attach(): void {
    this.attached = true;
    if (this.enabledFlag) {
      window.addEventListener('deviceorientation', this.handleDeviceOrientation);
    }
  }

  /** Detach on deactivation; keeps `enabled` so re-activation restores it. */
  detach(): void {
    this.attached = false;
    window.removeEventListener('deviceorientation', this.handleDeviceOrientation);
    this.baseline = null;
    this.lastEventMs = null;
    this.yawValue = 0;
    this.pitchValue = 0;
  }

  async toggle(): Promise<void> {
    if (this.enabledFlag) {
      this.enabledFlag = false;
      this.baseline = null;
      this.lastEventMs = null;
      this.yawValue = 0;
      this.pitchValue = 0;
      window.removeEventListener('deviceorientation', this.handleDeviceOrientation);
      this.onChange();
      this.notify('Gyro steering off');
      return;
    }

    const orientationCtor = window.DeviceOrientationEvent as typeof DeviceOrientationEvent & {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
    if (typeof orientationCtor === 'undefined') {
      this.availability = 'unavailable';
      this.onChange();
      this.notify('Gyro steering is not available on this device');
      return;
    }

    if (typeof orientationCtor.requestPermission === 'function' && this.availability !== 'granted') {
      let permission: 'granted' | 'denied';
      try {
        permission = await orientationCtor.requestPermission();
      } catch {
        permission = 'denied';
      }
      if (permission !== 'granted') {
        this.availability = 'denied';
        this.enabledFlag = false;
        this.baseline = null;
        this.yawValue = 0;
        this.pitchValue = 0;
        this.onChange();
        this.notify('Gyro permission denied');
        return;
      }
    }

    // The async permission prompt can resolve after the mode was deactivated;
    // don't attach a listener to a torn-down mode.
    if (!this.attached) return;

    this.availability = 'granted';
    this.enabledFlag = true;
    this.baseline = null;
    this.yawValue = 0;
    this.pitchValue = 0;
    this.screenAngle = this.getScreenAngle();
    window.addEventListener('deviceorientation', this.handleDeviceOrientation);
    this.onChange();
    this.notify('Gyro steering on — hold your phone at a comfortable angle to calibrate');
  }

  statusLabel(): string {
    if (this.enabledFlag) return 'On';
    if (this.availability === 'denied') return 'Denied';
    if (this.availability === 'unavailable') return 'N/A';
    return 'Off';
  }

  private handleDeviceOrientation(event: DeviceOrientationEvent): void {
    if (!this.enabledFlag) return;
    const rawGamma = event.gamma;
    const rawBeta = event.beta;
    if (!Number.isFinite(rawGamma) || !Number.isFinite(rawBeta)) return;
    const gamma = rawGamma as number;
    const beta = rawBeta as number;

    const angle = this.getScreenAngle();
    const mapped = this.mapAxes(beta, gamma, angle);
    if (!mapped) return;

    const nowMs = performance.now();
    const dtS = this.lastEventMs === null ? 0 : (nowMs - this.lastEventMs) / 1000;
    this.lastEventMs = nowMs;

    if (this.baseline === null || angle !== this.screenAngle) {
      this.screenAngle = angle;
      this.baseline = mapped;
      this.yawValue = 0;
      this.pitchValue = 0;
      return;
    }

    this.yawValue = GyroSteering.smooth(
      this.yawValue,
      this.normalizeDelta(this.baseline.yawDeg - mapped.yawDeg),
      dtS,
    );
    this.pitchValue = GyroSteering.smooth(
      this.pitchValue,
      this.normalizeDelta(mapped.pitchDeg - this.baseline.pitchDeg),
      dtS,
    );
  }

  /** Rate of the tilt ease, per second. deviceorientation cadence is the
   *  device's, not ours — 60 Hz on iOS, anywhere from 50 to 200 Hz elsewhere —
   *  so a fixed per-event fraction would give every phone a different tail.
   *  The rate is the one that reproduces the old 0.18-per-event ease at
   *  60 Hz, which is the cadence it was tuned on. */
  private static readonly SMOOTH_RATE_PER_S = -60 * Math.log(1 - 0.18);

  /** Ease toward the tilt target over `dtS` of wall time, and SNAP to a true
   *  zero once inside the residue band. The ease alone only ever approaches
   *  zero, so a centered phone would keep steering by ~1e-6 for a minute —
   *  and every "is the pilot flying?" test downstream reads this sum. Hands
   *  off the phone must mean exactly zero, or the ship never counts as
   *  unattended: no autopilot steering, no arrival look, no bounce off a
   *  body you flew into. The band sits far under the smallest tilt the dead
   *  zone passes, so real steering is untouched. */
  private static smooth(value: number, target: number, dtS: number): number {
    const alpha = 1 - Math.exp(-GyroSteering.SMOOTH_RATE_PER_S * Math.max(dtS, 0));
    const eased = THREE.MathUtils.lerp(value, target, alpha);
    return Math.abs(eased) < 1e-4 ? 0 : eased;
  }

  private getScreenAngle(): number {
    const orientation = screen.orientation;
    if (orientation && typeof orientation.angle === 'number') {
      return ((orientation.angle % 360) + 360) % 360;
    }
    const legacyOrientation = (window as Window & { orientation?: number }).orientation;
    return typeof legacyOrientation === 'number'
      ? ((legacyOrientation % 360) + 360) % 360
      : 0;
  }

  private mapAxes(beta: number, gamma: number, angle: number): GyroAxes | null {
    if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return null;

    if (angle === 90) {
      return { yawDeg: beta, pitchDeg: -gamma };
    }
    if (angle === 180) {
      return { yawDeg: -gamma, pitchDeg: -beta };
    }
    if (angle === 270) {
      return { yawDeg: -beta, pitchDeg: gamma };
    }
    return { yawDeg: gamma, pitchDeg: beta };
  }

  private normalizeDelta(deltaDeg: number): number {
    const deadZone = 3;
    const fullTilt = 28;
    const absDelta = Math.abs(deltaDeg);
    if (absDelta <= deadZone) return 0;
    const normalized = (absDelta - deadZone) / (fullTilt - deadZone);
    return THREE.MathUtils.clamp(normalized * Math.sign(deltaDeg), -1, 1);
  }
}

/**
 * The highlight meter: the planetarium's exposure closed down for the sea's
 * beam, the way a camera exposed for a glint renders it — the beam's core
 * back off the tone curve's shoulder as gold over dark water instead of a
 * white smear — and for nothing else.
 *
 * Per frame it predicts the brightest drawn point of the beam from the
 * shader's own equations (world/glintMeter) at Earth's mirror geometry, reads
 * the water, the wind and the cloud over it from coarse copies of the maps
 * (world/surfaceMaps), and asks for an exposure that lands that point near a
 * target, never under a floor, faded in with the beam's share of the frame.
 * The exposure eases in stops, down fast and up slowly, and the mode hands
 * the renderer the smaller of this and the Sun's own coverage meter, so the
 * same view is never darkened twice.
 *
 * It costs tens of microseconds on the main thread and nothing on the GPU,
 * and it holds EXACTLY one — nothing evaluated, nothing decoded — whenever
 * the beam cannot be in the picture: the switch off (`?glintmeter=0`, any
 * build), the sea's beam chain or the Sun's path compiled out, the wind map
 * not bound, Earth's air on the tier without tables, the camera far from
 * Earth, or the maps not yet decoded. The hold is bit-identical to the
 * picture before the meter, because the Sun's meter never exceeds one.
 *
 * Only Earth: it is the one body with a sea. Everything the meter reads is
 * in Earth's own frame (the mesh's axes, the radius as the unit), handed in
 * by the mode from scene positions — never from the heliocentric position
 * table — after every camera writer of the frame.
 */
import * as THREE from 'three';
import type { RGB } from './world/atmosphereModel';
import { atmosphereParams, bodySolarIrradianceScale } from './world/atmosphereModel';
import {
  HIGHLIGHT_KNOBS, advanceExposureStops, buildTransmittanceTable, coverageOfBeam, createBeamPeak, createBeamPlace, createGlintScratch,
  placeBeamInFrame,
  highlightTarget, scanBeam,
  type BeamPeak, type GlintMeterLight, type GlintMeterPose, type GlintMeterSea, type GlintScratch,
  type HighlightKnobs, type SurfaceSampler, type TransmittanceTable,
} from './world/glintMeter';
import { EarthSurfaceMaps, type EarthMapKind } from './world/surfaceMaps';
import { SEA_WATER_F0 } from './world/surfaceShading';

/** The rates the exposure moves at, in stops per second: eyes and cameras
 *  clamp down fast and recover slowly. */
export const HIGHLIGHT_DOWN_STOPS_PER_S = 3;
export const HIGHLIGHT_UP_STOPS_PER_S = 0.75;

/** Beyond this many radii the beam is a sparkle and the maps are not even
 *  requested. */
export const HIGHLIGHT_REACH_RADII = 12;

let meterEnabled = true;

/** `?glintmeter=0`, any build: the exposure never closes for the beam. */
export function parseGlintMeterParam(search: string): boolean {
  return new URLSearchParams(search).get('glintmeter') !== '0';
}

export function setHighlightMeterEnabled(on: boolean): void {
  meterEnabled = on;
}

export function highlightMeterEnabled(): boolean {
  return meterEnabled;
}

/** What the mode hands the meter each frame, in Earth's own frame. */
export interface HighlightContext {
  /** The camera relative to Earth's centre, in radii, in the mesh's axes. */
  camera: THREE.Vector3;
  /** The Sun relative to Earth's centre, in radii, in the mesh's axes. */
  sun: THREE.Vector3;
  /** The light's intensity and linear colour, as the point light has them now. */
  lightIntensity: number;
  lightLinear: RGB;
  /** Earth's air: on (the tables bound), its blend, its haze grade. */
  airOn: boolean;
  airBlend: number;
  hazeClearView: number;
  /** The deck's drift this frame, and whether the deck is drawn at all. */
  cloudSpin: number;
  cloudDrawn: boolean;
  /** The camera's forward and up, unit vectors in the mesh's axes: where the
   *  frame looks, so the beam is counted only where it falls in the frame. */
  view: THREE.Vector3;
  viewUp: THREE.Vector3;
  /** The displayed field of view, degrees, both axes. */
  fovXDeg: number;
  fovYDeg: number;
  /** The chain the surfaces compile: the beam, the Sun's path, the wind map. */
  seaBeamOn: boolean;
  sunPathOn: boolean;
  windMapOn: boolean;
}

export interface HighlightTelemetry {
  enabled: boolean;
  /** Why the meter is held at one this frame, or 'metering'. */
  hold: string;
  exposure: number;
  target: number;
  drawnMax: number;
  carried: [number, number, number];
  drawn: [number, number, number];
  groundAngleDeg: number;
  /** How far across the principal line the peak sits, degrees of ground:
   *  zero over a uniform sea, off it where land or cloud lies along it. */
  acrossAngleDeg: number;
  halfWidthAlongDeg: number;
  halfWidthAcrossDeg: number;
  /** The surface under the predicted peak: water, wind, cloud keep. */
  peakSample: { water: number; windMs: number; cloudKeep: number };
  coverage: number;
  /** Where the peak lands in the frame: degrees from its centre, right and
   *  up, and whether it is in front of the camera at all. */
  peakFrame: { xDeg: number; yDeg: number; inFront: boolean };
  maps: { ready: EarthMapKind[]; failed: EarthMapKind[]; loading: EarthMapKind[] };
  /** The scan's cost, an exponential average of the last frames, microseconds. */
  costUs: number;
  knobs: HighlightKnobs;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class HighlightMeter {
  /** The exposure the meter asks for right now, 1 when held. */
  exposure = 1;
  knobs: HighlightKnobs = { ...HIGHLIGHT_KNOBS };
  downStopsPerS = HIGHLIGHT_DOWN_STOPS_PER_S;
  upStopsPerS = HIGHLIGHT_UP_STOPS_PER_S;

  /** Built once: the atmosphere's parameters are a session constant, and
   *  `atmosphereParams` hands back a fresh object each call, so the table is
   *  keyed on nothing and never rebuilt (a rebuild is two hundred thousand
   *  exponentials, two milliseconds, which is what a per-frame rebuild cost). */
  private table: TransmittanceTable | null = null;
  private readonly peak: BeamPeak = createBeamPeak();
  private readonly scratch: GlintScratch = createGlintScratch();
  private readonly pose: { camera: [number, number, number]; sun: [number, number, number]; sunVisible: number } = {
    camera: [0, 0, 0], sun: [0, 0, 0], sunVisible: 1,
  };
  private readonly light: { intensity: number; linear: RGB; irradianceScale: number } = {
    intensity: 0, linear: [1, 1, 1], irradianceScale: bodySolarIrradianceScale('Earth'),
  };
  private readonly sea: { waterF0: number; knee: number; cap: number; hazeClearView: number; airBlend: number } = {
    waterF0: SEA_WATER_F0, knee: 0, cap: 0, hazeClearView: 0.35, airBlend: 1,
  };
  private cloudSpin = 0;
  private cloudDrawn = true;
  private readonly sampler: SurfaceSampler = (nx, ny, nz, out) => {
    this.maps.sampleAt(nx, ny, nz, this.cloudSpin, out);
    if (!this.cloudDrawn) out.cloudKeep = 1;
  };
  private hold = 'off';
  private target = 1;
  private coverage = 0;
  private readonly view: [number, number, number] = [0, 0, 1];
  private readonly viewUp: [number, number, number] = [0, 1, 0];
  private readonly place = createBeamPlace();
  private costUs = 0;

  constructor(
    public readonly maps: EarthSurfaceMaps,
    private readonly shoulder: () => { knee: number; cap: number },
  ) {}

  /** One frame. Returns the exposure the meter asks for. */
  update(dt: number, ctx: HighlightContext): number {
    const held = this.holdReason(ctx);
    if (held) {
      this.hold = held;
      this.target = 1;
      this.coverage = 0;
      // The switch is exact: off, the exposure is one at once. The other
      // holds ease back, so a cloud sliding over the beam does not step.
      this.exposure = held === 'off' ? 1 : advanceExposureStops(this.exposure, 1, dt, this.downStopsPerS, this.upStopsPerS);
      return this.exposure;
    }
    this.hold = 'metering';
    if (!this.table) this.table = buildTransmittanceTable(atmosphereParams('Earth'));
    // Timed from here: the table above is built once a session, and in the
    // average it would read as the scan's own cost for a hundred frames after.
    const t0 = now();
    this.pose.camera[0] = ctx.camera.x; this.pose.camera[1] = ctx.camera.y; this.pose.camera[2] = ctx.camera.z;
    this.pose.sun[0] = ctx.sun.x; this.pose.sun[1] = ctx.sun.y; this.pose.sun[2] = ctx.sun.z;
    this.light.intensity = ctx.lightIntensity;
    this.light.linear = ctx.lightLinear;
    const sh = this.shoulder();
    this.sea.knee = sh.knee; this.sea.cap = sh.cap;
    this.sea.hazeClearView = ctx.hazeClearView;
    this.sea.airBlend = ctx.airBlend;
    this.cloudSpin = ctx.cloudSpin;
    this.cloudDrawn = ctx.cloudDrawn;
    const found = scanBeam(
      this.pose as GlintMeterPose, this.light as GlintMeterLight, this.sea as GlintMeterSea,
      this.sampler, this.table, this.scratch, this.peak,
    );
    if (found) {
      this.view[0] = ctx.view.x; this.view[1] = ctx.view.y; this.view[2] = ctx.view.z;
      this.viewUp[0] = ctx.viewUp.x; this.viewUp[1] = ctx.viewUp.y; this.viewUp[2] = ctx.viewUp.z;
      placeBeamInFrame(
        this.pose as GlintMeterPose, this.peak.groundAngleDeg, this.view, this.viewUp, this.scratch, this.place, this.peak.acrossAngleDeg,
      );
    } else {
      this.place.inFront = false; this.place.xDeg = 0; this.place.yDeg = 0;
    }
    this.coverage = found ? coverageOfBeam(this.peak.halfWidthAlongDeg, this.peak.halfWidthAcrossDeg, ctx.fovXDeg, ctx.fovYDeg, this.place) : 0;
    this.target = found ? highlightTarget(this.peak.drawnMax, this.coverage, this.knobs) : 1;
    this.exposure = advanceExposureStops(this.exposure, this.target, dt, this.downStopsPerS, this.upStopsPerS);
    if (!Number.isFinite(this.exposure)) this.exposure = 1;
    this.costUs += ((now() - t0) * 1000 - this.costUs) * 0.05;
    return this.exposure;
  }

  private holdReason(ctx: HighlightContext): string | null {
    if (!meterEnabled) return 'off';
    if (!ctx.seaBeamOn) return 'sea beam off';
    if (!ctx.sunPathOn) return 'sun path off';
    if (!ctx.windMapOn) return 'wind map not bound';
    if (!ctx.airOn) return 'air without tables';
    const dist = ctx.camera.length();
    if (!(dist > 1) || dist > HIGHLIGHT_REACH_RADII) return 'far from Earth';
    if (!this.maps.ready) {
      this.maps.request();
      return 'maps decoding';
    }
    return null;
  }

  telemetry(): HighlightTelemetry {
    const p = this.peak;
    return {
      enabled: meterEnabled,
      hold: this.hold,
      exposure: this.exposure,
      target: this.target,
      drawnMax: p.drawnMax,
      carried: [p.carried[0], p.carried[1], p.carried[2]],
      drawn: [p.drawn[0], p.drawn[1], p.drawn[2]],
      groundAngleDeg: p.groundAngleDeg,
      acrossAngleDeg: p.acrossAngleDeg,
      halfWidthAlongDeg: p.halfWidthAlongDeg,
      halfWidthAcrossDeg: p.halfWidthAcrossDeg,
      peakSample: { water: p.sample.water, windMs: p.sample.windMs, cloudKeep: p.sample.cloudKeep },
      coverage: this.coverage,
      peakFrame: { xDeg: this.place.xDeg, yDeg: this.place.yDeg, inFront: this.place.inFront },
      maps: this.maps.state(),
      costUs: this.costUs,
      knobs: { ...this.knobs },
    };
  }
}

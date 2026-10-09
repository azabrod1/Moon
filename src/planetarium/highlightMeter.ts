/**
 * The highlight meter: the planetarium's exposure closed down for the sea's
 * beam, the way a camera exposed for a glint renders it — the beam's core
 * back off the tone curve's shoulder as gold over dark water instead of a
 * white smear — and for nothing else.
 *
 * Per frame it predicts the brightest drawn point of the beam from the
 * shader's own equations (world/glintMeter) at Earth's mirror geometry and
 * under the moons' shadows the ground traces, reads the water and the wind
 * there, and the cloud between it and the Sun and between it and the camera,
 * from coarse copies of the maps (world/surfaceMaps), and asks for an
 * exposure that lands that point near a target, never under a floor, faded
 * in with the beam's share of the frame.
 * The exposure eases in stops, down fast and up slowly, and the mode hands
 * the renderer the smaller of this and the Sun's own coverage meter, so the
 * same view is never darkened twice.
 *
 * The beam as drawn and as predicted is the foam-free sea's (the whitecaps,
 * world/seaWind, grey the diffuse colour and leave the mirror term whole), up
 * to about 5.9 % brighter than a foam-covered one at the map's windiest
 * annual mean (13.38 m/s), on the safe side for a meter that only lowers the
 * exposure.
 *
 * It costs about a tenth of a millisecond on the main thread (60–120 µs a
 * frame on an M5 Max over the shipped maps, the search beside the principal
 * line included) and nothing on the GPU,
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
  HIGHLIGHT_KNOBS, advanceExposureStops, beamRadianceAt, buildColumnDepthTable, buildTransmittanceTable, coverageOfBeam, createBeamPeak, createBeamPlace, createGlintScratch,
  placeBeamInFrame,
  highlightTarget, scanBeam, shoulder,
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
  /** Whether Earth's ground compiles its cloud shadows (`cloudShadowsOn`):
   *  the sea's cut under the deck is then read where the Sun's ray crosses
   *  the deck, and straight over the point without them. */
  cloudShadows: boolean;
  /** The deck's height over the ground, in radii: the shell both the cut and
   *  the drawn deck stand on. */
  cloudHeightOverRadius: number;
  /** The camera's forward and up, unit vectors in the mesh's axes: where the
   *  frame looks, so the beam is counted only where it falls in the frame. */
  view: THREE.Vector3;
  viewUp: THREE.Vector3;
  /** The displayed field of view, degrees, both axes. */
  fovXDeg: number;
  fovYDeg: number;
  /** The Moon-shadow casters Earth's ground traces this frame (its
   *  uMoonShadow): four numbers apiece, a centre in the mesh's axes and a
   *  radius, in radii; `moonShadowCount` of them. With the Sun's angular
   *  radius as a tangent and the terminator's half-width in N·L, the ground's
   *  own uSunTan and uTermWidth, the eclipse is traced as the ground traces it. */
  moonShadows: ArrayLike<number>;
  moonShadowCount: number;
  sunTan: number;
  termWidth: number;
  /** The chain the surfaces compile: the beam, the Sun's path, the wind map,
   *  and the lobe along the wind's axis, which the twin then draws too. */
  seaBeamOn: boolean;
  sunPathOn: boolean;
  windMapOn: boolean;
  seaAxisOn: boolean;
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
  /** The surface under the predicted peak: water, wind, the cloud's keeps on
   *  the Sun's side (before the shoulder) and the camera's (after), and the
   *  wind's axis in doubled angle. */
  peakSample: { water: number; windMs: number; cloudKeep: number; deckKeep: number; axisX: number; axisY: number };
  /** Whether the twin drew the lobe along the wind (the SEA_AXIS define). */
  axis: boolean;
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
  private readonly pose: {
    camera: [number, number, number]; sun: [number, number, number];
    shadows: ArrayLike<number>; shadowCount: number; sunTan: number; termWidth: number;
  } = {
    camera: [0, 0, 0], sun: [0, 0, 0], shadows: [], shadowCount: 0, sunTan: 0, termWidth: 0,
  };
  private readonly light: { intensity: number; linear: RGB; irradianceScale: number } = {
    intensity: 0, linear: [1, 1, 1], irradianceScale: bodySolarIrradianceScale('Earth'),
  };
  private readonly sea: { waterF0: number; knee: number; cap: number; hazeClearView: number; airBlend: number; axis: boolean } = {
    waterF0: SEA_WATER_F0, knee: 0, cap: 0, hazeClearView: 0.35, airBlend: 1, axis: true,
  };
  private cloudSpin = 0;
  private cloudDrawn = true;
  private cloudShadows = true;
  private cloudHeight = 0;
  private cameraOverDeck = true;
  /** The maps as the surfaces read them this frame. The water and the wind
   *  at the point. The Sun's side of the cloud where the ground's cut reads
   *  it: where the Sun's ray crosses the deck with cloud shadows compiled,
   *  straight over the point without. The camera's side where the drawn deck
   *  stands in the line of sight, which it does only for a camera above the
   *  deck. A hidden deck takes neither: the cut is held clear while it is. */
  private readonly sampler: SurfaceSampler = (nx, ny, nz, out, lx, ly, lz, vx, vy, vz) => {
    this.maps.sampleAt(nx, ny, nz, this.cloudSpin, out, this.cloudDrawn && !this.cloudShadows);
    // No water, no beam: the cloud over land is never read.
    if (!this.cloudDrawn || !(out.water > 0)) { out.cloudKeep = 1; out.deckKeep = 1; return; }
    if (this.cloudShadows) out.cloudKeep = this.maps.keepToward(nx, ny, nz, lx, ly, lz, this.cloudHeight, this.cloudSpin);
    out.deckKeep = this.cameraOverDeck ? this.maps.keepToward(nx, ny, nz, vx, vy, vz, this.cloudHeight, this.cloudSpin) : 1;
  };
  private hold = 'off';
  private target = 1;
  private coverage = 0;
  private readonly view: [number, number, number] = [0, 0, 1];
  private readonly viewUp: [number, number, number] = [0, 1, 0];
  private readonly place = createBeamPlace();
  private readonly scanOpts: { besideFloor: number } = { besideFloor: 0 };
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
    // A camera inside the air reads its view leg through the column above it,
    // whose table is built the first time one is.
    if (!this.table.column && ctx.camera.length() < this.table.topRadius) {
      this.table = { ...this.table, column: buildColumnDepthTable(atmosphereParams('Earth')) };
    }
    // Timed from here: the tables above are built once a session, and in the
    // average they would read as the scan's own cost for a hundred frames after.
    const t0 = now();
    this.pose.camera[0] = ctx.camera.x; this.pose.camera[1] = ctx.camera.y; this.pose.camera[2] = ctx.camera.z;
    this.pose.sun[0] = ctx.sun.x; this.pose.sun[1] = ctx.sun.y; this.pose.sun[2] = ctx.sun.z;
    this.pose.shadows = ctx.moonShadows; this.pose.shadowCount = ctx.moonShadowCount;
    this.pose.sunTan = ctx.sunTan; this.pose.termWidth = ctx.termWidth;
    this.light.intensity = ctx.lightIntensity;
    this.light.linear = ctx.lightLinear;
    const sh = this.shoulder();
    this.sea.knee = sh.knee; this.sea.cap = sh.cap;
    this.sea.hazeClearView = ctx.hazeClearView;
    this.sea.airBlend = ctx.airBlend;
    this.sea.axis = ctx.seaAxisOn;
    this.cloudSpin = ctx.cloudSpin;
    this.cloudDrawn = ctx.cloudDrawn;
    this.cloudShadows = ctx.cloudShadows;
    this.cloudHeight = ctx.cloudHeightOverRadius;
    this.cameraOverDeck = ctx.camera.length() > 1 + ctx.cloudHeightOverRadius;
    // Beside the principal line the scan looks only for a beam past the
    // target: under it the meter asks for one whatever the beam draws.
    this.scanOpts.besideFloor = this.knobs.target;
    const found = scanBeam(
      this.pose as GlintMeterPose, this.light as GlintMeterLight, this.sea as GlintMeterSea,
      this.sampler, this.table, this.scratch, this.peak, this.scanOpts,
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
      peakSample: {
        water: p.sample.water, windMs: p.sample.windMs, cloudKeep: p.sample.cloudKeep, deckKeep: p.sample.deckKeep,
        axisX: p.sample.axisX, axisY: p.sample.axisY,
      },
      axis: this.sea.axis,
      coverage: this.coverage,
      peakFrame: { xDeg: this.place.xDeg, yDeg: this.place.yDeg, inFront: this.place.inFront },
      maps: this.maps.state(),
      costUs: this.costUs,
      knobs: { ...this.knobs },
    };
  }

  /**
   * DEV: the twin's drawn value — the beam as carried, held by the shoulder,
   * times the deck's share — at each ground point of `normals` (unit, in
   * Earth's own frame, three numbers apiece) under the last metered frame's
   * pose, light, sea and maps, through the very functions the scan reads, so
   * a probe can take the predicted beam's shape the way it takes the drawn
   * one's without a copy of the equations. `axis` overrides whether the twin
   * draws the lobe along the wind (the sea's own define by default); `mirror`
   * reads the axis mirrored (its doubled sine negated), the handedness
   * check's deliberate fault. Also the peak the scan found, in the same
   * frame. Null until the meter has metered a frame.
   */
  devDrawnAt(normals: ArrayLike<number>, opts?: { axis?: boolean; mirror?: boolean }): {
    drawn: number[]; peakN: [number, number, number]; camera: [number, number, number]; sun: [number, number, number];
  } | null {
    const table = this.table;
    if (!table || this.hold !== 'metering') return null;
    const sea: GlintMeterSea = { ...this.sea, axis: opts?.axis ?? this.sea.axis };
    const base = this.sampler;
    const sampler: SurfaceSampler = opts?.mirror
      ? (nx, ny, nz, out, lx, ly, lz, vx, vy, vz) => { base(nx, ny, nz, out, lx, ly, lz, vx, vy, vz); out.axisY = -out.axisY; }
      : base;
    const scratch = createGlintScratch();
    const rad: [number, number, number] = [0, 0, 0];
    const drawn: number[] = [];
    for (let i = 0; i + 2 < normals.length; i += 3) {
      beamRadianceAt(normals[i], normals[i + 1], normals[i + 2], this.pose as GlintMeterPose, this.light as GlintMeterLight, sea, sampler, table, scratch, rad);
      const most = Math.max(shoulder(rad[0], sea.knee, sea.cap), shoulder(rad[1], sea.knee, sea.cap), shoulder(rad[2], sea.knee, sea.cap));
      drawn.push(most * scratch.sample.deckKeep);
    }
    return {
      drawn,
      peakN: [this.peak.n[0], this.peak.n[1], this.peak.n[2]],
      camera: [this.pose.camera[0], this.pose.camera[1], this.pose.camera[2]],
      sun: [this.pose.sun[0], this.pose.sun[1], this.pose.sun[2]],
    };
  }
}

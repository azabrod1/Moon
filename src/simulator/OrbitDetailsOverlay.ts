import * as THREE from 'three';
import { DEG2RAD, SCENE } from '../utils/constants';
import {
  getLunarOrbitMetrics,
  meanMotionDegPerDay,
  positionInOrbitPlaneFromTrueAnomaly,
  trueAnomalyDegFromMeanAnomaly,
} from '../utils/lunarOrbit';
import { orientOrbitPlane } from '../utils/orbitPlane';

const ORIGIN = new THREE.Vector3(0, 0, 0);

function createDashedLine(points: THREE.Vector3[], color: number, opacity: number) {
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineDashedMaterial({
    color,
    transparent: true,
    opacity,
    dashSize: 1.1,
    gapSize: 0.65,
    depthWrite: false,
    depthTest: false,
  });
  const line = new THREE.Line(geometry, material);
  line.computeLineDistances();
  line.renderOrder = 30;
  return line;
}

function createFocusRing(radius: number, centerX: number, color: number, opacity: number) {
  const points: THREE.Vector3[] = [];
  const segments = 48;
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    points.push(new THREE.Vector3(
      centerX + radius * Math.cos(angle),
      0,
      radius * Math.sin(angle),
    ));
  }
  return createDashedLine(points, color, opacity);
}

function createAreaGeometry(startMeanAnomalyDeg: number, endMeanAnomalyDeg: number, samples = 40) {
  const vertices: number[] = [];
  const outlinePoints = [ORIGIN.clone()];
  let previousPoint: THREE.Vector3 | null = null;

  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const meanAnomalyDeg = startMeanAnomalyDeg + (endMeanAnomalyDeg - startMeanAnomalyDeg) * t;
    const trueAnomalyDeg = trueAnomalyDegFromMeanAnomaly(meanAnomalyDeg);
    const point = positionInOrbitPlaneFromTrueAnomaly(trueAnomalyDeg);

    outlinePoints.push(point.clone());

    if (previousPoint) {
      vertices.push(
        0, 0, 0,
        previousPoint.x, previousPoint.y, previousPoint.z,
        point.x, point.y, point.z,
      );
    }

    previousPoint = point;
  }

  outlinePoints.push(ORIGIN.clone());

  const fillGeometry = new THREE.BufferGeometry();
  fillGeometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));

  const outlineGeometry = new THREE.BufferGeometry().setFromPoints(outlinePoints);

  return { fillGeometry, outlineGeometry };
}

type AreaVisual = {
  fill: THREE.Mesh;
  outline: THREE.Line;
};

export class OrbitDetailsOverlay {
  readonly group = new THREE.Group();
  private readonly metrics = getLunarOrbitMetrics();
  private readonly equalTimeDays = 1;
  private readonly areaVisuals: AreaVisual[];
  private readonly focus1Local = new THREE.Vector3(0, 0, 0);
  private readonly focus2Local: THREE.Vector3;

  constructor() {
    const { semiMinorAxisScene, focalOffsetScene, periapsisScene, apoapsisScene } = this.metrics;
    this.focus2Local = new THREE.Vector3(-focalOffsetScene * 2, 0, 0);

    this.group.visible = false;

    const majorAxis = createDashedLine(
      [
        new THREE.Vector3(-apoapsisScene, 0, 0),
        new THREE.Vector3(periapsisScene, 0, 0),
      ],
      0xcfe2ff,
      0.45,
    );
    const minorAxis = createDashedLine(
      [
        new THREE.Vector3(-focalOffsetScene, 0, -semiMinorAxisScene),
        new THREE.Vector3(-focalOffsetScene, 0, semiMinorAxisScene),
      ],
      0xaad2ff,
      0.32,
    );
    const earthFocus = createFocusRing(SCENE.EARTH_RADIUS * 1.18, 0, 0xffdf8c, 0.42);
    const secondFocus = createFocusRing(SCENE.EARTH_RADIUS * 0.82, -focalOffsetScene * 2, 0xa8d4ff, 0.38);
    const centerRing = createFocusRing(SCENE.EARTH_RADIUS * 0.38, -focalOffsetScene, 0x8eb7ff, 0.18);
    this.group.add(majorAxis, minorAxis, earthFocus, secondFocus, centerRing);

    this.areaVisuals = [
      this.createAreaVisual(0x9dd7ff, 0.14),
      this.createAreaVisual(0xffdf96, 0.12),
    ];

    for (const areaVisual of this.areaVisuals) {
      this.group.add(areaVisual.fill, areaVisual.outline);
    }
  }

  private createAreaVisual(color: number, opacity: number): AreaVisual {
    const fill = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
        depthTest: false,
      }),
    );
    fill.renderOrder = 28;

    const outline = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: opacity + 0.16,
        depthWrite: false,
        depthTest: false,
      }),
    );
    outline.renderOrder = 29;

    return { fill, outline };
  }

  private updateAreaVisual(areaVisual: AreaVisual, startMeanAnomalyDeg: number, endMeanAnomalyDeg: number) {
    const { fillGeometry, outlineGeometry } = createAreaGeometry(startMeanAnomalyDeg, endMeanAnomalyDeg);
    areaVisual.fill.geometry.dispose();
    areaVisual.outline.geometry.dispose();
    areaVisual.fill.geometry = fillGeometry;
    areaVisual.outline.geometry = outlineGeometry;
  }

  setVisible(visible: boolean) {
    this.group.visible = visible;
  }

  getFocusWorldPositions(target1: THREE.Vector3, target2: THREE.Vector3) {
    this.group.updateMatrixWorld(true);
    target1.copy(this.focus1Local);
    target2.copy(this.focus2Local);
    this.group.localToWorld(target1);
    this.group.localToWorld(target2);
  }

  update(nodeAngleDeg: number, moonMeanAnomalyDeg: number) {
    if (!this.group.visible) return;

    orientOrbitPlane(this.group, SCENE.MOON_INCLINATION, nodeAngleDeg * DEG2RAD);

    const equalTimeMeanStep = meanMotionDegPerDay() * this.equalTimeDays;
    this.updateAreaVisual(
      this.areaVisuals[0],
      moonMeanAnomalyDeg - equalTimeMeanStep,
      moonMeanAnomalyDeg,
    );
    this.updateAreaVisual(
      this.areaVisuals[1],
      moonMeanAnomalyDeg + 180 - equalTimeMeanStep,
      moonMeanAnomalyDeg + 180,
    );
  }

  getReadout() {
    const metrics = this.metrics;
    return {
      majorAxisKm: Math.round(metrics.semiMajorAxisKm * 2),
      minorAxisKm: Math.round(metrics.semiMinorAxisKm * 2),
      focalOffsetKm: Math.round(metrics.focalOffsetKm),
      periapsisKm: Math.round(metrics.periapsisKm),
      apoapsisKm: Math.round(metrics.apoapsisKm),
      equalTimeDays: this.equalTimeDays,
    };
  }
}

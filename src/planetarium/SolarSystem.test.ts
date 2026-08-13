/**
 * Tests for the orbit-line resampling seam — the only part of the lazy
 * drift rebuild that contains mechanics (the staleness policy in
 * PlanetariumMode is a two-line threshold check). Runs headless: THREE
 * BufferGeometry math needs no WebGL context.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import {
  ORBIT_LINE_OPACITY_CAP,
  ORBIT_LINE_OPACITY_FLOOR,
  ORBIT_LINE_OVERVIEW_OPACITY,
  ORBIT_LINE_SEGMENTS,
  ORBIT_LINE_WIDTH_PX,
  createAsteroidBelt,
  createOrbitLineMaterial,
  getPlanetOrbitalPosition,
  orbitLineOpacity,
  orbitLineSegmentCount,
  resampleOrbitLines,
  type SolarSystemObjects,
} from './SolarSystem';
import { createLensShaderUniforms } from '../shared/three/lensShader';
import {
  ORBIT_LINE_STENCIL_REF,
  applyOrbitLineStencilGate,
} from './world/orbitLineStencil';
import { computeBodyPositionAU, eclipticToEquatorial } from '../astronomy/planetary';
import { ASTEROID_BELT, PLANETARIUM_BODIES } from './planets/planetData';

const J2000_UTC_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

function makeBareObjects(): Pick<SolarSystemObjects, 'orbitLines' | 'orbitLinesEpochUtcMs'> {
  // Exactly the fields resampleOrbitLines declares it needs. Default Line2
  // geometry is empty, so the first resample exercises the fill path.
  return {
    orbitLines: PLANETARIUM_BODIES.map(() => new Line2()),
    orbitLinesEpochUtcMs: 0,
  };
}

function instanceStartOf(line: Line2): THREE.InterleavedBufferAttribute {
  // NB: fat-line geometry also carries a `position` attribute, but that is the
  // 8-vertex unit quad — the polyline lives in instanceStart/instanceEnd.
  return line.geometry.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute;
}

/** The sampled polyline back out of the instanced pair layout. */
function polylinePoints(line: Line2): THREE.Vector3[] {
  const start = instanceStartOf(line);
  const end = line.geometry.getAttribute('instanceEnd') as THREE.InterleavedBufferAttribute;
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < start.count; i++) {
    points.push(new THREE.Vector3().fromBufferAttribute(start, i));
  }
  points.push(new THREE.Vector3().fromBufferAttribute(end, end.count - 1));
  return points;
}

function minDistToPolyline(p: THREE.Vector3, points: THREE.Vector3[]): number {
  let best = Infinity;
  const ab = new THREE.Vector3();
  const ap = new THREE.Vector3();
  const closest = new THREE.Vector3();
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    ab.subVectors(b, a);
    ap.subVectors(p, a);
    const t = Math.max(0, Math.min(1, ap.dot(ab) / ab.lengthSq()));
    closest.copy(a).addScaledVector(ab, t);
    best = Math.min(best, p.distanceTo(closest));
  }
  return best;
}

describe('orbit-line stencil contract', () => {
  it('makes a décor material test-only against the line stamp', () => {
    const material = new THREE.PointsMaterial();
    applyOrbitLineStencilGate(material);
    // stencilWrite doubles as three's stencil-TEST enable; the zeroed write
    // mask is what keeps the material from stamping anything itself.
    expect(material.stencilWrite).toBe(true);
    expect(material.stencilWriteMask).toBe(0x00);
    expect(material.stencilFunc).toBe(THREE.NotEqualStencilFunc);
    expect(material.stencilRef).toBe(ORBIT_LINE_STENCIL_REF);
  });

  it('gates the asteroid belt so nearer dots cannot stud the outer rings', () => {
    const belt = createAsteroidBelt();
    const material = belt.material as THREE.PointsMaterial;
    expect(material.stencilWrite).toBe(true);
    expect(material.stencilWriteMask).toBe(0x00);
    expect(material.stencilFunc).toBe(THREE.NotEqualStencilFunc);
    expect(material.stencilRef).toBe(ORBIT_LINE_STENCIL_REF);
  });
});

describe('asteroid belt', () => {
  it('builds the same position and colour buffers on every load', () => {
    const first = createAsteroidBelt();
    const second = createAsteroidBelt();

    expect(Array.from(first.geometry.getAttribute('position').array)).toEqual(
      Array.from(second.geometry.getAttribute('position').array),
    );
    expect(Array.from(first.geometry.getAttribute('color').array)).toEqual(
      Array.from(second.geometry.getAttribute('color').array),
    );
  });

  it('stays inside the configured ecliptic annulus and spans both sides of its plane', () => {
    const belt = createAsteroidBelt();
    const positions = belt.geometry.getAttribute('position') as THREE.BufferAttribute;
    const eclipticNorth = eclipticToEquatorial(new THREE.Vector3(0, 1, 0)).normalize();
    const point = new THREE.Vector3();
    let minHeight = Infinity;
    let maxHeight = -Infinity;
    let minRadius = Infinity;
    let maxRadius = -Infinity;

    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i);
      const height = point.dot(eclipticNorth);
      const radius = point.addScaledVector(eclipticNorth, -height).length();
      minHeight = Math.min(minHeight, height);
      maxHeight = Math.max(maxHeight, height);
      minRadius = Math.min(minRadius, radius);
      maxRadius = Math.max(maxRadius, radius);
    }

    const FLOAT32_TOLERANCE_AU = 1e-6;
    expect(positions.count).toBe(3000);
    expect(minHeight).toBeGreaterThanOrEqual(-0.025 - FLOAT32_TOLERANCE_AU);
    expect(maxHeight).toBeLessThanOrEqual(0.025 + FLOAT32_TOLERANCE_AU);
    expect(minHeight).toBeLessThan(0);
    expect(maxHeight).toBeGreaterThan(0);
    expect(minRadius).toBeGreaterThanOrEqual(ASTEROID_BELT.innerAU - FLOAT32_TOLERANCE_AU);
    expect(maxRadius).toBeLessThanOrEqual(ASTEROID_BELT.outerAU + FLOAT32_TOLERANCE_AU);
  });
});

describe('aligned layout positions', () => {
  it('puts every planet on its catalog-radius circle in the transformed ecliptic plane', () => {
    const eclipticNorth = eclipticToEquatorial(new THREE.Vector3(0, 1, 0)).normalize();
    for (let i = 0; i < PLANETARIUM_BODIES.length; i++) {
      const body = PLANETARIUM_BODIES[i];
      const position = getPlanetOrbitalPosition(body, i + 1, 'aligned');
      const point = new THREE.Vector3(position.x, position.y, position.z);
      expect(Math.abs(point.dot(eclipticNorth)), body.name).toBeLessThan(1e-12);
      expect(Math.abs(point.length() - body.semiMajorAxisAU), body.name).toBeLessThan(1e-12);
    }
  });
});

describe('resampleOrbitLines', () => {
  it('fills every line with a full-period orbit and stamps the epoch', () => {
    const objects = makeBareObjects();
    resampleOrbitLines(objects, 'realistic', J2000_UTC_MS);

    expect(objects.orbitLinesEpochUtcMs).toBe(J2000_UTC_MS);
    for (let i = 0; i < objects.orbitLines.length; i++) {
      const geometry = objects.orbitLines[i].geometry;
      expect(instanceStartOf(objects.orbitLines[i]).count, PLANETARIUM_BODIES[i].name).toBe(
        orbitLineSegmentCount(PLANETARIUM_BODIES[i]),
      );
      expect(geometry.instanceCount, PLANETARIUM_BODIES[i].name).toBe(
        orbitLineSegmentCount(PLANETARIUM_BODIES[i]),
      );
      expect(geometry.boundingSphere, PLANETARIUM_BODIES[i].name).not.toBeNull();
      // Bounding sphere must be orbit-sized, not the default empty sphere.
      expect(geometry.boundingSphere!.radius).toBeGreaterThan(
        PLANETARIUM_BODIES[i].semiMajorAxisAU * 0.5,
      );
    }
  });

  it('keeps every planet on its own drawn line, even at the staleness bound', () => {
    // The user-facing guarantee behind the trajectory sampling + the 60-day
    // rebuild threshold: at landed zoom the planet must sit ON its orbit
    // line. Half a body radius of slack covers Pluto's clamped segment count
    // (~0.37 R sagitta) and Mercury's worst-case one-orbit-old precession at
    // 59 days stale. The old element-ellipse lines failed this by 1.4 R⊕
    // (Earth's Meeus/EMB seam) up to ~200 R (Pluto at 256 segments).
    const epochs = [
      Date.UTC(1977, 8, 5), // Voyager mission jump territory
      Date.UTC(2026, 5, 11),
      Date.UTC(2032, 0, 1),
    ];
    const STALE_MS = 59 * 86_400_000; // just under the rebuild threshold
    const objects = makeBareObjects();
    for (const epoch of epochs) {
      resampleOrbitLines(objects, 'realistic', epoch);
      for (const staleMs of [0, STALE_MS]) {
        for (let i = 0; i < objects.orbitLines.length; i++) {
          const body = PLANETARIUM_BODIES[i];
          const pos = computeBodyPositionAU(body, epoch + staleMs);
          const p = new THREE.Vector3(pos.x, pos.y, pos.z);
          const offAU = minDistToPolyline(p, polylinePoints(objects.orbitLines[i]));
          expect(offAU, `${body.name} @ ${new Date(epoch).toISOString()} +${staleMs / 86_400_000}d`)
            .toBeLessThan(body.radiusAU * 0.5);
        }
      }
    }
  });

  it('moves the lines in place — same geometry, same buffer — when resampled centuries later', () => {
    const objects = makeBareObjects();
    resampleOrbitLines(objects, 'realistic', J2000_UTC_MS);
    const mercury = objects.orbitLines[0];
    const geometryBefore = mercury.geometry;
    const attributeBefore = instanceStartOf(mercury);
    const versionBefore = attributeBefore.data.version;
    const before = new THREE.Vector3().fromBufferAttribute(attributeBefore, 0);
    const sphereCentreBefore = mercury.geometry.boundingSphere!.center.clone();
    // The instanced buffer is flagged for repeated re-upload from creation on.
    expect(attributeBefore.data.usage).toBe(THREE.DynamicDrawUsage);

    const later = J2000_UTC_MS + 200 * 365.25 * 86_400_000;
    resampleOrbitLines(objects, 'realistic', later);

    expect(objects.orbitLinesEpochUtcMs).toBe(later);
    const after = new THREE.Vector3().fromBufferAttribute(instanceStartOf(mercury), 0);
    // The strip starts half a period before the epoch — 200 years later that
    // vertex sits somewhere else entirely on the (precessed) orbit, and the
    // resample must land in place: the same geometry and interleaved buffer
    // (churning GPU buffers on the periodic drift rebuild is what the fast
    // path exists to avoid), with the upload flagged and the cached bounds
    // recomputed for the moved strip (stale bounds = stale frustum culling).
    expect(after.distanceTo(before)).toBeGreaterThan(1e-4);
    expect(mercury.geometry).toBe(geometryBefore);
    expect(instanceStartOf(mercury)).toBe(attributeBefore);
    expect(attributeBefore.data.version).toBeGreaterThan(versionBefore);
    expect(attributeBefore.count).toBe(orbitLineSegmentCount(PLANETARIUM_BODIES[0]));
    expect(
      mercury.geometry.boundingSphere!.center.distanceTo(sphereCentreBefore),
    ).toBeGreaterThan(1e-7);
  });

  it('keeps the realistic strip a strip — the period seam stays open', () => {
    // sampleTrajectoryLinePoints spans epoch −P/2 → +P/2; the endpoints differ
    // by one period of precession/perturbation and must never be snapped shut
    // (a forced closure would falsify the planet-sits-on-its-line guarantee
    // near the seam).
    const objects = makeBareObjects();
    resampleOrbitLines(objects, 'realistic', J2000_UTC_MS);
    const points = polylinePoints(objects.orbitLines[0]);
    expect(points[0].distanceTo(points[points.length - 1])).toBeGreaterThan(0);
  });

  it('swaps in a fresh geometry and disposes the old one when the segment count changes', () => {
    const objects = makeBareObjects();
    resampleOrbitLines(objects, 'realistic', J2000_UTC_MS);
    const mercury = objects.orbitLines[0];
    const geometryBefore = mercury.geometry;
    let disposed = false;
    geometryBefore.addEventListener('dispose', () => {
      disposed = true;
    });

    // Aligned circles use ORBIT_LINE_SEGMENTS (256) — a different count than
    // Mercury's realistic 1024, so the in-place path must refuse.
    resampleOrbitLines(objects, 'aligned', J2000_UTC_MS);

    expect(mercury.geometry).not.toBe(geometryBefore);
    expect(disposed).toBe(true);
    expect(instanceStartOf(mercury).count).toBe(ORBIT_LINE_SEGMENTS);
    expect(instanceStartOf(mercury).data.usage).toBe(THREE.DynamicDrawUsage);
    expect(mercury.geometry.boundingSphere).not.toBeNull();
  });

  it('draws catalog-radius ecliptic circles in aligned mode', () => {
    // Aligned rings are circles in the ecliptic plane expressed in the
    // equatorial scene frame (same obliquity tilt as every orbit) — epoch-free.
    // Independent expectation: longitude `angle` sits at (cos, 0, −sin) in the
    // scene's ecliptic frame (longitude runs toward −Z; planetary.test.ts).
    const objects = makeBareObjects();
    resampleOrbitLines(objects, 'aligned', J2000_UTC_MS);
    for (let i = 0; i < objects.orbitLines.length; i++) {
      const start = instanceStartOf(objects.orbitLines[i]);
      const radiusAU = PLANETARIUM_BODIES[i].semiMajorAxisAU;
      for (const vertexIndex of [0, 64, 192]) {
        const angle = (vertexIndex / ORBIT_LINE_SEGMENTS) * Math.PI * 2;
        const expected = eclipticToEquatorial(
          new THREE.Vector3(radiusAU * Math.cos(angle), 0, -radiusAU * Math.sin(angle)),
        );
        // BufferAttribute is float32: ~1e-7 relative quantization.
        const v = new THREE.Vector3().fromBufferAttribute(start, vertexIndex);
        expect(v.distanceTo(expected), PLANETARIUM_BODIES[i].name).toBeLessThan(1e-5 * (1 + radiusAU));
      }
    }
  });
});

describe('createOrbitLineMaterial', () => {
  it('applies the butt-cap + edge-feather patch and keeps its own program-cache key', () => {
    const material = createOrbitLineMaterial(0xff0000, 0.2, createLensShaderUniforms());
    // Anchors are asserted at patch time (replaceExactlyOnce throws on a three
    // upgrade that moves them) — construction alone proves they still match.
    // The feather must ride vUv.x: x is the cross-line axis, y runs along the
    // segment (feathering y re-creates the joint beading, inverted). The
    // derivative must be the true gradient length, not fwidth, whose
    // slope-dependent sqrt(2) overshoot bands shallow arcs.
    expect(material.fragmentShader).toContain('length( vec2( dFdx( vUv.x ), dFdy( vUv.x ) ) )');
    expect(material.fragmentShader).toContain('abs( vUv.x )');
    expect(material.fragmentShader).not.toContain('fwidth( vUv.x )');
    expect(material.fragmentShader).not.toContain('fwidth( vUv.y )');
    expect(material.fragmentShader).not.toContain('if ( len2 > 1.0 ) discard;');
    // Décor gating: the core stamps the stencil (stars/belt test NotEqual and
    // skip those pixels — blending can never hide a dot behind a dim line,
    // and depth can neither reject a NEARER belt dot nor survive tiny-near
    // quantization ties), the invisible feather shoulder discards so it
    // stamps nothing, and depth stays read-only so coincident rings blend
    // instead of z-chopping each other.
    expect(material.depthWrite).toBe(false);
    expect(material.stencilWrite).toBe(true);
    expect(material.stencilRef).toBe(ORBIT_LINE_STENCIL_REF);
    expect(material.stencilZPass).toBe(THREE.ReplaceStencilOp);
    expect(material.stencilWriteMask).toBe(0xff);
    // The coverage ramp must be linear and reach zero AT the quad edge, with a
    // near-zero discard threshold: any coverage step left at the edge snaps
    // pixels lit/gone as sub-pixel phase drifts, banding shallow arcs at
    // evenly spaced intervals (the 0.3 threshold this replaced did exactly
    // that).
    expect(material.fragmentShader).toContain(
      'clamp( ( 1.0 - abs( vUv.x ) ) / max( lineEdgeWidth, 1e-5 ), 0.0, 1.0 )',
    );
    expect(material.fragmentShader).toContain('lineEdgeCoverage < 0.05');
    expect(material.fragmentShader).not.toContain('smoothstep( 1.0 - lineEdgeWidth');
    // The three coverage statements must survive IN ORDER — compute, then the
    // near-zero discard (what keeps the stencil stamp off invisible
    // shoulders), then the alpha multiply (what actually feathers the edge).
    // Dropping the multiply or softening the discard to `alpha = 0.0` would
    // pass any single-token check while regressing banding or star blanking.
    const frag = material.fragmentShader;
    const iCompute = frag.indexOf('float lineEdgeCoverage = clamp(');
    const iDiscard = frag.indexOf('if ( lineEdgeCoverage < 0.05 ) discard;');
    const iMultiply = frag.indexOf('alpha *= lineEdgeCoverage;');
    expect(iCompute).toBeGreaterThan(-1);
    expect(iDiscard).toBeGreaterThan(iCompute);
    expect(iMultiply).toBeGreaterThan(iDiscard);
    // Distinct from the ShadowVisuals guides' 'fixed-screen-line-lens-v2' so
    // the two patched shader families can never share a compiled program.
    expect(material.customProgramCacheKey()).toBe('orbit-line-lens-buttcap-v2');
    expect(material.transparent).toBe(true);
    expect(material.worldUnits).toBe(false);
  });

  it('wires the lens width pre-distortion into the compiled program', () => {
    const lensUniforms = createLensShaderUniforms();
    const material = createOrbitLineMaterial(0xff0000, 0.2, lensUniforms);
    // Feed onBeforeCompile the stock sources the renderer would hand it: the
    // lens augment must inject its GLSL into the vertex stage and alias the
    // shared uniform block (identity, not copies — one applyLensShaderUniforms
    // call per frame drives all nine materials).
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: new LineMaterial().vertexShader,
      fragmentShader: material.fragmentShader,
    };
    material.onBeforeCompile(shader as never, null as never);
    expect(shader.vertexShader).toContain('lensUnwarpOutputNdc');
    // The camera-plane guard: segments wrapping/grazing the camera must keep
    // the stock quad (near-singular NDC endpoints explode the warp math into
    // frame-filling triangles — found by QA at outer-system framings).
    expect(shader.vertexShader).toContain('clipStart.w > 0.0 && clipEnd.w > 0.0');
    expect(shader.uniforms.uLensStrength).toBe(lensUniforms.uLensStrength);
    expect(shader.uniforms.uLensREdge).toBe(lensUniforms.uLensREdge);
  });

  it('pins the authored width and opacity levels', () => {
    // Taste knobs, pinned as literals so silent drift is loud. Width 2.25
    // from the 2026-08-12 tuning grid at Alex's near-Jupiter framing (it
    // collapses the lens-resample dash ripple 1.67:1 → 1.19:1 — a width
    // effect, not an opacity one).
    expect(ORBIT_LINE_WIDTH_PX).toBe(2.25);
    // 0.14: Alex's second "bit brighter" nudge (2026-08-12), applied together
    // with the depth-write star occlusion that removed the bead artifact.
    expect(ORBIT_LINE_OPACITY_FLOOR).toBe(0.14);
    // 0.55 overview/cap: measured against NASA Eyes' whole-system chart —
    // same line width as ours, but 105–145/255 peak luma vs our old 20–103.
    // At 0.55 our arcs land inside that band and the lens resample's few-code
    // ripple drops below visible contrast (Weber ~13% → ~5%).
    expect(ORBIT_LINE_OPACITY_CAP).toBe(0.55);
    expect(ORBIT_LINE_OVERVIEW_OPACITY).toBe(0.55);
  });
});

describe('orbitLineOpacity', () => {
  const NEPTUNE_A = 30.07;

  it('pins a far orbit to the floor when the camera is close', () => {
    expect(orbitLineOpacity(1, 0.001, NEPTUNE_A)).toBe(ORBIT_LINE_OPACITY_FLOOR);
  });

  it('saturates at the cap when the player rides the orbit', () => {
    expect(orbitLineOpacity(9.58, 0.001, 9.58)).toBe(ORBIT_LINE_OPACITY_CAP);
  });

  it('reaches full overview from a whole-system camera, however extreme the ratio', () => {
    // Mercury from 55 AU: camera/a ≈ 142 — the unclamped house smoothstep
    // would go hugely negative here and silently revive the headline bug.
    expect(orbitLineOpacity(55, 55, 0.387)).toBe(ORBIT_LINE_OVERVIEW_OPACITY);
    // Through Neptune, every orbit reads as chart furniture from the
    // whole-system pose (55 AU frames Neptune whole; Pluto's ring doesn't fit
    // that frame, and its overview correctly stays partial).
    for (const body of PLANETARIUM_BODIES) {
      if (body.semiMajorAxisAU > NEPTUNE_A) continue;
      expect(
        orbitLineOpacity(55, 55, body.semiMajorAxisAU),
        body.name,
      ).toBeGreaterThanOrEqual(0.25);
    }
  });

  it('ramps the overview term between 1 and 2 orbit radii of camera pullout', () => {
    const mid = orbitLineOpacity(1, NEPTUNE_A * 1.5, NEPTUNE_A);
    expect(mid).toBeCloseTo(ORBIT_LINE_OVERVIEW_OPACITY * 0.5, 5);
    expect(orbitLineOpacity(1, NEPTUNE_A * 0.99, NEPTUNE_A)).toBe(ORBIT_LINE_OPACITY_FLOOR);
    expect(orbitLineOpacity(1, NEPTUNE_A * 2, NEPTUNE_A)).toBe(ORBIT_LINE_OVERVIEW_OPACITY);
  });

  it('falls back to the floor on degenerate inputs', () => {
    expect(orbitLineOpacity(Number.NaN, 10, 1)).toBe(ORBIT_LINE_OPACITY_FLOOR);
    expect(orbitLineOpacity(1, Number.POSITIVE_INFINITY, 1)).toBe(ORBIT_LINE_OPACITY_FLOOR);
    expect(orbitLineOpacity(1, 10, 0)).toBe(ORBIT_LINE_OPACITY_FLOOR);
    // Infinity passes a bare `> 0` check but would drive proximity to NaN.
    expect(orbitLineOpacity(1, 10, Number.POSITIVE_INFINITY)).toBe(ORBIT_LINE_OPACITY_FLOOR);
  });
});

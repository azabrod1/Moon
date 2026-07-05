/**
 * Default Planetarium player-ship model — procedural THREE geometry.
 * A slim two-tone needle: matte-white forward hull, graphite aft section,
 * gold service band, flush lit window band, three swept fins carrying the
 * nav lights, and a machined engine bell.
 *
 * Design constraints the numbers encode:
 * - The chase camera views the ship from behind and slightly above nearly
 *   all the time, so the aft hull, bell, and plume carry the detail.
 * - The ship stays dimmer than the star field except at a deliberate full
 *   burn: plume colors are authored so PlayerShip's per-frame opacity ramp
 *   crosses the composer's bloom threshold (main.ts) only near full burn,
 *   and the nav lights sit below it so they read as dots, not lamps.
 * - Plume geometry is authored at full-burn size divided by PlayerShip's
 *   max exhaust scale, so the existing opacity/scale animation spans coast
 *   to full burn without touching PlayerShip.
 * - All detail sits flush on the hull or rides a parent part — nothing floats.
 *
 * Returns the assembled group plus the parts PlayerShip animates each frame
 * (the hull mesh and the two exhaust-plume cones).
 */
import * as THREE from 'three';

export interface DefaultShip {
  model: THREE.Group;
  mesh: THREE.Mesh;
  exhaustCone: THREE.Mesh;
  exhaustCore: THREE.Mesh;
}

/** Unlit material whose RGB may exceed 1 (toneMapped off) so it reaches bloom. */
function createGlowMaterial(r: number, g: number, b: number): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial();
  mat.color.setRGB(r, g, b);
  mat.toneMapped = false;
  return mat;
}

export function createDefaultShip(referenceRadiusAU: number): DefaultShip {
  // The previous ship's built envelope was ~6 reference radii nose to bell;
  // this hull is authored 3.32 units long, so 1.8 keeps the chase-camera
  // footprint the same.
  const U = referenceRadiusAU * 1.8;

  // Shared materials (one instance each, like the probe models). Albedo and
  // gloss are capped so the sunlit hull stays under the composer's bloom
  // threshold even at the near-Sun spawn (~0.05 AU, ~2.4x the 1-AU light):
  // the ship must never halo on its own — only the full-burn plume may.
  const thermalWhite = new THREE.MeshStandardMaterial({
    color: 0xb9c0ca, roughness: 0.6, metalness: 0.05,
  });
  const graphite = new THREE.MeshStandardMaterial({
    color: 0x23272e, roughness: 0.6, metalness: 0.45,
  });
  // Metalness under 1 plus a small emissive floor: the scene has no ambient
  // light, and pure metal turns into a black stripe whenever the sun glint
  // misses the camera.
  const goldFoil = new THREE.MeshStandardMaterial({
    color: 0xc9a133, roughness: 0.36, metalness: 0.82,
    emissive: 0x2a1e08, emissiveIntensity: 0.18,
  });
  // Flush window band with a warm interior light — dim enough that a parked
  // ship shows only a quiet glow, never a lamp.
  const windowGlass = new THREE.MeshStandardMaterial({
    color: 0x0a0f16, roughness: 0.2, metalness: 0.4,
    emissive: 0x4a3423, emissiveIntensity: 0.5,
  });
  // Dark machined steel: the concave bell faces the camera AND the Sun in
  // the everyday chase view, so any bright or glossy value here mirrors the
  // Sun into a bloom hotspot. Contrast with the plume comes from the flame,
  // not the metal.
  const bellSteel = new THREE.MeshStandardMaterial({
    color: 0x51575f, roughness: 0.55, metalness: 0.5, side: THREE.DoubleSide,
  });

  const model = new THREE.Group();

  // ── Hull: two-tone as a split lathe sharing an edge point (no overlay
  //    skin — an overlaid sleeve hides inside the hull surface) ──
  const forwardHull = new THREE.Mesh(
    new THREE.LatheGeometry(
      [
        new THREE.Vector2(0.001 * U, 1.5 * U),
        new THREE.Vector2(0.13 * U, 1.4 * U),
        new THREE.Vector2(0.27 * U, 1.26 * U),
        new THREE.Vector2(0.38 * U, 1.06 * U),
        new THREE.Vector2(0.44 * U, 0.74 * U),
        new THREE.Vector2(0.44 * U, -0.35 * U),
      ],
      48,
    ),
    thermalWhite,
  );
  const aftHull = new THREE.Mesh(
    new THREE.LatheGeometry(
      [
        new THREE.Vector2(0.44 * U, -0.35 * U),
        new THREE.Vector2(0.44 * U, -0.6 * U),
        new THREE.Vector2(0.4 * U, -0.98 * U),
        new THREE.Vector2(0.34 * U, -1.18 * U),
      ],
      48,
    ),
    graphite,
  );
  model.add(forwardHull, aftHull);
  const mesh = forwardHull;

  // Raised graphite trim rings — sit a hair proud and read as panel seams.
  for (const y of [0.5, -0.05]) {
    const ring = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4425 * U, 0.4425 * U, 0.022 * U, 48, 1, true),
      graphite,
    );
    ring.position.y = y * U;
    model.add(ring);
  }

  // Gold service band — the one sun-glint element.
  const band = new THREE.Mesh(
    new THREE.CylinderGeometry(0.4455 * U, 0.4455 * U, 0.2 * U, 48, 1, true),
    goldFoil,
  );
  band.position.y = -0.32 * U;
  model.add(band);

  // Window band, following the nose taper.
  const windowBand = new THREE.Mesh(
    new THREE.CylinderGeometry(0.415 * U, 0.437 * U, 0.12 * U, 48, 1, true),
    windowGlass,
  );
  windowBand.position.y = 0.88 * U;
  model.add(windowBand);

  // RCS quads ringing the nose.
  const rcsGeo = new THREE.BoxGeometry(0.06 * U, 0.05 * U, 0.06 * U);
  for (let i = 0; i < 4; i++) {
    const rcs = new THREE.Mesh(rcsGeo, graphite);
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    rcs.position.set(Math.cos(a) * 0.41 * U, 1.02 * U, Math.sin(a) * 0.41 * U);
    model.add(rcs);
  }

  // ── Fins: three slim swept plates rooted in the aft hull. Tip lights are
  //    children of their fin so they track any sweep or clocking change.
  //    Clocked so one fin is dorsal and the laterals carry the aviation
  //    convention: red port, green starboard, white up — from astern the
  //    trio doubles as a roll indicator. ──
  const finGeo = new THREE.BoxGeometry(0.44 * U, 0.62 * U, 0.022 * U);
  const finSpecs: { clock: number; light: THREE.MeshBasicMaterial; lightR: number }[] = [
    // Nose is +Y here and the final -90° z-rotation makes build -X the world
    // "up", so the dorsal fin pivots to PI; +Z stays starboard.
    { clock: Math.PI, light: createGlowMaterial(0.85, 0.85, 0.85), lightR: 0.022 },
    { clock: -Math.PI / 2, light: createGlowMaterial(0.08, 0.55, 0.18), lightR: 0.028 },
    { clock: Math.PI / 2, light: createGlowMaterial(1.6, 0.12, 0.08), lightR: 0.028 },
  ];
  for (const spec of finSpecs) {
    const fin = new THREE.Mesh(finGeo, graphite);
    fin.position.set(0.5 * U, -1.0 * U, 0);
    fin.rotation.z = -0.3; // sweep back
    const light = new THREE.Mesh(new THREE.SphereGeometry(spec.lightR * U, 8, 8), spec.light);
    light.position.set(0.2 * U, -0.26 * U, 0); // outboard-aft corner of the fin
    fin.add(light);
    const pivot = new THREE.Group();
    pivot.rotation.y = spec.clock;
    pivot.add(fin);
    model.add(pivot);
  }

  // ── Engine ──
  const NOZZLE_EXIT_Y = -1.82 * U;
  const engineHousing = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34 * U, 0.4 * U, 0.28 * U, 48),
    graphite,
  );
  engineHousing.position.y = -1.3 * U;
  model.add(engineHousing);
  const bellOuter = new THREE.Mesh(
    new THREE.CylinderGeometry(0.17 * U, 0.35 * U, 0.42 * U, 32, 1, true),
    graphite,
  );
  bellOuter.position.y = -1.62 * U;
  model.add(bellOuter);
  const bellInner = new THREE.Mesh(
    new THREE.CylinderGeometry(0.155 * U, 0.33 * U, 0.4 * U, 32, 1, true),
    bellSteel,
  );
  bellInner.position.y = -1.61 * U;
  model.add(bellInner);

  // ── Plume: two additive cones, base pinned at the nozzle so PlayerShip's
  //    y-scale stretches the flame away only. Authored at full-burn size
  //    divided by the animation's max scale (y 1.3/1.2, radial 0.9). The
  //    constructor opacities are the coast level; PlayerShip overwrites
  //    them every frame. renderOrder puts the flame after the transparent
  //    starfield so a head-on view can't sort stars over it. ──
  const createExhaustCone = (
    radius: number,
    length: number,
    color: [number, number, number],
    coastOpacity: number,
  ): THREE.Mesh => {
    const geo = new THREE.ConeGeometry(radius * U, length * U, 20, 1, true);
    geo.rotateX(Math.PI);
    geo.translate(0, (-length / 2) * U, 0); // base at y 0, apex at -length
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: coastOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    mat.color.setRGB(...color);
    mat.toneMapped = false;
    const cone = new THREE.Mesh(geo, mat);
    cone.position.y = NOZZLE_EXIT_Y;
    cone.renderOrder = 1;
    return cone;
  };
  // Color intensities account for additive stack-up: the chase camera looks
  // almost end-on through the plume, so front wall + back wall + ember pile
  // up to ~3 surfaces per pixel. Coast opacity must stay under the bloom
  // threshold through that stack; only full-burn opacity crosses it, and
  // only near the lance's spine where the surfaces overlap.
  const exhaustCore = createExhaustCone(0.28, 1.77, [1.45, 1.95, 2.85], 0.077);
  const exhaustCone = createExhaustCone(0.53, 1.28, [0.7, 1.15, 2.5], 0.02);

  // Throat ember: shares the core material INSTANCE so it rides PlayerShip's
  // opacity ramp (a separate material would burn throttle-flat), and the
  // additive disc-plus-cone overlap makes the nozzle the natural hot spot.
  // CircleGeometry faces +Z; rotate to face rearward. Parent x/z scale
  // breathes its radius, y-scale only squeezes its zero thickness.
  const ember = new THREE.Mesh(
    new THREE.CircleGeometry(0.27 * U, 24),
    exhaustCore.material as THREE.MeshBasicMaterial,
  );
  ember.rotation.x = Math.PI / 2;
  ember.renderOrder = 1;
  exhaustCore.add(ember);

  model.add(exhaustCone, exhaustCore);
  model.rotation.z = -Math.PI / 2;

  return { model, mesh, exhaustCone, exhaustCore };
}

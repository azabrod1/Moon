import * as THREE from 'three';

export function createSaturnRings(planetRadiusAU: number): THREE.Mesh {
  // Saturn's rings extend from ~1.24 to ~2.27 planet radii
  const innerRadius = planetRadiusAU * 1.24;
  const outerRadius = planetRadiusAU * 2.27;

  const segments = 128;
  const geo = new THREE.RingGeometry(innerRadius, outerRadius, segments, 3);

  // Fix UVs: RingGeometry default UVs are cartesian (bad for radial texture).
  // Remap so u = 0 at inner edge, u = 1 at outer edge.
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getY(i); // RingGeometry is in XY plane before we rotate
    const r = Math.sqrt(x * x + z * z);
    const t = (r - innerRadius) / (outerRadius - innerRadius);
    uv.setXY(i, t, uv.getY(i));
  }

  // Generate a ring texture procedurally
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1;
  const ctx = canvas.getContext('2d')!;

  // Deterministic hash for consistent ring texture
  function seededRand(seed: number): number {
    const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  const imgData = ctx.createImageData(1024, 1);
  const data = imgData.data;

  for (let x = 0; x < 1024; x++) {
    const t = x / 1024; // 0 to 1 across the ring

    // Multiple ring bands with gaps (Cassini division, Encke gap, etc.)
    let alpha = 0.75;

    // C Ring (inner, faint)
    if (t < 0.18) {
      alpha *= 0.3 + t / 0.18 * 0.4;
    }

    // Cassini Division (around 60% of the way out)
    if (t > 0.57 && t < 0.63) alpha = 0.04;
    // Encke Gap
    if (t > 0.82 && t < 0.84) alpha = 0.08;
    // Inner edge falloff
    if (t < 0.05) alpha *= t / 0.05;
    // Outer edge falloff
    if (t > 0.92) alpha *= (1 - t) / 0.08;

    // Base color: warm ivory/tan
    const brightness = 200 + seededRand(x * 7.3) * 30;
    let r = brightness;
    let g = brightness * 0.92;
    let b = brightness * 0.78;

    if (t < 0.57) {
      // B ring (brightest, inner half)
      r *= 1.05;
      g *= 1.0;
    } else if (t > 0.63) {
      // A ring (slightly dimmer, outer)
      r *= 0.88;
      g *= 0.85;
      b *= 0.82;
      alpha *= 0.75;
    }

    // Add fine structure (deterministic gaps)
    if (seededRand(x * 13.7) < 0.04) alpha *= 0.15;

    const idx = x * 4;
    data[idx] = Math.floor(Math.min(255, r));
    data[idx + 1] = Math.floor(Math.min(255, g));
    data[idx + 2] = Math.floor(Math.min(255, b));
    data[idx + 3] = Math.floor(Math.min(255, alpha * 255));
  }

  ctx.putImageData(imgData, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  const mat = new THREE.MeshStandardMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
    roughness: 0.6,
    metalness: 0.05,
    emissive: new THREE.Color(0x1a1510),
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geo, mat);

  // Rings lie in the equatorial plane — rotate to lie flat (XZ plane)
  mesh.rotation.x = -Math.PI / 2;

  return mesh;
}

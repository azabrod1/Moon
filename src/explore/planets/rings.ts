import * as THREE from 'three';

export function createSaturnRings(planetRadiusAU: number): THREE.Mesh {
  // Saturn's rings extend from ~1.24 to ~2.27 planet radii
  const innerRadius = planetRadiusAU * 1.24;
  const outerRadius = planetRadiusAU * 2.27;

  const geo = new THREE.RingGeometry(innerRadius, outerRadius, 128, 3);

  // Generate a ring texture procedurally
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;

  // Deterministic hash for consistent ring texture
  function seededRand(seed: number): number {
    const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  // Draw ring bands
  for (let x = 0; x < 512; x++) {
    const t = x / 512; // 0 to 1 across the ring

    // Multiple ring bands with gaps (Cassini division, Encke gap, etc.)
    let alpha = 0.8;
    const brightness = 180 + seededRand(x * 7.3) * 40;

    // Cassini Division (around 60% of the way out)
    if (t > 0.57 && t < 0.63) alpha = 0.05;
    // Encke Gap
    if (t > 0.82 && t < 0.84) alpha = 0.1;
    // Inner edge falloff
    if (t < 0.1) alpha *= t / 0.1;
    // Outer edge falloff
    if (t > 0.9) alpha *= (1 - t) / 0.1;

    // B ring (brightest, inner half)
    let r = brightness, g = brightness * 0.9, b = brightness * 0.75;
    if (t < 0.57) {
      // Brighter B ring
      r *= 1.1;
      g *= 1.05;
    } else if (t > 0.63) {
      // A ring (slightly dimmer, outer)
      r *= 0.85;
      g *= 0.82;
      b *= 0.78;
      alpha *= 0.7;
    }

    // Add fine structure (deterministic gaps)
    if (seededRand(x * 13.7) < 0.03) alpha *= 0.2;

    for (let y = 0; y < 64; y++) {
      ctx.fillStyle = `rgba(${Math.floor(r)}, ${Math.floor(g)}, ${Math.floor(b)}, ${alpha})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;

  const mat = new THREE.MeshStandardMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
    roughness: 0.9,
    metalness: 0.0,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geo, mat);

  // Rings lie in the equatorial plane — rotate to lie flat (XZ plane)
  mesh.rotation.x = -Math.PI / 2;

  return mesh;
}

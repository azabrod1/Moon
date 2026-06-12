/**
 * Default Planetarium player-ship model — procedural THREE geometry.
 * Returns the assembled group plus the parts PlayerShip animates each frame
 * (the hull mesh and the two exhaust-plume cones).
 */
import * as THREE from 'three';
import { createHullGeometry, createEngineBell, createFin } from './shipPrimitives';

export interface DefaultShip {
  model: THREE.Group;
  mesh: THREE.Mesh;
  exhaustCone: THREE.Mesh;
  exhaustCore: THREE.Mesh;
}

export function createDefaultShip(referenceRadiusAU: number): DefaultShip {
  const hullRadius = referenceRadiusAU * 0.7;
  const shipLength = referenceRadiusAU * 3;

  // ── Hull ──
  const hullGeo = createHullGeometry(hullRadius, shipLength);
  const hullMat = new THREE.MeshStandardMaterial({
    color: 0xb0c0d8,
    emissive: 0x0a1220,
    emissiveIntensity: 0.08,
    roughness: 0.7,
    metalness: 0.15,
  });
  const hull = new THREE.Mesh(hullGeo, hullMat);
  const mesh = hull;

  // ── Accent stripe (ring around the hull) ──
  const stripeGeo = new THREE.TorusGeometry(hullRadius * 1.005, hullRadius * 0.04, 8, 24);
  const stripeMat = new THREE.MeshStandardMaterial({
    color: 0x2266cc,
    emissive: 0x0a1133,
    emissiveIntensity: 0.08,
    roughness: 0.5,
    metalness: 0.3,
  });
  const stripe = new THREE.Mesh(stripeGeo, stripeMat);
  stripe.position.y = shipLength * 0.3;
  stripe.rotation.x = Math.PI / 2;
  hull.add(stripe);

  // Second accent stripe lower
  const stripe2 = new THREE.Mesh(stripeGeo, stripeMat);
  stripe2.position.y = -shipLength * 0.2;
  stripe2.rotation.x = Math.PI / 2;
  hull.add(stripe2);

  // ── Cockpit canopy ──
  const canopyGeo = new THREE.SphereGeometry(hullRadius * 0.38, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55);
  const canopyMat = new THREE.MeshPhysicalMaterial({
    color: 0x88ddff,
    emissive: 0x112233,
    emissiveIntensity: 0.08,
    roughness: 0.15,
    metalness: 0.05,
    transparent: true,
    opacity: 0.65,
    clearcoat: 0.5,
    clearcoatRoughness: 0.2,
  });
  const canopy = new THREE.Mesh(canopyGeo, canopyMat);
  canopy.position.set(0, shipLength * 0.55, hullRadius * 0.65);
  canopy.rotation.x = -Math.PI * 0.15;
  hull.add(canopy);

  // ── Engine bell ──
  const bellGeo = createEngineBell(hullRadius, shipLength);
  const bellMat = new THREE.MeshStandardMaterial({
    color: 0x4a5058,
    emissive: 0x0c1018,
    emissiveIntensity: 0.1,
    roughness: 0.6,
    metalness: 0.3,
  });
  const bell = new THREE.Mesh(bellGeo, bellMat);
  bell.position.y = -shipLength * 0.5;
  hull.add(bell);

  // Inner engine glow ring
  const glowRingGeo = new THREE.TorusGeometry(hullRadius * 0.3, hullRadius * 0.04, 8, 16);
  const glowRingMat = new THREE.MeshBasicMaterial({
    color: 0x884422,
    transparent: true,
    opacity: 0.25,
  });
  const glowRing = new THREE.Mesh(glowRingGeo, glowRingMat);
  glowRing.position.y = -shipLength * 0.52;
  glowRing.rotation.x = Math.PI / 2;
  hull.add(glowRing);

  // ── Fins (3 swept delta fins) ──
  for (let i = 0; i < 3; i++) {
    const fin = createFin(hullRadius, shipLength);
    fin.rotation.y = (i * Math.PI * 2) / 3;
    hull.add(fin);
  }

  // ── Exhaust plume (layered) ──
  // Outer glow (wide, subtle)
  const outerGeo = new THREE.ConeGeometry(hullRadius * 0.6, shipLength * 0.5, 12);
  const outerMat = new THREE.MeshBasicMaterial({
    color: 0x2a3d66,
    transparent: true,
    opacity: 0.08,
  });
  const exhaustCone = new THREE.Mesh(outerGeo, outerMat);
  exhaustCone.position.y = -shipLength * 1.3;
  exhaustCone.rotation.x = Math.PI;

  // Inner core (narrow, moderate)
  const coreGeo = new THREE.ConeGeometry(hullRadius * 0.18, shipLength * 0.55, 8);
  const coreMat = new THREE.MeshBasicMaterial({
    color: 0x7799cc,
    transparent: true,
    opacity: 0.35,
  });
  const exhaustCore = new THREE.Mesh(coreGeo, coreMat);
  exhaustCore.position.y = -shipLength * 1.35;
  exhaustCore.rotation.x = Math.PI;

  // ── Nose tip accent ──
  const noseTipGeo = new THREE.SphereGeometry(hullRadius * 0.08, 8, 8);
  const noseTipMat = new THREE.MeshStandardMaterial({
    color: 0xcc2200,
    emissive: 0x551100,
    emissiveIntensity: 0.3,
    roughness: 0.3,
    metalness: 0.5,
  });
  const noseTip = new THREE.Mesh(noseTipGeo, noseTipMat);
  noseTip.position.y = shipLength * 1.12;
  hull.add(noseTip);

  const model = new THREE.Group();
  model.add(hull, exhaustCone, exhaustCore);
  model.rotation.z = -Math.PI / 2;

  return { model, mesh, exhaustCone, exhaustCore };
}

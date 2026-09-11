/**
 * What the studio draws: a body's interior model flattened to the few
 * things the faces and the legend need per region, inside-out as the
 * shader wants it. Two constructors: one from a schema model, one for the
 * unresolved whole a body gets when nothing is drawn by default (a poorly
 * constrained body, or one not yet modelled), so the renderer never has to
 * know which it holds. Pure and DOM-free; every value stays physical — the
 * Readable remap happens downstream in interiorGeometry.
 */
import type { InteriorModel, MaterialFamily, Phase, Region } from './data/interiorTypes';
import { representativeTemperatureK } from './data/interiorTypes';

export interface DrawnRegion {
  key: string;
  name: string;
  family: MaterialFamily;
  phase: Phase;
  outerRadiusKm: number;
  innerRadiusKm: number;
  /** Representative temperature, K, or null when the model says unknown. */
  temperatureK: number | null;
  /** The one-line composition for the legend row. */
  composition: string;
  /** Width, km, of the physical transition at this region's OUTER boundary; 0 when sharp or unknown. */
  transitionKm: number;
  /** The schema region behind this one, for the inspector; null for the unresolved whole. */
  region: Region | null;
}

export interface DrawnModel {
  bodyId: string;
  /** The model's own id, or null for the unresolved whole. */
  modelId: string | null;
  referenceRadiusKm: number;
  /** Inside-out, the innermost first; the last reaches the reference radius. */
  regionsInsideOut: DrawnRegion[];
  illustrative: boolean;
  model: InteriorModel | null;
}

export function drawnFromModel(model: InteriorModel): DrawnModel {
  let innerRadiusKm = 0;
  const regionsInsideOut = model.regions.map((region): DrawnRegion => {
    const drawn: DrawnRegion = {
      key: region.key,
      name: region.name,
      family: region.family,
      phase: region.phase,
      outerRadiusKm: region.outerRadiusKm,
      innerRadiusKm,
      temperatureK: representativeTemperatureK(region.temperatureK),
      composition: region.composition.value,
      transitionKm: region.boundary.transition.kind === 'distributed' ? region.boundary.transition.widthKm.value : 0,
      region,
    };
    innerRadiusKm = region.outerRadiusKm;
    return drawn;
  });
  return {
    bodyId: model.body,
    modelId: model.modelId,
    referenceRadiusKm: model.referenceRadiusKm,
    regionsInsideOut,
    illustrative: model.illustrative === true,
    model,
  };
}

/** One unresolved region the size of the body: the honest treatment for a
 *  body with nothing drawn by default, never another body's layers. */
export function drawnUnresolved(bodyId: string, radiusKm: number, composition: string): DrawnModel {
  return {
    bodyId,
    modelId: null,
    referenceRadiusKm: radiusKm,
    regionsInsideOut: [
      {
        key: 'interior',
        name: 'Interior',
        family: 'unresolved',
        phase: 'unresolved',
        outerRadiusKm: radiusKm,
        innerRadiusKm: 0,
        temperatureK: null,
        composition,
        transitionKm: 0,
        region: null,
      },
    ],
    illustrative: false,
    model: null,
  };
}

/** Outer radii as fractions of the reference radius, inside-out and
 *  increasing, the order the shader and the remap want; the last is 1. */
export function outerFractionsInsideOut(drawn: DrawnModel): number[] {
  const fractions = drawn.regionsInsideOut.map((region) => region.outerRadiusKm / drawn.referenceRadiusKm);
  fractions[fractions.length - 1] = 1;
  return fractions;
}

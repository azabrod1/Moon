/**
 * The Look-inside tool's recurring words, in one place: the button names,
 * headings and field labels the TypeScript writes into the panel, so a
 * wording change is one edit and a test can pin that none of them is empty.
 * The controls that live in the markup (index.html) carry the same words
 * as static text; the test reads the markup and pins that each of those
 * constants is still there, so the two cannot drift apart unnoticed.
 *
 * What belongs here is only the fixed furniture. Scientific description
 * stays with the model it describes (`data/models/*`), where its source
 * sits beside it; a sentence built around a number stays in
 * `inspectorText`, where the number is formatted; a line that depends on
 * what is drawn stays in `interiorLogic`, where the decision is made.
 *
 * Not a localisation framework: one language, plain words, read aloud
 * before they are written. A constant earns its place by being used in two
 * places or by being a phrase the reader must meet twice in the same wording.
 */
import type { TemperatureUnit } from './inspectorText';

// ---- leaving, and choosing what to look at ----------------------------------

export const BACK = 'Back';
/** The button says "Back"; a screen reader is told what it goes back to. */
export const BACK_ARIA = 'Back to planetarium';
export const CHOOSE_BODY = 'Choose a body';
export const VIEW_OPTIONS = 'View options';

// ---- the panel's sections ---------------------------------------------------

export const LAYERS = 'Layers';
export const DETAILS = 'Details';
export const EVIDENCE_AND_SOURCES = 'Evidence & sources';
export const MODEL_AND_SOURCES = 'Model & sources';
export const PROPERTIES = 'Properties';
export const HEAT_SOURCES = 'Heat sources';
export const RELATED_STRUCTURES = 'Related structures';
export const EARLIER_MODELS = 'Earlier models';
export const INTERIOR_MODEL = 'Interior model';
export const STRUCTURE_UNCERTAIN = 'Structure uncertain';

// ---- the fields beside a region's numbers -----------------------------------

export const DEPTH_BELOW_SURFACE = 'Depth below surface';
export const THICKNESS = 'Thickness';
export const TEMPERATURE = 'Temperature';
export const PRESSURE = 'Pressure';
export const DENSITY = 'Density';
export const BOUNDARY_ABOVE = 'Boundary above';

// ---- the controls -----------------------------------------------------------

export const CUT_ANGLE = 'Cut angle';
export const ENLARGE_THIN_LAYERS = 'Enlarge thin layers';
export const THIN_LAYERS_ENLARGED = 'Thin layers enlarged';
/** The one-tap link beside the thin-layers note, and the word it turns into once they are enlarged. */
export const ENLARGE = 'Enlarge';
export const ACTUAL_SIZE = 'Actual size';
export const RINGS = 'Rings';
export const TEMPERATURE_UNIT = 'Temperature unit';

// ---- the notes that say how far to trust the picture ------------------------

export const BOUNDARY_UNCERTAIN = 'Boundary location uncertain';
export const ILLUSTRATIVE_NOTE = 'Illustrative scenario. The internal structure is not well constrained.';
export const TEXTURES_NOTE = 'Colours distinguish materials. Interior textures are illustrative.';

// ---- an evidence row, in the order a reader walks it -------------------------

export const EVIDENCE = 'Evidence';
export const OBSERVATION = 'Observation';
export const INTERPRETATION = 'Interpretation';
export const LIMITATIONS = 'Assumptions and limitations';
export const SOURCES = 'Sources';

// ---- the words on the switches ----------------------------------------------

export const VIEW_LABEL: Record<'closed' | 'cutaway' | 'section', string> = {
  closed: 'Surface',
  cutaway: 'Cutaway',
  section: 'Section',
};

export const MODE_LABEL: Record<'composition' | 'temperature', string> = {
  composition: 'Materials',
  temperature: 'Temperature',
};

/** The unit symbols on the temperature switch; inspectorText prints the same
 *  two after every temperature it formats. */
export const UNIT_LABEL: Record<TemperatureUnit, string> = { kelvin: 'K', celsius: '°C' };

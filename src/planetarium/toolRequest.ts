/**
 * A request to leave the planetarium for one of its tools. Every entry —
 * the Tools popover, a map-card action, a `?auto=` boot — builds one of
 * these and hands it to PlanetariumMode.enterTool, which owns the guards
 * (tutorial, mission, one entry at a time), the pre-tool journey snapshot,
 * and the callback main.ts registered to make the switch. The request
 * carries the context the tool opens on, so no entry ever calls the mode
 * switch directly and none can skip the snapshot.
 */
export type ToolRequest =
  | { kind: 'volumeCompare' }
  | { kind: 'interior'; bodyId: string };

export type ToolKind = ToolRequest['kind'];

/**
 * What to tell the reader when a switch into a tool fails, and how.
 *
 * A tool's code is a chunk fetched on first use, and that fetch is the one
 * step of a switch that depends on the network. It fails for two reasons that
 * look the same from the outside: the connection is down, or the tab is older
 * than the site. Every deploy replaces the whole site, chunks are named by
 * their hash, and the data service worker never caches code, so a tab opened
 * before a deploy asks for a chunk name that no longer exists. In both cases
 * trying the button again in the same tab cannot succeed: the browser records
 * a failed module fetch in its module map and a second import() of the same
 * URL rejects at once, without a request. Only a reload helps, and the toast
 * says so and offers it.
 *
 * Everything else that can throw on the way in (a material that will not
 * build, a shader that will not link) is a fault in the app, reproducible on
 * the next tap, and the connection has nothing to do with it. That one gets a
 * different sentence, so a bug cannot hide behind the network's wording.
 *
 * Vite also raises a `vite:preloadError` event on the window when a chunk's
 * dependencies fail to preload. That path rethrows through the same import()
 * promise unless the event is default-prevented, so wrapping the promise
 * covers it and no listener is needed.
 */

/** A tool's chunk did not arrive. Wraps the import() rejection. */
export class ToolChunkLoadFailure extends Error {
  constructor(public readonly toolName: string, cause: unknown) {
    super(`The ${toolName} code could not be loaded`, { cause });
    this.name = 'ToolChunkLoadFailure';
  }
}

/** Await a tool's dynamic import through this, so its failure is told apart
 *  from a failure inside the tool. */
export function loadToolChunk<Module>(toolName: string, chunkImport: Promise<Module>): Promise<Module> {
  return chunkImport.catch((cause: unknown) => {
    throw new ToolChunkLoadFailure(toolName, cause);
  });
}

export interface ModeSwitchFailureNotice {
  text: string;
  /** Offered beside the text, for a failure the reader can act on. */
  action: 'reload' | null;
}

/** The sentence for a failed switch into `toolName`, from what threw. */
export function describeModeSwitchFailure(error: unknown, toolName: string): ModeSwitchFailureNotice {
  if (error instanceof ToolChunkLoadFailure) {
    return {
      text: `${toolName} could not be downloaded — the connection dropped, or this tab is older than the site. Reload to try again.`,
      action: 'reload',
    };
  }
  return {
    text: `${toolName} hit a problem and could not open. If it keeps happening, it is a fault in the app, not the connection.`,
    action: null,
  };
}

/**
 * Types for the build plugin, hand-written because tools/ sits outside the
 * TypeScript project (tsconfig includes only src/). They exist so
 * src/planetarium/swContract.test.ts can drive the real plugin — the same
 * object Vite drives — instead of restating what it does.
 *
 * Only the parts of Vite's resolved config the plugin reads are declared.
 */

/** Vite's resolved config, narrowed to what the plugin uses. `env` is the
 *  object that backs `import.meta.env` in the app: Vite merges `.env` files
 *  into it, and never into process.env. */
export interface SwPluginConfig {
  root: string;
  base: string;
  build: { outDir: string };
  env: Record<string, string | boolean | undefined>;
}

export interface SwPluginInstance {
  name: string;
  apply: 'build';
  configResolved(config: SwPluginConfig): void;
  closeBundle(): void;
}

export function tileOriginFrom(env: SwPluginConfig['env'] | undefined): string;

export default function swPlugin(): SwPluginInstance;

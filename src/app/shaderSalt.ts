/**
 * A DEV-only knob that forces a genuinely COLD shader compile, so the cost a
 * user pays on a first visit stays measurable on a machine that has already
 * paid it.
 *
 * A fresh browser profile and `--disable-gpu-shader-disk-cache` clear only the
 * caches the browser owns. macOS keeps its own Metal library cache outside the
 * profile, keyed on the shader source, so a second run of the same build links
 * from that cache and a first-visit stall becomes invisible to every
 * measurement — including the smoothness gate, whose numbers then describe a
 * boot no user gets.
 *
 * `?shaderSalt=<anything>` appends a no-op `#define` carrying that string to
 * every shader the renderer compiles. The source changes, so the driver's
 * cache key changes, so every program links cold again. Nothing else about the
 * program changes: the define is never referenced.
 *
 * The salt must land AFTER the `#version` directive — GLSL ES 3.00 requires
 * `#version` to be the first thing in the source, and a shader that puts
 * anything before it fails to compile.
 */

/** Longest salt carried into the define; anything past this adds no entropy
 *  and only bloats every shader in the session. */
const MAX_SALT_LENGTH = 32;

/** Build the no-op define line for a salt, with the salt reduced to the
 *  characters a preprocessor token may hold. */
export function shaderSaltDefine(salt: string): string {
  const token = salt.slice(0, MAX_SALT_LENGTH).replace(/[^A-Za-z0-9_]/g, '_');
  return `#define MOON_SHADER_SALT_${token || 'X'} 1\n`;
}

/** Insert `define` into `source`, after the `#version` directive when there is
 *  one. Only leading whitespace may precede `#version`, so a source that has
 *  one is split at the end of that line and a source that has none is simply
 *  prefixed. */
export function injectShaderSalt(source: string, define: string): string {
  const version = /^\s*#version[^\n]*\n/.exec(source);
  if (!version) return define + source;
  return source.slice(0, version[0].length) + define + source.slice(version[0].length);
}

/**
 * Wrap `gl.shaderSource` so every shader compiled through this context carries
 * the salt. Installed once, before anything compiles; a second install on the
 * same context would nest the wrappers and salt twice.
 */
export function installShaderSalt(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  salt: string,
): void {
  const define = shaderSaltDefine(salt);
  const original = gl.shaderSource.bind(gl);
  gl.shaderSource = (shader: WebGLShader, source: string): void => {
    original(shader, injectShaderSalt(source, define));
  };
}

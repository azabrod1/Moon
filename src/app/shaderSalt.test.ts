import { describe, expect, it } from 'vitest';
import { injectShaderSalt, installShaderSalt, shaderSaltDefine } from './shaderSalt';

describe('shaderSaltDefine', () => {
  it('reduces the salt to characters a preprocessor token may hold', () => {
    expect(shaderSaltDefine('boot-7:a b')).toBe('#define MOON_SHADER_SALT_boot_7_a_b 1\n');
  });

  it('caps the length, so a long salt cannot bloat every shader in the session', () => {
    const define = shaderSaltDefine('x'.repeat(200));
    expect(define).toBe(`#define MOON_SHADER_SALT_${'x'.repeat(32)} 1\n`);
  });

  it('still names something when the salt reduces to nothing', () => {
    // An empty token would emit `#define MOON_SHADER_SALT_ 1`, which is not a
    // valid identifier and would fail every compile in the session.
    expect(shaderSaltDefine('!!!')).toBe('#define MOON_SHADER_SALT____ 1\n');
    expect(shaderSaltDefine('')).toBe('#define MOON_SHADER_SALT_X 1\n');
  });
});

describe('injectShaderSalt', () => {
  it('puts the define after the #version directive, never before it', () => {
    // GLSL ES 3.00 requires #version to be the first thing in the source; a
    // shader with anything ahead of it does not compile at all.
    const source = '#version 300 es\nprecision highp float;\nvoid main() {}\n';
    expect(injectShaderSalt(source, '#define S 1\n'))
      .toBe('#version 300 es\n#define S 1\nprecision highp float;\nvoid main() {}\n');
  });

  it('prefixes a source that has no #version', () => {
    expect(injectShaderSalt('void main() {}\n', '#define S 1\n'))
      .toBe('#define S 1\nvoid main() {}\n');
  });

  it('keeps whitespace ahead of #version with the directive', () => {
    const salted = injectShaderSalt('\n  #version 300 es\nvoid main() {}\n', '#define S 1\n');
    expect(salted).toBe('\n  #version 300 es\n#define S 1\nvoid main() {}\n');
  });

  it('only ever moves one directive: a later #version-looking line is untouched', () => {
    const source = '#version 300 es\n// #version 100\nvoid main() {}\n';
    expect(injectShaderSalt(source, '#define S 1\n').split('#define S 1\n')).toHaveLength(2);
  });
});

describe('installShaderSalt', () => {
  it('salts every source the context compiles, and passes the shader through', () => {
    const seen: Array<{ shader: unknown; source: string }> = [];
    const shader = {} as WebGLShader;
    const gl = {
      shaderSource(target: WebGLShader, source: string) { seen.push({ shader: target, source }); },
    } as unknown as WebGL2RenderingContext;

    installShaderSalt(gl, 'nonce1');
    gl.shaderSource(shader, '#version 300 es\nvoid main() {}\n');
    gl.shaderSource(shader, 'void frag() {}\n');

    expect(seen).toEqual([
      { shader, source: '#version 300 es\n#define MOON_SHADER_SALT_nonce1 1\nvoid main() {}\n' },
      { shader, source: '#define MOON_SHADER_SALT_nonce1 1\nvoid frag() {}\n' },
    ]);
  });

  it('carries the same salt for the life of the context', () => {
    // A salt that varied per call would give two shaders of the same program
    // different keys and buy nothing but noise.
    const seen: string[] = [];
    const gl = {
      shaderSource(_target: WebGLShader, source: string) { seen.push(source); },
    } as unknown as WebGL2RenderingContext;
    installShaderSalt(gl, 'stable');
    gl.shaderSource({} as WebGLShader, 'a');
    gl.shaderSource({} as WebGLShader, 'b');
    expect(seen.map((s) => s.split('\n')[0])).toEqual([
      '#define MOON_SHADER_SALT_stable 1',
      '#define MOON_SHADER_SALT_stable 1',
    ]);
  });
});

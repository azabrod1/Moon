/**
 * One macro of a GLSL text resolved the way the preprocessor resolves it, and
 * every other directive left exactly where it is.
 *
 * The surface shader carries a switch as a compile-time define (CLOUD_SHADOW):
 * three emits `#define NAME` in front of the text when the material asks for
 * it, and the driver's preprocessor keeps one arm of each `#ifdef NAME` /
 * `#ifndef NAME` and drops the other along with the directive lines. A test
 * that pins a text has to read the arm the GPU will compile, and the claim
 * "with the define off the program is the text it was" is a claim about this
 * function's output with `defined` false.
 *
 * Only the named macro is evaluated. Conditionals on anything else (USE_MAP,
 * CLOUD_DECK) are kept verbatim, but their nesting is tracked, so an `#else`
 * or `#endif` is always matched to the conditional it closes.
 *
 * Test-only: no production module imports this.
 */
export function resolveDefine(text: string, name: string, defined: boolean): string {
  const lines = text.split('\n');
  const out: string[] = [];
  // One entry per open conditional: whether it is the named macro's, and if
  // so whether its current arm is kept.
  const stack: Array<{ mine: boolean; keep: boolean }> = [];
  const emitting = (): boolean => stack.every((e) => !e.mine || e.keep);
  for (const line of lines) {
    const d = /^\s*#\s*(ifdef|ifndef|if|elif|else|endif)\b\s*(\S*)/.exec(line);
    if (!d) {
      if (emitting()) out.push(line);
      continue;
    }
    const [, word, arg] = d;
    if (word === 'ifdef' || word === 'ifndef') {
      const mine = arg === name;
      stack.push({ mine, keep: mine ? (word === 'ifdef') === defined : true });
      if (!mine && emitting()) out.push(line);
      continue;
    }
    if (word === 'if') {
      stack.push({ mine: false, keep: true });
      if (emitting()) out.push(line);
      continue;
    }
    const top = stack[stack.length - 1];
    if (!top) throw new Error(`#${word} with no open conditional`);
    if (word === 'elif') {
      if (top.mine) throw new Error(`#elif under ${name} is not handled`);
      if (emitting()) out.push(line);
      continue;
    }
    if (word === 'else') {
      if (top.mine) top.keep = !top.keep;
      else if (emitting()) out.push(line);
      continue;
    }
    // endif
    stack.pop();
    if (!top.mine && emitting()) out.push(line);
  }
  if (stack.length !== 0) throw new Error('unclosed conditional');
  return out.join('\n');
}

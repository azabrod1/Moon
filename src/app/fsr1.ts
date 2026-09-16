/**
 * FSR 1 — AMD FidelityFX Super Resolution 1.0, the spatial upscaler: EASU
 * (edge adaptive spatial upsampling) and RCAS (robust contrast adaptive
 * sharpening), as GLSL ES 3.00 fragment shaders for a full-screen quad.
 *
 * Ported from ffx_fsr1.h v1.20210629 and ffx_a.h (FidelityFX-FSR, MIT). The
 * shader text below is a transcription of FsrEasuF / FsrRcasF, kept line for
 * line where the two languages allow, so it can be checked against the
 * reference rather than trusted. The differences, each on purpose:
 *
 * - The reference gathers its 12 taps with four gather4 calls per channel
 *   (FsrEasuRF/GF/BF at the con1..con3 positions); WebGL2 has no gather, so
 *   the 12 texels are fetched by integer offset from 'f' with texelFetch,
 *   clamped to the image (the reference's sampler clamps to edge). The
 *   letters (b c / e f g h / i j k l / n o) and their offsets are the
 *   reference's; only the fetch differs.
 * - The reference's y grows down the image; a WebGL framebuffer's grows up.
 *   Everything here — the taps, the fraction inside the 2×2, the gradient
 *   sets and the directions — is in the framebuffer's own space, and the
 *   12-tap layout with its four gradient sets is mirror-symmetric about the
 *   centre row, so the filter in the flipped frame is the reference's filter
 *   of the flipped image: the same output.
 * - The reference's bit-trick reciprocals (APrxLoRcpF1, APrxLoRsqF1,
 *   APrxMedRcpF1) are kept as written, through floatBitsToUint /
 *   uintBitsToFloat. They are not an optimisation here: a flat region has a
 *   gradient of exactly 0, and its reciprocal is what keeps the length term
 *   finite (an exact 1/0 is an infinity, and 0 × ∞ a NaN over the whole
 *   pixel).
 * - RCAS divides by the ring's extremes, `4·max` and `4·min − 4`, which the
 *   reference leaves bare: game content rarely has a pure black or pure
 *   white ring, and space around a star is exactly a black one. Where a
 *   divisor is exactly zero the numerator is zero too, and the limiter is
 *   written as 0 there (no sharpening of an isolated point) instead of the
 *   0/0 the GLSL spec leaves undefined inside min/max; everywhere else the
 *   division is the reference's, untouched.
 * - RCAS's noise-detection term (FSR_RCAS_DENOISE) is left out, as the
 *   reference recommends for content without film grain.
 * - Alpha is written as 1: the canvas is opaque.
 *
 * Input requirements, from the reference: colour in [0, 1], tone-mapped and
 * display-encoded (sRGB), no alpha, no banding, 32-bit-per-pixel storage —
 * i.e. what OutputPass writes into an RGBA8 target. EASU is specified good
 * from 1× to 2× linear scaling; RCAS runs on EASU's output at output size.
 *
 * ---------------------------------------------------------------------------
 * Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files(the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and / or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions :
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * ---------------------------------------------------------------------------
 */

/** RCAS's default sharpness, in stops below maximum (0 = sharpest; each stop halves). */
export const RCAS_DEFAULT_STOPS = 0.2;

/**
 * The linear sharpness RCAS multiplies its lobe by, from stops (FsrRcasCon):
 * 2^-stops, so 0 is the reference's maximum and every stop halves it.
 */
export function rcasSharpness(stops: number): number {
  return Math.pow(2, -Math.max(0, stops));
}

/**
 * EASU's con0 (FsrEasuCon): output pixel index → input pixel position, as
 * `xy` scale and `zw` offset. The offset carries the half-pixel: the output
 * pixel's centre lands at (i + 0.5)·scale in the input, and 'f' — the texel
 * the 2×2 neighbourhood starts from — is the floor of that minus 0.5. The
 * reference's con1..con3 are gather positions and are not needed with
 * texelFetch.
 */
export function easuConstants(
  inputWidth: number,
  inputHeight: number,
  outputWidth: number,
  outputHeight: number,
): [number, number, number, number] {
  const sx = inputWidth / outputWidth;
  const sy = inputHeight / outputHeight;
  return [sx, sy, 0.5 * sx - 0.5, 0.5 * sy - 0.5];
}

/** The full-screen vertex shader the three passes share: three's FullScreenQuad
 *  geometry is already in clip space. */
export const FSR1_VERTEX_SHADER = /* glsl */ `
precision highp float;
in vec3 position;
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** The reciprocal approximations from ffx_a.h, bit for bit. */
const PRX_GLSL = /* glsl */ `
// APrxLoRcpF1: a low-precision 1/a from the exponent bits; finite at a = 0.
float prxLoRcp(float a) { return uintBitsToFloat(0x7ef07ebbu - floatBitsToUint(a)); }
// APrxLoRsqF1: a low-precision 1/sqrt(a) the same way.
float prxLoRsq(float a) { return uintBitsToFloat(0x5f347d74u - (floatBitsToUint(a) >> 1u)); }
// APrxMedRcpF1: one Newton step on the low one.
float prxMedRcp(float a) { float b = uintBitsToFloat(0x7ef19fffu - floatBitsToUint(a)); return b * (-b * a + 2.0); }
`;

/**
 * EASU. Uniforms: `tInput` (the render-size image), `uCon0` (easuConstants),
 * `uInputMax` (input size − 1, the fetch clamp). One output pixel per
 * fragment at output size.
 */
export const EASU_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D tInput;
uniform vec4 uCon0;
uniform ivec2 uInputMax;
out vec4 fragColor;
${PRX_GLSL}
vec3 tap(ivec2 p) { return texelFetch(tInput, clamp(p, ivec2(0), uInputMax), 0).rgb; }

// FsrEasuTapF: one tap of the directionally stretched lanczos2 approximation.
void easuTap(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len, float lob, float clp, vec3 c) {
  // Rotate offset by direction.
  vec2 v = vec2(off.x * dir.x + off.y * dir.y, off.x * -dir.y + off.y * dir.x);
  // Anisotropy.
  v *= len;
  // Distance squared, limited to the window (at a corner two taps can be outside).
  float d2 = min(dot(v, v), clp);
  // (25/16 * (2/5 * x^2 - 1)^2 - (25/16 - 1)) * (1/4 * x^2 - 1)^2: base times window.
  float wB = (2.0 / 5.0) * d2 - 1.0;
  float wA = lob * d2 - 1.0;
  wB *= wB;
  wA *= wA;
  wB = (25.0 / 16.0) * wB - (25.0 / 16.0 - 1.0);
  float w = wB * wA;
  aC += c * w;
  aW += w;
}

// FsrEasuSetF: accumulate direction and length from one '+' of lumas
// (a above, b left, c centre, d right, e below), weighted by the bilinear
// weight of that set's centre.
void easuSet(inout vec2 dir, inout float len, float w, float lA, float lB, float lC, float lD, float lE) {
  float dc = lD - lC;
  float cb = lC - lB;
  float lenX = max(abs(dc), abs(cb));
  lenX = prxLoRcp(lenX);
  float dirX = lD - lB;
  dir.x += dirX * w;
  lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);
  lenX *= lenX;
  len += lenX * w;
  float ec = lE - lC;
  float ca = lC - lA;
  float lenY = max(abs(ec), abs(ca));
  lenY = prxLoRcp(lenY);
  float dirY = lE - lA;
  dir.y += dirY * w;
  lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);
  lenY *= lenY;
  len += lenY * w;
}

// Luma times 2, in two FMAs (the reference's approximate luma).
float luma2(vec3 c) { return c.b * 0.5 + (c.r * 0.5 + c.g); }

void main() {
  // FsrEasuF. Position of 'f': the output pixel index through con0.
  vec2 pp = floor(gl_FragCoord.xy) * uCon0.xy + uCon0.zw;
  vec2 fp = floor(pp);
  pp -= fp;
  ivec2 f = ivec2(fp);
  // The 12-tap kernel, by offset from 'f' (the reference's letters):
  //    b c
  //  e f g h
  //  i j k l
  //    n o
  vec3 tB = tap(f + ivec2( 0, -1));
  vec3 tC = tap(f + ivec2( 1, -1));
  vec3 tE = tap(f + ivec2(-1,  0));
  vec3 tF = tap(f);
  vec3 tG = tap(f + ivec2( 1,  0));
  vec3 tH = tap(f + ivec2( 2,  0));
  vec3 tI = tap(f + ivec2(-1,  1));
  vec3 tJ = tap(f + ivec2( 0,  1));
  vec3 tK = tap(f + ivec2( 1,  1));
  vec3 tL = tap(f + ivec2( 2,  1));
  vec3 tN = tap(f + ivec2( 0,  2));
  vec3 tO = tap(f + ivec2( 1,  2));
  float bL = luma2(tB);
  float cL = luma2(tC);
  float eL = luma2(tE);
  float fL = luma2(tF);
  float gL = luma2(tG);
  float hL = luma2(tH);
  float iL = luma2(tI);
  float jL = luma2(tJ);
  float kL = luma2(tK);
  float lL = luma2(tL);
  float nL = luma2(tN);
  float oL = luma2(tO);
  // Accumulate for bilinear interpolation: the four '+' sets centred on
  // f, g, j and k, each with its corner's bilinear weight.
  vec2 dir = vec2(0.0);
  float len = 0.0;
  easuSet(dir, len, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);
  easuSet(dir, len,        pp.x  * (1.0 - pp.y), cL, fL, gL, hL, kL);
  easuSet(dir, len, (1.0 - pp.x) *        pp.y , fL, iL, jL, kL, nL);
  easuSet(dir, len,        pp.x  *        pp.y , gL, jL, kL, lL, oL);
  // Normalize with approximation, and cleanup close to zero.
  vec2 dir2 = dir * dir;
  float dirR = dir2.x + dir2.y;
  bool zro = dirR < (1.0 / 32768.0);
  dirR = prxLoRsq(dirR);
  dirR = zro ? 1.0 : dirR;
  dir.x = zro ? 1.0 : dir.x;
  dir *= dirR;
  // Transform from {0 to 2} to {0 to 1} range, and shape with square.
  len = len * 0.5;
  len *= len;
  // Stretch kernel {1.0 vert|horz, to sqrt(2.0) on diagonal}.
  float stretch = (dir.x * dir.x + dir.y * dir.y) * prxLoRcp(max(abs(dir.x), abs(dir.y)));
  // Anisotropic length after rotation: x 1.0 → 'stretch' on edges, y 1.0 → 0.5 on edges.
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  // Based on the amount of 'edge', the window shifts from +/-{sqrt(2.0) to slightly beyond 2.0}.
  float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
  // Set distance^2 clipping point to the end of the adjustable window.
  float clp = prxLoRcp(lob);
  // Min and max of the 4 nearest, for the dering.
  vec3 min4 = min(min(tF, tG), min(tJ, tK));
  vec3 max4 = max(max(tF, tG), max(tJ, tK));
  // Accumulation.
  vec3 aC = vec3(0.0);
  float aW = 0.0;
  easuTap(aC, aW, vec2( 0.0, -1.0) - pp, dir, len2, lob, clp, tB);
  easuTap(aC, aW, vec2( 1.0, -1.0) - pp, dir, len2, lob, clp, tC);
  easuTap(aC, aW, vec2(-1.0,  1.0) - pp, dir, len2, lob, clp, tI);
  easuTap(aC, aW, vec2( 0.0,  1.0) - pp, dir, len2, lob, clp, tJ);
  easuTap(aC, aW, vec2( 0.0,  0.0) - pp, dir, len2, lob, clp, tF);
  easuTap(aC, aW, vec2(-1.0,  0.0) - pp, dir, len2, lob, clp, tE);
  easuTap(aC, aW, vec2( 1.0,  1.0) - pp, dir, len2, lob, clp, tK);
  easuTap(aC, aW, vec2( 2.0,  1.0) - pp, dir, len2, lob, clp, tL);
  easuTap(aC, aW, vec2( 2.0,  0.0) - pp, dir, len2, lob, clp, tH);
  easuTap(aC, aW, vec2( 1.0,  0.0) - pp, dir, len2, lob, clp, tG);
  easuTap(aC, aW, vec2( 1.0,  2.0) - pp, dir, len2, lob, clp, tO);
  easuTap(aC, aW, vec2( 0.0,  2.0) - pp, dir, len2, lob, clp, tN);
  // Normalize and dering.
  fragColor = vec4(min(max4, max(min4, aC * (1.0 / aW))), 1.0);
}
`;

/**
 * RCAS. Uniforms: `tInput` (EASU's output, at output size), `uInputMax`
 * (its size − 1), `uSharpness` (rcasSharpness). One pixel per fragment, in
 * place.
 */
export const RCAS_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D tInput;
uniform ivec2 uInputMax;
uniform float uSharpness;
out vec4 fragColor;
${PRX_GLSL}
vec3 tap(ivec2 p) { return texelFetch(tInput, clamp(p, ivec2(0), uInputMax), 0).rgb; }
// FSR_RCAS_LIMIT: the limit of providing unnatural results for sharpening.
const float RCAS_LIMIT = 0.25 - (1.0 / 16.0);
// n / d per channel, 0 where d is 0 (the reference's bare division there is 0 / 0).
vec3 div0(vec3 n, vec3 d) {
  return vec3(d.x != 0.0 ? n.x / d.x : 0.0, d.y != 0.0 ? n.y / d.y : 0.0, d.z != 0.0 ? n.z / d.z : 0.0);
}

void main() {
  // FsrRcasF. The 3x3 cross:
  //    b
  //  d e f
  //    h
  ivec2 sp = ivec2(gl_FragCoord.xy);
  vec3 b = tap(sp + ivec2( 0, -1));
  vec3 d = tap(sp + ivec2(-1,  0));
  vec3 e = tap(sp);
  vec3 f = tap(sp + ivec2( 1,  0));
  vec3 h = tap(sp + ivec2( 0,  1));
  // Min and max of ring.
  vec3 mn4 = min(min(b, d), min(f, h));
  vec3 mx4 = max(max(b, d), max(f, h));
  // Immediate constants for peak range.
  vec2 peakC = vec2(1.0, -1.0 * 4.0);
  // Limiters: where the lobe would clip the signal below 0 or above 1. Where
  // the reference's divisor is exactly zero (see the header) the limiter is
  // 0; everywhere else it is the reference's value.
  vec3 hitMin = div0(min(mn4, e), 4.0 * mx4);
  vec3 hitMax = div0(peakC.x - max(mx4, e), 4.0 * mn4 + peakC.y);
  vec3 lobeRGB = max(-hitMin, hitMax);
  float lobe = max(-RCAS_LIMIT, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * uSharpness;
  // Resolve, which needs the medium precision rcp approximation to avoid visible tonality changes.
  float rcpL = prxMedRcp(4.0 * lobe + 1.0);
  fragColor = vec4((lobe * (b + d + h + f) + e) * rcpL, 1.0);
}
`;


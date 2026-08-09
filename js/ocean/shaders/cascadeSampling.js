/**
 * Cascade sampler declarations.
 *
 * ESSL 3.00 requires sampler array indices to be *constant expressions*, and a
 * loop counter does not qualify (that relaxation arrives in later GLSL
 * versions). `uniform sampler2D uDisp[4]` indexed by a loop variable fails to
 * compile on conforming drivers, so cascades are declared individually and the
 * per-cascade work is expanded by macro.
 *
 * Non-sampler arrays such as uPatch have no such restriction, but they are
 * indexed literally here anyway for symmetry.
 */

export const CASCADE_UNIFORMS_GLSL = /* glsl */ `
uniform sampler2D uDisp0;
uniform sampler2D uDisp1;
uniform sampler2D uDisp2;
uniform sampler2D uDisp3;
uniform sampler2D uDeriv0;
uniform sampler2D uDeriv1;
uniform sampler2D uDeriv2;
uniform sampler2D uDeriv3;
uniform float uPatch[4];
`;

/** Names in cascade order, for JS-side uniform binding. */
export const DISP_UNIFORM_NAMES = ["uDisp0", "uDisp1", "uDisp2", "uDisp3"];
export const DERIV_UNIFORM_NAMES = ["uDeriv0", "uDeriv1", "uDeriv2", "uDeriv3"];

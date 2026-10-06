/**
 * Open Lounge avatar shape: a heavily rounded hexagon (flat top and bottom).
 *
 * Path in objectBoundingBox units (0..1), shared by the global SVG <clipPath id="openlounge-hex">
 * (layout.tsx) and the speaking / podium outlines (Avatar.tsx) so they always match.
 *
 * Built as a regular hexagon whose six corners are circular arcs with radius = 92% of the
 * hexagon's inradius (about 46% of the avatar's size), then scaled to fill 0.01..0.99.
 * This reads as almost a circle while keeping a faint hint of the six flat sides.
 * (Generator: corner arcs as cubic Beziers, k = 4/3 * tan(15deg).)
 */
export const HEX_PATH =
  "M0.9303,0.7254 L0.908,0.7646 C0.8284,0.9041 0.6814,0.99 0.5224,0.99 L0.4776,0.99 C0.3186,0.99 0.1716,0.9041 0.092,0.7646 L0.0697,0.7254 C-0.0099,0.5859 -0.0099,0.4141 0.0697,0.2746 L0.092,0.2354 C0.1716,0.0959 0.3186,0.01 0.4776,0.01 L0.5224,0.01 C0.6814,0.01 0.8284,0.0959 0.908,0.2354 L0.9303,0.2746 C1.0099,0.4141 1.0099,0.5859 0.9303,0.7254 Z";

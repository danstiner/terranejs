/**
 * Shared geometric typedefs for the terranejs core. JSDoc-only — no runtime code.
 *
 * @typedef {[number, number, number, number]} BBox
 *   Geographic bounds as [south, west, north, east] in degrees.
 * @typedef {[number, number]} Cell
 *   Integer cell coordinate [i, j] on the tile lattice (+i east, +j south).
 * @typedef {[number, number]} LatLon
 *   A point as [latitude, longitude] in degrees.
 * @typedef {"square" | "hex" | "circle"} Shape
 *   Tile footprint shape.
 * @typedef {"none" | "flat" | "all"} WaterMode
 *   How the water mode treats the mask. `none` leaves water at true elevation; `flat` pulls all
 *   of it onto one plane below the land; `all` sinks all of it by the recess depth. The mode is the
 *   one setting a user picks — whether the geometry flattens or sinks comes from it, which is why
 *   `none` ignores a nonzero recess outright rather than needing the depth cleared to match.
 * @typedef {{ gx0: number, gy0: number, gw: number, gh: number }} Window
 *   Inclusive global-pixel window: origin (gx0,gy0), width gw, height gh.
 * @typedef {{ data: Float32Array, width: number, height: number, originGx: number, originGy: number, z: number }} Mosaic
 *   Rectangle of elevation values in web-mercator global-pixel space. Produced
 *   by stiching several tiles together into a single "mosaic". `data` is a
 *   row-major width×height Float32Array of metres; (originGx,originGy) is the
 *   global pixel of data[0] (row 0 = north); z is the source zoom.
 * @typedef {{ positions: Float32Array, indices: Uint32Array,
 *   mirrored?: boolean, loops?: number }} Solid
 *   Indexed watertight mesh: xyz per vertex in `positions`, three vertex ids per
 *   triangle in `indices`, outward-wound. `mirrored` records that assembleSolid could not stitch
 *   a flat base and mirrored the top instead — not a defect on its own, since buildDrape and the
 *   cord ask for it, but on a TILE it is the fingerprint of a non-conforming seam that no other
 *   check can see. `loops` is how many boundary loops that flat base was stitched from; 0 when
 *   mirrored.
 * @typedef {{ r0: number, r1: number, c0: number, c1: number }} Span
 *   Half-open grid-cell span: rows [r0,r1), columns [c0,c1) selecting a tile's cells.
 * @typedef {{ inside: Uint8Array, crossOf: Map<number, number[]>,
 *   ringOf: Map<number, number[]>, bcells: Set<number>, col: number[], row: number[],
 *   elev: Float64Array, gw: number, gh: number, HBASE: number }} Clip
 *   Footprint clip. `inside` is a gw×gh vertex mask. `crossOf` maps a grid-edge key to the
 *   vertex ids crossing it, ordered along the edge — the same ids for both cells sharing the
 *   edge, which is what keeps the clipped top surface free of interior boundary. `ringOf`
 *   maps a cell key to ring vertices strictly inside that cell; `bcells` is the set of cells
 *   the boundary touches. Ids at or above gw*gh index col/row/elev at (id − gw*gh).
 */
export {};

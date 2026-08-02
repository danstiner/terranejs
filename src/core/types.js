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
 * @typedef {{ gx0: number, gy0: number, gw: number, gh: number }} Window
 *   Inclusive global-pixel window: origin (gx0,gy0), width gw, height gh.
 * @typedef {{ data: Float32Array, width: number, height: number, originGx: number, originGy: number, z: number }} Mosaic
 *   Rectangle of elevation values in web-mercator global-pixel space. Produced
 *   by stiching several tiles together into a single "mosaic". `data` is a
 *   row-major width×height Float32Array of metres; (originGx,originGy) is the
 *   global pixel of data[0] (row 0 = north); z is the source zoom.
 * @typedef {{ positions: Float32Array, indices: Uint32Array }} Solid
 *   Indexed watertight mesh: xyz per vertex in `positions`, three vertex ids per
 *   triangle in `indices`, outward-wound.
 * @typedef {{ r0: number, r1: number, c0: number, c1: number }} Span
 *   Half-open grid-cell span: rows [r0,r1), columns [c0,c1) selecting a tile's cells.
 * @typedef {{ inside: Uint8Array, idOf: Map<number, number>, col: number[], row: number[],
 *   ea: number[], eb: number[], et: number[], elev: Float64Array, gw: number, HBASE: number }} Clip
 *   Circle footprint clip. `inside` is a gw×gh vertex mask. `idOf` maps a grid-edge key to
 *   the vertex id at that edge's crossing — the same id for both cells sharing the edge,
 *   which is what keeps the clipped top surface free of interior boundary. Ids at or above
 *   gw*gh index col/row/ea/eb/et/elev at (id − gw*gh).
 */
export {};

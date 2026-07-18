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
 */
export {};

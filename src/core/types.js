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
 */
export {};

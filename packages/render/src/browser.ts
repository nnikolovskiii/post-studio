// Browser entry (the editor canvas): the pure document → SVG renderer, without resvg, sharp,
// headless Chrome or the exporter, which need Node.
export * from "./types.ts";
export * from "./render.ts";
export { sketchPaths, sketchParams, sketchSeed, seededRandom, flattenPath, hatchSegments, SKETCH_DEFAULTS, SKETCH_FILLS, type SketchParams, type SketchPaths } from "./sketch.ts";
export { imageSize } from "./image-size.ts";
export { inlineSvgAsset, recolorText, fitViewBox, viewBoxOf } from "./svg-asset.ts";
export { fontFaceCss, unicodeRange } from "./fonts.ts";
export { num, paint } from "./util.ts";

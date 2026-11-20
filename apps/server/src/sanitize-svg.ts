// Allow-list SVG sanitizer. Uploaded and agent-made SVG is shown in the browser editor,
// so anything that can run script or fetch from outside is removed.
import { DOMParser, XMLSerializer, type Element as XElement, type Node as XNode } from "@xmldom/xmldom";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

const ELEMENTS = new Set([
  "svg", "g", "defs", "symbol", "use", "title", "desc", "metadata",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "textPath",
  "linearGradient", "radialGradient", "stop", "pattern", "clipPath", "mask",
  "image", "style",
  // Filter primitives that only compute pixels. feImage (can load a URL) stays out.
  "filter", "feBlend", "feColorMatrix", "feComponentTransfer", "feFuncR", "feFuncG", "feFuncB", "feFuncA",
  "feComposite", "feConvolveMatrix", "feDiffuseLighting", "feSpecularLighting", "feDistantLight", "fePointLight",
  "feSpotLight", "feDisplacementMap", "feDropShadow", "feFlood", "feGaussianBlur", "feMerge", "feMergeNode",
  "feMorphology", "feOffset", "feTile", "feTurbulence",
]);

const ATTRS = new Set([
  "id", "class", "style", "transform", "viewBox", "preserveAspectRatio", "width", "height", "x", "y",
  "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "pathLength",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap",
  "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "opacity", "color",
  "clip-path", "clip-rule", "mask", "display", "visibility", "vector-effect", "paint-order", "shape-rendering",
  "font-family", "font-size", "font-weight", "font-style", "letter-spacing", "word-spacing",
  "text-anchor", "dominant-baseline", "alignment-baseline", "baseline-shift", "dx", "dy", "rotate", "textLength", "lengthAdjust",
  "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "spreadMethod", "fx", "fy", "fr",
  "patternUnits", "patternContentUnits", "patternTransform", "clipPathUnits", "maskUnits", "maskContentUnits",
  "filter", "filterUnits", "primitiveUnits", "color-interpolation-filters", "in", "in2", "result", "mode", "type",
  "values", "operator", "k1", "k2", "k3", "k4", "stdDeviation", "edgeMode", "baseFrequency", "numOctaves", "seed",
  "stitchTiles", "tableValues", "slope", "intercept", "amplitude", "exponent", "scale", "xChannelSelector",
  "yChannelSelector", "radius", "flood-color", "flood-opacity", "lighting-color", "surfaceScale", "diffuseConstant",
  "specularConstant", "specularExponent", "kernelUnitLength", "kernelMatrix", "order", "divisor", "bias", "targetX",
  "targetY", "preserveAlpha", "azimuth", "elevation", "z", "pointsAtX", "pointsAtY", "pointsAtZ", "limitingConeAngle",
  "mix-blend-mode", "isolation",
  "href", "xlink:href", "xmlns", "xmlns:xlink", "version", "xml:space", "data-name", "role", "aria-label", "aria-hidden",
]);

const SAFE_DATA_IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/;

export class SvgRejected extends Error {}

export interface SanitizeResult {
  svg: string;
  removed: string[];
}

function unsafeCss(css: string): boolean {
  const s = css.toLowerCase();
  if (s.includes("@import") || s.includes("expression(") || s.includes("javascript:") || s.includes("behavior:")) return true;
  for (const m of s.matchAll(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/g)) if (!m[2].startsWith("#")) return true;
  return false;
}

export function sanitizeSvg(input: string): SanitizeResult {
  if (/<!DOCTYPE|<!ENTITY/i.test(input)) throw new SvgRejected("SVG with DOCTYPE or ENTITY declarations is not accepted");
  const errors: string[] = [];
  const doc = new DOMParser({
    onError: (level: string, msg: string) => {
      if (level !== "warning") errors.push(msg);
    },
  }).parseFromString(input, "image/svg+xml");
  const root = doc.documentElement;
  if (errors.length || !root) throw new SvgRejected(`SVG does not parse: ${errors[0] ?? "empty document"}`);
  if (root.localName !== "svg") throw new SvgRejected(`root element is <${root.localName}>, not <svg>`);
  const removed: string[] = [];

  const walk = (el: XElement) => {
    for (const child of Array.from(el.childNodes) as XNode[]) {
      if (child.nodeType === 7 || child.nodeType === 8) {
        el.removeChild(child);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const c = child as XElement;
      const name = c.localName ?? c.nodeName;
      const ns = c.namespaceURI;
      if (!ELEMENTS.has(name) || (ns && ns !== SVG_NS)) {
        removed.push(`<${c.nodeName}>`);
        el.removeChild(c);
        continue;
      }
      if (name === "style" && unsafeCss(c.textContent ?? "")) {
        removed.push("<style> with external references");
        el.removeChild(c);
        continue;
      }
      cleanAttrs(c);
      walk(c);
    }
  };

  const cleanAttrs = (el: XElement) => {
    for (const a of Array.from(el.attributes)) {
      const n = a.name;
      const v = a.value;
      let drop = !ATTRS.has(n) || n.toLowerCase().startsWith("on");
      if (!drop && (n === "href" || n === "xlink:href")) {
        drop = !(v.startsWith("#") || (el.localName === "image" && SAFE_DATA_IMAGE.test(v)));
      }
      if (!drop && n === "style") drop = unsafeCss(v);
      if (!drop && /url\(/i.test(v) && n !== "style") drop = unsafeCss(v);
      if (!drop && /^\s*javascript:/i.test(v)) drop = true;
      if (drop) {
        removed.push(`@${n} on <${el.nodeName}>`);
        el.removeAttributeNode(a);
      }
    }
  };

  cleanAttrs(root);
  walk(root);
  if (!root.getAttribute("xmlns")) root.setAttribute("xmlns", SVG_NS);
  if (root.toString().includes("xlink:") && !root.getAttribute("xmlns:xlink")) root.setAttribute("xmlns:xlink", XLINK_NS);
  return { svg: new XMLSerializer().serializeToString(root), removed };
}

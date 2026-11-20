// Phase 8 phone review view: the pure parts (which view opens, text layers, plain edit → spans,
// zoom maths). The UI itself is driven in headless Chrome in phone.e2e.test.ts.
import { describe, expect, it } from "vitest";
import type { Frame, TextNode } from "@post-studio/schema";
import { applyPlainEdit, chooseView, layerLabel, clampPan, isPhoneLike, MAX_PHONE_RUNS, phoneEditBlock, pinchStep, styledRuns, textLayers, zoomAbout } from "../src/model/phone.ts";
import { fullText, type Span } from "../src/model/richtext.ts";

const S24 = { coarse: true, shortSide: 384 };
const LAPTOP = { coarse: false, shortSide: 1080 };
const TABLET = { coarse: true, shortSide: 800 };

const text = (id: string, spans: Span[], extra: Partial<TextNode> = {}): TextNode =>
  ({ id, type: "text", x: 10, y: 10, box: "auto-width", align: "left", style: { font: "IBM Plex Sans", weight: 400, size: 40, lineHeight: 1.2, letterSpacing: 0, fill: "#111111" }, spans, ...extra }) as TextNode;

describe("which view opens", () => {
  it("a phone gets the phone view, a laptop and a tablet the desktop editor", () => {
    expect(isPhoneLike(S24)).toBe(true);
    expect(chooseView(null, null, S24)).toEqual({ mode: "phone" });
    expect(chooseView(null, null, LAPTOP)).toEqual({ mode: "desktop" });
    expect(chooseView(null, null, TABLET)).toEqual({ mode: "desktop" });
    // A narrow desktop window with a mouse stays desktop.
    expect(chooseView(null, null, { coarse: false, shortSide: 380 })).toEqual({ mode: "desktop" });
  });
  it("the remembered choice wins over the device, ?view= wins over both and is remembered", () => {
    expect(chooseView(null, "desktop", S24)).toEqual({ mode: "desktop" });
    expect(chooseView(null, "phone", LAPTOP)).toEqual({ mode: "phone" });
    expect(chooseView("phone", "desktop", LAPTOP)).toEqual({ mode: "phone", remember: "phone" });
    expect(chooseView("desktop", null, S24)).toEqual({ mode: "desktop", remember: "desktop" });
    expect(chooseView("bogus", "nonsense", S24)).toEqual({ mode: "phone" });
  });
});

describe("text layers on the phone", () => {
  const frame: Frame = {
    id: "square",
    name: "Square",
    w: 1080,
    h: 1080,
    children: [
      text("footer", [{ text: "demo.example" }], { y: 1000 }),
      { id: "grp", type: "group", x: 0, y: 300, w: 0, h: 0, children: [text("inner", [{ text: "in a group" }], { y: 20 })] } as never,
      text("headline", [{ text: "Исти " }, { text: "модели", weight: 700 }, { text: "." }], { y: 120, name: "Headline" }),
      text("locked", [{ text: "fixed" }], { y: 500, locked: true }),
      { id: "box", type: "rect", x: 0, y: 0, w: 10, h: 10 } as never,
      { id: "lockedgrp", type: "group", x: 0, y: 600, w: 0, h: 0, locked: true, children: [text("under-lock", [{ text: "x" }])] } as never,
    ],
  };
  it("lists every text top to bottom, opens groups, names them, and says why locked ones are blocked", () => {
    const l = textLayers(frame);
    expect(l.map((x) => x.id)).toEqual(["headline", "inner", "locked", "under-lock", "footer"]);
    expect(l[0]).toMatchObject({ label: "Headline", text: "Исти модели.", styledRuns: 1, blocked: undefined });
    expect(l[1].top).toBe(320);
    expect(l.find((x) => x.id === "locked")!.blocked).toMatch(/desktop/);
    expect(l.find((x) => x.id === "under-lock")!.blocked).toMatch(/desktop/);
  });
  it("labels skip made-up names (text-03-copy) and fall back to a readable id, else nothing", () => {
    expect(layerLabel(text("headline", [{ text: "x" }], { name: "text-03-copy" }))).toBe("headline");
    expect(layerLabel(text("text-06", [{ text: "x" }], { name: "text-06-copy" }))).toBe("");
    expect(layerLabel(text("t1", [{ text: "x" }], { name: "Headline" }))).toBe("Headline");
    expect(layerLabel({ ...text("text-09", [{ text: "x" }]), role: "kicker" } as never)).toBe("kicker");
  });
  it("a text with too many styled runs is blocked instead of risked", () => {
    const many: Span[] = [];
    for (let i = 0; i <= MAX_PHONE_RUNS; i++) many.push({ text: `w${i}`, weight: 700 }, { text: " " });
    expect(styledRuns(many)).toBe(MAX_PHONE_RUNS + 1);
    expect(phoneEditBlock(text("t", many))).toMatch(/styled runs/);
    expect(phoneEditBlock(text("t", many.slice(0, 4)))).toBeUndefined();
  });
});

describe("plain edit → spans (emphasis kept)", () => {
  const spans: Span[] = [{ text: "Исти " }, { text: "модели", weight: 700 }, { text: ", различни " }, { text: "цени", fill: { token: "lux.mark" } }, { text: "." }];
  it("a change in plain words keeps bold and coloured words exactly", () => {
    const r = applyPlainEdit(spans, "Исти модели, сосема различни цени.", 400);
    expect(r.changed).toBe(true);
    expect(r.emphasisLost).toEqual([]);
    expect(fullText(r.spans)).toBe("Исти модели, сосема различни цени.");
    expect(r.spans).toEqual([{ text: "Исти " }, { text: "модели", weight: 700 }, { text: ", сосема различни " }, { text: "цени", fill: { token: "lux.mark" } }, { text: "." }]);
  });
  it("typing inside a bold word keeps it bold", () => {
    const r = applyPlainEdit(spans, "Исти моделиии, различни цени.", 400);
    expect(r.spans[1]).toEqual({ text: "моделиии", weight: 700 });
    expect(r.emphasisLost).toEqual([]);
  });
  it("replacing across a styled word reports the emphasis that would go", () => {
    const r = applyPlainEdit(spans, "Сè е исто.", 400);
    expect(r.emphasisLost).toEqual(["модели", "цени"]);
    expect(fullText(r.spans)).toBe("Сè е исто.");
  });
  it("no change is no change; Windows newlines are normalised", () => {
    expect(applyPlainEdit(spans, fullText(spans), 400)).toMatchObject({ changed: false, spans });
    const r = applyPlainEdit([{ text: "a\nb" }], "a\r\nb\r\nc", 400);
    expect(fullText(r.spans)).toBe("a\nb\nc");
  });
  it("deleting everything keeps one valid span", () => {
    const r = applyPlainEdit([{ text: "x" }], "", 400);
    expect(r.spans).toEqual([{ text: "" }]);
  });
});

describe("zoom viewer maths", () => {
  it("zooms about the finger point and stays within 1×–6×", () => {
    const z = zoomAbout({ k: 1, x: 0, y: 0 }, 2, 100, 50);
    expect(z).toEqual({ k: 2, x: -100, y: -50 });
    expect(zoomAbout(z, 100, 0, 0).k).toBe(6);
    expect(zoomAbout(z, 0.01, 0, 0).k).toBe(1);
  });
  it("a pinch spreading the fingers to twice the distance doubles the zoom", () => {
    const z = pinchStep({ k: 1, x: 0, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 100 }, { x: 50, y: 100 }, { x: 250, y: 100 });
    expect(z.k).toBeCloseTo(2);
    // The midpoint (150, 100) stays under the fingers.
    expect(150 * z.k + z.x).toBeCloseTo(150);
  });
  it("pan is clamped: centred at 1×, edges never come inside the screen when zoomed", () => {
    // 360 × 360 content in a 360 × 640 viewport (centred at y 140).
    expect(clampPan({ k: 1, x: 40, y: 99 }, 360, 360, 360, 640)).toEqual({ k: 1, x: 0, y: 0 });
    const far = clampPan({ k: 2, x: 500, y: 500 }, 360, 360, 360, 640);
    expect(far.x + 0).toBe(0); // left edge at the screen's left edge
    const left = clampPan({ k: 2, x: -5000, y: 0 }, 360, 360, 360, 640);
    expect(left.x + 360 * 2).toBe(360); // right edge at the screen's right edge
    // Height 720 > 640: top edge (140·2 + y) between 640 − 720 and 0.
    const top = clampPan({ k: 2, x: 0, y: 1000 }, 360, 360, 360, 640);
    expect(140 * 2 + top.y).toBe(0);
  });
});

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sanitizeSvg } from "../src/sanitize-svg.ts";
import { createLux, setup } from "./helpers.ts";

let ctx: Awaited<ReturnType<typeof setup>>;
let id: string;
beforeEach(async () => {
  ctx = await setup();
  id = await createLux(ctx);
});
afterEach(async () => ctx.cleanup());

const raw = async (who: "claude" | null, url: string) => {
  const res = await ctx.app.inject({ method: "GET", url, headers: who ? { authorization: `Bearer ${ctx.tokens[who]}` } : {} });
  return { status: res.statusCode, headers: res.headers, bytes: res.rawPayload, json: res.headers["content-type"]?.toString().includes("json") ? res.json() : undefined };
};

describe("GET /v1/projects/:id/render", () => {
  it("renders the first frame as PNG by default, with rev / frame / warnings headers", async () => {
    const r = await raw("claude", `/v1/projects/${id}/render`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.headers["x-post-studio-rev"]).toBe("0");
    expect(r.headers["x-post-studio-frame"]).toBe("square");
    expect(JSON.parse(decodeURIComponent(r.headers["x-post-studio-warnings"] as string))).toEqual([]);
    const m = await sharp(r.bytes).metadata();
    expect([m.format, m.width, m.height]).toEqual(["png", 1080, 1080]);
  });

  it("serves jpg, svg (fonts embedded), figma (no fonts, live text) and outlined (no text), and scales", async () => {
    const jpg = await raw("claude", `/v1/projects/${id}/render?format=jpg`);
    expect([jpg.headers["content-type"], (await sharp(jpg.bytes).metadata()).format]).toEqual(["image/jpeg", "jpeg"]);
    const svg = (await raw("claude", `/v1/projects/${id}/render?format=svg`)).bytes.toString();
    expect(svg).toContain("@font-face");
    expect(svg).toMatch(/<tspan x="[\d.]+ [\d.]+ /); // per-character positions
    const figma = await raw("claude", `/v1/projects/${id}/render?format=figma`);
    expect(figma.headers["content-type"]).toBe("image/svg+xml");
    expect(figma.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(figma.bytes.toString()).not.toContain("@font-face");
    expect(figma.bytes.toString()).toMatch(/<tspan x="[\d.]+" /);
    const outlined = (await raw("claude", `/v1/projects/${id}/render?format=outlined`)).bytes.toString();
    expect(outlined).not.toContain("<text");
    const half = await raw("claude", `/v1/projects/${id}/render?scale=0.5`);
    expect((await sharp(half.bytes).metadata()).width).toBe(540);
  });

  it("renders any revision", async () => {
    const before = await raw("claude", `/v1/projects/${id}/render?format=svg`);
    const op = await ctx.call("claude", "POST", `/v1/projects/${id}/ops`, { base: 0, ops: [{ op: "set", node: "headline", path: "spans", value: [{ text: "Нов наслов." }] }], message: "new headline" });
    expect(op.status).toBe(200);
    const head = await raw("claude", `/v1/projects/${id}/render?format=svg`);
    const rev0 = await raw("claude", `/v1/projects/${id}/render?format=svg&rev=0`);
    expect(head.headers["x-post-studio-rev"]).toBe("1");
    expect(head.bytes.toString()).toContain("Нов наслов.");
    expect(rev0.bytes.equals(before.bytes)).toBe(true);
  });

  it("rejects unknown frames, formats and scales, and needs a token", async () => {
    expect((await raw("claude", `/v1/projects/${id}/render?frame=nope`)).json.error.code).toBe("not-found");
    expect((await raw("claude", `/v1/projects/${id}/render?format=gif`)).status).toBe(400);
    expect((await raw("claude", `/v1/projects/${id}/render?scale=9`)).status).toBe(400);
    expect((await raw(null, `/v1/projects/${id}/render`)).status).toBe(401);
    expect((await raw("claude", `/v1/projects/prj_nothere/render`)).status).toBe(404);
  });
});

describe("POST /v1/projects/:id/export", () => {
  it("returns every file (base64) with sizes, hashes and the manifest", async () => {
    const r = await ctx.call("claude", "POST", `/v1/projects/${id}/export`, {});
    expect(r.status).toBe(200);
    expect(r.json.rev).toBe(0);
    expect(r.json.files.map((f: any) => f.path)).toEqual(["post.svg", "post.png", "post.jpg", "figma/post.figma-ready.svg", "figma/post.outlined.svg", "post-studio.json", "export.json"]);
    for (const f of r.json.files) expect(Buffer.from(f.base64, "base64").length).toBe(f.bytes);
    const doc = JSON.parse(Buffer.from(r.json.files.find((f: any) => f.path === "post-studio.json").base64, "base64").toString());
    expect(doc.id).toBe(id);
    const manifest = JSON.parse(Buffer.from(r.json.files.find((f: any) => f.path === "export.json").base64, "base64").toString());
    expect([manifest.project, manifest.rev]).toEqual([id, 0]);
    expect((await ctx.call("claude", "POST", `/v1/projects/${id}/export`, { frames: ["nope"] })).status).toBe(404);
    expect((await ctx.call("claude", "POST", `/v1/projects/${id}/export`, { frames: "square" })).status).toBe(400);
  });
});

describe("SVG sanitizer: filters", () => {
  it("keeps pixel-only filter primitives and blend styles, drops feImage and external filter refs", () => {
    const s = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg"><defs><filter id="g" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="26" result="n"/><feColorMatrix type="saturate" values="0"/><feImage href="https://evil.example/x.png"/></filter></defs>` +
        `<rect width="10" height="10" filter="url(#g)" opacity="0.05" style="mix-blend-mode:multiply"/><rect filter="url(https://evil.example/f.svg#x)"/></svg>`,
    );
    expect(s.svg).toContain('<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="26" result="n"/>');
    expect(s.svg).toContain('<feColorMatrix type="saturate" values="0"/>');
    expect(s.svg).toContain('filter="url(#g)"');
    expect(s.svg).toContain("mix-blend-mode:multiply");
    expect(s.svg).not.toContain("feImage");
    expect(s.svg).not.toContain("evil");
    expect(s.removed).toEqual(["<feImage>", "@filter on <rect>"]);
  });
});

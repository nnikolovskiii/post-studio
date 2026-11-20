#!/usr/bin/env python3
"""Lane palette + single-accent check for SVGs (DESIGN §1.4, §2.1, §3.1, §4.1).

Usage: tools/check_palette.py LANE FILE.svg [--art]
  LANE   studio | lux | kites
  --art  art-only SVG: no paper background required (transparent is fine);
         the accent-group rule still applies.

Fails (exit 1) on:
  - a color in fill / stroke / stop-color / color / flood-color (attribute, style=, or a
    <style> block) that is not in the lane palette, or none / transparent / currentColor
  - any <linearGradient>, <radialGradient> or <filter> element, or a filter= reference
  - the lane accent used outside <g id="accent">, or more than one <g id="accent">
  - (without --art) no full-canvas background <rect> in the lane paper color as the first
    painted element
"""
from __future__ import annotations

import re
import sys
import xml.parsers.expat

LANES = {
    "studio": {
        "paper": "#F5EFE4",
        "accent": "#A93C23",
        "colors": {
            "#F5EFE4": "paper",
            "#221F1B": "ink",
            "#5E594F": "muted ink",
            "#A93C23": "brick (accent)",
            "#6F7D63": "sage",
            "#E3E6D8": "sage tint",
        },
    },
    "lux": {
        "paper": "#FCFAF6",
        "accent": "#AC1922",
        "colors": {
            "#FCFAF6": "paper",
            "#FEFDFC": "card",
            "#F3F0EA": "surface / ghost track",
            "#E2DDD5": "border",
            "#190F0B": "ink",
            "#655B56": "muted",
            "#AC1922": "mark (accent)",
            "#305880": "chart blue",
            "#3A8357": "chart green",
            "#17653C": "success",
        },
    },
    "kites": {
        "paper": "#FFFCF9",
        "accent": "#C4476E",
        "colors": {
            "#FFFCF9": "cream",
            "#3E3655": "ink",
            "#675F7A": "muted",
            "#7A56B8": "purple",
            "#655196": "purple deep",
            "#C4476E": "pink (accent)",
            "#ECE4EE": "border",
            "#FFF4E0": "amber wash",
            "#B87A28": "amber edge",
            "#E2F4F6": "teal wash",
            "#2E8C96": "teal edge",
            "#DDEBFF": "blue header",
            "#FDE7EE": "pink wash",
            "#F3ECFC": "purple wash",
            "#FFFFFF": "white (text on pink only)",
        },
    },
}

COLOR_PROPS = ("fill", "stroke", "stop-color", "color", "flood-color", "lighting-color")
KEYWORDS = {"none", "transparent", "currentcolor", "inherit"}
BANNED_TAGS = {"lineargradient", "radialgradient", "filter"}
NON_PAINT = {"defs", "title", "desc", "metadata", "style", "symbol", "clippath", "mask"}


def norm_hex(v: str) -> str | None:
    m = re.fullmatch(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})", v.strip())
    if not m:
        return None
    h = m.group(1).upper()
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return "#" + h


def parse_style(style: str) -> dict[str, str]:
    out = {}
    for decl in style.split(";"):
        if ":" in decl:
            k, v = decl.split(":", 1)
            out[k.strip().lower()] = v.strip()
    return out


def local(tag: str) -> str:
    return tag.rsplit(":", 1)[-1].rsplit("}", 1)[-1].lower()


def num(v: str | None) -> float | None:
    if v is None:
        return None
    m = re.fullmatch(r"\s*(-?[\d.]+)(px)?\s*", v)
    return float(m.group(1)) if m else None


def check(lane: str, path: str, art: bool) -> list[str]:
    spec = LANES[lane]
    allowed = spec["colors"]
    accent = spec["accent"]
    errors: list[str] = []
    stack: list[tuple[str, str | None]] = []  # (tag, id)
    state = {"accent_groups": 0, "canvas": None, "bg_ok": None, "in_style": False}
    style_text: list[tuple[int, str]] = []

    p = xml.parsers.expat.ParserCreate()

    def where() -> str:
        return f"{path}:{p.CurrentLineNumber}"

    def in_accent() -> bool:
        return any(t == "g" and i == "accent" for t, i in stack)

    def check_value(prop: str, value: str, tag: str) -> str | None:
        v = value.strip()
        if v.lower() in KEYWORDS:
            return None
        if v.lower().startswith("url("):
            errors.append(f"{where()}: <{tag}> {prop}={v}: paint servers are not allowed (flat color only)")
            return None
        h = norm_hex(v)
        if h is None:
            errors.append(f"{where()}: <{tag}> {prop}={v!r}: not a hex or allowed keyword")
            return None
        if h not in allowed:
            errors.append(f"{where()}: <{tag}> {prop}={v}: {h} is not in the {lane} palette")
        if h == accent and not in_accent():
            errors.append(f"{where()}: <{tag}> {prop}={v}: lane accent outside <g id=\"accent\">")
        return h

    def start(name, attrs):
        tag = local(name)
        eid = attrs.get("id")
        if tag in BANNED_TAGS:
            errors.append(f"{where()}: <{tag}> is not allowed (no gradients or filters)")
        if tag == "g" and eid == "accent":
            state["accent_groups"] += 1
            if state["accent_groups"] > 1:
                errors.append(f"{where()}: more than one <g id=\"accent\">")
        props = {k.lower(): v for k, v in attrs.items() if k.lower() in COLOR_PROPS}
        if "style" in attrs:
            st = parse_style(attrs["style"])
            props.update({k: v for k, v in st.items() if k in COLOR_PROPS})
            if "filter" in st and st["filter"].lower() != "none":
                errors.append(f"{where()}: <{tag}> style filter: is not allowed")
        if "filter" in attrs and attrs["filter"].strip().lower() != "none":
            errors.append(f"{where()}: <{tag}> filter= is not allowed")
        resolved = {k: check_value(k, v, tag) for k, v in props.items()}

        if tag == "svg" and not stack:
            vb = attrs.get("viewBox")
            if vb:
                x, y, w, h = (float(n) for n in re.split(r"[\s,]+", vb.strip()))
                state["canvas"] = (x, y, w, h)
            else:
                state["canvas"] = (0.0, 0.0, num(attrs.get("width")) or 0, num(attrs.get("height")) or 0)
        elif len(stack) == 1 and state["bg_ok"] is None and tag not in NON_PAINT:
            # First painted child of the root: must be the paper background rect.
            cx, cy, cw, ch = state["canvas"]
            ok = tag == "rect"
            if ok:
                w, h = attrs.get("width", ""), attrs.get("height", "")
                x, y = num(attrs.get("x", "0")) or 0, num(attrs.get("y", "0")) or 0
                full_w = w.strip() == "100%" or (num(w) or 0) >= cw
                full_h = h.strip() == "100%" or (num(h) or 0) >= ch
                ok = full_w and full_h and x <= cx and y <= cy and resolved.get("fill") == spec["paper"]
            state["bg_ok"] = ok
        if tag == "style":
            state["in_style"] = True
        stack.append((tag, eid))

    def end(name):
        tag, _ = stack.pop()
        if tag == "style":
            state["in_style"] = False

    def chars(data):
        if state["in_style"]:
            style_text.append((p.CurrentLineNumber, data))

    p.StartElementHandler = start
    p.EndElementHandler = end
    p.CharacterDataHandler = chars
    with open(path, "rb") as f:
        try:
            p.ParseFile(f)
        except xml.parsers.expat.ExpatError as e:
            return [f"{path}: XML parse error: {e}"]

    # <style> blocks: no selector context, so the accent may not appear there at all.
    for line, text in style_text:
        for prop, value in re.findall(r"([\w-]+)\s*:\s*([^;}{]+)", text):
            if prop.lower() not in COLOR_PROPS:
                continue
            v = value.strip()
            h = norm_hex(v)
            if v.lower() in KEYWORDS:
                continue
            if h is None or h not in allowed:
                errors.append(f"{path}:{line}: <style> {prop}: {v} is not in the {lane} palette")
            elif h == accent:
                errors.append(f"{path}:{line}: <style> {prop}: lane accent in a stylesheet (use <g id=\"accent\">)")
        if re.search(r"(^|[;{\s])filter\s*:", text):
            errors.append(f"{path}:{line}: <style> filter is not allowed")

    if not art and not state["bg_ok"]:
        errors.append(
            f"{path}: first painted element must be a full-canvas <rect> filled {spec['paper']} "
            f"(the {lane} paper); use --art for art-only files"
        )
    return errors


def main() -> None:
    args = [a for a in sys.argv[1:] if a != "--art"]
    art = "--art" in sys.argv[1:]
    if len(args) != 2 or args[0] not in LANES:
        sys.exit(f"usage: check_palette.py {{{'|'.join(LANES)}}} FILE.svg [--art]")
    lane, path = args
    errors = check(lane, path, art)
    if errors:
        print("\n".join(errors))
        print(f"FAIL {path} ({lane}{', art' if art else ''}): {len(errors)} problem(s)")
        sys.exit(1)
    print(f"OK {path} ({lane}{', art' if art else ''})")


if __name__ == "__main__":
    main()

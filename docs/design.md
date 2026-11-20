# Design

Post Studio is a deliberately small design canvas for fixed-size layouts (social posts, slides). Its one unusual
requirement is that a coding agent and a person edit the same design in turns, and the agent must be able to read
the person's changes back as structure. Most decisions below follow from that.

## Decisions and why

| Decision | Why |
|---|---|
| The source of truth is a **JSON scene graph**, not SVG | SVG has no notion of a wrapping text box, a role ("headline"), a brand colour token, a pin or "the human changed this". Agents edit typed JSON with stable ids far more reliably than a large SVG, and op diffs are readable. SVG stays first-class as import/export and as whole `svg` layers. |
| **Server-authoritative** (SQLite + revision log), not local-first | The agent runs in another process, often on another machine, and cannot read browser storage. One truth with optimistic revision checks and a full authored history beats two copies that conflict from day one. |
| **TypeScript end to end** | The server, CLI and editor must apply ops, validate documents and lay out text identically. One shared package set removes a whole class of drift bugs that a second backend language would bring. |
| **Turns + lease + pins + revision check** instead of real-time collaboration | One person and one agent take turns. That needs protection of the person's tweaks, not live cursors. A CRDT would solve the wrong problem. |
| **Registered fonts only** | The editor, the PNG export and the agent's text metrics must agree. Every face is checked for full coverage of the target alphabets at startup; an unknown font is a validation error, never a silent fallback. |

## Document model (`post-studio/2`)

A project is one document: `{ schema, id, title, lang, brandKit?, strictPalette?, motion?, frames[], meta }`.

- **Frames** are artboards (`id`, `name`, `w`, `h`, `background`, `guides`, `children`, and an optional editor-only
  `canvas {x, y}` position that is never rendered or diffed).
- **Nodes**: `text`, `rect`, `ellipse`, `line`, `path`, `image`, `svg`, `group`. Common fields are `id` (stable,
  readable, never reused), `name`, `role` (`headline`, `kicker`, `logo`, `accent`, `chart`, …), geometry,
  `rotation`, `opacity`, `visible`, `locked`, `pins`, and free-form `meta` that agents keep (for example the data
  behind a chart bar).
- **Text** has rich `spans` (per-span weight and fill), a box mode (`auto-width`, `fixed-width`, `fixed`) and a
  style. Overflow is reported by the layout engine, not guessed.
- **Colours** are hex or a token reference into the project's brand kit (`{ "token": "<kit>.<name>" }`).
- **Motion** (optional): `$doc.motion = { duration, fps, loop, poster }`, and per node
  `anim = { origin, revealBy, tracks }`. Tracks are offsets or multipliers on top of the layout (`dx`, `dy`,
  `scale`, `scaleX`, `scaleY`, `rotate`, `opacity`, and `reveal` for text), so `x` / `y` stay the rest pose.
  Keyframes are a map keyed by stable ids: `{ t, v, ease }`.
- **Hand-drawn look** (optional): `node.sketch` on shapes, rendered deterministically from a seed.

`packages/schema` defines all of this in zod, serves a generated JSON Schema at `GET /v1/schema`, and runs every
document from outside (import, `create --from`, restored backups) through a migration chain (`/1` → `/2`).

## Ops and revisions

Every change is a batch of ops against a base revision:

| Op | Meaning |
|---|---|
| `set` / `unset` | write or remove a property path on a node or on `$doc` |
| `insert` | add a node under a parent at an index |
| `delete` | remove a node and its subtree |
| `move` | change parent and/or z-order |
| `frame` | add or remove a frame |

A batch is all-or-nothing. `packages/ops` applies it and returns the inverse ops; the server stores both, plus the
batch's **footprint** (which node properties it wrote). The current document is kept on the project row, and a
full snapshot every 50 revisions, so any revision can be rebuilt. Undo in the editor sends the inverse ops as a new
revision; "revert rev N" rebases N's inverse over everything since and refuses when a later revision touched the
same property. History is never rewritten.

On top of raw ops, `packages/ops` produces two agent-facing views:

- `outline`: a short text tree of the document (roles, geometry, fonts, text excerpts, motion lines, pin marks).
- `diff`: grouped by layer and written for a reader, with author and revision range, for example
  `headline: moved 25,0 · size 60 → 56   (human, rev 2)`.

## Rendering pipeline

`packages/render` is pure and runs in both Node and the browser (a `browser` export condition, no Node APIs):

1. **Text layout** (`packages/text`): HarfBuzz shapes each run with the registered woff2 faces and the document
   language (OpenType `locl`), breaks lines for fixed-width boxes and reports overflow.
2. **SVG variants**: *live* (real `<text>`, fonts embedded, every glyph at its HarfBuzz x), *Figma* (real
   `<text>`, one x per line, no fonts, so Figma makes editable text layers), *outlined* (glyph paths, no text).
3. **Raster**: PNG = outlined SVG through resvg-js (no system fonts involved), JPEG through sharp.

The editor's canvas is the same live SVG markup, so what the person sees is what gets exported. This is enforced
by tests: Chrome's rendering of the live SVG is pixel-compared with the resvg PNG, and a regression test hashes the
live, Figma and outlined SVG plus the PNG of every still fixture against `fixtures/golden/still-render-hashes.json`.

Uploaded or agent-made SVG passes an allow-list sanitizer before it is stored (no script, event handlers or
external references). Assets are stored by sha256.

## Motion and MP4 export

- `packages/motion` is the single place that interpolates: eases (`linear`, `in`, `out`, `in-out`, `back-out`,
  `hold`), sampling, frame times (`round(i × 1000 / fps)`), validation and presets. Editor playback, the CLI's
  contact sheets and the export call the same functions, so the timeline only ever shows frames that the video will
  contain.
- Rendering at a time wraps each animated layer in one `<g>` with its transform and opacity. A document without
  motion renders byte-identically with or without a time, which the golden-hash test checks.
- `packages/render/src/video.ts` renders each frame time to an outlined SVG, rasterizes a few frames at a time with
  resvg, and streams raw RGBA into ffmpeg (`libx264`, CRF 18, `yuv420p`, `+faststart`). Frames are never all in
  memory.
- The server runs encodes as jobs (`GET …/video` → `202 { job }`, then poll `/v1/video-jobs/:job`), one at a time
  by default with a short queue, and caches finished MP4s keyed by the document at that revision, frame, scale and
  renderer version. The file endpoint supports Range requests and `?inline=1`, which is what the phone view uses to
  play, download or share a video.

## Server and API

Fastify on SQLite (better-sqlite3, WAL). Tables: `projects`, `revisions`, `snapshots`, `checkpoints`, `leases`,
`dispatches`, `assets`, `fonts`, `api_tokens`, `admin_user`, `sessions`. Schema steps run in order and are
recorded in `PRAGMA user_version`.

The API is under `/v1` and is the same for the editor (session cookie plus a CSRF header) and agents (bearer
token). Main groups:

- projects: list, create (blank, from a scene, or from a template), get (`?rev=` takes a number or a checkpoint
  name such as `last-agent`), archive;
- `POST …/ops` with `{ base, ops, message, dryRun?, overridePins? }`, revisions, restore, revert, diff, outline,
  pins, checkpoints, approve;
- turns: `…/handoff` (give, back, take-back, retry-dispatch) and `…/lease`;
- render (`png`, `jpg`, `svg`, `figma`, `outlined`, optionally at a time), contact sheet, timeline, export, video
  jobs;
- assets, fonts, brand kits, templates, palette check;
- `/v1/dispatch/*`, callable only by the dispatcher's token.

Errors are `{ "error": { code, message, details } }`: 409 for a conflict or a turn violation, 422 for invalid
documents or pinned properties, 423 while another agent holds the lease.

Security for a self-hosted deployment: hashed tokens and password, per-IP login back-off (client IP taken from
`X-Forwarded-For` only from a trusted proxy subnet), `SameSite=Strict` cookies, a strict CSP on editor pages,
traversal-guarded static files, and a container with a read-only root and no capabilities.

## Brand kits

A brand kit is JSON in `brand-kits/`: colour tokens, type styles, guide sets per frame size, and layout templates.
`packages/brand` validates kits, resolves tokens, and checks a document against the kit's palette rules (every
painted colour in the kit, the frame starts on the kit's paper colour, the accent colour only inside one accent
object). Problems are warnings by default; a person-only "strict palette" switch turns new problems into
rejections.

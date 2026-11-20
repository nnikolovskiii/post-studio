// Export into a real social-posts/posts/<slug>/ folder (PLAN §3.9, Phase 5). Off by default:
// it needs `--social-posts` AND the approval rule in social-posts/AGENTS.md (the marker below,
// added by proposals/social-posts-post-studio.patch once Nikola approves it).
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import type { Document, Node, TextNode } from "@post-studio/schema";

/** The line social-posts/AGENTS.md must contain before Post Studio may write into posts/. */
export const APPROVAL_MARKER = "<!-- post-studio-export: allowed -->";
export const PROPOSAL = "proposals/social-posts-post-studio.patch";
/** Files Post Studio writes into a post folder; everything else there (brief, captions, alt, sources) is never touched. */
export const OWNED = /^(post(-[A-Za-z0-9_-]+)?\.(svg|png|jpg|mp4)|figma\/.+|post-studio\.json|export\.json|copy\.json)$/;

export class SocialPostsRefused extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function real(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    try {
      return `${realpathSync(dirname(abs))}${sep}${basename(abs)}`;
    } catch {
      return abs;
    }
  }
}

/** True when a path is inside some social-posts/posts/ folder. */
export function insideSocialPosts(dir: string): boolean {
  return `${real(dir)}${sep}`.includes(`${sep}social-posts${sep}posts${sep}`);
}

/** <root>/posts/<slug> → root and slug. The target must be a direct child of posts/. */
export function socialPostsTarget(dir: string): { root: string; slug: string; dir: string } {
  const d = real(dir);
  const posts = dirname(d);
  const slug = basename(d);
  if (basename(posts) !== "posts" || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug)) {
    throw new SocialPostsRefused("bad-target", `--social-posts needs a folder directly inside social-posts/posts/ with a lower-case slug (got ${dir})`);
  }
  const root = dirname(posts);
  if (!existsSync(`${root}${sep}AGENTS.md`)) throw new SocialPostsRefused("bad-target", `${root} has no AGENTS.md: not a social-posts checkout`);
  return { root, slug, dir: d };
}

/** Nikola's approval: the marker line in social-posts/AGENTS.md. */
export function approved(root: string): boolean {
  return readFileSync(`${root}${sep}AGENTS.md`, "utf8").split(/\r?\n/).some((l) => l.trim() === APPROVAL_MARKER);
}

export function notApprovedMessage(root: string): string {
  return (
    `Writing into ${root}/posts/ is not approved yet: ${root}/AGENTS.md has no Post Studio export rule (${APPROVAL_MARKER}). ` +
    `Nikola approves it by applying ${PROPOSAL} (see PROPOSAL-social-posts.md). Until then export to another folder.`
  );
}

/**
 * What already sits in the folder: a folder Post Studio did not write (no post-studio.json) or
 * one written for another project is refused unless --force.
 */
export function ownership(dir: string, project: string): { fresh: boolean; problem?: string } {
  if (!existsSync(dir)) return { fresh: true };
  const manifest = `${dir}${sep}post-studio.json`;
  if (!existsSync(manifest)) {
    return existsSync(`${dir}${sep}post.svg`) || existsSync(`${dir}${sep}post.jpg`)
      ? { fresh: false, problem: `${dir} already has a post that Post Studio did not write (no post-studio.json); --force overwrites its post.* files` }
      : { fresh: false };
  }
  try {
    const doc = JSON.parse(readFileSync(manifest, "utf8")) as { meta?: { postStudio?: { project?: string } }; id?: string };
    const from = doc.meta?.postStudio?.project ?? doc.id;
    if (from && from !== project) return { fresh: false, problem: `${dir} holds an export of ${from}, not ${project}; --force overwrites it` };
  } catch {
    return { fresh: false, problem: `${manifest} does not parse; --force overwrites it` };
  }
  return { fresh: false };
}

const textOf = (n: TextNode) => n.spans.map((s) => s.text).join("");

function byRole(nodes: Node[], role: string): TextNode[] {
  const out: TextNode[] = [];
  const walk = (ns: Node[]) =>
    ns.forEach((n) => {
      if (n.type === "text" && n.role === role) out.push(n);
      if (n.type === "group") walk(n.children);
    });
  walk(nodes);
  return out;
}

/** Headline spans split into lines, like copy.json: [{spans:[{text, fill?, weight?}]}]. */
function headlineLines(n: TextNode | undefined): Array<{ spans: Array<Record<string, unknown>> }> {
  if (!n) return [];
  const lines: Array<{ spans: Array<Record<string, unknown>> }> = [{ spans: [] }];
  for (const s of n.spans) {
    s.text.split("\n").forEach((part, i) => {
      if (i > 0) lines.push({ spans: [] });
      if (!part) return;
      const span: Record<string, unknown> = { text: part };
      if (typeof s.fill === "string") span.fill = s.fill;
      if (s.weight !== undefined) span.weight = s.weight;
      lines[lines.length - 1].spans.push(span);
    });
  }
  return lines.filter((l) => l.spans.length);
}

/**
 * copy.json for the review site (review-site/build.py reads kicker, headline, language) from the
 * text roles of the first frame. Marked `post_studio` so a later export may replace it.
 */
export function copyJsonFor(doc: Document, project: string, rev: number): Record<string, unknown> {
  const nodes = doc.frames[0].children;
  const one = (role: string) => {
    const t = byRole(nodes, role)[0];
    return t ? textOf(t).replace(/\n/g, " ") : null;
  };
  const sourceOf = typeof doc.meta?.copy === "object" && doc.meta.copy ? (doc.meta.copy as Record<string, unknown>) : {};
  return {
    ...(typeof sourceOf.lane === "string" ? { lane: sourceOf.lane } : doc.brandKit ? { lane: doc.brandKit } : {}),
    kicker: one("kicker") ?? "",
    headline: headlineLines(byRole(nodes, "headline")[0]),
    sub: one("sub"),
    source: one("source"),
    footer: one("footer"),
    language: doc.lang.split("-")[0],
    post_studio: { project, rev, note: "written by pstudio export --social-posts; edit the post in Post Studio, not here" },
  };
}

/** copy.json may be (re)written when it is missing or was written by Post Studio before. */
export function mayWriteCopy(dir: string): boolean {
  const p = `${dir}${sep}copy.json`;
  if (!existsSync(p)) return true;
  try {
    return !!JSON.parse(readFileSync(p, "utf8")).post_studio;
  } catch {
    return false;
  }
}

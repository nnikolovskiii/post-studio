// Readable, document-wide unique node ids ([A-Za-z0-9_-], no dots). Frames after the first get a suffix.
export function slug(s: string): string {
  return (
    s
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "node"
  );
}

export class Ids {
  private used: Set<string>;

  /** `taken`: ids already in use (the document a paste goes into). */
  constructor(taken: Iterable<string> = []) {
    this.used = new Set(taken);
  }

  /** Reserve an id built from `base` (+ suffix), adding -2, -3 … when taken. */
  take(base: string, suffix = ""): string {
    const b = slug(base);
    let id = `${b}${suffix}`.slice(0, 64);
    for (let k = 2; this.used.has(id); k++) id = `${b}-${k}${suffix}`.slice(0, 64);
    this.used.add(id);
    return id;
  }
}

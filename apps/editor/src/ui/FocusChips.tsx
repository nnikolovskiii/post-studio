// "Pointing at" chips in the hand-off dialog (desktop) and sheet (phone).
import { focusChips } from "../model/focus.ts";
import { useEditor } from "../store.ts";
import { Icon } from "./Icons.tsx";

/** "Pointing at": one removable chip per element he means by "this" in the note. */
export function FocusChips({ ids, onRemove }: { ids: string[]; onRemove: (id: string) => void }) {
  const doc = useEditor((s) => s.doc);
  if (!doc || !ids.length) return null;
  const chips = focusChips(doc, ids);
  if (!chips.length) return null;
  return (
    <div className="focus-chips" data-testid="focus-chips">
      <span className="focus-label">Pointing at:</span>
      {chips.map((c) => (
        <span key={c.id} className="chip focus" data-focus={c.id} title={`${c.kind} ${c.id}`}>
          {c.label}
          <button className="chip-x" aria-label={`Stop pointing at ${c.label}`} data-testid={`focus-remove-${c.id}`} onClick={() => onRemove(c.id)}>
            <Icon name="close" size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}

/** The playhead moment as a chip ("At 1.20 s"): what "here" means in a motion hand-off. Removable. */
export function AtChip({ at, onRemove }: { at: number | undefined; onRemove: () => void }) {
  if (at === undefined) return null;
  const label = `At ${(at / 1000).toFixed(2)} s`;
  return (
    <div className="focus-chips" data-testid="at-chips">
      <span className="focus-label">Moment:</span>
      <span className="chip focus at" data-testid="at-chip" data-at={at} title="The moment on the timeline your note is about">
        {label}
        <button className="chip-x" aria-label={`Not about ${label}`} data-testid="at-remove" onClick={onRemove}>
          <Icon name="close" size={12} />
        </button>
      </span>
    </div>
  );
}

/** The playhead to offer as "At …" when he hands over: a motion project, paused away from the start. */
export function handoffMoment(doc: { motion?: unknown } | null | undefined, t: number, playing: boolean): number | undefined {
  if (!doc?.motion || playing || !(t > 0)) return undefined;
  return t;
}

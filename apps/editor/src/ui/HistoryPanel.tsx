// History (PLAN §3.5, §3.7): every revision with author and message, newest first. Click to
// preview a revision on the canvas (read-only); Restore makes it the new head as a new revision.
// Revert undoes just that one revision (as a new revision) and keeps everything after it.
import { ago, authorLabel } from "../api.ts";
import { openHistory, previewRevision, readOnlyReason, restoreRevision, revertRevision, useEditor } from "../store.ts";
import { Icon } from "./Icons.tsx";

export function HistoryPanel() {
  const s = useEditor();
  const head = s.handoff?.head ?? s.save.rev;
  // Revert is a write: not while an agent holds the lease (previewing is fine, it is left first).
  const blocked = readOnlyReason({ ...s, preview: null });
  return (
    <div className="history" data-testid="history">
      <h3>
        History
        <button className="mini" title="Close" onClick={() => void openHistory(false)}>
          <Icon name="close" size={12} />
        </button>
      </h3>
      <div className="rev-list">
        {s.revisions.map((r) => {
          const current = r.rev === head;
          const viewing = s.preview?.rev === r.rev;
          return (
            <div key={r.rev} data-testid={`rev-${r.rev}`} className={`rev${viewing ? " viewing" : ""}${current ? " current" : ""} ${r.author === "human" ? "by-human" : "by-agent"}`} onClick={() => void previewRevision(current ? null : r.rev)}>
              <div className="rev-head">
                <b>rev {r.rev}</b> <span className="who">{authorLabel(r.author)}</span>
                <span className="when" title={r.createdAt}>
                  {ago(r.createdAt)}
                </span>
              </div>
              <div className="rev-msg">
                {r.kind === "restore" ? <Icon name="restore" size={12} /> : r.kind === "revert" ? <Icon name="revert" size={12} /> : null}
                {r.message}
              </div>
              {r.rev > 0 && r.opCount > 0 ? (
                <button
                  className="mini rev-revert"
                  data-testid={`revert-${r.rev}`}
                  disabled={!!blocked}
                  title={blocked ? `Read-only: ${blocked}` : `Undo only rev ${r.rev} (as a new revision); later changes stay`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void revertRevision(r.rev);
                  }}
                >
                  <Icon name="revert" size={12} /> Revert
                </button>
              ) : null}
              {r.overrides.length ? <div className="rev-override">overrode {r.overrides.map((o) => `${o.key} (“${o.reason}”)`).join(", ")}</div> : null}
              {viewing ? (
                <div className="row">
                  <button
                    data-testid="restore"
                    className="primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      void restoreRevision(r.rev);
                    }}
                  >
                    Restore this version
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void previewRevision(null);
                    }}
                  >
                    Back to current
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

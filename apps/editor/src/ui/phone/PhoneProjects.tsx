// Phone project list (Phase 8): one column of big rows, thumbnail, whose turn, approval, last change.
import { useEffect, useState } from "react";
import { ago, api, authorLabel, type ProjectSummary } from "../../api.ts";
import { Icon } from "../Icons.tsx";

export function turnLabel(p: { turn: "human" | "agent"; lease: ProjectSummary["lease"] }): { text: string; cls: string } {
  if (p.lease && p.lease.holder !== "human") return { text: `${p.lease.holder.replace(/^agent:/, "")} is working`, cls: "working" };
  return p.turn === "agent" ? { text: "Agent's turn", cls: "agent" } : { text: "Your turn", cls: "human" };
}

export function PhoneProjects({ navigate, toDesktop }: { navigate: (path: string) => void; toDesktop: () => void }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    api<{ projects: ProjectSummary[] }>("GET", "/v1/projects")
      .then((r) => (setProjects(r.projects), setError(null)))
      .catch((e) => setError(e.message));
  useEffect(() => {
    document.title = "Post Studio";
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  const logout = async () => {
    await api("POST", "/v1/auth/logout").catch(() => undefined);
    navigate("/login");
  };

  return (
    <div className="phone" data-testid="phone-projects">
      <header className="ph-top">
        <span className="ph-brand">
          <Icon name="logo" size={20} /> Post Studio
        </span>
        <span className="grow" />
        <button className="ph-btn ghost" data-testid="to-desktop" onClick={toDesktop}>
          Desktop
        </button>
        <button className="ph-btn ghost" onClick={() => void logout()}>
          Log out
        </button>
      </header>
      {error ? <p className="ph-error">{error}</p> : null}
      {!projects ? <p className="ph-message">Loading…</p> : null}
      {projects && !projects.length ? <p className="ph-message">No projects yet. Agents create them; new blank posts are made on the desktop editor.</p> : null}
      <ul className="ph-list">
        {projects?.map((p) => {
          const t = turnLabel(p);
          return (
            <li key={p.id}>
              <a className="ph-row" href={`/p/${p.id}`} data-testid={`phone-project-${p.id}`} onClick={(e) => (e.preventDefault(), navigate(`/p/${p.id}`))}>
                <span className="ph-thumb">
                  <img loading="lazy" alt="" src={`/v1/projects/${p.id}/render?format=png&scale=0.2&rev=${p.head_rev}`} />
                </span>
                <span className="ph-row-body">
                  <span className="ph-row-title">{p.title}</span>
                  <span className="ph-chips">
                    <span className={`turn turn-${t.cls}`}>{t.text}</span>
                    {p.approved_rev !== null && p.approved_rev !== undefined ? (
                      <span className={`chip approved${p.approved_rev === p.head_rev ? "" : " stale"}`}>{p.approved_rev === p.head_rev ? "Approved" : `Approved rev ${p.approved_rev}`}</span>
                    ) : null}
                  </span>
                  <span className="ph-dim">
                    rev {p.head_rev} · changed {ago(p.updated_at)} · by {authorLabel(p.created_by)}
                  </span>
                </span>
                <Icon name="caretRight" size={18} />
              </a>
            </li>
          );
        })}
      </ul>
      <p className="ph-message small">The phone view is for review: preview, text, approve, hand to agent, history. Layout editing stays on the desktop editor.</p>
    </div>
  );
}

// Project list: thumbnail, title, whose turn it is, last change; new project from a preset.
import { useEffect, useState } from "react";
import { ago, api, authorLabel, type ProjectSummary } from "../api.ts";
import { FRAME_PRESETS, type FramePreset } from "../model/guides.ts";
import { loadFonts } from "../fonts.ts";
import { newProjectDoc } from "../store.ts";
import { Icon } from "./Icons.tsx";
import { deviceIsPhoneLike } from "./viewmode.ts";

interface TemplateInfo {
  id: string;
  kit: string;
  name: string;
  description: string;
  frames: Array<{ id: string; name: string; w: number; h: number }>;
}

export function ProjectList({ navigate, toPhone }: { navigate: (path: string) => void; toPhone?: () => void }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [preset, setPreset] = useState<FramePreset["id"]>("ig");
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  // "" = blank frame from a preset; else a brand-kit template id (lux/post, …).
  const [template, setTemplate] = useState("");

  const load = () =>
    api<{ projects: ProjectSummary[] }>("GET", "/v1/projects")
      .then((r) => setProjects(r.projects))
      .catch((e) => setError(e.message));
  useEffect(() => {
    document.title = "Post Studio";
    void load();
    // The UI is set in IBM Plex Sans like the posts; this also warms the editor's font cache.
    void loadFonts().catch(() => undefined);
    void api<{ templates: TemplateInfo[] }>("GET", "/v1/templates")
      .then((r) => setTemplates(r.templates))
      .catch(() => undefined);
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  const create = async () => {
    const t = title.trim() || "Untitled post";
    try {
      const r = template
        ? await api("POST", "/v1/projects", { template, title: t, message: `created in the editor from template ${template}` })
        : await api("POST", "/v1/projects", { doc: newProjectDoc(t, preset), message: "created in the editor" });
      navigate(`/p/${r.project}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const logout = async () => {
    await api("POST", "/v1/auth/logout").catch(() => undefined);
    navigate("/login");
  };

  return (
    <div className="projects" data-testid="projects">
      <header className="topbar">
        <span className="home"><Icon name="logo" /> Post Studio</span>
        <span className="grow" />
        <button className="primary" data-testid="new-project" onClick={() => setCreating((c) => !c)}>
          New project
        </button>
        {toPhone && deviceIsPhoneLike() ? (
          <button data-testid="to-phone" onClick={toPhone}>
            Phone view
          </button>
        ) : null}
        <button onClick={logout}>Log out</button>
      </header>
      {creating ? (
        <div className="new-project">
          <input autoFocus placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void create()} data-testid="new-title" />
          <select value={template} onChange={(e) => setTemplate(e.target.value)} data-testid="new-template" title={templates.find((x) => x.id === template)?.description ?? "an empty frame"}>
            <option value="">Blank</option>
            {templates.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} · {x.frames.map((f) => `${f.w}×${f.h}`).join(" + ")}
              </option>
            ))}
          </select>
          {!template
            ? FRAME_PRESETS.map((p) => (
                <label key={p.id} className="check">
                  <input type="radio" name="preset" checked={preset === p.id} onChange={() => setPreset(p.id)} /> {p.name} {p.w}×{p.h}
                </label>
              ))
            : null}
          <button className="primary" onClick={() => void create()} data-testid="create-project">
            Create
          </button>
        </div>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      {!projects ? <p className="page-message">Loading…</p> : null}
      {projects && !projects.length ? <p className="page-message">No projects yet. Agents create them with <code>pstudio create</code> or <code>pstudio import social-posts</code>, or press New project.</p> : null}
      <div className="cards">
        {projects?.map((p) => {
          const agentWorking = p.lease && p.lease.holder !== "human";
          const turn = agentWorking ? `${p.lease!.holder.replace(/^agent:/, "")} is working` : p.turn === "agent" ? "Agent's turn" : "Your turn";
          return (
            <a key={p.id} className="card" href={`/p/${p.id}`} data-testid={`project-${p.id}`} onClick={(e) => (e.preventDefault(), navigate(`/p/${p.id}`))}>
              <div className="thumb">
                <img loading="lazy" alt="" src={`/v1/projects/${p.id}/render?format=png&scale=0.3&rev=${p.head_rev}`} />
              </div>
              <div className="card-body">
                <div className="card-title">{p.title}</div>
                <div className="card-meta">
                  <span className={`turn turn-${agentWorking ? "working" : p.turn}`}>{turn}</span>
                  {p.approved_rev !== null && p.approved_rev !== undefined ? (
                    <span className={`chip approved${p.approved_rev === p.head_rev ? "" : " stale"}`} data-testid={`approved-${p.id}`}>
                      {p.approved_rev === p.head_rev ? "Approved" : `Approved rev ${p.approved_rev}`}
                    </span>
                  ) : null}
                  <span title={p.updated_at}>changed {ago(p.updated_at)}</span>
                </div>
                <div className="card-meta dim">
                  rev {p.head_rev} · created by {authorLabel(p.created_by)}
                </div>
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

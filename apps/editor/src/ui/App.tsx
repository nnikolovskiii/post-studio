// Routes: /login, / (projects), /p/:id (editor). Plain history API, no router library.
// Phase 8: a phone (touch, short side ≤ 600 px) gets the phone review view of the same routes;
// "Desktop" / "Phone view" switch between them and the choice is remembered (ui/viewmode.ts).
import { useEffect, useState } from "react";
import type { ViewMode } from "../model/phone.ts";
import { PhoneProject } from "./phone/PhoneProject.tsx";
import { PhoneProjects } from "./phone/PhoneProjects.tsx";
import { initialView, remember } from "./viewmode.ts";
import { api, setUnauthorizedHandler } from "../api.ts";
import { EditorPage } from "./Editor.tsx";
import { Login } from "./Login.tsx";
import { ProjectList } from "./ProjectList.tsx";

interface AuthState {
  passwordSet: boolean;
  loggedIn: boolean;
}

export function App() {
  const [path, setPath] = useState(location.pathname);
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [mode, setMode] = useState<ViewMode>(initialView);
  const switchTo = (m: ViewMode) => {
    remember(m);
    setMode(m);
  };
  useEffect(() => {
    document.documentElement.classList.toggle("phone-mode", mode === "phone");
  }, [mode]);
  const navigate = (p: string) => {
    if (p !== location.pathname) history.pushState(null, "", p);
    setPath(p);
  };
  const refreshAuth = () => api<AuthState>("GET", "/v1/auth/state").then(setAuth).catch(() => setAuth({ passwordSet: true, loggedIn: false }));

  useEffect(() => {
    const pop = () => setPath(location.pathname);
    window.addEventListener("popstate", pop);
    setUnauthorizedHandler(() => setAuth((a) => (a ? { ...a, loggedIn: false } : a)));
    void refreshAuth();
    return () => window.removeEventListener("popstate", pop);
  }, []);

  if (!auth) return <div className="page-message">…</div>;
  if (!auth.loggedIn || path === "/login") {
    return (
      <Login
        passwordSet={auth.passwordSet}
        onDone={() => {
          void refreshAuth();
          const next = new URLSearchParams(location.search).get("next");
          navigate(next && next.startsWith("/") ? next : path === "/login" ? "/" : path);
        }}
      />
    );
  }
  const m = /^\/p\/(prj_[A-Za-z0-9]+)/.exec(path);
  if (mode === "phone") {
    if (m) return <PhoneProject key={m[1]} id={m[1]} navigate={navigate} toDesktop={() => switchTo("desktop")} />;
    return <PhoneProjects navigate={navigate} toDesktop={() => switchTo("desktop")} />;
  }
  if (m) return <EditorPage key={m[1]} id={m[1]} toPhone={() => switchTo("phone")} />;
  return <ProjectList navigate={navigate} toPhone={() => switchTo("phone")} />;
}

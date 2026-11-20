// Editor login (PLAN §3.8): one admin password → httpOnly session cookie.
import { useState } from "react";
import { api } from "../api.ts";
import { Icon } from "./Icons.tsx";

export function Login({ passwordSet, onDone }: { passwordSet: boolean; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/v1/auth/login", { password });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form onSubmit={submit} data-testid="login-form">
        <h1><Icon name="logo" size={22} /> Post Studio</h1>
        {passwordSet ? (
          <>
            <label>
              Password
              <input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="login-password" />
            </label>
            {error ? <p className="error" data-testid="login-error">{error}</p> : null}
            <button className="primary" disabled={busy || !password} data-testid="login-submit">
              Log in
            </button>
          </>
        ) : (
          <p>
            No editor password is set yet. On the machine running the server:
            <br />
            <code>apps/cli/bin/pstudio admin set-password</code>
          </p>
        )}
      </form>
    </div>
  );
}

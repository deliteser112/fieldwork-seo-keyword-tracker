import { StrictMode, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { TrackerWorkspace } from "./tracker";

type Session = { user: { id: string; email: string }; csrfToken: string };
type Client = { id: string; name: string; websiteUrl: string };
class ApiError extends Error {
  constructor(readonly status: number) {
    super("Request failed");
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function validResponse(path: string, value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (path === "/clients") {
    return (
      Array.isArray(value.clients) &&
      value.clients.every(
        (client: unknown) =>
          isRecord(client) &&
          typeof client.id === "string" &&
          typeof client.name === "string" &&
          typeof client.websiteUrl === "string",
      )
    );
  }
  return (
    isRecord(value.user) &&
    typeof value.user.id === "string" &&
    typeof value.user.email === "string" &&
    typeof value.csrfToken === "string"
  );
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const timeout = AbortSignal.timeout(10_000);
  const res = await fetch(`/api${path}`, {
    ...init,
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (!res.ok) throw new ApiError(res.status);
  if (res.status === 204 && path === "/auth/logout") return undefined as T;
  const value: unknown = await res.json();
  if (!validResponse(path, value)) throw new Error("Invalid API response");
  return value as T;
}
function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [clients, setClients] = useState<Client[]>([]);
  const [loadingClients, setLoadingClients] = useState(false);
  const [clientError, setClientError] = useState(false);
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!booting) main.current?.focus();
  }, [booting, session]);
  async function restore() {
    setBooting(true);
    setBootError(false);
    try {
      setSession(await request<Session>("/auth/session"));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setBootError(true);
      setSession(null);
    } finally {
      setBooting(false);
    }
  }
  useEffect(() => {
    void restore();
  }, []);
  const clientRequest = useRef<AbortController | null>(null);
  async function loadClients() {
    clientRequest.current?.abort();
    const controller = new AbortController();
    clientRequest.current = controller;
    setLoadingClients(true);
    setClientError(false);
    try {
      const result = await request<{ clients: Client[] }>("/clients", {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setClients(result.clients);
    } catch (e) {
      if (controller.signal.aborted) return;
      if (e instanceof ApiError && e.status === 401) {
        setSession(null);
        setError("Your session expired. Please sign in again.");
      } else setClientError(true);
    } finally {
      if (!controller.signal.aborted) setLoadingClients(false);
    }
  }
  useEffect(() => {
    if (session) void loadClients();
    else setClients([]);
    return () => clientRequest.current?.abort();
  }, [session]);
  async function login(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget);
    try {
      setSession(
        await request<Session>("/auth/login", {
          method: "POST",
          body: JSON.stringify({
            email: form.get("email"),
            password: form.get("password"),
          }),
        }),
      );
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 401
          ? "Email or password is incorrect."
          : e instanceof ApiError && e.status === 429
            ? "Too many attempts. Please wait a minute before trying again."
            : "Sign-in is unavailable. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    if (!session) return;
    setBusy(true);
    setError("");
    try {
      await request<void>("/auth/logout", {
        method: "POST",
        headers: { "X-CSRF-Token": session.csrfToken },
        body: "{}",
      });
      setSession(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setSession(null);
      else setError("Could not sign out. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header>
        <a className="brand" href="/">
          <span className="mark" aria-hidden="true">
            F
          </span>
          Fieldwork<span className="brand-note">AGENCY WORKSPACE</span>
        </a>
        {session && (
          <div className="account">
            <span>{session.user.email}</span>
            <button
              className="secondary"
              onClick={() => void logout()}
              disabled={busy}
            >
              {busy ? "Signing out…" : "Sign out"}
            </button>
          </div>
        )}
      </header>
      <main id="main" ref={main} tabIndex={-1}>
        {booting ? (
          <p role="status">Opening your workspace…</p>
        ) : bootError ? (
          <section className="panel">
            <h1>Workspace unavailable</h1>
            <p role="alert">
              We couldn’t check your session. Your data has not been changed.
            </p>
            <button onClick={() => void restore()}>Try again</button>
          </section>
        ) : !session ? (
          <div className="login-layout">
            <section className="intro">
              <p className="eyebrow">A CLEARER VIEW OF SEARCH</p>
              <h1>
                Your clients.
                <br />
                Their next opportunity.
              </h1>
              <p>One workspace for website insights and keyword performance.</p>
              <div className="intro-note">
                <span aria-hidden="true">↗</span> Thoughtful insights. Focused
                work.
              </div>
            </section>
            <section className="panel login">
              <p className="eyebrow">WELCOME BACK</p>
              <h2>Sign in to your workspace</h2>
              <p className="muted">Use your agency account to continue.</p>
              <form
                aria-busy={busy}
                onSubmit={(e) => void login(e)}
                aria-describedby={error ? "form-error" : undefined}
              >
                <label htmlFor="email">Email address</label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  maxLength={254}
                  placeholder="you@agency.com"
                />
                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={256}
                />
                {error && (
                  <p id="form-error" className="error" role="alert">
                    {error}
                  </p>
                )}
                <button className="full" disabled={busy}>
                  {busy ? "Signing in…" : "Sign in"}
                </button>
              </form>
              <p className="privacy">
                Your workspace is private to your account.
              </p>
            </section>
          </div>
        ) : (
          <>
            {error && <p className="error" role="alert">{error}</p>}
          <TrackerWorkspace
            session={session}
            clients={clients}
            onAdded={() => void loadClients()}
            onExpired={() => {
              setSession(null);
              setError("Your session expired. Please sign in again.");
            }}
          >
            <section>
              <div className="page-heading">
                <p className="eyebrow">YOUR WORKSPACE</p>
                <h1>Clients</h1>
                <p className="muted">
                  The websites you manage, all in one place.
                </p>
              </div>
              {loadingClients ? (
                <p role="status">Loading your clients…</p>
              ) : clientError ? (
                <div className="panel">
                  <p role="alert">We couldn’t load your clients.</p>
                  <button onClick={() => void loadClients()}>Try again</button>
                </div>
              ) : clients.length === 0 ? (
                <div className="panel empty">
                  <h2>No clients yet</h2>
                  <p>
                    Your clients will appear here once they have been added.
                  </p>
                </div>
              ) : (
                <ul className="client-grid" aria-label="Your clients">
                  {clients.map((client) => (
                    <li key={client.id} className="panel client">
                      <div className="client-icon" aria-hidden="true">
                        {client.name.slice(0, 1).toUpperCase()}
                      </div>
                      <h2>{client.name}</h2>
                      <p className="muted site">{client.websiteUrl}</p>
                      <span className="badge">Client workspace</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </TrackerWorkspace>
          </>
        )}
      </main>
      <footer>
        Fieldwork <span>·</span> Agency keyword tracker
      </footer>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

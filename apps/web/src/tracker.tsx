import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { z } from "zod";
const keyword = z.object({
  id: z.string(),
  term: z.string(),
  score: z.number(),
  evidence: z.string(),
  latestPosition: z.number().nullable(),
});
const pageSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  url: z.string(),
  title: z.string(),
  ruleVersion: z.string(),
  crawledAt: z.iso.datetime(),
  keywords: z.array(keyword),
  issues: z.array(
    z.object({ code: z.string(), advisory: z.boolean(), evidence: z.string() }),
  ),
});
const pagesSchema = z.object({
  pages: z.array(pageSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
const historySchema = z.object({
  timezone: z.string(),
  simulated: z.boolean(),
  keywords: z.array(
    z.object({
      id: z.string(),
      term: z.string(),
      snapshots: z.array(
        z.object({ capturedAt: z.iso.datetime(), position: z.number() }),
      ),
    }),
  ),
});
const jobSchema = z.object({
  job: z
    .object({
      id: z.string(),
      state: z.string(),
      attempt: z.number(),
      error: z.string().nullable(),
      retryable: z.boolean(),
      checkpoints: z.array(
        z.object({
          ordinal: z.number(),
          url: z.string(),
          state: z.string(),
          error: z.string().nullable(),
          retryable: z.boolean(),
        }),
      ),
    })
    .nullable(),
});
class RequestFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
) {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "same-origin",
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000),
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new RequestFailure(
      response.status,
      typeof error.error === "string" ? error.error : "REQUEST_FAILED",
    );
  }
  return schema.parse(await response.json());
}
function message(error: unknown) {
  return error instanceof RequestFailure
    ? error.code === "DUPLICATE_WEBSITE"
      ? "This website is already in your workspace."
      : error.status === 404
        ? "This page or client is unavailable."
        : error.status === 400
          ? "Check the URL or date range and try again."
          : "The request could not be completed. Please try again."
    : "Could not load a valid response. Please try again.";
}
function calendarToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
function initialDates() {
  const to = calendarToday();
  const d = new Date(`${to}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 89);
  return { from: d.toISOString().slice(0, 10), to };
}
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto",
  year: "numeric",
  month: "short",
  day: "numeric",
});
type Client = { id: string; name: string; websiteUrl: string };
export function TrackerWorkspace({
  session,
  clients,
  onAdded,
  onExpired,
  children,
}: {
  session: { csrfToken: string };
  clients: Client[];
  onAdded: () => void;
  onExpired: () => void;
  children: ReactNode;
}) {
  const readRoute = () =>
    /^(clients|pages|add|pages\/[a-f0-9-]+)$/.test(location.hash.slice(1))
      ? location.hash.slice(1)
      : "clients";
  const [route, setRoute] = useState(readRoute);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<z.infer<typeof pagesSchema> | null>(null);
  const [detail, setDetail] = useState<z.infer<typeof pageSchema> | null>(null);
  const [history, setHistory] = useState<z.infer<typeof historySchema> | null>(
    null,
  );
  const [clientId, setClientId] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [dates, setDates] = useState(initialDates);
  const [jobClient, setJobClient] = useState("");
  const [job, setJob] = useState<z.infer<typeof jobSchema>["job"]>(null);
  const [jobError, setJobError] = useState("");
  const [jobPollVersion, setJobPollVersion] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const addForm = useRef<HTMLFormElement>(null);
  const csrf = { "X-CSRF-Token": session.csrfToken };
  useEffect(() => {
    const change = () => {
      if (location.hash === "#main") return;
      setRoute(readRoute());
      setError("");
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    if (route !== "clients") heading.current?.focus();
  }, [route]);
  const expire = useRef(onExpired);
  expire.current = onExpired;
  useEffect(() => {
    if (route === "clients" || route === "add") {
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    setBusy(true);
    setError("");
    setDetail(null);
    setHistory(null);
    setData(null);
    async function load() {
      try {
        if (route.startsWith("pages/")) {
          const id = encodeURIComponent(route.slice(6));
          const [pageResult, historyResult] = await Promise.all([
            api(`/pages/${id}`, z.object({ page: pageSchema }), {
              signal: controller.signal,
            }),
            api(
              `/pages/${id}/history?from=${dates.from}&to=${dates.to}`,
              historySchema,
              { signal: controller.signal },
            ),
          ]);
          if (!controller.signal.aborted) {
            setDetail(pageResult.page);
            setHistory(historyResult);
          }
        } else {
          const query = new URLSearchParams({ search, page: String(page) });
          if (clientId) query.set("clientId", clientId);
          const result = await api(`/pages?${query}`, pagesSchema, {
            signal: controller.signal,
          });
          if (!controller.signal.aborted) setData(result);
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(message(e));
          if (e instanceof RequestFailure && e.status === 401) expire.current();
        }
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [route, clientId, search, page, dates]);
  useEffect(() => {
    if (!jobClient) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await api(`/clients/${jobClient}/crawl`, jobSchema, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setJob(result.job);
        setJobError("");
        if (result.job && ["queued", "running"].includes(result.job.state))
          timer = setTimeout(() => void poll(), 2000);
      } catch (e) {
        if (!controller.signal.aborted) {
          setJobError(message(e));
          if (e instanceof RequestFailure && e.status === 401) expire.current();
        }
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [jobClient, route, jobPollVersion]);
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await api(
        "/clients",
        z.object({ client: z.object({ id: z.string() }), jobId: z.string() }),
        {
          method: "POST",
          headers: csrf,
          body: JSON.stringify({
            name: form.get("name"),
            websiteUrl: form.get("websiteUrl"),
          }),
        },
      );
      setJobClient(result.client.id);
      onAdded();
      location.hash = "clients";
    } catch (e) {
      setError(message(e));
      if (e instanceof RequestFailure && e.status === 401) onExpired();
    } finally {
      setBusy(false);
    }
  }
  async function retryJob() {
    if (!jobClient) return;
    setBusy(true);
    try {
      await api(
        `/clients/${jobClient}/crawl/retry`,
        z.object({ status: z.string() }),
        { method: "POST", headers: csrf, body: "{}" },
      );
      setJob(null);
      setJobPollVersion((value) => value + 1);
    } catch (e) {
      setJobError(message(e));
      if (e instanceof RequestFailure && e.status === 401) onExpired();
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <nav className="workspace-nav" aria-label="Workspace">
        <a
          href="#clients"
          aria-current={route === "clients" ? "page" : undefined}
        >
          Clients
        </a>
        <a
          href="#pages"
          aria-current={route.startsWith("pages") ? "page" : undefined}
        >
          Pages
        </a>
        <a href="#add" aria-current={route === "add" ? "page" : undefined}>
          Add client
        </a>
      </nav>
      {route === "clients" ? (
        children
      ) : (
        <section>
          <p className="eyebrow">WEBSITE INTELLIGENCE</p>
          <h1 ref={heading} tabIndex={-1}>
            {route === "add"
              ? "Add a client"
              : route.startsWith("pages/")
                ? "Page detail"
                : "Pages"}
          </h1>
          {error && (
            <p className="error" role="alert">
              {error}{" "}
              <button
                className="secondary"
                onClick={() => route === "add" ? addForm.current?.requestSubmit() : setDates({ ...dates })}
              >
                Retry request
              </button>
            </p>
          )}
          {route === "add" ? (
            <form
              ref={addForm}
              className="panel add-form"
              onSubmit={(e) => void add(e)}
              aria-busy={busy}
            >
              <p>
                Add a website to discover and analyze its first 15 blog posts.
                Processing runs in the background.
              </p>
              <label htmlFor="client-name">Client name</label>
              <input id="client-name" name="name" required maxLength={120} />
              <label htmlFor="website-url">Website URL</label>
              <input
                id="website-url"
                name="websiteUrl"
                type="url"
                placeholder="https://example.com"
                required
                maxLength={2048}
              />
              <button className="full" disabled={busy}>
                {busy ? "Adding…" : "Add client"}
              </button>
            </form>
          ) : (
            <>
              <p className="muted">
                Rank positions are simulated. Page content, keywords, and
                findings come from crawled websites.
              </p>
              {route === "pages" && (
                <form
                  className="filters"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const values = new FormData(e.currentTarget);
                    setSearch(String(values.get("search") ?? ""));
                    setPage(1);
                  }}
                >
                  <div>
                    <label htmlFor="client-filter">Client</label>
                    <select
                      id="client-filter"
                      value={clientId}
                      onChange={(e) => {
                        setClientId(e.target.value);
                        setPage(1);
                      }}
                    >
                      <option value="">All clients</option>
                      {clients.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="page-search">Search URL or keyword</label>
                    <input
                      id="page-search"
                      name="search"
                      defaultValue={search}
                      type="search"
                      maxLength={200}
                    />
                  </div>
                  <button>Search</button>
                </form>
              )}
              {route.startsWith("pages/") && (
                <>
                  <a href="#pages">← Back to pages</a>
                  <form
                    className="filters"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const values = new FormData(e.currentTarget);
                      setDates({
                        from: String(values.get("from")),
                        to: String(values.get("to")),
                      });
                    }}
                  >
                    <div>
                      <label htmlFor="history-from">From (Toronto)</label>
                      <input
                        id="history-from"
                        name="from"
                        type="date"
                        defaultValue={dates.from}
                        required
                      />
                    </div>
                    <div>
                      <label htmlFor="history-to">To (Toronto)</label>
                      <input
                        id="history-to"
                        name="to"
                        type="date"
                        defaultValue={dates.to}
                        required
                      />
                    </div>
                    <button>Update history</button>
                  </form>
                </>
              )}
              {busy ? (
                <p role="status">Loading website insights…</p>
              ) : detail && history ? (
                <>
                  <article className="panel detail">
                    <h2>{detail.title || "Untitled page"}</h2>
                    <p className="site">{detail.url}</p>
                    <p className="muted">
                      Analyzed{" "}
                      {dateFormatter.format(new Date(detail.crawledAt))} ·{" "}
                      {detail.ruleVersion}
                    </p>
                    <h3>Suggested keywords</h3>
                    {detail.keywords.length ? (
                      <ul>
                        {detail.keywords.map((k) => (
                          <li key={k.id}>
                            <strong>{k.term}</strong> — {k.evidence}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>
                        No sufficiently supported keyword phrases were
                        extracted.
                      </p>
                    )}
                    <h3>SEO findings</h3>
                    {detail.issues.length ? (
                      <ul>
                        {detail.issues.map((i) => (
                          <li key={i.code}>
                            <strong>{i.code.replaceAll("_", " ")}</strong>
                            {i.advisory ? " (advisory)" : ""}: {i.evidence}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>
                        No findings from the implemented checks. This is not a
                        complete SEO audit.
                      </p>
                    )}
                  </article>
                  <div className="panel history">
                    <h2>Position history</h2>
                    <p className="muted">
                      Simulated positions · America/Toronto · Missing entries
                      mean no snapshot was recorded.
                    </p>
                    {history.keywords.map((k) => (
                      <section key={k.id}>
                        <h3>{k.term}</h3>
                        {k.snapshots.length ? (
                          <div
                            className="table-scroll"
                            tabIndex={0}
                            role="region"
                            aria-label={`${k.term} history`}
                          >
                            <table>
                              <caption>
                                {k.term} — simulated daily positions
                              </caption>
                              <thead>
                                <tr>
                                  <th scope="col">Date in Toronto</th>
                                  <th scope="col">Position</th>
                                </tr>
                              </thead>
                              <tbody>
                                {k.snapshots.map((s) => (
                                  <tr key={s.capturedAt}>
                                    <td>
                                      {dateFormatter.format(
                                        new Date(s.capturedAt),
                                      )}
                                    </td>
                                    <td>{s.position}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <p>No rank snapshots in this date range.</p>
                        )}
                      </section>
                    ))}
                  </div>
                </>
              ) : data ? (
                <>
                  {!data.pages.length ? (
                    <div className="panel empty">
                      <h2>No pages found</h2>
                      <p>
                        Try another filter, or add a client to start crawling.
                      </p>
                    </div>
                  ) : (
                    <ul className="pages-list">
                      {data.pages.map((p) => (
                        <li key={p.id} className="panel">
                          <h2>
                            <a href={`#pages/${p.id}`}>
                              {p.title || "Untitled page"}
                            </a>
                          </h2>
                          <p className="site muted">{p.url}</p>
                          <div className="keyword-chips">
                            {p.keywords.map((k) => (
                              <span key={k.id}>
                                {k.term}{" "}
                                <strong>
                                  {k.latestPosition === null
                                    ? "No rank"
                                    : `#${k.latestPosition}`}
                                </strong>
                              </span>
                            ))}
                          </div>
                          <p className="muted">
                            {p.issues.length} SEO finding
                            {p.issues.length === 1 ? "" : "s"}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="pagination">
                    <button
                      className="secondary"
                      disabled={page <= 1}
                      onClick={() => setPage(page - 1)}
                    >
                      Previous
                    </button>
                    <span>
                      Page {page} · {data.total} pages
                    </span>
                    <button
                      className="secondary"
                      disabled={page * data.pageSize >= data.total}
                      onClick={() => setPage(page + 1)}
                    >
                      Next
                    </button>
                  </div>
                </>
              ) : null}
            </>
          )}
        </section>
      )}
      {route === "clients" && (
        <section className="crawl-panel panel">
          <h2>Crawl progress</h2>
          <label htmlFor="crawl-client">Client to inspect</label>
          <select
            id="crawl-client"
            value={jobClient}
            onChange={(e) => {
              setJob(null);
              setJobClient(e.target.value);
            }}
          >
            <option value="">Select a client</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {jobError && (
            <p role="alert" className="error">
              {jobError}{" "}
              <button onClick={() => setJobPollVersion((value) => value + 1)}>
                Retry status
              </button>
            </p>
          )}
          {job && (
            <>
              <p role="status">
                {job.state} ·{" "}
                {job.checkpoints.filter((p) => p.state === "succeeded").length}{" "}
                / {job.checkpoints.length} selected pages completed
              </p>
              {job.error && <p>{job.error.replaceAll("_", " ")}</p>}
              <ul>
                {job.checkpoints
                  .filter((p) => p.state === "failed")
                  .map((p) => (
                    <li key={p.ordinal} className="site">
                      {p.url}: {p.error}
                    </li>
                  ))}
              </ul>
              {job.retryable && ["failed", "partial"].includes(job.state) && (
                <button disabled={busy} onClick={() => void retryJob()}>
                  Retry failed pages
                </button>
              )}
              <a href="#pages">View analyzed pages →</a>
            </>
          )}
          {jobClient && !job && !jobError && (
            <p>No crawl is recorded yet, or status is loading.</p>
          )}
        </section>
      )}
    </>
  );
}

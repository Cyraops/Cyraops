"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  CircleDot,
  Clock,
  Loader2,
  MessageSquare,
  Plus,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { Button, useToast } from "@/components/ui";

/**
 * The ticket desk.
 *
 * Tasks are worked as tickets here, in the shape a service desk expects: a
 * queue with the columns people scan (subject, contact, status, priority, owner,
 * created), and a detail pane with the properties, the conversation and the
 * resolution kept apart. The description is what the requester said; the
 * resolution is what we did about it — merging them loses that distinction.
 */

type Ticket = {
  id: string;
  number: number;
  title: string;
  description: string;
  status: string;
  priority: string;
  kind?: string | null;
  source?: string | null;
  type?: string | null;
  groupName?: string | null;
  category?: string | null;
  requesterName?: string | null;
  requesterEmail?: string | null;
  resolution?: string;
  closedAt?: string | null;
  dueDate?: string | null;
  createdAt: string;
  updatedAt?: string;
  project?: { id: string; name: string } | null;
  creator?: { id: string; name: string } | null;
  assignees?: Array<{ kind: string; id: string; name: string }>;
};

type Comment = { id: string; body: string; createdAt: string; author?: { name: string } | null };

const STATUSES = ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"] as const;
const STATUS_LABEL: Record<string, string> = {
  BACKLOG: "Backlog",
  TODO: "New",
  IN_PROGRESS: "In progress",
  IN_REVIEW: "In review",
  DONE: "Closed",
};
const statusTone = (status: string) =>
  status === "DONE"
    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
    : status === "IN_PROGRESS"
      ? "bg-sky-500/10 text-sky-600 dark:text-sky-400"
      : status === "IN_REVIEW"
        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
        : "bg-[var(--hover)] text-[var(--muted)]";

const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
const priorityDot = (priority: string) =>
  priority === "URGENT" ? "bg-rose-500" : priority === "HIGH" ? "bg-amber-500" : priority === "MEDIUM" ? "bg-sky-500" : "bg-emerald-500";

const SOURCES = ["EMAIL", "PHONE", "CHAT", "WEB", "PORTAL", "API"] as const;
const TYPES = ["SERVICE_REQUEST", "INCIDENT", "PROBLEM", "CHANGE"] as const;
const humanise = (value?: string | null) =>
  value ? value.replaceAll("_", " ").toLowerCase().replace(/^./, (c) => c.toUpperCase()) : "—";

const ticketRef = (n: number) => `#SR-${n}`;
const formatDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";


/** Width breakpoints for the two layouts. Inline styles are used rather than
 *  classes because a cached stylesheet silently kept the queue stacked. */
function useNarrow(query = "(max-width: 900px)") {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return narrow;
}

export function TicketDesk() {
  const toast = useToast();
  const narrow = useNarrow();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"open" | "all" | "closed">("open");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<"details" | "activity" | "resolution">("details");
  const [comments, setComments] = useState<Comment[]>([]);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState<string>("");
  const [resolution, setResolution] = useState("");
  const [quickAdd, setQuickAdd] = useState("");
  const [adding, setAdding] = useState(false);
  const [team, setTeam] = useState<Array<{ id: string; name: string }>>([]);
  const [approvals, setApprovals] = useState<number>(0);

  const load = useCallback(async () => {
    const [list, people, pending] = await Promise.all([
      fetch("/api/tickets?limit=60").then((r) => (r.ok ? r.json() : { tickets: [] })).catch(() => ({ tickets: [] })),
      fetch("/api/team").then((r) => (r.ok ? r.json() : { members: [] })).catch(() => ({ members: [] })),
      fetch("/api/ai/approvals").then((r) => (r.ok ? r.json() : { approvals: [] })).catch(() => ({ approvals: [] })),
    ]);
    setTickets(list.tickets ?? []);
    setTeam(people.members ?? []);
    setApprovals((pending.approvals ?? []).length);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = tickets.find((t) => t.id === selectedId) ?? null;

  useEffect(() => {
    setResolution(selected?.resolution ?? "");
    setComment("");
    if (!selected) return;
    fetch(`/api/tasks/${selected.id}/comments`)
      .then((r) => (r.ok ? r.json() : { comments: [] }))
      .then((d) => setComments(d.comments ?? []))
      .catch(() => setComments([]));
  }, [selected?.id, selected?.resolution]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tickets.filter((t) => {
      if (statusFilter === "open" && t.status === "DONE") return false;
      if (statusFilter === "closed" && t.status !== "DONE") return false;
      if (!needle) return true;
      return [t.title, t.requesterName, t.requesterEmail, ticketRef(t.number), t.groupName, t.category]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle));
    });
  }, [tickets, statusFilter, query]);

  const patch = async (id: string, body: Record<string, unknown>, field: string) => {
    setSaving(field);
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save");
      setTickets((prev) => prev.map((t) => (t.id === id ? { ...t, ...(data.task ?? {}) } : t)));
      return true;
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not save", "error");
      return false;
    } finally {
      setSaving("");
    }
  };

  const addTicket = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = quickAdd.trim();
    if (!text) {
      // A disabled button looks broken: say what is missing instead.
      toast("Type what the ticket is about first", "error");
      return;
    }
    setAdding(true);
    try {
      // The same @tasks path the bot uses, so chat and desk cannot diverge.
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.startsWith("@tasks") ? text : `@tasks ${text}` }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.message || data.error || "Could not create the ticket");
      setQuickAdd("");
      await load();
      if (data.ticket?.id) setSelectedId(data.ticket.id);
      toast("Ticket created");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not create the ticket", "error");
    } finally {
      setAdding(false);
    }
  };

  const addComment = async () => {
    if (!selected || !comment.trim()) return;
    setSaving("comment");
    try {
      const res = await fetch(`/api/tasks/${selected.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: comment.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not add the note");
      setComments((prev) => [...prev, data.comment]);
      setComment("");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not add the note", "error");
    } finally {
      setSaving("");
    }
  };

  const closeTicket = async () => {
    if (!selected) return;
    const ok = await patch(selected.id, { status: "DONE", resolution }, "close");
    if (ok) toast("Ticket closed");
  };

  const openCount = tickets.filter((t) => t.status !== "DONE").length;

  const propRow = (label: string, control: React.ReactNode, hint?: string) => (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">{label}</span>
      {control}
      {hint && <span className="mt-0.5 block text-[10px] text-[var(--muted)]">{hint}</span>}
    </label>
  );
  const selectCls =
    "h-8 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 text-caption outline-none focus:border-accent";
  const inputCls = selectCls;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 sm:p-6">
      {/* ---------------- A ticket is open: the ticket owns the screen ---------------- */}
      {selected ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => setSelectedId(null)}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 text-caption font-semibold text-[var(--muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
            >
              <ArrowLeft size={13} /> All tickets
            </button>
            <span className="font-mono text-caption text-[var(--muted)]">{ticketRef(selected.number)}</span>
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${statusTone(selected.status)}`}>
              {STATUS_LABEL[selected.status] ?? selected.status}
            </span>
            {saving && <Loader2 size={13} className="animate-spin text-[var(--muted)]" />}
          </div>

          <div
            className="ticket-layout flex-1"
            style={{ display: "grid", gridTemplateColumns: narrow ? "minmax(0,1fr)" : "minmax(0,1fr) 320px", gap: 16, alignItems: "start" }}
          >
            {/* The conversation */}
            <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              <header className="border-b border-[var(--border)] px-5 py-4">
                <h1 className="text-lg font-bold leading-snug">{selected.title}</h1>
                <p className="mt-1 text-caption text-[var(--muted)]">
                  <span className="font-semibold text-[var(--text)]">{selected.requesterName || selected.creator?.name || "Unknown"}</span>
                  {" reported "}
                  {formatDate(selected.createdAt)}
                  {selected.source ? ` via ${humanise(selected.source)}` : ""}
                  {selected.requesterEmail ? ` · ${selected.requesterEmail}` : ""}
                </p>
              </header>

              <nav className="flex gap-1 border-b border-[var(--border)] px-3" role="tablist">
                {(["details", "activity", "resolution"] as const).map((value) => (
                  <button
                    key={value}
                    role="tab"
                    aria-selected={tab === value}
                    onClick={() => setTab(value)}
                    className={`border-b-2 px-3 py-2.5 text-caption font-semibold capitalize transition ${
                      tab === value ? "border-accent text-accent" : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"
                    }`}
                  >
                    {value}
                  </button>
                ))}
              </nav>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {tab === "details" && (
                  <section>
                    <h2 className="mb-1 text-[10px] font-bold uppercase tracking-widest text-[var(--muted)]">Description</h2>
                    <p className="whitespace-pre-wrap text-meta leading-relaxed">{selected.description || "No description."}</p>
                    {selected.project && (
                      <p className="mt-4 flex items-center gap-1 text-[10px] text-[var(--muted)]">
                        <ChevronRight size={10} /> Project: {selected.project.name}
                      </p>
                    )}
                  </section>
                )}

                {tab === "activity" && (
                  <div className="space-y-3">
                    {comments.length === 0 && (
                      <p className="text-caption text-[var(--muted)]">No notes yet. Anything you add here is kept with the ticket.</p>
                    )}
                    {comments.map((c) => (
                      <div key={c.id} className="rounded-lg border border-[var(--border)] p-3">
                        <p className="text-[10px] font-semibold text-[var(--muted)]">
                          {c.author?.name ?? "Someone"} · {formatDate(c.createdAt)}
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-meta">{c.body}</p>
                      </div>
                    ))}
                    <div className="flex gap-2">
                      <input
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && void addComment()}
                        placeholder="Add an internal note…"
                        aria-label="Add an internal note"
                        className="h-9 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 text-meta outline-none focus:border-accent"
                      />
                      <Button onClick={() => void addComment()} disabled={saving === "comment" || !comment.trim()}>
                        <MessageSquare size={12} /> Note
                      </Button>
                    </div>
                  </div>
                )}

                {tab === "resolution" && (
                  <div className="space-y-3">
                    <p className="text-caption text-[var(--muted)]">
                      What we actually did. Kept separate from the description, which is what the requester said.
                    </p>
                    <textarea
                      value={resolution}
                      onChange={(e) => setResolution(e.target.value)}
                      rows={8}
                      placeholder="Root cause, the fix, and anything the requester should know…"
                      aria-label="Resolution"
                      className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-meta outline-none focus:border-accent"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button onClick={() => void patch(selected.id, { resolution }, "resolution")} disabled={saving === "resolution"}>
                        <Check size={12} /> Save resolution
                      </Button>
                      {selected.status !== "DONE" ? (
                        <Button variant="secondary" onClick={() => void closeTicket()} disabled={saving === "close"}>
                          <AlertTriangle size={12} /> Resolve &amp; close
                        </Button>
                      ) : (
                        <Button variant="secondary" onClick={() => void patch(selected.id, { status: "IN_PROGRESS" }, "reopen")} disabled={saving === "reopen"}>
                          Reopen ticket
                        </Button>
                      )}
                      {selected.closedAt && <span className="text-[10px] text-[var(--muted)]">Closed {formatDate(selected.closedAt)}</span>}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Properties, on the right edge like a service desk */}
            <aside
              className="ticket-props"
              style={{
                border: "1px solid var(--border)",
                borderRadius: 12,
                background: "var(--surface)",
                overflow: "hidden",
                ...(narrow ? {} : { position: "sticky", top: 16, maxHeight: "calc(100vh - 8rem)" }),
              }}
            >
              <h2 className="border-b border-[var(--border)] px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-[var(--muted)]">
                Properties
              </h2>
              <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-4">
                {propRow("Priority", (
                  <select value={selected.priority} disabled={saving === "priority"} onChange={(e) => void patch(selected.id, { priority: e.target.value }, "priority")} className={selectCls}>
                    {PRIORITIES.map((x) => <option key={x} value={x}>{humanise(x)}</option>)}
                  </select>
                ))}
                {propRow("Status", (
                  <select value={selected.status} disabled={saving === "status"} onChange={(e) => void patch(selected.id, { status: e.target.value }, "status")} className={selectCls}>
                    {["BACKLOG", ...STATUSES].map((x) => <option key={x} value={x}>{STATUS_LABEL[x] ?? x}</option>)}
                  </select>
                ))}
                {propRow("Source", (
                  <select value={selected.source ?? ""} disabled={saving === "source"} onChange={(e) => void patch(selected.id, { source: e.target.value || null }, "source")} className={selectCls}>
                    <option value="">—</option>
                    {SOURCES.map((x) => <option key={x} value={x}>{humanise(x)}</option>)}
                  </select>
                ))}
                {propRow("Type", (
                  <select value={selected.type ?? ""} disabled={saving === "type"} onChange={(e) => void patch(selected.id, { type: e.target.value || null }, "type")} className={selectCls}>
                    <option value="">—</option>
                    {TYPES.map((x) => <option key={x} value={x}>{humanise(x)}</option>)}
                  </select>
                ))}
                {propRow("Group", (
                  <input defaultValue={selected.groupName ?? ""} placeholder="e.g. ANZ_Wintel" onBlur={(e) => e.target.value !== (selected.groupName ?? "") && void patch(selected.id, { groupName: e.target.value || null }, "group")} className={inputCls} />
                ))}
                {propRow("Category", (
                  <input defaultValue={selected.category ?? ""} placeholder="e.g. Cloud alarm" onBlur={(e) => e.target.value !== (selected.category ?? "") && void patch(selected.id, { category: e.target.value || null }, "category")} className={inputCls} />
                ))}
                {propRow("Agent", (
                  <select
                    value={selected.assignees?.find((a) => a.kind === "user")?.id ?? ""}
                    disabled={saving === "assignee"}
                    onChange={(e) => void patch(selected.id, { assigneeIds: e.target.value ? [e.target.value] : [] }, "assignee")}
                    className={selectCls}
                  >
                    <option value="">Unassigned</option>
                    {team.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                ))}
                {propRow("Kind", (
                  <span className="flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 text-caption">
                    <CircleDot size={11} className="text-[var(--muted)]" />
                    {selected.kind ? selected.kind.toLowerCase() : "unclassified"}
                  </span>
                ))}
              </div>
            </aside>
          </div>
        </div>
      ) : (
        <>
          {/* ---------------- The queue ---------------- */}
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="font-display text-xl font-extrabold tracking-tight">Tickets</h1>
              <p className="text-caption text-[var(--muted)]">
                {openCount} open · {tickets.length} total · every task is a ticket, with a number, a requester and a resolution
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5">
                <Search size={13} className="text-[var(--muted)]" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search tickets…"
                  aria-label="Search tickets"
                  className="w-44 bg-transparent text-meta outline-none placeholder:text-[var(--muted)]"
                />
              </label>
              <div className="flex h-9 items-center rounded-lg border border-[var(--border)] p-0.5">
                {(["open", "all", "closed"] as const).map((value) => (
                  <button
                    key={value}
                    onClick={() => setStatusFilter(value)}
                    aria-pressed={statusFilter === value}
                    className={`h-8 rounded-md px-2.5 text-caption font-semibold capitalize transition ${
                      statusFilter === value ? "bg-accent/10 text-accent" : "text-[var(--muted)] hover:bg-[var(--hover)]"
                    }`}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>
          </header>

          {approvals > 0 && (
            <div className="flex items-center gap-2 rounded-xl border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-meta dark:border-amber-900/40 dark:bg-amber-950/20">
              <ShieldCheck size={14} className="text-amber-600" />
              <span className="font-semibold">{approvals} agent step{approvals === 1 ? "" : "s"} waiting for your approval</span>
              <a href="/ai" className="ml-auto text-caption font-semibold text-accent underline decoration-dotted underline-offset-2">Review in the bot</a>
            </div>
          )}

          <form onSubmit={addTicket} className="flex gap-2">
            <input
              value={quickAdd}
              onChange={(e) => setQuickAdd(e.target.value)}
              placeholder="New ticket… e.g. @tasks bug: invoice page crashes when saving"
              aria-label="New ticket"
              className="h-10 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm outline-none focus:border-accent"
            />
            <Button type="submit" disabled={adding}>
              {adding ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Add ticket
            </Button>
          </form>

          <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            <div style={{ display: "grid", gridTemplateColumns: narrow ? "minmax(0,1fr) 96px" : "minmax(0,1fr) 140px 110px 90px minmax(0,1fr)", gap: 12, alignItems: "center" }}
              className="ticket-grid-head border-b border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-[var(--muted)]">
              <span>Subject</span>
              <span>Contact</span>
              <span>Status</span>
              <span>Priority</span>
              <span>Assigned · created</span>
            </div>
            <div className="max-h-[calc(100vh-320px)] overflow-y-auto">
              {loading ? (
                <p className="px-3 py-8 text-center text-meta text-[var(--muted)]"><Loader2 size={14} className="mx-auto animate-spin" /></p>
              ) : visible.length === 0 ? (
                <p className="px-3 py-10 text-center text-meta text-[var(--muted)]">
                  No tickets here yet. Add one above, or ask the bot in chat with <span className="font-semibold">@tasks</span>.
                </p>
              ) : (
                visible.map((t) => {
                  const owners = t.assignees ?? [];
                  const contact = t.requesterName || t.creator?.name || "Unknown";
                  return (
                    <button
                      key={t.id}
                      onClick={() => { setSelectedId(t.id); setTab("details"); }}
                      style={{ display: "grid", gridTemplateColumns: narrow ? "minmax(0,1fr) 96px" : "minmax(0,1fr) 140px 110px 90px minmax(0,1fr)", gap: 12, alignItems: "center" }}
                      className="ticket-grid w-full border-b border-[var(--border)] px-3 py-2.5 text-left transition hover:bg-[var(--hover)]"
                    >
                      <span className="min-w-0">
                        <span className={`block truncate text-meta font-semibold ${t.status === "DONE" ? "text-[var(--muted)]" : ""}`}>{t.title}</span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--muted)]">
                          <span className="font-mono">{ticketRef(t.number)}</span>
                          {t.type && <span>· {humanise(t.type)}</span>}
                          {t.groupName && <span>· {t.groupName}</span>}
                        </span>
                      </span>
                      {!narrow && (
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-[9px] font-bold uppercase text-[var(--muted)]">
                            {contact.slice(0, 1)}
                          </span>
                          <span className="truncate text-caption text-[var(--muted)]">{contact}</span>
                        </span>
                      )}
                      <span>
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusTone(t.status)}`}>
                          {STATUS_LABEL[t.status] ?? t.status}
                        </span>
                      </span>
                      {!narrow && (
                        <span className="flex items-center gap-1.5 text-caption capitalize text-[var(--muted)]">
                          <span className={`h-2 w-2 rounded-sm ${priorityDot(t.priority)}`} />
                          {t.priority.toLowerCase()}
                        </span>
                      )}
                      {!narrow && (
                        <span className="min-w-0 text-caption text-[var(--muted)]">
                          <span className="block truncate">{owners.length ? owners.map((o) => o.name).join(", ") : "Unassigned"}</span>
                          <span className="flex items-center gap-1 text-[10px]"><Clock size={9} /> {formatDate(t.createdAt)}</span>
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

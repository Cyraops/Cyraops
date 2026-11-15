"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, Check, Clock, ListChecks, ShieldCheck, Sparkles } from "lucide-react";
import { Button, useToast } from "@/components/ui";

/**
 * The Tasks page: every ticket in one place.
 *
 * Tickets arrive from two directions — a `@tasks …` message in the bot, or the
 * project board — and both land in the same table, so this is the place to see
 * what exists, who owns it, and what still needs a decision.
 *
 * Two things sit above the list and cannot be missed:
 *  - agent requests waiting on an approver, because work that is silently blocked
 *    is worse than work that was never asked for;
 *  - a quick-add box, because the fastest way to file a ticket should not be
 *    slower than the chat command that already exists.
 */

type Ticket = {
  id: string;
  title: string;
  status: string;
  priority?: string;
  dueDate?: string | null;
  createdAt: string;
  project?: { id: string; name: string } | null;
  creator?: { id: string; name: string } | null;
  assignees?: Array<{ kind: string; id: string; name: string }>;
};

type Approval = {
  id: string;
  proposedAction: string;
  description: string;
  requestedBy?: { name: string } | null;
  createdAt: string;
};

const STATUSES = ["BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"] as const;

const statusLabel = (status: string) => status.replaceAll("_", " ").toLowerCase();

const statusTone = (status: string) => {
  switch (status) {
    case "DONE":
      return "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
    case "IN_PROGRESS":
      return "bg-[#f0efff] text-accent dark:bg-[#302c4e] dark:text-[#c9c3ff]";
    case "IN_REVIEW":
      return "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
    default:
      return "bg-[var(--surface-2)] text-[var(--muted)]";
  }
};

export function TasksBoard() {
  const toast = useToast();
  const router = useRouter();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "open" | "done" | "mine">("all");
  const [query, setQuery] = useState("");
  const [quickAdd, setQuickAdd] = useState("");
  const [adding, setAdding] = useState(false);
  const [deciding, setDeciding] = useState("");
  const [savingStatus, setSavingStatus] = useState("");
  const [me, setMe] = useState<{ id: string; name: string; role: string } | null>(null);

  const load = useCallback(async () => {
    const [list, pending, who] = await Promise.all([
      fetch("/api/tickets?limit=60").then((r) => (r.ok ? r.json() : { tickets: [] })).catch(() => ({ tickets: [] })),
      fetch("/api/ai/approvals").then((r) => (r.ok ? r.json() : { approvals: [] })).catch(() => ({ approvals: [] })),
      fetch("/api/auth/me")
        .then((r) => (r.ok ? r.json() : { user: null }))
        .catch(() => ({ user: null })) as Promise<{ user?: { id: string; name: string; role: string } | null }>,
    ]);
    setTickets(list.tickets ?? []);
    setApprovals(pending.approvals ?? []);
    setMe(who.user ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tickets.filter((ticket) => {
      if (filter === "open" && ticket.status === "DONE") return false;
      if (filter === "done" && ticket.status !== "DONE") return false;
      if (filter === "mine" && !(ticket.assignees ?? []).some((owner) => owner.kind === "user" && owner.id === me?.id)) {
        return false;
      }
      if (!needle) return true;
      return (
        ticket.title.toLowerCase().includes(needle) ||
        (ticket.assignees ?? []).some((owner) => owner.name.toLowerCase().includes(needle))
      );
    });
  }, [tickets, filter, query, me]);

  const openCount = tickets.filter((ticket) => ticket.status !== "DONE").length;

  const setStatus = async (ticket: Ticket, status: string) => {
    setSavingStatus(ticket.id);
    try {
      const response = await fetch(`/api/tasks/${ticket.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast(data.error ?? "Could not update that ticket", "error");
        return;
      }
      setTickets((prev) => prev.map((item) => (item.id === ticket.id ? { ...item, status } : item)));
    } finally {
      setSavingStatus("");
    }
  };

  const decide = async (approvalId: string, action: "APPROVED" | "REJECTED") => {
    setDeciding(approvalId);
    try {
      const response = await fetch("/api/ai/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalId, action }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast(data.error ?? "Could not record that decision", "error");
        return;
      }
      toast(action === "APPROVED" ? "Approved — the agent is on it" : "Rejected — nothing ran");
      await load();
    } finally {
      setDeciding("");
    }
  };

  const addTicket = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = quickAdd.trim();
    if (!text) return;
    setAdding(true);
    try {
      // Same parser as chat: one sentence, optional @name to hand it to someone.
      const response = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.startsWith("@tasks") ? text : `@tasks ${text}` }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        toast(data.error ?? data.message ?? "Could not create that ticket", "error");
        return;
      }
      const unmatched: string[] = data.parsed?.unmatched ?? [];
      const waiting: string[] = data.ticket?.awaitingApproval ?? [];
      toast(
        waiting.length > 0
          ? `Ticket created. The ${waiting.join(", ")} agent needs approval.`
          : unmatched.length > 0
            ? `Ticket created, but ${unmatched.join(", ")} is not on the team — it went to you.`
            : "Ticket created"
      );
      setQuickAdd("");
      await load();
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold">Tasks</h1>
          <p className="mt-0.5 text-meta text-[var(--muted)]">
            {tickets.length} ticket{tickets.length === 1 ? "" : "s"}, {openCount} still open. Create one here or type{" "}
            <span className="font-semibold">@tasks</span> in the Cyraops Bot.
          </p>
        </div>
        <div className="flex gap-1">
          {(["all", "open", "done", "mine"] as const).map((value) => (
            <button
              key={value}
              onClick={() => setFilter(value)}
              className={`rounded-lg px-2.5 py-1.5 text-meta font-semibold capitalize transition ${
                filter === value
                  ? "bg-[#f0efff] text-accent dark:bg-[#302c4e] dark:text-[#c9c3ff]"
                  : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
              }`}
            >
              {value === "mine" ? "Assigned to me" : value}
            </button>
          ))}
        </div>
      </header>

      {/* Anything blocked on a person is the most important thing on this page. */}
      {approvals.length > 0 && (
        <section className="rounded-xl border border-amber-300/60 bg-amber-50/60 p-3 dark:border-amber-900/40 dark:bg-amber-950/20">
          <div className="flex items-start gap-2">
            <ShieldCheck size={15} className="mt-0.5 shrink-0 text-amber-600" />
            <div>
              <h2 className="text-meta font-bold">
                {approvals.length} agent step{approvals.length === 1 ? "" : "s"} waiting for your approval
              </h2>
              <p className="mt-0.5 text-caption text-[var(--muted)]">
                These are <span className="font-semibold">not tickets</span>. An agent planned these actions and the
                approval gate stopped it before it acted. Approving lets that one step run; rejecting drops it.
              </p>
            </div>
          </div>
          <div className="mt-2 space-y-2">
            {approvals.map((approval) => (
              <div
                key={approval.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-meta font-semibold">{approval.proposedAction}</p>
                  <p className="truncate text-caption text-[var(--muted)]">
                    Planned by an agent · asked by {approval.requestedBy?.name ?? "someone"} ·{" "}
                    {approval.description}
                  </p>
                </div>
                <div className="flex gap-1.5">
                  <Button disabled={deciding === approval.id} onClick={() => void decide(approval.id, "APPROVED")}>
                    {deciding === approval.id ? "…" : "Approve"}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={deciding === approval.id}
                    onClick={() => void decide(approval.id, "REJECTED")}
                  >
                    Reject
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <form onSubmit={addTicket} className="flex gap-2">
        <input
          value={quickAdd}
          onChange={(event) => setQuickAdd(event.target.value)}
          placeholder="Add a ticket… e.g. Call Northwind back @akshat"
          className="h-10 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm outline-none focus:border-accent"
        />
        <Button disabled={adding || !quickAdd.trim()}>{adding ? "Adding…" : "Add ticket"}</Button>
      </form>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
          <ListChecks size={14} className="text-[var(--muted)]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by title or owner…"
            className="h-7 flex-1 bg-transparent text-meta outline-none placeholder:text-[var(--muted)]"
          />
        </div>

        {loading ? (
          <p className="px-3 py-10 text-center text-meta text-[var(--muted)]">Loading tickets…</p>
        ) : visible.length === 0 ? (
          <div className="px-3 py-12 text-center">
            <Sparkles size={20} className="mx-auto text-[var(--muted)]" />
            <p className="mt-2 text-meta font-semibold">
              {tickets.length === 0 ? "No tickets yet" : "Nothing matches that filter"}
            </p>
            {tickets.length === 0 && (
              <p className="mt-1 text-caption text-[var(--muted)]">
                Type <span className="font-semibold">@tasks</span> in the{" "}
                <button onClick={() => router.push("/ai")} className="font-semibold text-accent underline">
                  Cyraops Bot
                </button>{" "}
                — add <span className="font-semibold">@name</span> to hand it to a teammate or an AI agent.
              </p>
            )}
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {visible.map((ticket) => {
              const owners = ticket.assignees ?? [];
              return (
                <div key={ticket.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p
                      className={`truncate text-meta font-semibold ${
                        ticket.status === "DONE" ? "text-[var(--muted)] line-through" : ""
                      }`}
                    >
                      {ticket.title}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-caption text-[var(--muted)]">
                      {owners.length === 0 ? (
                        <span>Unassigned</span>
                      ) : (
                        owners.map((owner) => (
                          <span
                            key={`${owner.kind}-${owner.id}`}
                            className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-2)] px-1.5 py-0.5"
                          >
                            {owner.kind === "agent" ? <Bot size={10} /> : null}
                            {owner.name}
                          </span>
                        ))
                      )}
                      {ticket.creator?.name && <span>· by {ticket.creator.name}</span>}
                      {ticket.dueDate && (
                        <span className="inline-flex items-center gap-1">
                          <Clock size={10} /> {new Date(ticket.dueDate).toLocaleDateString()}
                        </span>
                      )}
                    </p>
                  </div>

                  <span className={`rounded-full px-2 py-0.5 text-caption font-semibold ${statusTone(ticket.status)}`}>
                    {statusLabel(ticket.status)}
                  </span>

                  {/* Tracking means being able to move it, not just look at it. */}
                  <select
                    value={ticket.status}
                    disabled={savingStatus === ticket.id}
                    onChange={(event) => void setStatus(ticket, event.target.value)}
                    aria-label={`Change status for ${ticket.title}`}
                    className="h-7 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-1.5 text-caption outline-none focus:border-accent disabled:opacity-50"
                  >
                    {STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {statusLabel(status)}
                      </option>
                    ))}
                  </select>

                  <button
                    onClick={() =>
                      router.push(ticket.project ? `/projects?project=${ticket.project.id}&tab=tasks` : "/projects")
                    }
                    className="rounded-lg px-1.5 py-1 text-caption font-semibold text-accent hover:underline"
                  >
                    Open
                  </button>

                  {ticket.status !== "DONE" && (
                    <button
                      title="Mark done"
                      disabled={savingStatus === ticket.id}
                      onClick={() => void setStatus(ticket, "DONE")}
                      className="flex h-6 w-6 items-center justify-center rounded-full border border-[var(--border)] text-[var(--muted)] transition hover:border-emerald-500 hover:text-emerald-600 disabled:opacity-50"
                    >
                      <Check size={12} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

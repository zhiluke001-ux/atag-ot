// src/app/(app)/me/pay/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import {
  centsToRm,
  WORK_ROLE_LABEL,
  formatPayBreakdownInline,
  // admin-side breakdown building (from ot-events.taskCodes)
  CLAIM_LABEL,
  TASK_LABEL,
  resolveAddOnRates,
  resolveBaseRates,
  type ClaimCode,
  type TaskCode,
  type TaskSelection,
  type WorkRole,
} from "@/lib/pricing";

/* ---------------- Types ---------------- */

type AdminUser = { id: string; name: string; email: string };

type PayRow = {
  id: string;
  status: "UNPAID" | "PAID";
  workRole: string;

  amountDefaultCents: number;
  amountOverrideCents: number | null;
  effectiveCents: number;

  paidAt: string | null;

  otEvent: {
    date: string; // event "anchor" date (often day-1)
    project: string;
    startTime: string; // ISO datetime
    endTime: string; // ISO datetime (can be next day(s))
    remark: string | null;
    taskCodes?: string;
  };

  taskBreakdown?: {
    hours: number;
    totalRM: number;
    items: { key: string; label: string; amountRM: number }[];
  };
};

/* -------- Admin OT-event payload (from /api/admin/ot-events) -------- */

type AdminAssignment = {
  id: string;
  userId: string;
  status: "UNPAID" | "PAID";
  amountDefault: number;
  amountOverride: number | null;
  workRole: WorkRole;
  user: { name: string; email: string };
};

type AdminOtEvent = {
  id: string;
  date: string;
  project: string;
  startTime: string;
  endTime: string;
  taskCodes: string;
  remark: string | null;
  assignments: AdminAssignment[];
};

/* ---------------- UI helpers ---------------- */

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString();
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Date display:
 * - Normal events: "MM/DD/YYYY" (or your locale)
 * - Multi-day events (2D1N/3D2N): "MM/DD/YYYY - MM/DD/YYYY"
 *
 * We detect multi-day by comparing startTime vs endTime calendar date.
 */
function fmtDateRangeFromEvent(ev: { date?: string; startTime?: string; endTime?: string }) {
  const start = ev?.startTime ? new Date(ev.startTime) : ev?.date ? new Date(ev.date) : null;
  const end = ev?.endTime ? new Date(ev.endTime) : ev?.date ? new Date(ev.date) : null;

  if (!start || Number.isNaN(start.getTime())) return ev?.date ? fmtDate(ev.date) : "-";
  if (!end || Number.isNaN(end.getTime())) return start.toLocaleDateString();

  const s = start.toLocaleDateString();
  const e = end.toLocaleDateString();

  // If same calendar day, show one date; else show range.
  if (s === e) return s;
  return `${s} - ${e}`;
}

/* ---------------- CSV helpers ---------------- */

function csvEscape(v: unknown) {
  const s = String(v ?? "");
  if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadTextFile(filename: string, content: string, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---------------- Admin-side breakdown builders ---------------- */

function isTaskCode(x: unknown): x is TaskCode {
  return typeof x === "string" && Object.prototype.hasOwnProperty.call(TASK_LABEL, x);
}

function safeParseSelection(taskCodes: string): TaskSelection {
  try {
    const j = JSON.parse(taskCodes || "{}") as any;

    const rawCodes: unknown[] = Array.isArray(j?.codes) ? j.codes : [];
    const codes: TaskCode[] = rawCodes.filter(isTaskCode);

    const claim = (j?.claim ?? null) as ClaimCode | null;

    return {
      claim,
      codes,
      note: typeof j?.note === "string" ? j.note : "",
      baseRates: j?.baseRates ?? {},
      addOnRates: j?.addOnRates ?? {},
      custom: j?.custom ?? { enabled: false, label: "", amount: "" },
    } as TaskSelection;
  } catch {
    return {
      claim: null,
      codes: [],
      note: "",
      baseRates: {},
      addOnRates: {},
      custom: { enabled: false, label: "", amount: "" },
    } as TaskSelection;
  }
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function hoursBetween(start: Date, end: Date) {
  const ms = end.getTime() - start.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return round2(ms / (1000 * 60 * 60));
}

function toNum(v: unknown, fallback = 0) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function buildTaskPayBreakdown(args: {
  workRole: WorkRole;
  start: Date;
  end: Date;
  selection: TaskSelection;
}): { hours: number; items: { key: string; label: string; amountRM: number }[]; totalRM: number } {
  const { workRole, start, end, selection } = args;

  const isSenior = String(workRole).includes("SENIOR");
  const isMarshal = String(workRole).includes("MARSHAL");
  const isEmcee = String(workRole).includes("EMCEE");

  const hrs = hoursBetween(start, end);
  const items: { key: string; label: string; amountRM: number }[] = [];

  // Base claim
  if (selection.claim) {
    const claim = selection.claim;
    const base = resolveBaseRates(claim, selection) as any;

    const baseKind = base?.kind as string | undefined;
    const isHourly = baseKind === "HOURLY" || claim === "EVENT_HOURLY";

    if (isHourly) {
      if (isMarshal) {
        const rate = isSenior ? toNum(base?.marshalSenior, 0) : toNum(base?.marshalJunior, 0);
        const amt = round2(hrs * rate);
        if (amt > 0) {
          items.push({
            key: `base-${claim}-marshal`,
            label: `Event - ${CLAIM_LABEL[claim]} (${hrs}h × RM${rate}/hr)`,
            amountRM: amt,
          });
        }
      } else if (isEmcee) {
        const rate = isSenior ? toNum(base?.emceeSenior, 0) : toNum(base?.emceeJunior, 0);
        const amt = round2(hrs * rate);
        if (amt > 0) {
          items.push({
            key: `base-${claim}-emcee`,
            label: `Event - ${CLAIM_LABEL[claim]} (${hrs}h × RM${rate}/hr)`,
            amountRM: amt,
          });
        }
      }
    } else {
      if (isMarshal) {
        const amt = round2(isSenior ? toNum(base?.marshalSenior, 0) : toNum(base?.marshalJunior, 0));
        if (amt > 0) items.push({ key: `base-${claim}-marshal`, label: `Event - ${CLAIM_LABEL[claim]}`, amountRM: amt });
      }
      if (isEmcee) {
        const amt = round2(isSenior ? toNum(base?.emceeSenior, 0) : toNum(base?.emceeJunior, 0));
        if (amt > 0) items.push({ key: `base-${claim}-emcee`, label: `Event - ${CLAIM_LABEL[claim]}`, amountRM: amt });
      }
    }
  }

  // Add-ons
  const add = resolveAddOnRates(selection) as any;
  const startsAfter6pm = start.getHours() >= 18;

  for (const code of selection.codes || []) {
    if (code === "BACKEND_RM15") {
      const rate = toNum(add?.backendPerHour, 0);
      const amt = round2(hrs * rate);
      if (amt > 0) items.push({ key: `add-${code}`, label: `Backend (${hrs}h × RM${rate}/hr)`, amountRM: amt });
    }

    if (code === "EVENT_AFTER_6PM") {
      const rate = toNum(add?.after6pmPerHour, 0);
      const appliedHrs = startsAfter6pm ? hrs : 0;
      const amt = round2(appliedHrs * rate);
      if (amt > 0) items.push({ key: `add-${code}`, label: `Event starts after 6PM (${appliedHrs}h × RM${rate}/hr)`, amountRM: amt });
    }

    if (code === "EARLY_CALLING_RM30") {
      const amt = round2(toNum(add?.earlyCallingFlat, 0));
      if (amt > 0) items.push({ key: `add-${code}`, label: "Early Calling", amountRM: amt });
    }

    if (code === "LOADING_UNLOADING_RM30") {
      const amt = round2(toNum(add?.loadingUnloadingFlat, 0));
      if (amt > 0) items.push({ key: `add-${code}`, label: "Loading & Unloading", amountRM: amt });
    }
  }

  // Custom
  if (selection.custom?.enabled) {
    const amt = round2(toNum((selection.custom as any).amount, 0));
    const label = typeof (selection.custom as any).label === "string" ? (selection.custom as any).label.trim() : "";
    if (amt > 0) items.push({ key: "custom", label: label || "Custom", amountRM: amt });
  }

  const totalRM = round2(items.reduce((s, x) => s + x.amountRM, 0));
  return { hours: hrs, items, totalRM };
}

function buildRowsForUserFromEvents(events: AdminOtEvent[], userId: string): PayRow[] {
  const out: PayRow[] = [];

  for (const ev of events || []) {
    const selection = safeParseSelection(ev.taskCodes || "{}");
    const start = new Date(ev.startTime);
    const end = new Date(ev.endTime);

    for (const a of ev.assignments || []) {
      if (a.userId !== userId) continue;

      const amountDefaultCents = Number(a.amountDefault ?? 0);
      const amountOverrideCents = a.amountOverride === null || a.amountOverride === undefined ? null : Number(a.amountOverride);
      const effectiveCents = amountOverrideCents ?? amountDefaultCents;

      const bd = buildTaskPayBreakdown({
        workRole: a.workRole,
        start,
        end,
        selection,
      });

      out.push({
        id: a.id,
        status: a.status,
        workRole: a.workRole,
        amountDefaultCents,
        amountOverrideCents,
        effectiveCents,
        paidAt: null, // not provided by /api/admin/ot-events payload
        otEvent: {
          date: ev.date,
          project: ev.project,
          startTime: ev.startTime,
          endTime: ev.endTime,
          remark: ev.remark,
          taskCodes: ev.taskCodes,
        },
        taskBreakdown: bd,
      });
    }
  }

  // newest first
  out.sort((x, y) => new Date(y.otEvent.date).getTime() - new Date(x.otEvent.date).getTime());
  return out;
}

/* ---------------- Page ---------------- */

export default function MyPayPage() {
  // role detection
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  // admin data
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [adminEvents, setAdminEvents] = useState<AdminOtEvent[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [userSearch, setUserSearch] = useState("");

  // pay rows
  const [rows, setRows] = useState<PayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);

  const selectedUser = useMemo(() => adminUsers.find((u) => u.id === selectedUserId) || null, [adminUsers, selectedUserId]);

  async function loadNormal() {
    setLoading(true);
    setMsg(null);
    try {
      const res = await fetch("/api/me/pay", { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(j?.error || "Failed to load pay");
        setRows([]);
        return;
      }
      setRows(Array.isArray(j.assignments) ? j.assignments : []);
    } catch (e: any) {
      setMsg(e?.message || "Failed to load pay");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  async function loadAdminUsersAndEvents() {
    setLoading(true);
    setMsg(null);

    try {
      const [uRes, eRes] = await Promise.all([
        fetch("/api/admin/users", { cache: "no-store" }),
        fetch("/api/admin/ot-events", { cache: "no-store" }),
      ]);

      const uj = await uRes.json().catch(() => ({}));
      const ej = await eRes.json().catch(() => ({}));

      if (!uRes.ok || !eRes.ok) {
        setMsg((uj?.error || ej?.error || "Forbidden (Admin only)") as string);
        setAdminUsers([]);
        setAdminEvents([]);
        setRows([]);
        return;
      }

      const users: AdminUser[] = Array.isArray(uj.users) ? uj.users : [];
      const events: AdminOtEvent[] = Array.isArray(ej.events) ? ej.events : [];

      setAdminUsers(users);
      setAdminEvents(events);

      const defaultId = selectedUserId || users?.[0]?.id || "";
      setSelectedUserId(defaultId);

      if (defaultId) setRows(buildRowsForUserFromEvents(events, defaultId));
      else setRows([]);
    } catch (e: any) {
      setMsg(e?.message || "Failed to load admin data");
      setAdminUsers([]);
      setAdminEvents([]);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

async function detectAndLoad() {
  setMsg(null);

  try {
    // ✅ Use a non-admin endpoint to check role
    const meRes = await fetch("/api/me/profile", { cache: "no-store" });
    const me = await meRes.json().catch(() => ({}));

    const role = me?.user?.role;

    if (meRes.ok && role === "ADMIN") {
      setIsAdmin(true);
      await loadAdminUsersAndEvents(); // calls /api/admin/users + /api/admin/ot-events (now only for admin)
      return;
    }

    // normal user
    setIsAdmin(false);
    await loadNormal();
  } catch (e: any) {
    setIsAdmin(false);
    await loadNormal();
  }
}


        const events: AdminOtEvent[] = Array.isArray(ej.events) ? ej.events : [];
        setAdminEvents(events);

        if (defaultId) setRows(buildRowsForUserFromEvents(events, defaultId));
        else setRows([]);

        setLoading(false);
        return;
      }

      setIsAdmin(false);
      await loadNormal();
    } catch {
      setIsAdmin(false);
      await loadNormal();
    }
  }

  useEffect(() => {
    detectAndLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // when admin switches user -> rebuild rows from cached events
  useEffect(() => {
    if (!isAdmin) return;
    if (!selectedUserId) return;
    if (!adminEvents?.length) return;
    setRows(buildRowsForUserFromEvents(adminEvents, selectedUserId));
  }, [isAdmin, selectedUserId, adminEvents]);

  const totals = useMemo(() => {
    let unpaid = 0;
    let paid = 0;
    for (const r of rows) {
      if (r.status === "PAID") paid += Number(r.effectiveCents || 0);
      else unpaid += Number(r.effectiveCents || 0);
    }
    return { unpaid, paid, count: rows.length };
  }, [rows]);

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return adminUsers;
    return adminUsers.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  }, [adminUsers, userSearch]);

  async function refresh() {
    if (isAdmin) return loadAdminUsersAndEvents();
    return loadNormal();
  }

  function exportCsv() {
    try {
      setExportBusy(true);

      const viewingName = isAdmin ? selectedUser?.name || "user" : "me";
      const safeName = viewingName.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_");
      const fileName = `pay_${safeName}_${new Date().toISOString().slice(0, 10)}.csv`;

      const headers = [
        ...(isAdmin ? ["UserName", "UserEmail"] : []),
        "Date",
        "Project",
        "StartTime",
        "EndTime",
        "Role",
        "Task&Pay",
        "EffectiveRM",
        "Status",
        "PaidAt",
        "Remark",
      ];

      const lines: string[] = [];
      lines.push(headers.map(csvEscape).join(","));

      for (const r of rows) {
        const inline = formatPayBreakdownInline((r.taskBreakdown?.items || []) as any);

        const row = [
          ...(isAdmin ? [selectedUser?.name || "", selectedUser?.email || ""] : []),
          fmtDateRangeFromEvent(r.otEvent), // ✅ range-aware date
          r.otEvent.project,
          fmtTime(r.otEvent.startTime),
          fmtTime(r.otEvent.endTime),
          (WORK_ROLE_LABEL as any)?.[r.workRole] || r.workRole,
          inline,
          centsToRm(r.effectiveCents),
          r.status,
          r.paidAt ? fmtDate(r.paidAt) : "",
          r.otEvent.remark || "",
        ];

        lines.push(row.map(csvEscape).join(","));
      }

      downloadTextFile(fileName, lines.join("\n"));
    } finally {
      setExportBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-col md:flex-row md:items-center">
        <div>
          <h1 className="text-2xl font-semibold">{isAdmin ? selectedUser?.name || "Select a user" : "My Pay"}</h1>
          <div className="text-sm text-gray-600 mt-1">
            Approved OT assignments + tasks breakdown.
            {isAdmin && selectedUser?.email ? <span className="ml-2 text-xs text-gray-500">({selectedUser.email})</span> : null}
          </div>
        </div>

        <div className="flex gap-2">
          <button className="text-sm px-3 py-1.5 border rounded bg-white hover:bg-gray-50" onClick={refresh}>
            Refresh
          </button>
          <button
            className="text-sm px-3 py-1.5 border rounded bg-white hover:bg-gray-50 disabled:opacity-60"
            onClick={exportCsv}
            disabled={exportBusy || loading || rows.length === 0}
            title="Download CSV (Excel/Google Sheets)"
          >
            {exportBusy ? "Exporting..." : "Export CSV"}
          </button>
        </div>
      </div>

      {msg && <div className="text-sm text-red-600">{msg}</div>}

      {/* Admin user switcher (names clickable) */}
      {isAdmin && (
        <div className="bg-white border rounded-xl p-4 space-y-3">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
            <div className="font-semibold">View Pay By User</div>
            <input
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              placeholder="Search name/email..."
              className="border rounded px-3 py-2 text-sm w-full md:w-72"
            />
          </div>

          <div className="flex gap-2 overflow-auto py-1">
            {filteredUsers.map((u) => {
              const active = u.id === selectedUserId;
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => setSelectedUserId(u.id)}
                  className={`whitespace-nowrap px-3 py-1.5 rounded border text-sm ${
                    active ? "bg-black text-white border-black" : "bg-white hover:bg-gray-50"
                  }`}
                  title={u.email}
                >
                  {u.name}
                </button>
              );
            })}

            {filteredUsers.length === 0 && <div className="text-sm text-gray-500">No users found.</div>}
          </div>
        </div>
      )}

      {/* Totals */}
      <div className="grid md:grid-cols-3 gap-3">
        <div className="bg-white border rounded-xl p-4">
          <div className="text-xs text-gray-600">Unpaid Total</div>
          <div className="text-xl font-semibold mt-1">RM{centsToRm(totals.unpaid)}</div>
        </div>
        <div className="bg-white border rounded-xl p-4">
          <div className="text-xs text-gray-600">Paid Total</div>
          <div className="text-xl font-semibold mt-1">RM{centsToRm(totals.paid)}</div>
        </div>
        <div className="bg-white border rounded-xl p-4">
          <div className="text-xs text-gray-600">Assignments</div>
          <div className="text-xl font-semibold mt-1">{totals.count}</div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white border rounded-xl overflow-hidden">
        <div className="p-4 border-b flex items-center justify-between">
          <div className="font-semibold">Details</div>
          {loading && <div className="text-sm text-gray-500">Loading…</div>}
        </div>

        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-2">Date</th>
                <th className="text-left p-2">Project</th>
                <th className="text-left p-2">Time</th>
                <th className="text-left p-2">Role</th>
                <th className="text-left p-2">Task & Pay</th>
                <th className="text-right p-2">Effective</th>
                <th className="text-center p-2">Status</th>
              </tr>
            </thead>

            <tbody>
              {!loading && rows.length === 0 && (
                <tr className="border-t">
                  <td className="p-4 text-gray-500" colSpan={7}>
                    No assignments found.
                  </td>
                </tr>
              )}

              {rows.map((r) => {
                const isPaid = r.status === "PAID";
                const inline = formatPayBreakdownInline((r.taskBreakdown?.items || []) as any);

                return (
                  <tr key={r.id} className={`border-t ${isPaid ? "bg-gray-50 text-gray-600" : "bg-white"}`}>
                    {/* ✅ Date column now supports 2D1N/3D2N */}
                    <td className="p-2 whitespace-nowrap">{fmtDateRangeFromEvent(r.otEvent)}</td>

                    <td className="p-2 min-w-[220px]">
                      <div className="font-medium">{r.otEvent.project}</div>
                      {r.otEvent.remark && <div className="text-xs text-gray-600 mt-0.5">Remark: {r.otEvent.remark}</div>}
                    </td>

                    <td className="p-2 whitespace-nowrap">
                      {fmtTime(r.otEvent.startTime)} - {fmtTime(r.otEvent.endTime)}
                    </td>

                    <td className="p-2 whitespace-nowrap text-xs">{(WORK_ROLE_LABEL as any)?.[r.workRole] || r.workRole}</td>

                    <td className="p-2 text-xs min-w-[280px]">
                      <div className="text-gray-800">{inline}</div>
                    </td>

                    <td className="p-2 text-right whitespace-nowrap font-semibold">RM{centsToRm(r.effectiveCents)}</td>

                    <td className="p-2 text-center whitespace-nowrap">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-xs border ${
                          isPaid ? "bg-white border-gray-200" : "bg-yellow-50 border-yellow-200 text-yellow-800"
                        }`}
                      >
                        {isPaid ? "PAID" : "UNPAID"}
                      </span>
                      {isPaid && r.paidAt && <div className="text-[11px] mt-1">{fmtDate(r.paidAt)}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Small note for admin */}
      {isAdmin && (
        <div className="text-xs text-gray-500">
          Admin view builds the breakdown from <code>ot-events.taskCodes</code>. If you want to show <code>paidAt</code> here too,
          include it inside <code>/api/admin/ot-events</code> assignment payload.
        </div>
      )}
    </div>
  );
}

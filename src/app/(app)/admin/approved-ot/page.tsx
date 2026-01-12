// src/app/(app)/admin/approved-ot/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CLAIM_LABEL,
  TASK_LABEL,
  WORK_ROLE_LABEL,
  centsToRm,
  computeDefaultPayRM,
  resolveAddOnRates,
  resolveBaseRates,
  type ClaimCode,
  type TaskCode,
  type TaskSelection,
  type WorkRole,
} from "@/lib/pricing";

/* ---------------- Types ---------------- */

type User = {
  id: string;
  name: string;
  email: string;
  defaultWorkRole: WorkRole;
};

type Assignment = {
  id: string;
  userId: string;
  status: "UNPAID" | "PAID";
  amountDefault: number;
  amountOverride: number | null;
  workRole: WorkRole;
  user: { name: string; email: string };
};

type OtEvent = {
  id: string;
  date: string;
  project: string;
  startTime: string;
  endTime: string;
  taskCodes: string;
  remark: string | null;
  assignments: Assignment[];
};

/* ---------------- Safe helpers ---------------- */

function isTaskCode(x: unknown): x is TaskCode {
  return typeof x === "string" && Object.prototype.hasOwnProperty.call(TASK_LABEL, x);
}

function isoDateOnly(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function hhmmFromIso(iso: string) {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
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

/* ---------------- Task + Pay breakdown (display only) ---------------- */

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
}): { lines: { label: string; amountRM: number }[]; totalRM: number } {
  const { workRole, start, end, selection } = args;

  const isSenior = String(workRole).includes("SENIOR");
  const isMarshal = String(workRole).includes("MARSHAL");
  const isEmcee = String(workRole).includes("EMCEE");

  const hrs = hoursBetween(start, end);
  const lines: { label: string; amountRM: number }[] = [];

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
          lines.push({
            label: `Event - ${CLAIM_LABEL[claim]} (${hrs}h × RM${rate}/hr)`,
            amountRM: amt,
          });
        }
      } else if (isEmcee) {
        const rate = isSenior ? toNum(base?.emceeSenior, 0) : toNum(base?.emceeJunior, 0);
        const amt = round2(hrs * rate);
        if (amt > 0) {
          lines.push({
            label: `Event - ${CLAIM_LABEL[claim]} (${hrs}h × RM${rate}/hr)`,
            amountRM: amt,
          });
        }
      }
    } else {
      if (isMarshal) {
        const amt = round2(isSenior ? toNum(base?.marshalSenior, 0) : toNum(base?.marshalJunior, 0));
        if (amt > 0) lines.push({ label: `Event - ${CLAIM_LABEL[claim]}`, amountRM: amt });
      }
      if (isEmcee) {
        const amt = round2(isSenior ? toNum(base?.emceeSenior, 0) : toNum(base?.emceeJunior, 0));
        if (amt > 0) lines.push({ label: `Event - ${CLAIM_LABEL[claim]}`, amountRM: amt });
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
      if (amt > 0) lines.push({ label: `Backend (${hrs}h × RM${rate}/hr)`, amountRM: amt });
    }

    if (code === "EVENT_AFTER_6PM") {
      const rate = toNum(add?.after6pmPerHour, 0);
      const appliedHrs = startsAfter6pm ? hrs : 0;
      const amt = round2(appliedHrs * rate);
      if (amt > 0) lines.push({ label: `Event starts after 6PM (${appliedHrs}h × RM${rate}/hr)`, amountRM: amt });
    }

    if (code === "EARLY_CALLING_RM30") {
      const amt = round2(toNum(add?.earlyCallingFlat, 0));
      if (amt > 0) lines.push({ label: "Early Calling", amountRM: amt });
    }

    if (code === "LOADING_UNLOADING_RM30") {
      const amt = round2(toNum(add?.loadingUnloadingFlat, 0));
      if (amt > 0) lines.push({ label: "Loading & Unloading", amountRM: amt });
    }
  }

  // Custom
  if (selection.custom?.enabled) {
    const amt = round2(toNum((selection.custom as any).amount, 0));
    const label = typeof (selection.custom as any).label === "string" ? (selection.custom as any).label.trim() : "";
    if (amt > 0) lines.push({ label: label || "Custom", amountRM: amt });
  }

  const totalRM = round2(lines.reduce((s, x) => s + x.amountRM, 0));
  return { lines, totalRM };
}

function formatBreakdownInline(lines: { label: string; amountRM: number }[]) {
  if (!lines?.length) return "-";
  return lines.map((x) => `${x.label} (RM${x.amountRM.toFixed(2)})`).join(" + ");
}

/* ---------------- Task Modal ---------------- */

function TaskModal({
  open,
  onClose,
  selection,
  setSelection,
}: {
  open: boolean;
  onClose: () => void;
  selection: TaskSelection;
  setSelection: (s: TaskSelection) => void;
}) {
  if (!open) return null;

  const claimOptions: { value: ClaimCode | null; label: string }[] = [
    { value: null, label: "None" },
    { value: "EVENT_HOURLY", label: "Hourly" },
    { value: "EVENT_HALF_DAY", label: "Half Day" },
    { value: "EVENT_FULL_DAY", label: "Full Day" },
    { value: "EVENT_2D1N", label: "2D1N" },
    { value: "EVENT_3D2N", label: "3D2N" },
  ];

  const addOnRows: {
    code: TaskCode;
    left: string;
    unit: "perHour" | "flat";
    rateKey: keyof NonNullable<TaskSelection["addOnRates"]>;
  }[] = [
    { code: "BACKEND_RM15", left: "Backend — Annual Dinner / Karaoke / Packing / Set Up", unit: "perHour", rateKey: "backendPerHour" },
    { code: "EVENT_AFTER_6PM", left: "Event starts after 6PM (RM30 | RM20 per hour)", unit: "perHour", rateKey: "after6pmPerHour" },
    { code: "EARLY_CALLING_RM30", left: "Early Calling", unit: "flat", rateKey: "earlyCallingFlat" },
    { code: "LOADING_UNLOADING_RM30", left: "Loading & Unloading", unit: "flat", rateKey: "loadingUnloadingFlat" },
  ];

  function toggleCode(code: TaskCode) {
    const exists = selection.codes.includes(code);
    const next = exists ? selection.codes.filter((c) => c !== code) : [...selection.codes, code];
    setSelection({ ...selection, codes: next });
  }

  function setAddOnRate(key: string, value: string) {
    const next = { ...(selection.addOnRates || {}) } as Record<string, string>;
    if (value.trim() === "") delete next[key];
    else next[key] = value;
    setSelection({ ...selection, addOnRates: next as any });
  }

  function setBaseRate(key: string, value: string) {
    const next = { ...(selection.baseRates || {}) } as Record<string, string>;
    if (value.trim() === "") delete next[key];
    else next[key] = value;
    setSelection({ ...selection, baseRates: next as any });
  }

  const claim = selection.claim;
  const base = claim ? (resolveBaseRates(claim, selection) as any) : null;
  const add = resolveAddOnRates(selection) as any;

  const showEmceeBase = claim === "EVENT_HALF_DAY" || claim === "EVENT_FULL_DAY";
  const showMarshalBase = claim !== null;

  function resetDefaults() {
    setSelection({
      ...selection,
      baseRates: {},
      addOnRates: {},
      custom: { enabled: false, label: "", amount: "" },
      note: "",
    } as TaskSelection);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3">
      <div className="w-full max-w-3xl bg-white rounded-2xl border shadow-sm flex flex-col max-h-[90vh]">
        <div className="sticky top-0 bg-white z-10 border-b p-4 flex items-center justify-between">
          <div>
            <div className="font-semibold">Select Task Description</div>
            <div className="text-xs text-gray-600">Pick base claim (0 or 1) + tick add-ons. You can edit the RM amounts here.</div>
          </div>
          <div className="flex gap-2">
            <button className="text-sm px-3 py-1.5 border rounded" onClick={resetDefaults}>Reset</button>
            <button className="text-sm px-3 py-1.5 border rounded" onClick={onClose}>Close</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          <div>
            <div className="text-sm font-semibold mb-2">Event Type (0 or 1)</div>
            <div className="flex flex-wrap gap-2">
              {claimOptions.map((opt) => {
                const active = selection.claim === opt.value;
                return (
                  <button
                    key={String(opt.value)}
                    type="button"
                    onClick={() => setSelection({ ...selection, claim: opt.value })}
                    className={`px-3 py-1.5 rounded border text-sm ${active ? "bg-black text-white border-black" : "bg-white hover:bg-gray-50"}`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {claim && base && (
            <div className="border rounded-xl p-3">
              <div>
                <div className="text-sm font-semibold">Base Pay — {CLAIM_LABEL[claim]}</div>
                <div className="text-xs text-gray-600">{base?.kind === "HOURLY" ? "Marshal rates are per hour." : "Flat amount for the claim."}</div>
              </div>

              <div className="mt-3 grid md:grid-cols-2 gap-3">
                {showMarshalBase && (
                  <div className="border rounded-lg p-3">
                    <div className="text-sm font-semibold">Marshal</div>
                    <div className="mt-2 grid grid-cols-2 gap-2 items-center">
                      <label className="text-xs text-gray-600">Senior (RM)</label>
                      <input
                        className="border rounded px-2 py-1 text-right"
                        value={String((selection.baseRates as any)?.marshalSenior ?? base?.marshalSenior ?? "")}
                        onChange={(e) => setBaseRate("marshalSenior", e.target.value)}
                      />
                      <label className="text-xs text-gray-600">Junior (RM)</label>
                      <input
                        className="border rounded px-2 py-1 text-right"
                        value={String((selection.baseRates as any)?.marshalJunior ?? base?.marshalJunior ?? "")}
                        onChange={(e) => setBaseRate("marshalJunior", e.target.value)}
                      />
                    </div>
                  </div>
                )}

                <div className={`border rounded-lg p-3 ${showEmceeBase ? "" : "opacity-50"}`}>
                  <div className="text-sm font-semibold">Emcee</div>
                  <div className="mt-2 grid grid-cols-2 gap-2 items-center">
                    <label className="text-xs text-gray-600">Senior (RM)</label>
                    <input
                      disabled={!showEmceeBase}
                      className="border rounded px-2 py-1 text-right disabled:opacity-60"
                      value={String((selection.baseRates as any)?.emceeSenior ?? base?.emceeSenior ?? "")}
                      onChange={(e) => setBaseRate("emceeSenior", e.target.value)}
                    />
                    <label className="text-xs text-gray-600">Junior (RM)</label>
                    <input
                      disabled={!showEmceeBase}
                      className="border rounded px-2 py-1 text-right disabled:opacity-60"
                      value={String((selection.baseRates as any)?.emceeJunior ?? base?.emceeJunior ?? "")}
                      onChange={(e) => setBaseRate("emceeJunior", e.target.value)}
                    />
                  </div>
                  {!showEmceeBase && <div className="text-xs text-gray-600 mt-2">Emcee base only applies for Half Day / Full Day.</div>}
                </div>
              </div>
            </div>
          )}

          <div className="border rounded-xl p-3">
            <div className="text-sm font-semibold">Add-ons</div>
            <div className="text-xs text-gray-600">Tick what applies, then adjust RM if needed.</div>

            <div className="mt-3 space-y-2">
              {addOnRows.map((row) => {
                const checked = selection.codes.includes(row.code);
                const current =
                  (selection.addOnRates as any)?.[row.rateKey] ??
                  (row.rateKey === "backendPerHour"
                    ? add?.backendPerHour
                    : row.rateKey === "after6pmPerHour"
                    ? add?.after6pmPerHour
                    : row.rateKey === "earlyCallingFlat"
                    ? add?.earlyCallingFlat
                    : add?.loadingUnloadingFlat);

                return (
                  <div key={row.code} className="border rounded-lg p-3 flex items-center justify-between gap-3">
                    <label className="flex items-start gap-2 text-sm">
                      <input type="checkbox" className="mt-1" checked={checked} onChange={() => toggleCode(row.code)} />
                      <div>
                        <div className="font-medium">{row.left}</div>
                        <div className="text-xs text-gray-600">{row.unit === "perHour" ? "per hour" : "flat"}</div>
                      </div>
                    </label>

                    <div className="flex items-center gap-2">
                      <span className="text-sm text-gray-600">RM</span>
                      <input
                        className="w-24 border rounded px-2 py-1 text-right"
                        value={String(current ?? "")}
                        onChange={(e) => setAddOnRate(String(row.rateKey), e.target.value)}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="border rounded-xl p-3">
            <div className="text-sm font-semibold">Optional custom item</div>
            <div className="text-xs text-gray-600">Example: “Driver fee”, “Special allowance”, etc.</div>

            <div className="mt-3 flex flex-col md:flex-row gap-2 md:items-center">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!!selection.custom?.enabled}
                  onChange={(e) =>
                    setSelection({
                      ...selection,
                      custom: {
                        enabled: e.target.checked,
                        label: selection.custom?.label || "",
                        amount: (selection.custom as any)?.amount ?? "",
                      } as any,
                    })
                  }
                />
                Enable
              </label>

              <input
                className="flex-1 border rounded px-2 py-1"
                placeholder="Optional text (e.g. Driver fee)"
                value={selection.custom?.label || ""}
                onChange={(e) =>
                  setSelection({
                    ...selection,
                    custom: {
                      enabled: !!selection.custom?.enabled,
                      label: e.target.value,
                      amount: (selection.custom as any)?.amount ?? "",
                    } as any,
                  })
                }
              />

              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600">RM</span>
                <input
                  className="w-28 border rounded px-2 py-1 text-right"
                  placeholder="0"
                  value={String((selection.custom as any)?.amount ?? "")}
                  onChange={(e) =>
                    setSelection({
                      ...selection,
                      custom: {
                        enabled: !!selection.custom?.enabled,
                        label: selection.custom?.label || "",
                        amount: e.target.value,
                      } as any,
                    })
                  }
                />
              </div>
            </div>
          </div>

          <div className="border rounded-xl p-3">
            <div className="text-sm font-semibold">Optional note</div>
            <input
              className="mt-2 w-full border rounded px-2 py-2"
              placeholder="e.g. 'Backend include packing', etc"
              value={selection.note || ""}
              onChange={(e) => setSelection({ ...selection, note: e.target.value })}
            />
          </div>

          <div className="text-xs text-gray-500">
            Tip: If you don’t want base claim, choose <b>None</b> and only tick add-ons.
          </div>
        </div>

        <div className="sticky bottom-0 bg-white z-10 border-t p-4 flex justify-end">
          <button className="px-4 py-2 border rounded" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Page ---------------- */

export default function ApprovedOTAdminPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [events, setEvents] = useState<OtEvent[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  // form
  const [date, setDate] = useState("");
  const [project, setProject] = useState("");
  const [startTime, setStartTime] = useState("18:00");
  const [endTime, setEndTime] = useState("20:00");
  const [remark, setRemark] = useState("");

  // modal + selection
  const [modalOpen, setModalOpen] = useState(false);
  const [selection, setSelection] = useState<TaskSelection>({
    claim: null,
    codes: [],
    note: "",
    baseRates: {},
    addOnRates: {},
    custom: { enabled: false, label: "", amount: "" } as any,
  } as TaskSelection);

  // chosen users + role per user + overrides
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [roleByUserId, setRoleByUserId] = useState<Record<string, WorkRole>>({});
  const [overrides, setOverrides] = useState<Record<string, string>>({}); // RM as string

  // Edit mode for existing event
  const [editingEventId, setEditingEventId] = useState<string | null>(null);

  function combineDateTime(d: string, t: string) {
    return new Date(`${d}T${t}:00`);
  }

  const selectedUsers = useMemo(() => users.filter((u) => selectedUserIds.includes(u.id)), [users, selectedUserIds]);

  const preview = useMemo(() => {
    if (!date) return [];
    const start = combineDateTime(date, startTime);
    const end = combineDateTime(date, endTime);

    return selectedUsers.map((u) => {
      const workRole = roleByUserId[u.id] || u.defaultWorkRole || "JUNIOR_MARSHAL";
      const rm = computeDefaultPayRM({ workRole, start, end, selection });
      return { user: u, workRole, defaultRM: rm };
    });
  }, [selectedUsers, roleByUserId, selection, date, startTime, endTime]);

  async function loadAll() {
    setMsg(null);
    const [uRes, eRes] = await Promise.all([fetch("/api/admin/users"), fetch("/api/admin/ot-events")]);

    if (!uRes.ok || !eRes.ok) {
      setMsg("Forbidden (Admin only)");
      return;
    }

    const uj = await uRes.json();
    const ej = await eRes.json();
    setUsers(uj.users);
    setEvents(ej.events);
  }

  useEffect(() => {
    loadAll();
  }, []);

  function toggleUser(u: User) {
    setSelectedUserIds((prev) => {
      const exists = prev.includes(u.id);
      return exists ? prev.filter((x) => x !== u.id) : [...prev, u.id];
    });

    setRoleByUserId((prev) => {
      if (prev[u.id]) return prev;
      return { ...prev, [u.id]: u.defaultWorkRole || "JUNIOR_MARSHAL" };
    });
  }

  const workRoleOptions: WorkRole[] = ["JUNIOR_MARSHAL", "SENIOR_MARSHAL", "JUNIOR_EMCEE", "SENIOR_EMCEE"];

  function resetCreateForm() {
    setEditingEventId(null);
    setDate("");
    setProject("");
    setStartTime("18:00");
    setEndTime("20:00");
    setRemark("");
    setSelection({
      claim: null,
      codes: [],
      note: "",
      baseRates: {},
      addOnRates: {},
      custom: { enabled: false, label: "", amount: "" } as any,
    } as TaskSelection);
    setSelectedUserIds([]);
    setRoleByUserId({});
    setOverrides({});
  }

  function fillFormFromEvent(ev: OtEvent) {
    const d = new Date(ev.date);
    setEditingEventId(ev.id);

    setDate(isoDateOnly(d));
    setProject(ev.project || "");
    setStartTime(hhmmFromIso(ev.startTime));
    setEndTime(hhmmFromIso(ev.endTime));
    setRemark(ev.remark || "");

    const sel = safeParseSelection(ev.taskCodes || "{}");
    setSelection(sel);

    const ids = ev.assignments.map((a) => a.userId).filter(Boolean);
    setSelectedUserIds(ids);

    const roles: Record<string, WorkRole> = {};
    const ovs: Record<string, string> = {};
    for (const a of ev.assignments) {
      const uid = a.userId;
      roles[uid] = a.workRole;
      if (a.amountOverride !== null && a.amountOverride !== undefined) {
        ovs[uid] = (Number(a.amountOverride) / 100).toFixed(2);
      }
    }
    setRoleByUserId(roles);
    setOverrides(ovs);
  }

  async function createOrUpdateEvent() {
    setMsg(null);
    if (!date || !project || selectedUserIds.length === 0) {
      setMsg("Please fill date/project and select users.");
      return;
    }

    const start = combineDateTime(date, startTime);
    const end = combineDateTime(date, endTime);

    const assignments = selectedUserIds.map((id) => ({
      userId: id,
      workRole: roleByUserId[id] || users.find((u) => u.id === id)?.defaultWorkRole || "JUNIOR_MARSHAL",
    }));

    const url = editingEventId ? `/api/admin/ot-events/${editingEventId}` : "/api/admin/ot-events";
    const method = editingEventId ? "PATCH" : "POST";

    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        date,
        project,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        remark: remark || null,
        selection,
        assignments,
        overrides,
      }),
    });

    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg(j.error || (editingEventId ? "Update failed" : "Create failed"));
      return;
    }

    setMsg(editingEventId ? "Updated ✅" : "Created ✅");
    resetCreateForm();
    await loadAll();
  }

  async function deleteEvent(eventId: string) {
    const ok = confirm("Delete this Approved OT event? This will remove assignments too.");
    if (!ok) return;

    setMsg(null);
    const res = await fetch(`/api/admin/ot-events/${eventId}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg(j.error || "Delete failed");
      return;
    }
    setMsg("Deleted ✅");
    if (editingEventId === eventId) resetCreateForm();
    await loadAll();
  }

  async function patchAssignment(id: string, patch: unknown) {
    const res = await fetch(`/api/admin/assignments/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg(j.error || "Update failed");
      return;
    }
    await loadAll();
  }

  const selectionSummary = useMemo(() => {
    const parts: string[] = [];
    parts.push(selection.claim ? CLAIM_LABEL[selection.claim] : "None");
    const codes = (selection.codes ?? []) as TaskCode[];
    if (codes.length) parts.push(codes.map((c) => TASK_LABEL[c]).join(" + "));
    if (selection.custom?.enabled && (selection.custom as any)?.amount) {
      parts.push(`Custom: ${(selection.custom as any).label || "Item"} (RM${(selection.custom as any).amount})`);
    }
    if (selection.note) parts.push(`Note: ${selection.note}`);
    return parts.join(" · ");
  }, [selection]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Admin — Approved OT</h1>
      {msg && <div className="text-sm text-gray-700">{msg}</div>}

      {/* Create / Edit form */}
      <div className="bg-white border rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-semibold">{editingEventId ? "Edit Approved OT" : "Create Approved OT"}</div>
          {editingEventId && (
            <button className="text-sm px-3 py-1.5 border rounded" onClick={resetCreateForm}>
              Cancel Edit
            </button>
          )}
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-3">
            <div>
              <label className="text-sm font-semibold">Date</label>
              <input className="w-full border rounded px-3 py-2" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>

            <div>
              <label className="text-sm font-semibold">Event / Project</label>
              <input className="w-full border rounded px-3 py-2" value={project} onChange={(e) => setProject(e.target.value)} />
            </div>

            <div>
              <label className="text-sm font-semibold">Task Description</label>
              <div className="flex gap-2">
                <button type="button" className="px-3 py-2 border rounded" onClick={() => setModalOpen(true)}>
                  Select tasks
                </button>
              </div>
              <div className="text-xs text-gray-600 mt-2">{selectionSummary}</div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-semibold">Start Time</label>
                <input className="w-full border rounded px-3 py-2" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
              </div>
              <div>
                <label className="text-sm font-semibold">End Time</label>
                <input className="w-full border rounded px-3 py-2" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              </div>
            </div>

            <div>
              <label className="text-sm font-semibold">Remark</label>
              <input className="w-full border rounded px-3 py-2" value={remark} onChange={(e) => setRemark(e.target.value)} />
            </div>
          </div>

          {/* User selection + role + preview */}
          <div className="space-y-3">
            <div className="text-sm font-semibold">Marshal Approved (select users + role)</div>

            <div className="max-h-56 overflow-auto border rounded p-2 bg-gray-50 space-y-2">
              {users.map((u) => {
                const checked = selectedUserIds.includes(u.id);
                const currentRole = roleByUserId[u.id] || u.defaultWorkRole || "JUNIOR_MARSHAL";
                return (
                  <div key={u.id} className="flex items-center justify-between gap-2 bg-white border rounded px-2 py-2">
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={checked} onChange={() => toggleUser(u)} />
                      <span className="font-medium">{u.name}</span>
                    </label>

                    <select
                      className="border rounded px-2 py-1 text-sm"
                      disabled={!checked}
                      value={currentRole}
                      onChange={(e) => setRoleByUserId((prev) => ({ ...prev, [u.id]: e.target.value as WorkRole }))}
                    >
                      {workRoleOptions.map((r) => (
                        <option key={r} value={r}>
                          {WORK_ROLE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>

            <div className="text-sm font-semibold">Pay Amount (default → editable)</div>
            <div className="border rounded overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left p-2">User</th>
                    <th className="text-left p-2">Role</th>
                    <th className="text-right p-2">Default (RM)</th>
                    <th className="text-right p-2">Override (RM)</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((p) => (
                    <tr key={p.user.id} className="border-t bg-white">
                      <td className="p-2">{p.user.name}</td>
                      <td className="p-2 text-xs text-gray-700">{WORK_ROLE_LABEL[p.workRole]}</td>
                      <td className="p-2 text-right">{Number.isFinite(p.defaultRM) ? p.defaultRM.toFixed(2) : "0.00"}</td>
                      <td className="p-2 text-right">
                        <input
                          className="w-28 border rounded px-2 py-1 text-right"
                          placeholder="(auto)"
                          value={overrides[p.user.id] ?? ""}
                          onChange={(e) => setOverrides((prev) => ({ ...prev, [p.user.id]: e.target.value }))}
                        />
                      </td>
                    </tr>
                  ))}
                  {preview.length === 0 && (
                    <tr>
                      <td className="p-3 text-gray-500" colSpan={4}>
                        Select date + users to preview default pay
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <button className="w-full rounded bg-black text-white py-2 hover:opacity-90" onClick={createOrUpdateEvent}>
              {editingEventId ? "Save Changes" : "Create Approved OT"}
            </button>
          </div>
        </div>
      </div>

      <TaskModal open={modalOpen} onClose={() => setModalOpen(false)} selection={selection} setSelection={setSelection} />

      {/* Existing events */}
      <div className="space-y-3">
        <div className="text-lg font-semibold">Existing Approved OT</div>

        {events.map((ev) => {
          const sel = safeParseSelection(ev.taskCodes || "{}");

          const titleLeft = `${new Date(ev.date).toLocaleDateString()} — ${ev.project}`;
          const timeRange =
            `${new Date(ev.startTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} - ` +
            `${new Date(ev.endTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

          const selSummary = [
            sel.claim ? CLAIM_LABEL[sel.claim] : "None",
            sel.codes?.length ? sel.codes.map((c) => TASK_LABEL[c]).join(" + ") : null,
            sel.custom?.enabled ? `Custom: ${(sel.custom as any)?.label || "Item"} (RM${(sel.custom as any)?.amount})` : null,
            sel.note ? `Note: ${sel.note}` : null,
          ]
            .filter(Boolean)
            .join(" · ");

          return (
            <div key={ev.id} className="bg-white border rounded-xl overflow-hidden">
              <div className="p-4 border-b flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="font-semibold">{titleLeft}</div>
                  <div className="text-xs text-gray-600">{timeRange}</div>
                  <div className="text-xs text-gray-700 mt-1">{selSummary}</div>
                  {ev.remark && <div className="text-xs text-gray-600 mt-1">Remark: {ev.remark}</div>}
                </div>

                <div className="flex gap-2">
                  <button className="text-sm px-3 py-1.5 border rounded" onClick={() => fillFormFromEvent(ev)}>
                    Edit
                  </button>
                  <button className="text-sm px-3 py-1.5 border rounded text-red-600 border-red-200" onClick={() => deleteEvent(ev.id)}>
                    Delete
                  </button>
                </div>
              </div>

              <div className="p-4">
                <div className="text-sm font-semibold mb-2">Assignments</div>
                <div className="border rounded overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left p-2">User</th>
                        <th className="text-left p-2">Role</th>
                        <th className="text-left p-2">Task & Pay</th>
                        <th className="text-right p-2">Default</th>
                        <th className="text-right p-2">Override</th>
                        <th className="text-center p-2">Paid</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ev.assignments.map((a) => {
                        const isPaid = a.status === "PAID";
                        const defaultCents = Number(a.amountDefault ?? 0);
                        const overrideCents = a.amountOverride === null ? null : Number(a.amountOverride);
                        const effectiveCents = overrideCents ?? defaultCents;

                        const breakdown = buildTaskPayBreakdown({
                          workRole: a.workRole,
                          start: new Date(ev.startTime),
                          end: new Date(ev.endTime),
                          selection: sel,
                        });

                        const inline = formatBreakdownInline(breakdown.lines);

                        return (
                          <tr key={a.id} className={`border-t ${isPaid ? "bg-gray-100 text-gray-500" : "bg-white"}`}>
                            <td className="p-2">{a.user.name}</td>
                            <td className="p-2 text-xs">{WORK_ROLE_LABEL[a.workRole] || a.workRole}</td>

                            <td className="p-2 text-xs min-w-[280px]">
                              <div className="text-gray-800">{inline}</div>
                              <div className="text-[11px] text-gray-500 mt-1">Breakdown total: RM{breakdown.totalRM.toFixed(2)}</div>
                            </td>

                            <td className="p-2 text-right">RM{centsToRm(defaultCents)}</td>
                            <td className="p-2 text-right">
                              <input
                                className="w-28 border rounded px-2 py-1 text-right disabled:opacity-60"
                                defaultValue={overrideCents !== null && Number.isFinite(overrideCents) ? (overrideCents / 100).toFixed(2) : ""}
                                disabled={isPaid}
                                placeholder="(none)"
                                onBlur={(e) =>
                                  patchAssignment(a.id, {
                                    amountOverrideRM: e.target.value === "" ? null : e.target.value,
                                  })
                                }
                              />
                            </td>
                            <td className="p-2 text-center">
                              <input
                                type="checkbox"
                                checked={isPaid}
                                onChange={(e) => patchAssignment(a.id, { status: e.target.checked ? "PAID" : "UNPAID" })}
                              />
                              <div className="text-xs mt-1">RM{centsToRm(effectiveCents)}</div>
                            </td>
                          </tr>
                        );
                      })}

                      {ev.assignments.length === 0 && (
                        <tr>
                          <td className="p-3 text-gray-500" colSpan={6}>
                            No assignments
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          );
        })}

        {events.length === 0 && <div className="text-sm text-gray-600">No Approved OT yet.</div>}
      </div>

      <div className="text-xs text-gray-500">
        Note: For Edit/Delete to work, you must add API routes:
        <code className="ml-1">/api/admin/ot-events/[id]</code> with PATCH + DELETE.
      </div>
    </div>
  );
}

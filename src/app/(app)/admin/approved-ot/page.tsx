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
  otSlotId?: string | null;
  status: "UNPAID" | "PAID";
  amountDefault: number;
  amountOverride: number | null;
  workRole: WorkRole;
  user: { name: string; email: string };
};

type OtSlot = {
  id: string;
  index: number;
  startTime: string; // ISO
  endTime: string; // ISO
  taskCodes: string; // JSON stringified TaskSelection
  assignments: Assignment[];
};

type OtEvent = {
  id: string;
  date: string; // start date (legacy)
  project: string;
  startTime: string; // ISO (legacy)
  endTime: string; // ISO (legacy)
  taskCodes: string; // legacy selection
  remark: string | null;

  // NEW
  slots?: OtSlot[];

  // legacy relation (may contain duplicates of slot assignments)
  assignments?: Assignment[];
};

type SlotForm = {
  key: string; // local key for react
  id?: string; // db id when editing
  date: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD (for 2D1N / 3D2N)
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  selection: TaskSelection;

  selectedUserIds: string[];
  roleByUserId: Record<string, WorkRole>;
  overrides: Record<string, string>; // RM as string, keyed by userId (within slot)
};

/* ---------------- Safe helpers ---------------- */

function newKey() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: any = typeof crypto !== "undefined" ? crypto : null;
    if (c?.randomUUID) return c.randomUUID();
  } catch {
    // ignore
  }
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function isTaskCode(x: unknown): x is TaskCode {
  return typeof x === "string" && Object.prototype.hasOwnProperty.call(TASK_LABEL, x);
}

function isoDateOnly(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDaysToIsoDate(iso: string, days: number) {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return isoDateOnly(d);
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

function combineDateTime(d: string, t: string) {
  return new Date(`${d}T${t}:00`);
}

function toLocalTime(d: Date) {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* ---------------- Task + Pay breakdown (display + export) ---------------- */

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

/* ---------------- CSV Export helpers ---------------- */

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

function selectionSummary(sel: TaskSelection) {
  const parts: string[] = [];
  parts.push(sel.claim ? CLAIM_LABEL[sel.claim] : "None");
  const codes = (sel.codes ?? []) as TaskCode[];
  if (codes.length) parts.push(codes.map((c) => TASK_LABEL[c]).join(" + "));
  if (sel.custom?.enabled && (sel.custom as any)?.amount) {
    parts.push(`Custom: ${(sel.custom as any).label || "Item"} (RM${(sel.custom as any).amount})`);
  }
  if (sel.note) parts.push(`Note: ${sel.note}`);
  return parts.join(" · ");
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
      <div className="w-full max-w-3xl bg-white rounded-2xl border-2 border-black shadow-sm flex flex-col max-h-[90vh] text-gray-900">
        <div className="sticky top-0 bg-white z-10 border-b-2 border-black p-4 flex items-center justify-between">
          <div>
            <div className="font-semibold">Select Task Description</div>
            <div className="text-xs text-gray-700">Pick base claim (0 or 1) + tick add-ons. You can edit the RM amounts here.</div>
          </div>
          <div className="flex gap-2">
            <button className="text-sm px-3 py-1.5 border-2 border-black rounded bg-white text-gray-900" onClick={resetDefaults}>
              Reset
            </button>
            <button className="text-sm px-3 py-1.5 border-2 border-black rounded bg-white text-gray-900" onClick={onClose}>
              Close
            </button>
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
                    className={`px-3 py-1.5 rounded border-2 text-sm ${
                      active ? "bg-black text-white border-black" : "bg-white border-black text-gray-900 hover:bg-gray-50"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {claim && base && (
            <div className="border-2 border-black rounded-xl p-3">
              <div>
                <div className="text-sm font-semibold">Base Pay — {CLAIM_LABEL[claim]}</div>
                <div className="text-xs text-gray-700">{base?.kind === "HOURLY" ? "Marshal rates are per hour." : "Flat amount for the claim."}</div>
              </div>

              <div className="mt-3 grid md:grid-cols-2 gap-3">
                {showMarshalBase && (
                  <div className="border-2 border-black rounded-lg p-3">
                    <div className="text-sm font-semibold">Marshal</div>
                    <div className="mt-2 grid grid-cols-2 gap-2 items-center">
                      <label className="text-xs text-gray-700">Senior (RM)</label>
                      <input
                        className="border-2 border-black rounded px-2 py-1 text-right bg-white text-gray-900 placeholder:text-gray-400"
                        value={String((selection.baseRates as any)?.marshalSenior ?? base?.marshalSenior ?? "")}
                        onChange={(e) => setBaseRate("marshalSenior", e.target.value)}
                      />
                      <label className="text-xs text-gray-700">Junior (RM)</label>
                      <input
                        className="border-2 border-black rounded px-2 py-1 text-right bg-white text-gray-900 placeholder:text-gray-400"
                        value={String((selection.baseRates as any)?.marshalJunior ?? base?.marshalJunior ?? "")}
                        onChange={(e) => setBaseRate("marshalJunior", e.target.value)}
                      />
                    </div>
                  </div>
                )}

                <div className={`border-2 border-black rounded-lg p-3 ${showEmceeBase ? "" : "opacity-60"}`}>
                  <div className="text-sm font-semibold">Emcee</div>
                  <div className="mt-2 grid grid-cols-2 gap-2 items-center">
                    <label className="text-xs text-gray-700">Senior (RM)</label>
                    <input
                      disabled={!showEmceeBase}
                      className="border-2 border-black rounded px-2 py-1 text-right bg-white text-gray-900 placeholder:text-gray-400 disabled:opacity-60"
                      value={String((selection.baseRates as any)?.emceeSenior ?? base?.emceeSenior ?? "")}
                      onChange={(e) => setBaseRate("emceeSenior", e.target.value)}
                    />
                    <label className="text-xs text-gray-700">Junior (RM)</label>
                    <input
                      disabled={!showEmceeBase}
                      className="border-2 border-black rounded px-2 py-1 text-right bg-white text-gray-900 placeholder:text-gray-400 disabled:opacity-60"
                      value={String((selection.baseRates as any)?.emceeJunior ?? base?.emceeJunior ?? "")}
                      onChange={(e) => setBaseRate("emceeJunior", e.target.value)}
                    />
                  </div>
                  {!showEmceeBase && <div className="text-xs text-gray-700 mt-2">Emcee base only applies for Half Day / Full Day.</div>}
                </div>
              </div>
            </div>
          )}

          <div className="border-2 border-black rounded-xl p-3">
            <div className="text-sm font-semibold">Add-ons</div>
            <div className="text-xs text-gray-700">Tick what applies, then adjust RM if needed.</div>

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
                  <div key={row.code} className="border-2 border-black rounded-lg p-3 flex items-center justify-between gap-3 bg-white">
                    <label className="flex items-start gap-2 text-sm text-gray-900">
                      <input type="checkbox" className="mt-1" checked={checked} onChange={() => toggleCode(row.code)} />
                      <div>
                        <div className="font-medium">{row.left}</div>
                        <div className="text-xs text-gray-700">{row.unit === "perHour" ? "per hour" : "flat"}</div>
                      </div>
                    </label>

                    <div className="flex items-center gap-2">
                      <span className="text-sm text-gray-700">RM</span>
                      <input
                        className="w-24 border-2 border-black rounded px-2 py-1 text-right bg-white text-gray-900 placeholder:text-gray-400"
                        value={String(current ?? "")}
                        onChange={(e) => setAddOnRate(String(row.rateKey), e.target.value)}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="border-2 border-black rounded-xl p-3">
            <div className="text-sm font-semibold">Optional custom item</div>
            <div className="text-xs text-gray-700">Example: “Driver fee”, “Special allowance”, etc.</div>

            <div className="mt-3 flex flex-col md:flex-row gap-2 md:items-center">
              <label className="flex items-center gap-2 text-sm text-gray-900">
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
                className="flex-1 border-2 border-black rounded px-2 py-1 bg-white text-gray-900 placeholder:text-gray-400"
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
                <span className="text-sm text-gray-700">RM</span>
                <input
                  className="w-28 border-2 border-black rounded px-2 py-1 text-right bg-white text-gray-900 placeholder:text-gray-400"
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

          <div className="border-2 border-black rounded-xl p-3">
            <div className="text-sm font-semibold">Optional note</div>
            <input
              className="mt-2 w-full border-2 border-black rounded px-2 py-2 bg-white text-gray-900 placeholder:text-gray-400"
              placeholder="e.g. 'Backend include packing', etc"
              value={selection.note || ""}
              onChange={(e) => setSelection({ ...selection, note: e.target.value })}
            />
          </div>

          <div className="text-xs text-gray-700">
            Tip: If you don’t want base claim, choose <b>None</b> and only tick add-ons.
          </div>
        </div>

        <div className="sticky bottom-0 bg-white z-10 border-t-2 border-black p-4 flex justify-end">
          <button className="px-4 py-2 border-2 border-black rounded bg-white text-gray-900" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Page ---------------- */

const workRoleOptions: WorkRole[] = ["JUNIOR_MARSHAL", "SENIOR_MARSHAL", "JUNIOR_EMCEE", "SENIOR_EMCEE"];

function blankSelection(): TaskSelection {
  return {
    claim: null,
    codes: [],
    note: "",
    baseRates: {},
    addOnRates: {},
    custom: { enabled: false, label: "", amount: "" } as any,
  } as TaskSelection;
}

function blankSlot(): SlotForm {
  return {
    key: newKey(),
    date: "",
    endDate: "",
    startTime: "18:00",
    endTime: "20:00",
    selection: blankSelection(),
    selectedUserIds: [],
    roleByUserId: {},
    overrides: {},
  };
}

export default function ApprovedOTAdminPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [events, setEvents] = useState<OtEvent[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  const [exportBusy, setExportBusy] = useState(false);

  // event-level form
  const [project, setProject] = useState("");
  const [remark, setRemark] = useState("");

  // slots form
  const [slots, setSlots] = useState<SlotForm[]>([blankSlot()]);

  // Task modal (edits a specific slot)
  const [modalOpen, setModalOpen] = useState(false);
  const [modalSlotKey, setModalSlotKey] = useState<string | null>(null);

  // edit mode
  const [editingEventId, setEditingEventId] = useState<string | null>(null);

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

  function resetCreateForm() {
    setEditingEventId(null);
    setProject("");
    setRemark("");
    setSlots([blankSlot()]);
    setModalOpen(false);
    setModalSlotKey(null);
  }

  function updateSlot(slotKey: string, patch: Partial<SlotForm>) {
    setSlots((prev) => prev.map((s) => (s.key === slotKey ? { ...s, ...patch } : s)));
  }

  function setSlotDate(slotKey: string, nextDate: string) {
    setSlots((prev) =>
      prev.map((s) => {
        if (s.key !== slotKey) return s;
        const isMultiDay = s.selection.claim === "EVENT_2D1N" || s.selection.claim === "EVENT_3D2N";
        let nextEndDate = s.endDate;

        if (isMultiDay) {
          if (!nextEndDate || nextEndDate === s.date) {
            const delta = s.selection.claim === "EVENT_3D2N" ? 2 : 1;
            nextEndDate = addDaysToIsoDate(nextDate, delta);
          }
        } else {
          nextEndDate = nextDate;
        }

        return { ...s, date: nextDate, endDate: nextEndDate };
      })
    );
  }

  function setSlotSelection(slotKey: string, sel: TaskSelection) {
    setSlots((prev) =>
      prev.map((s) => {
        if (s.key !== slotKey) return s;

        const isMultiDay = sel.claim === "EVENT_2D1N" || sel.claim === "EVENT_3D2N";
        let nextEndDate = s.endDate;

        if (isMultiDay) {
          if (!s.date) {
            // no date yet; keep endDate empty for now
            nextEndDate = s.endDate || "";
          } else if (!nextEndDate || nextEndDate === s.date) {
            const delta = sel.claim === "EVENT_3D2N" ? 2 : 1;
            nextEndDate = addDaysToIsoDate(s.date, delta);
          }
        } else {
          nextEndDate = s.date || "";
        }

        return { ...s, selection: sel, endDate: nextEndDate };
      })
    );
  }

  function toggleUserInSlot(slotKey: string, u: User) {
    setSlots((prev) =>
      prev.map((s) => {
        if (s.key !== slotKey) return s;

        const exists = s.selectedUserIds.includes(u.id);
        const nextIds = exists ? s.selectedUserIds.filter((x) => x !== u.id) : [...s.selectedUserIds, u.id];

        const nextRoles = { ...s.roleByUserId };
        if (!nextRoles[u.id]) nextRoles[u.id] = u.defaultWorkRole || "JUNIOR_MARSHAL";

        // if unchecking, also clear override (optional)
        const nextOverrides = { ...s.overrides };
        if (exists) delete nextOverrides[u.id];

        return { ...s, selectedUserIds: nextIds, roleByUserId: nextRoles, overrides: nextOverrides };
      })
    );
  }

  function computeSlotPreview(slot: SlotForm) {
    if (!slot.date) return [];

    const isMultiDay = slot.selection.claim === "EVENT_2D1N" || slot.selection.claim === "EVENT_3D2N";
    const endDateUsed = isMultiDay ? slot.endDate : slot.date;
    if (isMultiDay && !endDateUsed) return [];

    const start = combineDateTime(slot.date, slot.startTime);
    const end = combineDateTime(endDateUsed, slot.endTime);

    const selectedUsers = users.filter((u) => slot.selectedUserIds.includes(u.id));

    return selectedUsers.map((u) => {
      const workRole = slot.roleByUserId[u.id] || u.defaultWorkRole || "JUNIOR_MARSHAL";
      const rm = computeDefaultPayRM({ workRole, start, end, selection: slot.selection });
      return { user: u, workRole, defaultRM: rm };
    });
  }

  function fillFormFromEvent(ev: OtEvent) {
    setEditingEventId(ev.id);
    setProject(ev.project || "");
    setRemark(ev.remark || "");

    const hasSlots = Array.isArray(ev.slots) && ev.slots.length > 0;

    if (hasSlots) {
      const nextSlots: SlotForm[] = (ev.slots || [])
        .slice()
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((sl) => {
          const s = new Date(sl.startTime);
          const e = new Date(sl.endTime);
          const sel = safeParseSelection(sl.taskCodes || "{}");

          const ids = (sl.assignments || []).map((a) => a.userId).filter(Boolean);

          const roles: Record<string, WorkRole> = {};
          const ovs: Record<string, string> = {};
          for (const a of sl.assignments || []) {
            const uid = a.userId;
            roles[uid] = a.workRole;
            if (a.amountOverride !== null && a.amountOverride !== undefined) {
              ovs[uid] = (Number(a.amountOverride) / 100).toFixed(2);
            }
          }

          return {
            key: newKey(),
            id: sl.id,
            date: isoDateOnly(s),
            endDate: isoDateOnly(e),
            startTime: hhmmFromIso(sl.startTime),
            endTime: hhmmFromIso(sl.endTime),
            selection: sel,
            selectedUserIds: ids,
            roleByUserId: roles,
            overrides: ovs,
          };
        });

      setSlots(nextSlots.length ? nextSlots : [blankSlot()]);
      return;
    }

    // fallback: legacy event → single slot form
    const s = new Date(ev.startTime);
    const e = new Date(ev.endTime);
    const sel = safeParseSelection(ev.taskCodes || "{}");

    const legacyAssignments = ev.assignments || [];
    const ids = legacyAssignments.map((a) => a.userId).filter(Boolean);

    const roles: Record<string, WorkRole> = {};
    const ovs: Record<string, string> = {};
    for (const a of legacyAssignments) {
      const uid = a.userId;
      roles[uid] = a.workRole;
      if (a.amountOverride !== null && a.amountOverride !== undefined) {
        ovs[uid] = (Number(a.amountOverride) / 100).toFixed(2);
      }
    }

    setSlots([
      {
        key: newKey(),
        date: isoDateOnly(s),
        endDate: isoDateOnly(e),
        startTime: hhmmFromIso(ev.startTime),
        endTime: hhmmFromIso(ev.endTime),
        selection: sel,
        selectedUserIds: ids,
        roleByUserId: roles,
        overrides: ovs,
      },
    ]);
  }

  async function createOrUpdateEvent() {
    setMsg(null);

    if (!project) {
      setMsg("Please fill Event / Project.");
      return;
    }

    const cleanedSlots = slots.filter((s) => s.date || s.selectedUserIds.length || (s.selection.codes?.length || 0) > 0 || !!s.selection.claim);

    if (cleanedSlots.length === 0) {
      setMsg("Please add at least 1 slot.");
      return;
    }

    // validate each slot
    for (const [i, sl] of cleanedSlots.entries()) {
      if (!sl.date) {
        setMsg(`Slot ${i + 1}: Please pick Date.`);
        return;
      }

      const isMultiDay = sl.selection.claim === "EVENT_2D1N" || sl.selection.claim === "EVENT_3D2N";
      const endDateUsed = isMultiDay ? sl.endDate : sl.date;

      if (isMultiDay && !endDateUsed) {
        setMsg(`Slot ${i + 1}: Please pick End Date (2D1N/3D2N).`);
        return;
      }

      if (endDateUsed < sl.date) {
        setMsg(`Slot ${i + 1}: End date cannot be earlier than start date.`);
        return;
      }

      if (!sl.startTime || !sl.endTime) {
        setMsg(`Slot ${i + 1}: Please pick Start Time and End Time.`);
        return;
      }

      const start = combineDateTime(sl.date, sl.startTime);
      const end = combineDateTime(endDateUsed, sl.endTime);
      if (!(start instanceof Date) || !(end instanceof Date) || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        setMsg(`Slot ${i + 1}: Invalid date/time.`);
        return;
      }
      if (end.getTime() <= start.getTime()) {
        setMsg(`Slot ${i + 1}: End time must be later than start time.`);
        return;
      }

      if (sl.selectedUserIds.length === 0) {
        setMsg(`Slot ${i + 1}: Please select users.`);
        return;
      }
    }

    // event date for sorting = earliest slot start date
    const slotStarts = cleanedSlots
      .map((s) => combineDateTime(s.date, s.startTime))
      .filter((d) => d instanceof Date && !Number.isNaN(d.getTime()))
      .sort((a, b) => a.getTime() - b.getTime());

    const eventDate = slotStarts.length ? isoDateOnly(slotStarts[0]) : cleanedSlots[0].date;

    const payloadSlots = cleanedSlots.map((s, idx) => {
      const isMultiDay = s.selection.claim === "EVENT_2D1N" || s.selection.claim === "EVENT_3D2N";
      const endDateUsed = isMultiDay ? s.endDate : s.date;

      const start = combineDateTime(s.date, s.startTime);
      const end = combineDateTime(endDateUsed, s.endTime);

      const assignments = s.selectedUserIds.map((id) => ({
        userId: id,
        workRole: s.roleByUserId[id] || users.find((u) => u.id === id)?.defaultWorkRole || "JUNIOR_MARSHAL",
      }));

      return {
        id: s.id || null,
        index: idx,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        selection: s.selection,
        assignments,
        overrides: s.overrides || {},
      };
    });

    const url = editingEventId ? `/api/admin/ot-events/${editingEventId}` : "/api/admin/ot-events";
    const method = editingEventId ? "PATCH" : "POST";

    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        date: eventDate, // for OtEvent.date sorting
        project,
        remark: remark || null,
        slots: payloadSlots,
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
    const ok = confirm("Delete this Approved OT event? This will remove slots + assignments too.");
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

  /* ---------------- Export existing approved OT to CSV ---------------- */
  async function exportToCsv() {
    try {
      setExportBusy(true);
      setMsg(null);

      const eRes = await fetch("/api/admin/ot-events");
      const ej = await eRes.json().catch(() => ({}));

      if (!eRes.ok) {
        setMsg(ej?.error || "Export failed (cannot load events)");
        return;
      }

      const evs: OtEvent[] = ej.events || [];

      const headers = [
        "EventDate",
        "Project",
        "Remark",
        "SlotIndex",
        "SlotStartDate",
        "SlotEndDate",
        "SlotStartTime",
        "SlotEndTime",
        "SlotTaskSummary",
        "Breakdown",
        "UserName",
        "UserEmail",
        "WorkRole",
        "DefaultRM",
        "OverrideRM",
        "EffectiveRM",
        "Status",
        "EventId",
        "SlotId",
        "AssignmentId",
      ];

      const rows: string[] = [];
      rows.push(headers.map(csvEscape).join(","));

      for (const ev of evs) {
        const slotsToUse: OtSlot[] =
          Array.isArray(ev.slots) && ev.slots.length > 0
            ? ev.slots
            : [
              {
                id: "",
                index: 0,
                startTime: ev.startTime,
                endTime: ev.endTime,
                taskCodes: ev.taskCodes,
                assignments: (ev.assignments || []) as Assignment[],
              },
            ];

        for (const sl of slotsToUse) {
          const sel = safeParseSelection(sl.taskCodes || "{}");
          const start = new Date(sl.startTime);
          const end = new Date(sl.endTime);

          const slotTaskSummary = selectionSummary(sel);

          const slotStartDateLabel = isoDateOnly(start);
          const slotEndDateLabel = isoDateOnly(end);

          for (const a of sl.assignments || []) {
            const defaultCents = Number(a.amountDefault ?? 0);
            const overrideCents = a.amountOverride === null ? null : Number(a.amountOverride);
            const effectiveCents = overrideCents ?? defaultCents;

            const breakdown = buildTaskPayBreakdown({
              workRole: a.workRole,
              start,
              end,
              selection: sel,
            });

            const breakdownInline = formatBreakdownInline(breakdown.lines);

            const line = [
              ev.date || "",
              ev.project || "",
              ev.remark || "",
              String(sl.index ?? 0),
              slotStartDateLabel,
              slotEndDateLabel,
              toLocalTime(start),
              toLocalTime(end),
              slotTaskSummary,
              breakdownInline,
              a.user?.name || "",
              a.user?.email || "",
              WORK_ROLE_LABEL[a.workRole] || a.workRole,
              centsToRm(defaultCents),
              overrideCents === null ? "" : centsToRm(overrideCents),
              centsToRm(effectiveCents),
              a.status,
              ev.id,
              sl.id || "",
              a.id,
            ];

            rows.push(line.map(csvEscape).join(","));
          }
        }
      }

      const csv = rows.join("\n");
      const fileName = `approved-ot-export_${isoDateOnly(new Date())}.csv`;
      downloadTextFile(fileName, csv);
      setMsg("Exported CSV ✅");
    } catch (e: any) {
      setMsg(e?.message || "Export failed");
    } finally {
      setExportBusy(false);
    }
  }

  const activeModalSelection = useMemo(() => {
    if (!modalSlotKey) return blankSelection();
    const slot = slots.find((s) => s.key === modalSlotKey);
    return slot?.selection || blankSelection();
  }, [modalSlotKey, slots]);

  return (
    <div className="space-y-6 text-gray-900">
      <div className="flex items-start justify-between gap-3 flex-col md:flex-row md:items-center">
        <div>
          <h1 className="text-2xl font-semibold">Admin — Approved OT (Multi-Slot)</h1>
          {msg && <div className="text-sm text-gray-900 mt-2">{msg}</div>}
        </div>

        <button
          type="button"
          onClick={exportToCsv}
          disabled={exportBusy}
          className="px-3 py-2 border-2 border-black rounded bg-white text-gray-900 hover:bg-gray-50 disabled:opacity-60"
          title="Download as CSV (Excel/Google Sheets)"
        >
          {exportBusy ? "Exporting..." : "Export to CSV"}
        </button>
      </div>

      {/* Create / Edit form */}
      <div className="bg-white border-2 border-black rounded-xl p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">{editingEventId ? "Edit Approved OT" : "Create Approved OT"}</div>
          {editingEventId && (
            <button className="text-sm px-3 py-1.5 border-2 border-black rounded bg-white text-gray-900" onClick={resetCreateForm}>
              Cancel Edit
            </button>
          )}
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-3">
            <div>
              <label className="text-sm font-semibold">Event / Project</label>
              <input
                className="w-full border-2 border-black rounded px-3 py-2 bg-white text-gray-900 placeholder:text-gray-400"
                value={project}
                onChange={(e) => setProject(e.target.value)}
              />
            </div>

            <div>
              <label className="text-sm font-semibold">Remark</label>
              <input
                className="w-full border-2 border-black rounded px-3 py-2 bg-white text-gray-900 placeholder:text-gray-400"
                value={remark}
                onChange={(e) => setRemark(e.target.value)}
              />
            </div>

            <div className="text-xs text-gray-700">
              You can add multiple slots under the same event. Each slot can have different task selection and different users.
            </div>
          </div>

          <div className="space-y-3">
            <button
              type="button"
              className="w-full px-3 py-2 border-2 border-black rounded bg-white text-gray-900 hover:bg-gray-50"
              onClick={() => setSlots((prev) => [...prev, blankSlot()])}
            >
              + Add Slot
            </button>

            <button
              className="w-full rounded bg-black text-white py-2 hover:opacity-90 border-2 border-black"
              onClick={createOrUpdateEvent}
            >
              {editingEventId ? "Save Changes" : "Create Approved OT"}
            </button>
          </div>
        </div>

        {/* Slots editor */}
        <div className="space-y-4">
          {slots.map((sl, idx) => {
            const isMultiDay = sl.selection.claim === "EVENT_2D1N" || sl.selection.claim === "EVENT_3D2N";
            const preview = computeSlotPreview(sl);

            return (
              <div key={sl.key} className="border-2 border-black rounded-xl overflow-hidden bg-white">
                <div className="p-3 border-b-2 border-black flex items-center justify-between gap-3">
                  <div>
                    <div className="font-semibold">Slot {idx + 1}</div>
                    <div className="text-xs text-gray-700">{selectionSummary(sl.selection) || "No tasks selected yet"}</div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="text-sm px-3 py-1.5 border-2 border-black rounded bg-white text-gray-900"
                      onClick={() => {
                        setModalSlotKey(sl.key);
                        setModalOpen(true);
                      }}
                    >
                      Select tasks
                    </button>

                    <button
                      type="button"
                      className="text-sm px-3 py-1.5 border-2 border-black rounded bg-white text-red-600 disabled:opacity-60"
                      disabled={slots.length <= 1}
                      onClick={() => setSlots((prev) => prev.filter((x) => x.key !== sl.key))}
                      title={slots.length <= 1 ? "At least 1 slot is required" : "Remove slot"}
                    >
                      Remove
                    </button>
                  </div>
                </div>

                <div className="p-4 grid md:grid-cols-2 gap-4">
                  {/* Left: time */}
                  <div className="space-y-3">
                    {!isMultiDay ? (
                      <div>
                        <label className="text-sm font-semibold">Date</label>
                        <input
                          className="w-full border-2 border-black rounded px-3 py-2 bg-white text-gray-900"
                          type="date"
                          value={sl.date}
                          onChange={(e) => setSlotDate(sl.key, e.target.value)}
                        />
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className="text-sm font-semibold">Start Date</label>
                          <input
                            className="w-full border-2 border-black rounded px-3 py-2 bg-white text-gray-900"
                            type="date"
                            value={sl.date}
                            onChange={(e) => setSlotDate(sl.key, e.target.value)}
                          />
                        </div>
                        <div>
                          <label className="text-sm font-semibold">End Date</label>
                          <input
                            className="w-full border-2 border-black rounded px-3 py-2 bg-white text-gray-900"
                            type="date"
                            value={sl.endDate}
                            min={sl.date || undefined}
                            onChange={(e) => updateSlot(sl.key, { endDate: e.target.value })}
                          />
                        </div>
                        <div className="md:col-span-2 text-xs text-gray-700">
                          For <b>2D1N</b> / <b>3D2N</b>, pick both start & end dates.
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-sm font-semibold">Start Time</label>
                        <input
                          className="w-full border-2 border-black rounded px-3 py-2 bg-white text-gray-900"
                          type="time"
                          value={sl.startTime}
                          onChange={(e) => updateSlot(sl.key, { startTime: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="text-sm font-semibold">End Time</label>
                        <input
                          className="w-full border-2 border-black rounded px-3 py-2 bg-white text-gray-900"
                          type="time"
                          value={sl.endTime}
                          onChange={(e) => updateSlot(sl.key, { endTime: e.target.value })}
                        />
                      </div>
                    </div>

                    <div className="text-xs text-gray-700">
                      Slot time range drives pay computation (defaultRM). Overrides are per-slot.
                    </div>
                  </div>

                  {/* Right: users + preview */}
                  <div className="space-y-3">
                    <div className="text-sm font-semibold">Select users + role (this slot)</div>

                    <div className="max-h-56 overflow-auto border-2 border-black rounded p-2 bg-gray-50 space-y-2">
                      {users.map((u) => {
                        const checked = sl.selectedUserIds.includes(u.id);
                        const currentRole = sl.roleByUserId[u.id] || u.defaultWorkRole || "JUNIOR_MARSHAL";

                        return (
                          <div key={u.id} className="flex items-center justify-between gap-2 bg-white border-2 border-black rounded px-2 py-2">
                            <label className="flex items-center gap-2 text-sm text-gray-900">
                              <input type="checkbox" checked={checked} onChange={() => toggleUserInSlot(sl.key, u)} />
                              <span className="font-medium">{u.name}</span>
                            </label>

                            <select
                              className="border-2 border-black rounded px-2 py-1 text-sm bg-white text-gray-900"
                              disabled={!checked}
                              value={currentRole}
                              onChange={(e) =>
                                updateSlot(sl.key, {
                                  roleByUserId: { ...sl.roleByUserId, [u.id]: e.target.value as WorkRole },
                                })
                              }
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

                    <div className="text-sm font-semibold">Pay Amount (default → editable) (this slot)</div>
                    <div className="border-2 border-black rounded overflow-hidden bg-white">
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
                            <tr key={`${sl.key}:${p.user.id}`} className="border-t bg-white">
                              <td className="p-2 text-gray-900">{p.user.name}</td>
                              <td className="p-2 text-xs text-gray-900">{WORK_ROLE_LABEL[p.workRole]}</td>
                              <td className="p-2 text-right text-gray-900">
                                {Number.isFinite(p.defaultRM) ? p.defaultRM.toFixed(2) : "0.00"}
                              </td>
                              <td className="p-2 text-right">
                                <input
                                  className="w-28 border-2 border-black rounded px-2 py-1 text-right bg-white text-gray-900 placeholder:text-gray-400"
                                  placeholder="(auto)"
                                  value={sl.overrides[p.user.id] ?? ""}
                                  onChange={(e) =>
                                    updateSlot(sl.key, {
                                      overrides: { ...sl.overrides, [p.user.id]: e.target.value },
                                    })
                                  }
                                />
                              </td>
                            </tr>
                          ))}
                          {preview.length === 0 && (
                            <tr>
                              <td className="p-3 text-gray-700" colSpan={4}>
                                Select task + date(s) + users to preview default pay
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>

                    <div className="text-xs text-gray-700">
                      Tip: You can assign the same person in multiple slots (different time/tasks) — it will create separate assignments.
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Shared modal for slot selection */}
      <TaskModal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setModalSlotKey(null);
        }}
        selection={activeModalSelection}
        setSelection={(sel) => {
          if (!modalSlotKey) return;
          setSlotSelection(modalSlotKey, sel);
        }}
      />

      {/* Existing events */}
      <div className="space-y-3">
        <div className="text-lg font-semibold">Existing Approved OT</div>

        {events.map((ev) => {
          const hasSlots = Array.isArray(ev.slots) && ev.slots.length > 0;
          const showSlots: OtSlot[] =
            hasSlots
              ? (ev.slots || []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
              : [
                {
                  id: "",
                  index: 0,
                  startTime: ev.startTime,
                  endTime: ev.endTime,
                  taskCodes: ev.taskCodes,
                  assignments: (ev.assignments || []) as Assignment[],
                },
              ];

          const titleLeft = `${ev.project}`;

          return (
            <div key={ev.id} className="bg-white border-2 border-black rounded-xl overflow-hidden">
              <div className="p-4 border-b-2 border-black flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                <div className="text-gray-900">
                  <div className="font-semibold">{titleLeft}</div>
                  {ev.remark && <div className="text-xs text-gray-700 mt-1">Remark: {ev.remark}</div>}
                  <div className="text-xs text-gray-700 mt-1">
                    {hasSlots ? `Slots: ${showSlots.length}` : "Legacy (single slot)"}
                  </div>
                </div>

                <div className="flex gap-2">
                  <button className="text-sm px-3 py-1.5 border-2 border-black rounded bg-white text-gray-900" onClick={() => fillFormFromEvent(ev)}>
                    Edit
                  </button>
                  <button className="text-sm px-3 py-1.5 border-2 border-black rounded bg-white text-red-600" onClick={() => deleteEvent(ev.id)}>
                    Delete
                  </button>
                </div>
              </div>

              <div className="p-4 space-y-4">
                {showSlots.map((sl) => {
                  const sel = safeParseSelection(sl.taskCodes || "{}");
                  const s = new Date(sl.startTime);
                  const e = new Date(sl.endTime);

                  const startDateLabel = s.toLocaleDateString();
                  const endDateLabel = e.toLocaleDateString();
                  const sameDay = startDateLabel === endDateLabel;

                  const timeRange = sameDay
                    ? `${toLocalTime(s)} - ${toLocalTime(e)}`
                    : `${startDateLabel} ${toLocalTime(s)} - ${endDateLabel} ${toLocalTime(e)}`;

                  const selSummary = selectionSummary(sel);

                  return (
                    <div key={`${ev.id}:${sl.id || sl.index}`} className="border-2 border-black rounded-xl overflow-hidden">
                      <div className="p-3 border-b-2 border-black bg-gray-50">
                        <div className="font-semibold">
                          Slot {Number.isFinite(sl.index) ? sl.index + 1 : 1} — {timeRange}
                        </div>
                        <div className="text-xs text-gray-900 mt-1">{selSummary}</div>
                      </div>

                      <div className="p-3">
                        <div className="text-sm font-semibold mb-2">Assignments</div>
                        <div className="border-2 border-black rounded overflow-hidden bg-white">
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
                              {(sl.assignments || []).map((a) => {
                                const isPaid = a.status === "PAID";
                                const defaultCents = Number(a.amountDefault ?? 0);
                                const overrideCents = a.amountOverride === null ? null : Number(a.amountOverride);
                                const effectiveCents = overrideCents ?? defaultCents;

                                const breakdown = buildTaskPayBreakdown({
                                  workRole: a.workRole,
                                  start: s,
                                  end: e,
                                  selection: sel,
                                });

                                const inline = formatBreakdownInline(breakdown.lines);

                                return (
                                  <tr key={a.id} className={`border-t ${isPaid ? "bg-gray-100 text-gray-900" : "bg-white text-gray-900"}`}>
                                    <td className="p-2">{a.user.name}</td>
                                    <td className="p-2 text-xs">{WORK_ROLE_LABEL[a.workRole] || a.workRole}</td>

                                    <td className="p-2 text-xs min-w-[280px]">
                                      <div className="text-gray-900">{inline}</div>
                                      <div className="text-[11px] text-gray-700 mt-1">Breakdown total: RM{breakdown.totalRM.toFixed(2)}</div>
                                    </td>

                                    <td className="p-2 text-right">RM{centsToRm(defaultCents)}</td>
                                    <td className="p-2 text-right">
                                      <input
                                        className="w-28 border-2 border-black rounded px-2 py-1 text-right bg-white text-gray-900 placeholder:text-gray-400 disabled:opacity-60"
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

                              {(sl.assignments || []).length === 0 && (
                                <tr>
                                  <td className="p-3 text-gray-700" colSpan={6}>
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
              </div>
            </div>
          );
        })}

        {events.length === 0 && <div className="text-sm text-gray-700">No Approved OT yet.</div>}
      </div>
    </div>
  );
}

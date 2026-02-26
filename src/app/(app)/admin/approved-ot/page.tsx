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

type OtSlot = {
  id: string;
  index: number;
  startTime: string; // ISO
  endTime: string; // ISO
  taskCodes: string;
  assignments: Assignment[];
};

type OtEvent = {
  id: string;
  date: string;
  project: string;
  startTime: string;
  endTime: string;
  taskCodes: string;
  remark: string | null;
  assignments: Assignment[]; // legacy fallback
  slots: OtSlot[];
};

/* ---------------- Draft Slot State ---------------- */

type SlotDraft = {
  tempId: string;
  id?: string;
  index: number;

  label: string;

  date: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD for 2D1N/3D2N
  startTime: string; // HH:mm
  endTime: string; // HH:mm

  selection: TaskSelection;

  selectedUserIds: string[];
  roleByUserId: Record<string, WorkRole>;
  overrides: Record<string, string>; // RM string
};

/* ---------------- Tiny UI helpers ---------------- */

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function Badge({
  children,
  tone = "gray",
}: {
  children: React.ReactNode;
  tone?: "gray" | "green" | "red" | "blue" | "amber";
}) {
  const map: Record<string, string> = {
    gray: "bg-gray-100 text-gray-800 border-gray-200",
    green: "bg-green-50 text-green-800 border-green-200",
    red: "bg-red-50 text-red-800 border-red-200",
    blue: "bg-blue-50 text-blue-800 border-blue-200",
    amber: "bg-amber-50 text-amber-900 border-amber-200",
  };
  return (
    <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full border", map[tone])}>
      {children}
    </span>
  );
}

function IconButton({
  children,
  onClick,
  title,
  tone = "default",
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  title?: string;
  tone?: "default" | "danger";
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        "px-3 py-1.5 text-sm rounded-lg border transition",
        tone === "danger"
          ? "border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-50"
          : "border-gray-200 text-gray-900 hover:bg-gray-50 disabled:opacity-50"
      )}
    >
      {children}
    </button>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "px-4 py-2 rounded-lg bg-black text-white border border-black hover:opacity-90 transition",
        disabled && "opacity-60 cursor-not-allowed"
      )}
    >
      {children}
    </button>
  );
}

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

function toLocalDateShort(d: Date) {
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

function toLocalTime(d: Date) {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function combineDateTime(date: string, time: string) {
  return new Date(`${date}T${time}:00`);
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

function newSelection(): TaskSelection {
  return {
    claim: null,
    codes: [],
    note: "",
    baseRates: {},
    addOnRates: {},
    custom: { enabled: false, label: "", amount: "" } as any,
  } as TaskSelection;
}

function makeTempId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function isMultiDayClaim(claim: ClaimCode | null) {
  return claim === "EVENT_2D1N" || claim === "EVENT_3D2N";
}

function normalizeSlots(ev: OtEvent): OtSlot[] {
  if (ev.slots && ev.slots.length) return ev.slots;
  // legacy fallback (old events without slots)
  return [
    {
      id: `legacy-${ev.id}`,
      index: 0,
      startTime: ev.startTime,
      endTime: ev.endTime,
      taskCodes: ev.taskCodes,
      assignments: ev.assignments || [],
    },
  ];
}

/* ---------------- Breakdown helpers (for existing list) ---------------- */

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
        if (amt > 0) lines.push({ label: `Event - ${CLAIM_LABEL[claim]} (${hrs}h × RM${rate}/hr)`, amountRM: amt });
      } else if (isEmcee) {
        const rate = isSenior ? toNum(base?.emceeSenior, 0) : toNum(base?.emceeJunior, 0);
        const amt = round2(hrs * rate);
        if (amt > 0) lines.push({ label: `Event - ${CLAIM_LABEL[claim]} (${hrs}h × RM${rate}/hr)`, amountRM: amt });
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
      <div className="w-full max-w-3xl bg-white rounded-2xl border border-gray-200 shadow-lg flex flex-col max-h-[90vh] text-gray-900">
        <div className="sticky top-0 bg-white z-10 border-b border-gray-200 p-4 flex items-center justify-between">
          <div>
            <div className="font-semibold">Task & Rates</div>
            <div className="text-xs text-gray-600">Pick base claim (0 or 1) + tick add-ons. You can edit RM amounts here.</div>
          </div>
          <div className="flex gap-2">
            <IconButton onClick={resetDefaults} title="Reset to defaults">
              Reset
            </IconButton>
            <IconButton onClick={onClose}>Close</IconButton>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          <div>
            <div className="text-sm font-semibold mb-2">Event Type</div>
            <div className="flex flex-wrap gap-2">
              {claimOptions.map((opt) => {
                const active = selection.claim === opt.value;
                return (
                  <button
                    key={String(opt.value)}
                    type="button"
                    onClick={() => setSelection({ ...selection, claim: opt.value })}
                    className={cn(
                      "px-3 py-1.5 rounded-lg border text-sm transition",
                      active ? "bg-black text-white border-black" : "bg-white border-gray-200 text-gray-900 hover:bg-gray-50"
                    )}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {claim && base && (
            <div className="border border-gray-200 rounded-xl p-3">
              <div>
                <div className="text-sm font-semibold">Base Pay — {CLAIM_LABEL[claim]}</div>
                <div className="text-xs text-gray-600">{base?.kind === "HOURLY" ? "Marshal rates are per hour." : "Flat amount for the claim."}</div>
              </div>

              <div className="mt-3 grid md:grid-cols-2 gap-3">
                {showMarshalBase && (
                  <div className="border border-gray-200 rounded-lg p-3">
                    <div className="text-sm font-semibold">Marshal</div>
                    <div className="mt-2 grid grid-cols-2 gap-2 items-center">
                      <label className="text-xs text-gray-600">Senior (RM)</label>
                      <input
                        className="border border-gray-200 rounded px-2 py-1 text-right bg-white text-gray-900"
                        value={String((selection.baseRates as any)?.marshalSenior ?? base?.marshalSenior ?? "")}
                        onChange={(e) => setBaseRate("marshalSenior", e.target.value)}
                      />
                      <label className="text-xs text-gray-600">Junior (RM)</label>
                      <input
                        className="border border-gray-200 rounded px-2 py-1 text-right bg-white text-gray-900"
                        value={String((selection.baseRates as any)?.marshalJunior ?? base?.marshalJunior ?? "")}
                        onChange={(e) => setBaseRate("marshalJunior", e.target.value)}
                      />
                    </div>
                  </div>
                )}

                <div className={cn("border border-gray-200 rounded-lg p-3", !showEmceeBase && "opacity-60")}>
                  <div className="text-sm font-semibold">Emcee</div>
                  <div className="mt-2 grid grid-cols-2 gap-2 items-center">
                    <label className="text-xs text-gray-600">Senior (RM)</label>
                    <input
                      disabled={!showEmceeBase}
                      className="border border-gray-200 rounded px-2 py-1 text-right bg-white text-gray-900 disabled:opacity-60"
                      value={String((selection.baseRates as any)?.emceeSenior ?? base?.emceeSenior ?? "")}
                      onChange={(e) => setBaseRate("emceeSenior", e.target.value)}
                    />
                    <label className="text-xs text-gray-600">Junior (RM)</label>
                    <input
                      disabled={!showEmceeBase}
                      className="border border-gray-200 rounded px-2 py-1 text-right bg-white text-gray-900 disabled:opacity-60"
                      value={String((selection.baseRates as any)?.emceeJunior ?? base?.emceeJunior ?? "")}
                      onChange={(e) => setBaseRate("emceeJunior", e.target.value)}
                    />
                  </div>
                  {!showEmceeBase && <div className="text-xs text-gray-600 mt-2">Emcee base only applies for Half Day / Full Day.</div>}
                </div>
              </div>
            </div>
          )}

          <div className="border border-gray-200 rounded-xl p-3">
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
                  <div key={row.code} className="border border-gray-200 rounded-lg p-3 flex items-center justify-between gap-3 bg-white">
                    <label className="flex items-start gap-2 text-sm text-gray-900">
                      <input type="checkbox" className="mt-1" checked={checked} onChange={() => toggleCode(row.code)} />
                      <div>
                        <div className="font-medium">{row.left}</div>
                        <div className="text-xs text-gray-600">{row.unit === "perHour" ? "per hour" : "flat"}</div>
                      </div>
                    </label>

                    <div className="flex items-center gap-2">
                      <span className="text-sm text-gray-600">RM</span>
                      <input
                        className="w-24 border border-gray-200 rounded px-2 py-1 text-right bg-white text-gray-900"
                        value={String(current ?? "")}
                        onChange={(e) => setAddOnRate(String(row.rateKey), e.target.value)}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="border border-gray-200 rounded-xl p-3">
            <div className="text-sm font-semibold">Optional custom item</div>
            <div className="text-xs text-gray-600">Example: “Driver fee”, “Special allowance”, etc.</div>

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
                className="flex-1 border border-gray-200 rounded px-2 py-1 bg-white text-gray-900"
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
                  className="w-28 border border-gray-200 rounded px-2 py-1 text-right bg-white text-gray-900"
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

          <div className="border border-gray-200 rounded-xl p-3">
            <div className="text-sm font-semibold">Optional note</div>
            <input
              className="mt-2 w-full border border-gray-200 rounded px-2 py-2 bg-white text-gray-900"
              placeholder="e.g. 'Backend include packing', etc"
              value={selection.note || ""}
              onChange={(e) => setSelection({ ...selection, note: e.target.value })}
            />
          </div>

          <div className="text-xs text-gray-600">
            Tip: If you don’t want base claim, choose <b>None</b> and only tick add-ons.
          </div>
        </div>

        <div className="sticky bottom-0 bg-white z-10 border-t border-gray-200 p-4 flex justify-end">
          <PrimaryButton onClick={onClose}>Done</PrimaryButton>
        </div>
      </div>
    </div>
  );
}

/* ---------------- User Picker Modal (cleaner UX) ---------------- */

function UserPickerModal({
  open,
  onClose,
  users,
  selectedUserIds,
  roleByUserId,
  setSelectedUserIds,
  setRoleByUserId,
}: {
  open: boolean;
  onClose: () => void;
  users: User[];
  selectedUserIds: string[];
  roleByUserId: Record<string, WorkRole>;
  setSelectedUserIds: (ids: string[]) => void;
  setRoleByUserId: (m: Record<string, WorkRole>) => void;
}) {
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const workRoleOptions: WorkRole[] = ["JUNIOR_MARSHAL", "SENIOR_MARSHAL", "JUNIOR_EMCEE", "SENIOR_EMCEE"];

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return users;
    return users.filter((u) => (u.name || "").toLowerCase().includes(s) || (u.email || "").toLowerCase().includes(s));
  }, [users, q]);

  function toggle(u: User) {
    const exists = selectedUserIds.includes(u.id);
    const next = exists ? selectedUserIds.filter((x) => x !== u.id) : [...selectedUserIds, u.id];
    setSelectedUserIds(next);

    if (!exists) {
      setRoleByUserId({ ...roleByUserId, [u.id]: roleByUserId[u.id] || u.defaultWorkRole || "JUNIOR_MARSHAL" });
    } else {
      const m = { ...roleByUserId };
      delete m[u.id];
      setRoleByUserId(m);
    }
  }

  function clearAll() {
    setSelectedUserIds([]);
    setRoleByUserId({});
  }

  function selectAllFiltered() {
    const ids = Array.from(new Set([...selectedUserIds, ...filtered.map((u) => u.id)]));
    const m = { ...roleByUserId };
    for (const u of filtered) {
      if (!m[u.id]) m[u.id] = u.defaultWorkRole || "JUNIOR_MARSHAL";
    }
    setSelectedUserIds(ids);
    setRoleByUserId(m);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3">
      <div className="w-full max-w-3xl bg-white rounded-2xl border border-gray-200 shadow-lg flex flex-col max-h-[90vh] text-gray-900">
        <div className="sticky top-0 bg-white z-10 border-b border-gray-200 p-4 flex items-center justify-between">
          <div>
            <div className="font-semibold">Assign users</div>
            <div className="text-xs text-gray-600">Search by name/email, then set role per selected user.</div>
          </div>
          <div className="flex gap-2">
            <IconButton onClick={clearAll} title="Clear all selected">
              Clear
            </IconButton>
            <IconButton onClick={selectAllFiltered} title="Select all (filtered)">
              Select all
            </IconButton>
            <IconButton onClick={onClose}>Close</IconButton>
          </div>
        </div>

        <div className="p-4">
          <input
            className="w-full border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-900"
            placeholder="Search users…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />

          <div className="mt-3 text-xs text-gray-600">
            Selected: <b>{selectedUserIds.length}</b>
          </div>

          <div className="mt-3 border border-gray-200 rounded-xl overflow-hidden">
            <div className="max-h-[55vh] overflow-auto">
              {filtered.map((u) => {
                const checked = selectedUserIds.includes(u.id);
                const role = roleByUserId[u.id] || u.defaultWorkRole || "JUNIOR_MARSHAL";
                return (
                  <div key={u.id} className="flex items-center justify-between gap-3 px-3 py-2 border-b border-gray-100 bg-white">
                    <label className="flex items-center gap-2 min-w-0">
                      <input type="checkbox" checked={checked} onChange={() => toggle(u)} />
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{u.name}</div>
                        <div className="text-xs text-gray-600 truncate">{u.email}</div>
                      </div>
                    </label>

                    <select
                      className="border border-gray-200 rounded-lg px-2 py-1 text-sm bg-white text-gray-900 disabled:opacity-60"
                      disabled={!checked}
                      value={role}
                      onChange={(e) => setRoleByUserId({ ...roleByUserId, [u.id]: e.target.value as WorkRole })}
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
              {filtered.length === 0 && <div className="p-4 text-sm text-gray-600">No matching users.</div>}
            </div>
          </div>
        </div>

        <div className="sticky bottom-0 bg-white z-10 border-t border-gray-200 p-4 flex justify-end">
          <PrimaryButton onClick={onClose}>Done</PrimaryButton>
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

  // Export
  const [exportBusy, setExportBusy] = useState(false);

  // Create/Edit state
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [project, setProject] = useState("");
  const [remark, setRemark] = useState("");

  // Draft slots
  const [slots, setSlots] = useState<SlotDraft[]>(() => [
    {
      tempId: makeTempId(),
      index: 0,
      label: "Slot 1",
      date: "",
      endDate: "",
      startTime: "18:00",
      endTime: "20:00",
      selection: newSelection(),
      selectedUserIds: [],
      roleByUserId: {},
      overrides: {},
    },
  ]);

  // Slot accordion expanded set
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([slots[0]?.tempId].filter(Boolean) as string[]));

  // Modals
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [userModalOpen, setUserModalOpen] = useState(false);
  const [activeSlotTempId, setActiveSlotTempId] = useState<string | null>(null);

  // Existing list controls
  const [existingQ, setExistingQ] = useState("");
  const [onlyUnpaid, setOnlyUnpaid] = useState(false);
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(() => new Set());

  // Existing row breakdown toggles
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());

  // Busy state
  const [saving, setSaving] = useState(false);

  const workRoleOptions: WorkRole[] = ["JUNIOR_MARSHAL", "SENIOR_MARSHAL", "JUNIOR_EMCEE", "SENIOR_EMCEE"];

  async function loadAll() {
    setMsg(null);
    const [uRes, eRes] = await Promise.all([fetch("/api/admin/users"), fetch("/api/admin/ot-events")]);

    if (!uRes.ok || !eRes.ok) {
      setMsg("Forbidden (Admin only)");
      return;
    }

    const uj = await uRes.json();
    const ej = await eRes.json();
    setUsers(uj.users || []);
    setEvents(ej.events || []);
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function ensureEndDate(s: SlotDraft): SlotDraft {
    const multi = isMultiDayClaim(s.selection.claim ?? null);
    if (!s.date) return s;

    if (multi) {
      const delta = s.selection.claim === "EVENT_3D2N" ? 2 : 1;
      const desired = addDaysToIsoDate(s.date, delta);
      if (!s.endDate || s.endDate === s.date) return { ...s, endDate: desired };
      return s;
    }

    // normal: keep endDate = date
    if (s.endDate !== s.date) return { ...s, endDate: s.date };
    return s;
  }

  function updateSlot(tempId: string, patch: Partial<SlotDraft>) {
    setSlots((prev) =>
      prev.map((s) => {
        if (s.tempId !== tempId) return s;
        const merged = ensureEndDate({ ...s, ...patch } as SlotDraft);
        return merged;
      })
    );
  }

  function addSlot(copyFromTempId?: string) {
    setSlots((prev) => {
      const copyFrom = copyFromTempId ? prev.find((s) => s.tempId === copyFromTempId) : null;

      const nextIndex = prev.length;
      const base: SlotDraft = {
        tempId: makeTempId(),
        id: undefined,
        index: nextIndex,
        label: `Slot ${nextIndex + 1}`,
        date: copyFrom?.date || "",
        endDate: copyFrom?.endDate || "",
        startTime: copyFrom?.startTime || "18:00",
        endTime: copyFrom?.endTime || "20:00",
        selection: copyFrom ? { ...(copyFrom.selection as any) } : newSelection(),
        selectedUserIds: copyFrom ? [...copyFrom.selectedUserIds] : [],
        roleByUserId: copyFrom ? { ...copyFrom.roleByUserId } : {},
        overrides: {}, // overrides should not be copied
      };

      const next = [...prev, ensureEndDate(base)];
      // auto expand new slot
      setExpanded((old) => new Set(old).add(base.tempId));
      return next;
    });
  }

  function removeSlot(tempId: string) {
    setSlots((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((s) => s.tempId !== tempId).map((s, idx) => ({ ...s, index: idx, label: s.label || `Slot ${idx + 1}` }));
      // cleanup expanded
      setExpanded((old) => {
        const n = new Set(old);
        n.delete(tempId);
        return n.size ? n : new Set([next[0]?.tempId].filter(Boolean) as string[]);
      });
      return next;
    });
  }

  function toggleExpandSlot(tempId: string) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(tempId)) n.delete(tempId);
      else n.add(tempId);
      return n;
    });
  }

  function openTaskModal(tempId: string) {
    setActiveSlotTempId(tempId);
    setTaskModalOpen(true);
  }

  function openUserModal(tempId: string) {
    setActiveSlotTempId(tempId);
    setUserModalOpen(true);
  }

  const activeSlot = useMemo(() => slots.find((s) => s.tempId === activeSlotTempId) || null, [slots, activeSlotTempId]);

  function slotSelectionSummary(sel: TaskSelection) {
    const parts: string[] = [];
    parts.push(sel.claim ? CLAIM_LABEL[sel.claim] : "No base");
    const codes = (sel.codes ?? []) as TaskCode[];
    if (codes.length) parts.push(codes.map((c) => TASK_LABEL[c]).join(" + "));
    if (sel.custom?.enabled && (sel.custom as any)?.amount) parts.push(`Custom: ${(sel.custom as any).label || "Item"} (RM${(sel.custom as any).amount})`);
    if (sel.note) parts.push(`Note: ${sel.note}`);
    return parts.join(" · ");
  }

  function getSlotStartEnd(slot: SlotDraft) {
    const multi = isMultiDayClaim(slot.selection.claim ?? null);
    const endDateUsed = multi ? slot.endDate : slot.date;
    if (!slot.date || (multi && !endDateUsed)) return null;

    const start = combineDateTime(slot.date, slot.startTime);
    const end = combineDateTime(endDateUsed, slot.endTime);
    return { start, end, endDateUsed };
  }

  function parseOverrideToRM(v: string) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function computeSlotTotals(slot: SlotDraft) {
    const se = getSlotStartEnd(slot);
    if (!se) return { totalRM: 0, rows: [] as Array<{ user: User; workRole: WorkRole; defaultRM: number; overrideRM: number | null; effectiveRM: number }> };

    const { start, end } = se;

    const selectedUsers = users.filter((u) => slot.selectedUserIds.includes(u.id));
    const rows = selectedUsers.map((u) => {
      const workRole = slot.roleByUserId[u.id] || u.defaultWorkRole || "JUNIOR_MARSHAL";
      const defaultRM = computeDefaultPayRM({ workRole, start, end, selection: slot.selection });
      const overrideRM = slot.overrides[u.id] ? parseOverrideToRM(slot.overrides[u.id]) : null;
      const effectiveRM = overrideRM ?? defaultRM;
      return { user: u, workRole, defaultRM, overrideRM, effectiveRM };
    });

    const totalRM = rows.reduce((s, r) => s + (Number.isFinite(r.effectiveRM) ? r.effectiveRM : 0), 0);
    return { totalRM: round2(totalRM), rows };
  }

  const slotComputed = useMemo(() => {
    const map = new Map<string, ReturnType<typeof computeSlotTotals>>();
    for (const s of slots) map.set(s.tempId, computeSlotTotals(s));
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, users]);

  function resetForm() {
    setEditingEventId(null);
    setProject("");
    setRemark("");
    const first: SlotDraft = {
      tempId: makeTempId(),
      index: 0,
      label: "Slot 1",
      date: "",
      endDate: "",
      startTime: "18:00",
      endTime: "20:00",
      selection: newSelection(),
      selectedUserIds: [],
      roleByUserId: {},
      overrides: {},
    };
    setSlots([first]);
    setExpanded(new Set([first.tempId]));
  }

  function fillFormFromEvent(ev: OtEvent) {
    setEditingEventId(ev.id);
    setProject(ev.project || "");
    setRemark(ev.remark || "");

    const sls = normalizeSlots(ev).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const drafts: SlotDraft[] = sls.map((sl, idx) => {
      const start = new Date(sl.startTime);
      const end = new Date(sl.endTime);

      const sel = safeParseSelection(sl.taskCodes || "{}");
      const selectedUserIds = (sl.assignments || []).map((a) => a.userId).filter(Boolean);

      const roleByUserId: Record<string, WorkRole> = {};
      const overrides: Record<string, string> = {};
      for (const a of sl.assignments || []) {
        roleByUserId[a.userId] = a.workRole;
        if (a.amountOverride !== null && a.amountOverride !== undefined) overrides[a.userId] = (Number(a.amountOverride) / 100).toFixed(2);
      }

      const d: SlotDraft = {
        tempId: makeTempId(),
        id: sl.id.startsWith("legacy-") ? undefined : sl.id,
        index: idx,
        label: `Slot ${idx + 1}`,
        date: isoDateOnly(start),
        endDate: isoDateOnly(end),
        startTime: hhmmFromIso(sl.startTime),
        endTime: hhmmFromIso(sl.endTime),
        selection: sel,
        selectedUserIds,
        roleByUserId,
        overrides,
      };
      return ensureEndDate(d);
    });

    setSlots(drafts.length ? drafts : []);
    setExpanded(new Set(drafts.map((d) => d.tempId))); // expand all when editing
  }

  function buildValidation() {
    const errors: string[] = [];
    if (!project.trim()) errors.push("Project is required.");
    if (!slots.length) errors.push("At least 1 slot is required.");

    slots.forEach((s, i) => {
      const n = i + 1;
      if (!s.date) errors.push(`Slot ${n}: date is required.`);
      const multi = isMultiDayClaim(s.selection.claim ?? null);
      if (multi && !s.endDate) errors.push(`Slot ${n}: end date is required for ${CLAIM_LABEL[s.selection.claim as any]}.`);
      if (multi && s.endDate && s.endDate < s.date) errors.push(`Slot ${n}: end date cannot be earlier than start date.`);
      const se = getSlotStartEnd(s);
      if (se && !(se.end.getTime() > se.start.getTime())) errors.push(`Slot ${n}: end time must be after start time.`);
      if (!s.selectedUserIds.length) errors.push(`Slot ${n}: select at least 1 user.`);
    });

    return errors;
  }

  const validationErrors = useMemo(() => buildValidation(), [project, slots]);

  async function createOrUpdateEvent() {
    if (saving) return;

    const errs = buildValidation();
    if (errs.length) {
      setMsg(errs[0]);
      return;
    }

    try {
      setSaving(true);
      setMsg(null);

      const payloadSlots = slots.map((s, idx) => {
        const se = getSlotStartEnd(s)!;
        const assignments = s.selectedUserIds.map((uid) => {
          const u = users.find((x) => x.id === uid);
          const role = s.roleByUserId[uid] || u?.defaultWorkRole || "JUNIOR_MARSHAL";
          const amountOverrideRM = s.overrides[uid] ?? null;
          return { userId: uid, workRole: role, amountOverrideRM };
        });

        return {
          id: s.id,
          index: idx,
          startTime: se.start.toISOString(),
          endTime: se.end.toISOString(),
          selection: s.selection,
          assignments,
        };
      });

      const url = editingEventId ? `/api/admin/ot-events/${editingEventId}` : "/api/admin/ot-events";
      const method = editingEventId ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: project.trim(),
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
      resetForm();
      await loadAll();
    } finally {
      setSaving(false);
    }
  }

  async function deleteEvent(eventId: string) {
    const ok = confirm("Delete this Approved OT event? This will remove slots & assignments too.");
    if (!ok) return;

    setMsg(null);
    const res = await fetch(`/api/admin/ot-events/${eventId}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg(j.error || "Delete failed");
      return;
    }
    setMsg("Deleted ✅");
    if (editingEventId === eventId) resetForm();
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

  /* ---------------- Export to CSV (slot-aware) ---------------- */
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
        "Project",
        "Remark",
        "EventId",
        "SlotIndex",
        "SlotId",
        "SlotStartDate",
        "SlotEndDate",
        "SlotStartTime",
        "SlotEndTime",
        "UserName",
        "UserEmail",
        "WorkRole",
        "TaskSummary",
        "Breakdown",
        "DefaultRM",
        "OverrideRM",
        "EffectiveRM",
        "Status",
        "AssignmentId",
      ];

      const rows: string[] = [];
      rows.push(headers.map(csvEscape).join(","));

      for (const ev of evs) {
        const sls = normalizeSlots(ev).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

        for (const sl of sls) {
          const sel = safeParseSelection(sl.taskCodes || "{}");
          const start = new Date(sl.startTime);
          const end = new Date(sl.endTime);

          const taskSummary = slotSelectionSummary(sel);

          for (const a of sl.assignments || []) {
            const defaultCents = Number(a.amountDefault ?? 0);
            const overrideCents = a.amountOverride === null ? null : Number(a.amountOverride);
            const effectiveCents = overrideCents ?? defaultCents;

            const breakdown = buildTaskPayBreakdown({ workRole: a.workRole, start, end, selection: sel });
            const breakdownInline = formatBreakdownInline(breakdown.lines);

            rows.push(
              [
                ev.project || "",
                ev.remark || "",
                ev.id,
                String(sl.index ?? 0),
                sl.id,
                isoDateOnly(start),
                isoDateOnly(end),
                toLocalTime(start),
                toLocalTime(end),
                a.user?.name || "",
                a.user?.email || "",
                WORK_ROLE_LABEL[a.workRole] || a.workRole,
                taskSummary,
                breakdownInline,
                centsToRm(defaultCents),
                overrideCents === null ? "" : centsToRm(overrideCents),
                centsToRm(effectiveCents),
                a.status,
                a.id,
              ].map(csvEscape).join(",")
            );
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

  /* ---------------- Existing list computed + filters ---------------- */

  function eventSummary(ev: OtEvent) {
    const sls = normalizeSlots(ev);
    const slotDates = Array.from(
      new Set(
        sls
          .flatMap((sl) => [isoDateOnly(new Date(sl.startTime)), isoDateOnly(new Date(sl.endTime))])
          .filter(Boolean)
      )
    ).sort();

    const allAssignments = sls.flatMap((sl) => sl.assignments || []);
    const unpaidCount = allAssignments.filter((a) => a.status === "UNPAID").length;

    const totalCents = allAssignments.reduce((s, a) => {
      const eff = (a.amountOverride ?? null) !== null ? Number(a.amountOverride) : Number(a.amountDefault ?? 0);
      return s + (Number.isFinite(eff) ? eff : 0);
    }, 0);

    return {
      slotCount: sls.length,
      slotDates,
      unpaidCount,
      totalRM: round2(totalCents / 100),
    };
  }

  const filteredEvents = useMemo(() => {
    const q = existingQ.trim().toLowerCase();
    return (events || []).filter((ev) => {
      if (q) {
        const hay = `${ev.project || ""} ${(ev.remark || "")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (onlyUnpaid) {
        const s = eventSummary(ev);
        if (s.unpaidCount <= 0) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, existingQ, onlyUnpaid]);

  function toggleEventExpand(id: string) {
    setExpandedEvents((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function toggleRow(id: string) {
    setExpandedRows((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  /* ---------------- Render ---------------- */

  const stickyHint = validationErrors.length ? validationErrors[0] : null;

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      {/* Header */}
      <div className="sticky top-0 z-40 bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-lg font-semibold truncate">Admin — Approved OT</div>
            {msg && <div className="text-xs text-gray-700 mt-0.5">{msg}</div>}
          </div>

          <div className="flex items-center gap-2">
            <IconButton onClick={exportToCsv} disabled={exportBusy} title="Download as CSV">
              {exportBusy ? "Exporting…" : "Export CSV"}
            </IconButton>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* Create/Edit Card */}
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="px-4 py-4 border-b border-gray-200 flex items-start justify-between gap-3">
            <div>
              <div className="font-semibold">{editingEventId ? "Edit Approved OT" : "Create Approved OT"}</div>
              <div className="text-xs text-gray-600 mt-1">
                Cleaner multi-slot flow: add slots, set tasks/time, assign users, then create.
              </div>
            </div>
            {editingEventId && (
              <IconButton onClick={resetForm} title="Cancel edit">
                Cancel Edit
              </IconButton>
            )}
          </div>

          <div className="p-4 space-y-4">
            {/* Event fields */}
            <div className="grid md:grid-cols-3 gap-3">
              <div className="md:col-span-2">
                <label className="text-sm font-medium">Event / Project</label>
                <input
                  className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 bg-white"
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                  placeholder="e.g. Corporate Dinner @ KL"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Remark</label>
                <input
                  className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 bg-white"
                  value={remark}
                  onChange={(e) => setRemark(e.target.value)}
                  placeholder="Optional…"
                />
              </div>
            </div>

            {/* Slots header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="font-semibold">Time slots</div>
                <Badge tone="gray">{slots.length} slot(s)</Badge>
              </div>
              <div className="flex gap-2">
                <IconButton onClick={() => addSlot()} title="Add a new slot">
                  + Add slot
                </IconButton>
              </div>
            </div>

            {/* Slots list */}
            <div className="space-y-3">
              {slots.map((sl, idx) => {
                const isExpanded = expanded.has(sl.tempId);
                const se = getSlotStartEnd(sl);
                const dateLabel = se ? `${toLocalDateShort(se.start)}${isoDateOnly(se.start) !== isoDateOnly(se.end) ? ` → ${toLocalDateShort(se.end)}` : ""}` : "No date";
                const timeLabel = se ? `${toLocalTime(se.start)} – ${toLocalTime(se.end)}` : "No time";
                const taskLabel = slotSelectionSummary(sl.selection);
                const comp = slotComputed.get(sl.tempId);
                const totalRM = comp?.totalRM ?? 0;

                return (
                  <div key={sl.tempId} className="border border-gray-200 rounded-2xl overflow-hidden bg-white">
                    {/* Slot header (compact) */}
                    <button
                      type="button"
                      onClick={() => toggleExpandSlot(sl.tempId)}
                      className="w-full text-left px-4 py-3 bg-gray-50 hover:bg-gray-100 transition flex items-start justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="font-semibold truncate">{sl.label || `Slot ${idx + 1}`}</div>
                          <Badge tone="blue">{dateLabel}</Badge>
                          <Badge tone="gray">{timeLabel}</Badge>
                          <Badge tone={sl.selectedUserIds.length ? "green" : "amber"}>
                            {sl.selectedUserIds.length ? `${sl.selectedUserIds.length} user(s)` : "No users"}
                          </Badge>
                          <Badge tone="gray">Total RM{totalRM.toFixed(2)}</Badge>
                        </div>
                        <div className="text-xs text-gray-600 mt-1 truncate">{taskLabel}</div>
                      </div>

                      <div className="shrink-0 flex items-center gap-2">
                        <span className="text-xs text-gray-600">{isExpanded ? "Collapse" : "Expand"}</span>
                        <span className={cn("transition", isExpanded ? "rotate-180" : "")}>▾</span>
                      </div>
                    </button>

                    {/* Slot body */}
                    {isExpanded && (
                      <div className="p-4 space-y-4">
                        <div className="grid md:grid-cols-3 gap-3">
                          <div className="md:col-span-2">
                            <label className="text-sm font-medium">Slot label</label>
                            <input
                              className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 bg-white"
                              value={sl.label}
                              onChange={(e) => updateSlot(sl.tempId, { label: e.target.value })}
                              placeholder={`Slot ${idx + 1}`}
                            />
                          </div>

                          <div className="flex items-end gap-2">
                            <IconButton onClick={() => addSlot(sl.tempId)} title="Duplicate slot (copies time/tasks/users)">
                              Duplicate
                            </IconButton>
                            <IconButton
                              tone="danger"
                              disabled={slots.length <= 1}
                              onClick={() => removeSlot(sl.tempId)}
                              title={slots.length <= 1 ? "At least one slot is required" : "Remove this slot"}
                            >
                              Remove
                            </IconButton>
                          </div>
                        </div>

                        {/* Task */}
                        <div className="border border-gray-200 rounded-xl p-3">
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="text-sm font-semibold">Task</div>
                              <div className="text-xs text-gray-600 mt-1">{taskLabel}</div>
                            </div>
                            <IconButton onClick={() => openTaskModal(sl.tempId)}>Edit tasks</IconButton>
                          </div>
                        </div>

                        {/* Time */}
                        <div className="border border-gray-200 rounded-xl p-3">
                          <div className="text-sm font-semibold mb-2">Date & time</div>

                          {!isMultiDayClaim(sl.selection.claim ?? null) ? (
                            <div className="grid md:grid-cols-3 gap-3">
                              <div>
                                <label className="text-xs text-gray-600">Date</label>
                                <input
                                  className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 bg-white"
                                  type="date"
                                  value={sl.date}
                                  onChange={(e) => updateSlot(sl.tempId, { date: e.target.value })}
                                />
                              </div>
                              <div>
                                <label className="text-xs text-gray-600">Start time</label>
                                <input
                                  className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 bg-white"
                                  type="time"
                                  value={sl.startTime}
                                  onChange={(e) => updateSlot(sl.tempId, { startTime: e.target.value })}
                                />
                              </div>
                              <div>
                                <label className="text-xs text-gray-600">End time</label>
                                <input
                                  className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 bg-white"
                                  type="time"
                                  value={sl.endTime}
                                  onChange={(e) => updateSlot(sl.tempId, { endTime: e.target.value })}
                                />
                              </div>
                            </div>
                          ) : (
                            <div className="grid md:grid-cols-4 gap-3">
                              <div>
                                <label className="text-xs text-gray-600">Start date</label>
                                <input
                                  className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 bg-white"
                                  type="date"
                                  value={sl.date}
                                  onChange={(e) => updateSlot(sl.tempId, { date: e.target.value })}
                                />
                              </div>
                              <div>
                                <label className="text-xs text-gray-600">End date</label>
                                <input
                                  className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 bg-white"
                                  type="date"
                                  value={sl.endDate}
                                  min={sl.date || undefined}
                                  onChange={(e) => updateSlot(sl.tempId, { endDate: e.target.value })}
                                />
                              </div>
                              <div>
                                <label className="text-xs text-gray-600">Start time</label>
                                <input
                                  className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 bg-white"
                                  type="time"
                                  value={sl.startTime}
                                  onChange={(e) => updateSlot(sl.tempId, { startTime: e.target.value })}
                                />
                              </div>
                              <div>
                                <label className="text-xs text-gray-600">End time</label>
                                <input
                                  className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 bg-white"
                                  type="time"
                                  value={sl.endTime}
                                  onChange={(e) => updateSlot(sl.tempId, { endTime: e.target.value })}
                                />
                              </div>
                              <div className="md:col-span-4 text-xs text-gray-600">
                                Multi-day claim selected: end date is required.
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Users + Pay */}
                        <div className="border border-gray-200 rounded-xl p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="text-sm font-semibold">Users</div>
                              <div className="text-xs text-gray-600 mt-1">
                                Selected: <b>{sl.selectedUserIds.length}</b>
                              </div>
                            </div>
                            <IconButton onClick={() => openUserModal(sl.tempId)}>Assign users</IconButton>
                          </div>

                          {/* Selected chips */}
                          <div className="mt-3 flex flex-wrap gap-2">
                            {sl.selectedUserIds.length === 0 && <div className="text-xs text-gray-600">No users selected.</div>}
                            {sl.selectedUserIds.map((uid) => {
                              const u = users.find((x) => x.id === uid);
                              if (!u) return null;
                              const role = sl.roleByUserId[uid] || u.defaultWorkRole || "JUNIOR_MARSHAL";
                              return (
                                <span key={uid} className="inline-flex items-center gap-2 px-2 py-1 rounded-full border border-gray-200 bg-white text-xs">
                                  <span className="font-medium">{u.name}</span>
                                  <span className="text-gray-600">{WORK_ROLE_LABEL[role] || role}</span>
                                  <button
                                    type="button"
                                    className="text-gray-500 hover:text-gray-900"
                                    title="Remove"
                                    onClick={() => {
                                      const nextIds = sl.selectedUserIds.filter((x) => x !== uid);
                                      const nextRoles = { ...sl.roleByUserId };
                                      delete nextRoles[uid];
                                      const nextOvs = { ...sl.overrides };
                                      delete nextOvs[uid];
                                      updateSlot(sl.tempId, { selectedUserIds: nextIds, roleByUserId: nextRoles, overrides: nextOvs });
                                    }}
                                  >
                                    ×
                                  </button>
                                </span>
                              );
                            })}
                          </div>

                          {/* Pay table (only for selected) */}
                          <div className="mt-4 border border-gray-200 rounded-xl overflow-hidden">
                            <table className="w-full text-sm">
                              <thead className="bg-gray-50">
                                <tr>
                                  <th className="text-left p-2">User</th>
                                  <th className="text-left p-2">Role</th>
                                  <th className="text-right p-2">Default (RM)</th>
                                  <th className="text-right p-2">Override (RM)</th>
                                  <th className="text-right p-2">Effective</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(slotComputed.get(sl.tempId)?.rows || []).map((r) => (
                                  <tr key={r.user.id} className="border-t border-gray-100">
                                    <td className="p-2">{r.user.name}</td>
                                    <td className="p-2">
                                      <select
                                        className="border border-gray-200 rounded-lg px-2 py-1 text-sm bg-white"
                                        value={r.workRole}
                                        onChange={(e) => updateSlot(sl.tempId, { roleByUserId: { ...sl.roleByUserId, [r.user.id]: e.target.value as WorkRole } })}
                                      >
                                        {workRoleOptions.map((w) => (
                                          <option key={w} value={w}>
                                            {WORK_ROLE_LABEL[w]}
                                          </option>
                                        ))}
                                      </select>
                                    </td>
                                    <td className="p-2 text-right tabular-nums">{Number.isFinite(r.defaultRM) ? r.defaultRM.toFixed(2) : "0.00"}</td>
                                    <td className="p-2 text-right">
                                      <input
                                        className="w-28 border border-gray-200 rounded-lg px-2 py-1 text-right bg-white tabular-nums"
                                        placeholder="(auto)"
                                        value={sl.overrides[r.user.id] ?? ""}
                                        onChange={(e) => updateSlot(sl.tempId, { overrides: { ...sl.overrides, [r.user.id]: e.target.value } })}
                                      />
                                    </td>
                                    <td className="p-2 text-right tabular-nums font-medium">{Number.isFinite(r.effectiveRM) ? r.effectiveRM.toFixed(2) : "0.00"}</td>
                                  </tr>
                                ))}

                                {(slotComputed.get(sl.tempId)?.rows?.length || 0) === 0 && (
                                  <tr>
                                    <td className="p-3 text-gray-600" colSpan={5}>
                                      Pick date/time + tasks + users to see default pay.
                                    </td>
                                  </tr>
                                )}

                                <tr className="border-t border-gray-200 bg-gray-50">
                                  <td className="p-2 font-semibold" colSpan={4}>
                                    Slot total
                                  </td>
                                  <td className="p-2 text-right font-semibold tabular-nums">RM{(slotComputed.get(sl.tempId)?.totalRM ?? 0).toFixed(2)}</td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Spacer so sticky footer doesn't cover */}
            <div className="h-16" />
          </div>
        </div>

        {/* Existing list */}
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="px-4 py-4 border-b border-gray-200 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <div className="font-semibold">Existing Approved OT</div>
              <div className="text-xs text-gray-600 mt-1">Tip: expand an event to see slots + assignments.</div>
            </div>

            <div className="flex flex-col md:flex-row gap-2 md:items-center">
              <input
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                placeholder="Search project/remark…"
                value={existingQ}
                onChange={(e) => setExistingQ(e.target.value)}
              />
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={onlyUnpaid} onChange={(e) => setOnlyUnpaid(e.target.checked)} />
                Only unpaid
              </label>
            </div>
          </div>

          <div className="p-4 space-y-3 bg-gray-50">
            {filteredEvents.map((ev) => {
              const sum = eventSummary(ev);
              const isOpen = expandedEvents.has(ev.id);

              return (
                <div key={ev.id} className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
                  <div className="p-4 flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="font-semibold truncate">{ev.project}</div>
                        <Badge tone="gray">{sum.slotCount} slot(s)</Badge>
                        <Badge tone={sum.unpaidCount ? "amber" : "green"}>{sum.unpaidCount ? `${sum.unpaidCount} unpaid` : "All paid"}</Badge>
                        <Badge tone="gray">Total RM{sum.totalRM.toFixed(2)}</Badge>
                      </div>

                      <div className="text-xs text-gray-600 mt-1">
                        Date(s): {sum.slotDates.length ? sum.slotDates.join(" · ") : "-"}
                        {ev.remark ? <span className="ml-2">· Remark: {ev.remark}</span> : null}
                      </div>
                    </div>

                    <div className="flex gap-2 shrink-0">
                      <IconButton onClick={() => toggleEventExpand(ev.id)}>{isOpen ? "Collapse" : "Expand"}</IconButton>
                      <IconButton onClick={() => fillFormFromEvent(ev)}>Edit</IconButton>
                      <IconButton tone="danger" onClick={() => deleteEvent(ev.id)}>
                        Delete
                      </IconButton>
                    </div>
                  </div>

                  {isOpen && (
                    <div className="px-4 pb-4 space-y-4">
                      {normalizeSlots(ev)
                        .slice()
                        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
                        .map((sl) => {
                          const sel = safeParseSelection(sl.taskCodes || "{}");
                          const s = new Date(sl.startTime);
                          const e = new Date(sl.endTime);

                          const head = `${(sl.index ?? 0) + 1}. ${toLocalDateShort(s)} ${toLocalTime(s)} → ${
                            isoDateOnly(s) === isoDateOnly(e) ? toLocalTime(e) : `${toLocalDateShort(e)} ${toLocalTime(e)}`
                          }`;

                          const slotAssignments = sl.assignments || [];

                          const slotTotalCents = slotAssignments.reduce((acc, a) => {
                            const eff = (a.amountOverride ?? null) !== null ? Number(a.amountOverride) : Number(a.amountDefault ?? 0);
                            return acc + (Number.isFinite(eff) ? eff : 0);
                          }, 0);

                          return (
                            <div key={sl.id} className="border border-gray-200 rounded-2xl overflow-hidden">
                              <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div className="font-semibold text-sm">Slot {head}</div>
                                  <Badge tone="gray">Slot total RM{(slotTotalCents / 100).toFixed(2)}</Badge>
                                </div>
                                <div className="text-xs text-gray-600 mt-1">{slotSelectionSummary(sel)}</div>
                              </div>

                              <div className="p-3">
                                <div className="border border-gray-200 rounded-xl overflow-hidden">
                                  <table className="w-full text-sm">
                                    <thead className="bg-gray-50">
                                      <tr>
                                        <th className="text-left p-2">User</th>
                                        <th className="text-left p-2">Role</th>
                                        <th className="text-right p-2">Default</th>
                                        <th className="text-right p-2">Override</th>
                                        <th className="text-right p-2">Effective</th>
                                        <th className="text-center p-2">Paid</th>
                                        <th className="text-center p-2">Details</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {slotAssignments.map((a) => {
                                        const isPaid = a.status === "PAID";
                                        const defaultCents = Number(a.amountDefault ?? 0);
                                        const overrideCents = a.amountOverride === null ? null : Number(a.amountOverride);
                                        const effectiveCents = overrideCents ?? defaultCents;

                                        const show = expandedRows.has(a.id);
                                        const breakdown = show
                                          ? buildTaskPayBreakdown({ workRole: a.workRole, start: s, end: e, selection: sel })
                                          : null;

                                        return (
                                          <>
                                            <tr key={a.id} className={cn("border-t border-gray-100", isPaid && "bg-gray-50")}>
                                              <td className="p-2">{a.user?.name || "-"}</td>
                                              <td className="p-2 text-xs">{WORK_ROLE_LABEL[a.workRole] || a.workRole}</td>
                                              <td className="p-2 text-right tabular-nums">RM{centsToRm(defaultCents)}</td>
                                              <td className="p-2 text-right">
                                                <input
                                                  className="w-24 border border-gray-200 rounded-lg px-2 py-1 text-right bg-white tabular-nums disabled:opacity-60"
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
                                              <td className="p-2 text-right tabular-nums font-medium">RM{centsToRm(effectiveCents)}</td>
                                              <td className="p-2 text-center">
                                                <input
                                                  type="checkbox"
                                                  checked={isPaid}
                                                  onChange={(e) => patchAssignment(a.id, { status: e.target.checked ? "PAID" : "UNPAID" })}
                                                />
                                              </td>
                                              <td className="p-2 text-center">
                                                <button
                                                  type="button"
                                                  className="text-xs px-2 py-1 rounded-lg border border-gray-200 hover:bg-gray-50"
                                                  onClick={() => toggleRow(a.id)}
                                                >
                                                  {show ? "Hide" : "Show"}
                                                </button>
                                              </td>
                                            </tr>

                                            {show && breakdown && (
                                              <tr className="border-t border-gray-100 bg-white">
                                                <td className="p-3 text-xs text-gray-700" colSpan={7}>
                                                  <div className="font-medium text-gray-900 mb-1">Breakdown</div>
                                                  <div className="text-gray-700">
                                                    {formatBreakdownInline(breakdown.lines)}
                                                  </div>
                                                  <div className="text-gray-600 mt-1">Total: RM{breakdown.totalRM.toFixed(2)}</div>
                                                </td>
                                              </tr>
                                            )}
                                          </>
                                        );
                                      })}

                                      {slotAssignments.length === 0 && (
                                        <tr>
                                          <td className="p-3 text-gray-600" colSpan={7}>
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
                  )}
                </div>
              );
            })}

            {filteredEvents.length === 0 && <div className="text-sm text-gray-600">No events found.</div>}
          </div>
        </div>
      </div>

      {/* Sticky footer action bar */}
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-gray-200">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0 text-sm">
            {stickyHint ? (
              <div className="text-red-700 truncate">
                <span className="font-semibold">Fix:</span> {stickyHint}
              </div>
            ) : (
              <div className="text-gray-700 truncate">
                Ready to {editingEventId ? "save changes" : "create"} · Total slots: <b>{slots.length}</b>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <IconButton onClick={resetForm} title="Reset form">
              Reset
            </IconButton>
            <PrimaryButton onClick={createOrUpdateEvent} disabled={saving || validationErrors.length > 0}>
              {saving ? (editingEventId ? "Saving…" : "Creating…") : editingEventId ? "Save changes" : "Create Approved OT"}
            </PrimaryButton>
          </div>
        </div>
      </div>

      {/* Modals */}
      <TaskModal
        open={taskModalOpen}
        onClose={() => setTaskModalOpen(false)}
        selection={activeSlot?.selection || newSelection()}
        setSelection={(sel) => {
          if (!activeSlotTempId) return;
          updateSlot(activeSlotTempId, { selection: sel });
        }}
      />

      <UserPickerModal
        open={userModalOpen}
        onClose={() => setUserModalOpen(false)}
        users={users}
        selectedUserIds={activeSlot?.selectedUserIds || []}
        roleByUserId={activeSlot?.roleByUserId || {}}
        setSelectedUserIds={(ids) => {
          if (!activeSlotTempId) return;
          updateSlot(activeSlotTempId, { selectedUserIds: ids });
        }}
        setRoleByUserId={(m) => {
          if (!activeSlotTempId) return;
          updateSlot(activeSlotTempId, { roleByUserId: m });
        }}
      />
    </div>
  );
}

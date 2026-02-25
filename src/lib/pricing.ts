// src/lib/pricing.ts

export type WorkRole =
  | "JUNIOR_MARSHAL"
  | "SENIOR_MARSHAL"
  | "JUNIOR_EMCEE"
  | "SENIOR_EMCEE";

export type ClaimCode =
  | "EVENT_HOURLY"
  | "EVENT_HALF_DAY"
  | "EVENT_FULL_DAY"
  | "EVENT_2D1N"
  | "EVENT_3D2N";

export type TaskCode =
  | "BACKEND_RM15" // per hour
  | "EVENT_AFTER_6PM" // per hour (single amount)
  | "EARLY_CALLING_RM30" // flat
  | "LOADING_UNLOADING_RM30"; // flat

export type TaskSelection = {
  // base claim (0 or 1)
  claim: ClaimCode | null;

  // add-ons
  codes: TaskCode[];

  // optional note (stored inside modal, not main page)
  note?: string;

  /**
   * Editable base rates for CURRENT selected claim only.
   * - For EVENT_HOURLY: marshal rates are PER HOUR
   * - For others: flat amounts
   */
  baseRates?: Partial<{
    marshalJunior: string | number;
    marshalSenior: string | number;
    emceeJunior: string | number;
    emceeSenior: string | number;
  }>;

  /**
   * Editable add-on rates
   */
  addOnRates?: Partial<{
    backendPerHour: string | number; // default 15
    after6pmPerHour: string | number; // default 30 (admin can change to 20, etc)
    earlyCallingFlat: string | number; // default 30
    loadingUnloadingFlat: string | number; // default 30
  }>;

  /**
   * Optional custom line item (flat)
   */
  custom?: {
    enabled: boolean;
    label: string;
    amount: string | number; // RM
  };
};

export const WORK_ROLE_LABEL: Record<WorkRole, string> = {
  JUNIOR_MARSHAL: "Junior Marshal",
  SENIOR_MARSHAL: "Senior Marshal",
  JUNIOR_EMCEE: "Junior Emcee",
  SENIOR_EMCEE: "Senior Emcee",
};

export const CLAIM_LABEL: Record<ClaimCode, string> = {
  EVENT_HOURLY: "Event - Hourly",
  EVENT_HALF_DAY: "Event - Half Day",
  EVENT_FULL_DAY: "Event - Full Day",
  EVENT_2D1N: "Event - 2D1N",
  EVENT_3D2N: "Event - 3D2N",
};

export const TASK_LABEL: Record<TaskCode, string> = {
  BACKEND_RM15: "Backend (RM15/hr) — Annual Dinner / Karaoke / Packing / Set Up",
  EVENT_AFTER_6PM: "Event starts after 6PM (per hour)",
  EARLY_CALLING_RM30: "Early Calling (flat)",
  LOADING_UNLOADING_RM30: "Loading & Unloading (flat)",
};

function toNumber(v: unknown, fallback: number): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function hoursBetweenDates(start: Date, end: Date): number {
  let ms = end.getTime() - start.getTime();
  if (ms < 0) ms += 24 * 60 * 60 * 1000; // cross midnight
  return round2(ms / (1000 * 60 * 60));
}

export function rmToCents(rm: number): number {
  const n = toNumber(rm, 0);
  return Math.round(n * 100);
}

export function centsToRm(cents: unknown): string {
  const n = toNumber(cents, 0);
  return (n / 100).toFixed(2);
}

/** Defaults from your sheet */
const DEFAULT_BASE: Record<
  ClaimCode,
  { marshalJunior: number; marshalSenior: number; emceeJunior: number; emceeSenior: number; kind: "HOURLY" | "FLAT" }
> = {
  EVENT_HOURLY: { marshalJunior: 20, marshalSenior: 30, emceeJunior: 0, emceeSenior: 0, kind: "HOURLY" },
  EVENT_HALF_DAY: { marshalJunior: 80, marshalSenior: 100, emceeJunior: 44, emceeSenior: 88, kind: "FLAT" },
  EVENT_FULL_DAY: { marshalJunior: 150, marshalSenior: 180, emceeJunior: 88, emceeSenior: 168, kind: "FLAT" },
  EVENT_2D1N: { marshalJunior: 230, marshalSenior: 270, emceeJunior: 0, emceeSenior: 0, kind: "FLAT" },
  EVENT_3D2N: { marshalJunior: 300, marshalSenior: 350, emceeJunior: 0, emceeSenior: 0, kind: "FLAT" },
};

const DEFAULT_ADDON = {
  backendPerHour: 15,
  after6pmPerHour: 30, // admin can change to 20 if needed
  earlyCallingFlat: 30,
  loadingUnloadingFlat: 30,
};

export function resolveBaseRates(claim: ClaimCode, selection?: TaskSelection) {
  const d = DEFAULT_BASE[claim];
  const o = selection?.baseRates || {};
  return {
    kind: d.kind,
    marshalJunior: toNumber(o.marshalJunior, d.marshalJunior),
    marshalSenior: toNumber(o.marshalSenior, d.marshalSenior),
    emceeJunior: toNumber(o.emceeJunior, d.emceeJunior),
    emceeSenior: toNumber(o.emceeSenior, d.emceeSenior),
  };
}

export function resolveAddOnRates(selection?: TaskSelection) {
  const o = selection?.addOnRates || {};
  return {
    backendPerHour: toNumber(o.backendPerHour, DEFAULT_ADDON.backendPerHour),
    after6pmPerHour: toNumber(o.after6pmPerHour, DEFAULT_ADDON.after6pmPerHour),
    earlyCallingFlat: toNumber(o.earlyCallingFlat, DEFAULT_ADDON.earlyCallingFlat),
    loadingUnloadingFlat: toNumber(o.loadingUnloadingFlat, DEFAULT_ADDON.loadingUnloadingFlat),
  };
}

function isSeniorRole(workRole: WorkRole) {
  return workRole.startsWith("SENIOR");
}
function isMarshalRole(workRole: WorkRole) {
  return workRole.includes("MARSHAL");
}
function isEmceeRole(workRole: WorkRole) {
  return workRole.includes("EMCEE");
}

export function computeDefaultPayRM(args: {
  workRole: WorkRole | undefined | null; // guard
  start: Date;
  end: Date;
  selection: TaskSelection;
}): number {
  const workRole = (args.workRole || "JUNIOR_MARSHAL") as WorkRole;
  const { start, end, selection } = args;

  const hrs = hoursBetweenDates(start, end);
  const senior = isSeniorRole(workRole);
  const marshal = isMarshalRole(workRole);
  const emcee = isEmceeRole(workRole);

  let total = 0;

  // Base claim (optional)
  if (selection.claim) {
    const base = resolveBaseRates(selection.claim, selection);

    if (selection.claim === "EVENT_HOURLY") {
      if (marshal) total += hrs * (senior ? base.marshalSenior : base.marshalJunior);
    } else if (selection.claim === "EVENT_2D1N" || selection.claim === "EVENT_3D2N") {
      if (marshal) total += senior ? base.marshalSenior : base.marshalJunior;
    } else {
      // HALF/FULL day: marshal OR emcee
      if (marshal) total += senior ? base.marshalSenior : base.marshalJunior;
      if (emcee) total += senior ? base.emceeSenior : base.emceeJunior;
    }
  }

  // Add-ons
  const add = resolveAddOnRates(selection);
  const startsAfter6pm = start.getHours() >= 18;

  for (const code of selection.codes || []) {
    if (code === "BACKEND_RM15") total += hrs * add.backendPerHour;
    if (code === "EVENT_AFTER_6PM") total += (startsAfter6pm ? hrs : 0) * add.after6pmPerHour;
    if (code === "EARLY_CALLING_RM30") total += add.earlyCallingFlat;
    if (code === "LOADING_UNLOADING_RM30") total += add.loadingUnloadingFlat;
  }

  // Custom line item (flat)
  if (selection.custom?.enabled) {
    total += toNumber(selection.custom.amount, 0);
  }

  return round2(total);
}


export type PayBreakdownItem = {
  key: string;
  label: string; // e.g. "Event - Half Day"
  amountRM: number; // e.g. 80
};

export function computePayBreakdownRM(args: {
  workRole: WorkRole | undefined | null;
  start: Date;
  end: Date;
  selection: TaskSelection;
}): { hours: number; items: PayBreakdownItem[]; totalRM: number } {
  const workRole = (args.workRole || "JUNIOR_MARSHAL") as WorkRole;
  const { start, end, selection } = args;

  const hrs = hoursBetweenDates(start, end);
  const senior = isSeniorRole(workRole);
  const marshal = isMarshalRole(workRole);
  const emcee = isEmceeRole(workRole);

  const items: PayBreakdownItem[] = [];

  // --- Base claim (0 or 1)
  if (selection.claim) {
    const claim = selection.claim;
    const base = resolveBaseRates(claim, selection);

    if (claim === "EVENT_HOURLY") {
      // Marshal hourly only (per your defaults)
      if (marshal) {
        const rate = senior ? base.marshalSenior : base.marshalJunior;
        const amt = round2(hrs * rate);
        if (amt > 0) {
          items.push({
            key: "BASE",
            label: `${CLAIM_LABEL[claim]} (${hrs}h × RM${rate}/hr)`,
            amountRM: amt,
          });
        }
      }
    } else if (claim === "EVENT_2D1N" || claim === "EVENT_3D2N") {
      // Flat for marshal (emcee usually 0)
      if (marshal) {
        const amt = round2(senior ? base.marshalSenior : base.marshalJunior);
        if (amt > 0) {
          items.push({ key: "BASE", label: `${CLAIM_LABEL[claim]}`, amountRM: amt });
        }
      } else if (emcee) {
        const amt = round2(senior ? base.emceeSenior : base.emceeJunior);
        if (amt > 0) {
          items.push({ key: "BASE", label: `${CLAIM_LABEL[claim]}`, amountRM: amt });
        }
      }
    } else {
      // Half/Full day: marshal OR emcee
      if (marshal) {
        const amt = round2(senior ? base.marshalSenior : base.marshalJunior);
        if (amt > 0) items.push({ key: "BASE", label: `${CLAIM_LABEL[claim]}`, amountRM: amt });
      }
      if (emcee) {
        const amt = round2(senior ? base.emceeSenior : base.emceeJunior);
        if (amt > 0) items.push({ key: "BASE", label: `${CLAIM_LABEL[claim]}`, amountRM: amt });
      }
    }
  }

  // --- Add-ons
  const add = resolveAddOnRates(selection);
  const startsAfter6pm = start.getHours() >= 18;

  for (const code of selection.codes || []) {
    if (code === "BACKEND_RM15") {
      const amt = round2(hrs * add.backendPerHour);
      if (amt > 0) {
        items.push({
          key: "BACKEND",
          label: `Backend (${hrs}h × RM${add.backendPerHour}/hr)`,
          amountRM: amt,
        });
      }
    }

    if (code === "EVENT_AFTER_6PM") {
      const appliedHrs = startsAfter6pm ? hrs : 0;
      const amt = round2(appliedHrs * add.after6pmPerHour);
      if (amt > 0) {
        items.push({
          key: "AFTER6PM",
          label: `Event starts after 6PM (${appliedHrs}h × RM${add.after6pmPerHour}/hr)`,
          amountRM: amt,
        });
      }
    }

    if (code === "EARLY_CALLING_RM30") {
      const amt = round2(add.earlyCallingFlat);
      if (amt > 0) items.push({ key: "EARLY", label: "Early Calling", amountRM: amt });
    }

    if (code === "LOADING_UNLOADING_RM30") {
      const amt = round2(add.loadingUnloadingFlat);
      if (amt > 0) items.push({ key: "LOAD", label: "Loading & Unloading", amountRM: amt });
    }
  }

  // --- Custom line item
  if (selection.custom?.enabled) {
    const amt = round2(toNumber(selection.custom.amount, 0));
    if (amt > 0) {
      items.push({
        key: "CUSTOM",
        label: selection.custom.label?.trim() ? selection.custom.label.trim() : "Custom",
        amountRM: amt,
      });
    }
  }

  const totalRM = round2(items.reduce((s, i) => s + i.amountRM, 0));
  return { hours: hrs, items, totalRM };
}

export function formatPayBreakdownInline(items: PayBreakdownItem[]) {
  if (!items?.length) return "-";
  return items.map((i) => `${i.label} (RM${i.amountRM.toFixed(2)})`).join(" + ");
}

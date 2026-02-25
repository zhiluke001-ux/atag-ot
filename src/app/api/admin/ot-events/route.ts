// src/app/api/admin/ot-events/route.ts
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeDefaultPayRM, rmToCents } from "@/lib/pricing";
import type { TaskSelection, WorkRole, ClaimCode, TaskCode } from "@/lib/pricing";

export const runtime = "nodejs";

/** ---------- validators ---------- */
const WORK_ROLES: WorkRole[] = ["JUNIOR_MARSHAL", "SENIOR_MARSHAL", "JUNIOR_EMCEE", "SENIOR_EMCEE"];
const CLAIMS: (ClaimCode | null)[] = [null, "EVENT_HOURLY", "EVENT_HALF_DAY", "EVENT_FULL_DAY", "EVENT_2D1N", "EVENT_3D2N"];
const TASK_CODES: TaskCode[] = ["BACKEND_RM15", "EVENT_AFTER_6PM", "EARLY_CALLING_RM30", "LOADING_UNLOADING_RM30"];

function isWorkRole(x: any): x is WorkRole {
  return WORK_ROLES.includes(x);
}
function isClaim(x: any): x is ClaimCode | null {
  return CLAIMS.includes(x);
}
function isTaskCode(x: any): x is TaskCode {
  return TASK_CODES.includes(x);
}

function safeNumber(v: any): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function toDate(x: any): Date | null {
  const d = new Date(x);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const v = id.trim();
  return v ? v : null;
}

/**
 * Validate important bits only, keep the rest.
 */
function parseSelection(input: any): TaskSelection | null {
  if (!input || typeof input !== "object") return null;

  if (!isClaim(input.claim ?? null)) return null;

  const codes = Array.isArray(input.codes) ? input.codes : [];
  if (!codes.every(isTaskCode)) return null;

  return { ...input, claim: input.claim ?? null, codes } as TaskSelection;
}

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session || (session.user as any)?.role !== "ADMIN") return null;
  return session;
}

type SlotInput = {
  id?: string;
  index?: number;
  startTime: string;
  endTime: string;
  selection: any;
  assignments: { userId: string; workRole: any }[];
  overrides?: Record<string, any> | null;
};

function parseSlotsInput(body: any): SlotInput[] | null {
  const slotsRaw = body?.slots;
  if (!Array.isArray(slotsRaw) || slotsRaw.length === 0) return null;

  const out: SlotInput[] = [];
  for (let i = 0; i < slotsRaw.length; i++) {
    const s = slotsRaw[i];
    const start = toDate(s?.startTime);
    const end = toDate(s?.endTime);
    if (!start || !end) return null;
    if (!(end.getTime() > start.getTime())) return null;

    const sel = parseSelection(s?.selection);
    if (!sel) return null;

    const assignments = Array.isArray(s?.assignments) ? s.assignments : [];
    if (assignments.length === 0) return null;

    // de-dup by userId inside slot
    const seen = new Set<string>();
    const normalizedAssignments = assignments
      .map((a: any) => ({ userId: normalizeId(a?.userId), workRole: a?.workRole }))
      .filter((a: any) => a.userId && !seen.has(a.userId) && (seen.add(a.userId), true));

    if (normalizedAssignments.length === 0) return null;

    out.push({
      id: typeof s?.id === "string" && s.id.trim() ? s.id.trim() : undefined,
      index: typeof s?.index === "number" && Number.isFinite(s.index) ? s.index : i,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      selection: sel,
      assignments: normalizedAssignments as any,
      overrides: s?.overrides && typeof s.overrides === "object" ? s.overrides : null,
    });
  }

  return out;
}

/** ---------- handlers ---------- */
export async function GET() {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const raw = await prisma.otEvent.findMany({
    orderBy: { date: "desc" },
    include: {
      // new slots
      slots: {
        orderBy: [{ index: "asc" }, { startTime: "asc" }],
        include: {
          assignments: {
            select: {
              id: true,
              userId: true,
              workRole: true,
              status: true,
              amountDefault: true,
              amountOverride: true,
              paidAt: true,
              paidById: true,
              user: { select: { name: true, email: true } },
            },
            orderBy: { user: { name: "asc" } },
          },
        },
      },
      // legacy assignments (only those not linked to a slot)
      assignments: {
        where: { otSlotId: null },
        select: {
          id: true,
          userId: true,
          workRole: true,
          status: true,
          amountDefault: true,
          amountOverride: true,
          paidAt: true,
          paidById: true,
          user: { select: { name: true, email: true } },
        },
        orderBy: { user: { name: "asc" } },
      },
    },
  });

  // backfill old events: if no slots, return a pseudo-slot so UI can edit
  const events = raw.map((ev) => {
    const hasSlots = ev.slots && ev.slots.length > 0;
    if (hasSlots) {
      return {
        ...ev,
        // remove legacy assignments from top-level to avoid confusion
        assignments: undefined,
      };
    }

    const pseudoSlotId = `__legacy__${ev.id}`;
    const pseudo = {
      id: pseudoSlotId,
      index: 0,
      startTime: ev.startTime,
      endTime: ev.endTime,
      taskCodes: ev.taskCodes,
      assignments: ev.assignments || [],
    };

    return {
      ...ev,
      slots: [pseudo],
      assignments: undefined,
    };
  });

  return NextResponse.json({ events });
}

export async function POST(req: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    // robust adminId: session.user.id else fallback by email
    let adminId = (session.user as any)?.id as string | undefined;
    if (!adminId) {
      const email = session.user?.email;
      if (!email) return NextResponse.json({ error: "Missing session user email" }, { status: 400 });
      const admin = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      adminId = admin?.id;
    }
    if (!adminId) {
      return NextResponse.json({ error: "Missing adminId (ensure NextAuth session includes user.id)" }, { status: 400 });
    }

    const body = await req.json().catch(() => null);
    const project = typeof body?.project === "string" ? body.project.trim() : "";
    const remark = body?.remark ?? null;

    if (!project) return NextResponse.json({ error: "Missing project" }, { status: 400 });

    const slotsInput = parseSlotsInput(body);
    if (!slotsInput) return NextResponse.json({ error: "Missing/invalid slots (need at least 1 slot)" }, { status: 400 });

    // collect all userIds
    const allUserIds = Array.from(
      new Set(
        slotsInput.flatMap((s) => (s.assignments || []).map((a) => String(a.userId)))
      )
    );

    const users = await prisma.user.findMany({
      where: { id: { in: allUserIds } },
      select: { id: true, active: true, defaultWorkRole: true },
    });

    const found = new Map(users.map((u) => [u.id, u]));
    const missing = allUserIds.filter((id) => !found.has(id));
    if (missing.length) return NextResponse.json({ error: `Unknown userIds: ${missing.join(", ")}` }, { status: 400 });

    // compute event legacy min/max
    const slotStarts = slotsInput.map((s) => new Date(s.startTime));
    const slotEnds = slotsInput.map((s) => new Date(s.endTime));
    const minStart = new Date(Math.min(...slotStarts.map((d) => d.getTime())));
    const maxEnd = new Date(Math.max(...slotEnds.map((d) => d.getTime())));

    const eventDate = new Date(minStart);
    eventDate.setHours(0, 0, 0, 0);

    const firstSelection = parseSelection(slotsInput[0].selection)!;

    // build nested create for slots + assignments
    const slotCreates = slotsInput
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((s, idx) => {
        const sel = parseSelection(s.selection)!;
        const start = new Date(s.startTime);
        const end = new Date(s.endTime);

        const assignmentsCreate = (s.assignments || []).map((a) => {
          const userId = String(a.userId);
          const u = found.get(userId)!;
          if (!u.active) return null;

          const picked = isWorkRole(a.workRole) ? (a.workRole as WorkRole) : u.defaultWorkRole;
          if (!isWorkRole(picked)) return null;

          const rm = computeDefaultPayRM({ workRole: picked, start, end, selection: sel });
          const amountDefault = rmToCents(rm);

          const raw = (s.overrides || null)?.[userId];
          const overrideRM = raw === "" || raw === null || raw === undefined ? null : safeNumber(raw);
          const amountOverride = overrideRM === null ? null : rmToCents(overrideRM);

          return {
            otEventId: undefined, // will be linked via relation automatically
            userId,
            workRole: picked,
            amountDefault,
            amountOverride,
          };
        }).filter(Boolean) as any[];

        if (assignmentsCreate.length === 0) {
          // will be rejected later by prisma if empty; we error early
          throw new Error("A slot has no active users to assign");
        }

        return {
          index: typeof s.index === "number" ? s.index : idx,
          startTime: start,
          endTime: end,
          taskCodes: JSON.stringify(sel),
          assignments: {
            create: assignmentsCreate,
          },
        };
      });

    const created = await prisma.otEvent.create({
      data: {
        date: eventDate,
        project,
        startTime: minStart,
        endTime: maxEnd,
        taskCodes: JSON.stringify(firstSelection), // legacy compat
        remark: remark || null,
        createdById: adminId,
        slots: {
          create: slotCreates,
        },
      },
      select: { id: true },
    });

    return NextResponse.json({ ok: true, id: created.id });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500 });
  }
}

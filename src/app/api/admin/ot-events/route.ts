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

function utcDateOnlyFrom(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
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

function normalizeId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const v = id.trim();
  return v ? v : null;
}

/** ---------- NEW: slots parsing ---------- */
type SlotInput = {
  id?: string;
  index?: number;
  startTime: string;
  endTime: string;
  selection?: any;
  taskCodes?: string; // allow compat
  assignments?: { userId: string; workRole?: WorkRole; amountOverrideRM?: string | number | null }[];
};

function parseSlotSelection(slot: any): TaskSelection | null {
  if (slot?.selection) return parseSelection(slot.selection);
  if (typeof slot?.taskCodes === "string") {
    try {
      return parseSelection(JSON.parse(slot.taskCodes || "{}"));
    } catch {
      return null;
    }
  }
  return null;
}

export async function GET() {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const events = await prisma.otEvent.findMany({
    orderBy: { date: "desc" },
    include: {
      // Keep event.assignments for legacy fallback (old events w/o slots)
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
      slots: {
        orderBy: { index: "asc" },
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
    },
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
    const { project, taskNotes, remark, slots } = body || {};

    // ✅ NEW FLOW: multi-slot
    if (Array.isArray(slots) && slots.length > 0) {
      if (typeof project !== "string" || !project.trim()) {
        return NextResponse.json({ error: "Missing project" }, { status: 400 });
      }

      const parsedSlots: {
        index: number;
        start: Date;
        end: Date;
        selection: TaskSelection;
        assignments: { userId: string; workRole?: WorkRole; amountOverrideRM?: any }[];
      }[] = [];

      for (let i = 0; i < slots.length; i++) {
        const s: SlotInput = slots[i];
        const start = toDate(s?.startTime);
        const end = toDate(s?.endTime);
        if (!start || !end) return NextResponse.json({ error: `Invalid slot time at slot ${i + 1}` }, { status: 400 });
        if (end.getTime() <= start.getTime()) return NextResponse.json({ error: `Slot endTime must be after startTime (slot ${i + 1})` }, { status: 400 });

        const sel = parseSlotSelection(s);
        if (!sel) return NextResponse.json({ error: `Invalid selection at slot ${i + 1}` }, { status: 400 });

        const idx = Number.isFinite(Number(s?.index)) ? Number(s.index) : i;

        parsedSlots.push({
          index: idx,
          start,
          end,
          selection: sel,
          assignments: Array.isArray(s?.assignments) ? s.assignments : [],
        });
      }

      // normalize indices by UI order (0..n-1)
      parsedSlots.sort((a, b) => a.index - b.index);
      parsedSlots.forEach((s, i) => (s.index = i));

      const minStart = parsedSlots.reduce((m, s) => (s.start < m ? s.start : m), parsedSlots[0].start);
      const maxEnd = parsedSlots.reduce((m, s) => (s.end > m ? s.end : m), parsedSlots[0].end);
      const eventDate = utcDateOnlyFrom(minStart);

      // gather all userIds across slots
      const allUserIds: string[] = [];
      for (const sl of parsedSlots) {
        for (const a of sl.assignments || []) {
          const uid = normalizeId(a?.userId);
          if (uid) allUserIds.push(uid);
        }
      }
      const uniqueUserIds = Array.from(new Set(allUserIds));
      const users = uniqueUserIds.length
        ? await prisma.user.findMany({
            where: { id: { in: uniqueUserIds } },
            select: { id: true, active: true, defaultWorkRole: true },
          })
        : [];
      const found = new Map(users.map((u) => [u.id, u]));

      // validate userIds exist
      const missing = uniqueUserIds.filter((id) => !found.has(id));
      if (missing.length) return NextResponse.json({ error: `Unknown userIds: ${missing.join(", ")}` }, { status: 400 });

      const firstSel = parsedSlots[0].selection;

      const createdId = await prisma.$transaction(async (tx) => {
        // create event + slots (NO assignments nested)
        const created = await tx.otEvent.create({
          data: {
            date: eventDate,
            project: project.trim(),
            taskNotes: taskNotes || null,
            startTime: minStart,
            endTime: maxEnd,
            // legacy field (keep for backward compat): store slot0 selection
            taskCodes: JSON.stringify(firstSel),
            remark: remark || null,
            createdById: adminId!,
            slots: {
              create: parsedSlots.map((sl) => ({
                index: sl.index,
                startTime: sl.start,
                endTime: sl.end,
                taskCodes: JSON.stringify(sl.selection),
              })),
            },
          },
          select: {
            id: true,
            slots: { select: { id: true, index: true } },
          },
        });

        const slotIdByIndex = new Map(created.slots.map((s) => [s.index, s.id]));

        const assignmentsData: any[] = [];

        for (const sl of parsedSlots) {
          const slotId = slotIdByIndex.get(sl.index);
          if (!slotId) continue;

          // de-dup inside slot by userId
          const seen = new Set<string>();
          const normalizedAssigns = (sl.assignments || [])
            .map((a) => ({
              userId: normalizeId(a?.userId) || "",
              workRole: a?.workRole,
              amountOverrideRM: (a as any)?.amountOverrideRM,
            }))
            .filter((a) => a.userId && !seen.has(a.userId) && (seen.add(a.userId), true));

          for (const a of normalizedAssigns) {
            const u = found.get(a.userId)!;
            if (!u.active) continue;

            const picked = isWorkRole(a.workRole) ? (a.workRole as WorkRole) : u.defaultWorkRole;
            if (!isWorkRole(picked)) continue;

            const rm = computeDefaultPayRM({ workRole: picked, start: sl.start, end: sl.end, selection: sl.selection });
            const amountDefault = rmToCents(rm);

            const raw = a.amountOverrideRM;
            const overrideRM = raw === "" || raw === null || raw === undefined ? null : safeNumber(raw);
            const amountOverride = overrideRM === null ? null : rmToCents(overrideRM);

            assignmentsData.push({
              otEventId: created.id,
              otSlotId: slotId,
              userId: a.userId,
              workRole: picked,
              amountDefault,
              amountOverride,
            });
          }
        }

        if (assignmentsData.length === 0) {
          // No assignments at all -> rollback by throwing
          throw new Error("No assignments created. Please assign at least 1 person in at least 1 slot.");
        }

        await tx.otAssignment.createMany({ data: assignmentsData });

        return created.id;
      });

      return NextResponse.json({ ok: true, id: createdId });
    }

    // ✅ LEGACY FLOW (single slot) — keep old clients working
    const { date, startTime, endTime, selection, overrides, assignments, userIds, workRoles } = body || {};
    if (!date || !project || !startTime || !endTime) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }

    const start = toDate(startTime);
    const end = toDate(endTime);
    if (!start || !end) return NextResponse.json({ error: "Invalid startTime/endTime" }, { status: 400 });

    const sel = parseSelection(selection);
    if (!sel) return NextResponse.json({ error: "Invalid selection" }, { status: 400 });

    // normalize assignments
    let normalized: { userId: string; workRole: WorkRole }[] = [];
    if (Array.isArray(assignments) && assignments.length > 0) {
      normalized = assignments.map((a: any) => ({ userId: String(a?.userId || ""), workRole: a?.workRole }));
    } else if (Array.isArray(userIds) && userIds.length > 0) {
      normalized = userIds.map((id: any) => ({ userId: String(id), workRole: workRoles?.[id] }));
    } else {
      return NextResponse.json({ error: "No users selected" }, { status: 400 });
    }

    // de-dup
    const seen = new Set<string>();
    normalized = normalized.filter((a) => {
      if (!a.userId) return false;
      if (seen.has(a.userId)) return false;
      seen.add(a.userId);
      return true;
    });

    const ids = normalized.map((a) => a.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, active: true, defaultWorkRole: true },
    });

    const found = new Map(users.map((u) => [u.id, u]));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) return NextResponse.json({ error: `Unknown userIds: ${missing.join(", ")}` }, { status: 400 });

    const created = await prisma.otEvent.create({
      data: {
        date: utcDateOnlyFrom(start),
        project,
        taskNotes: taskNotes || null,
        startTime: start,
        endTime: end,
        taskCodes: JSON.stringify(sel),
        remark: remark || null,
        createdById: adminId,
      },
      select: { id: true },
    });

    const assignmentsData = normalized
      .map((a) => {
        const u = found.get(a.userId)!;
        if (!u.active) return null;

        const picked = isWorkRole(a.workRole) ? a.workRole : u.defaultWorkRole;
        if (!isWorkRole(picked)) return null;

        const rm = computeDefaultPayRM({ workRole: picked, start, end, selection: sel });
        const amountDefault = rmToCents(rm);

        const raw = overrides?.[a.userId];
        const overrideRM = raw === "" || raw === null || raw === undefined ? null : safeNumber(raw);
        const amountOverride = overrideRM === null ? null : rmToCents(overrideRM);

        return {
          otEventId: created.id,
          userId: a.userId,
          workRole: picked,
          amountDefault,
          amountOverride,
        };
      })
      .filter(Boolean) as any[];

    if (assignmentsData.length === 0) {
      await prisma.otEvent.delete({ where: { id: created.id } });
      return NextResponse.json({ error: "No active users to assign" }, { status: 400 });
    }

    await prisma.otAssignment.createMany({ data: assignmentsData });

    return NextResponse.json({ ok: true, id: created.id });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500 });
  }
}

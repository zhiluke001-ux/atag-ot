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

function parseDateInput(date: any): Date | null {
  if (typeof date !== "string") return null;

  const iso = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toDate(x: any): Date | null {
  const d = new Date(x);
  return Number.isNaN(d.getTime()) ? null : d;
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

function minDate(a: Date, b: Date) {
  return a.getTime() <= b.getTime() ? a : b;
}
function maxDate(a: Date, b: Date) {
  return a.getTime() >= b.getTime() ? a : b;
}

/** ---------- handlers ---------- */
export async function GET() {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const events = await prisma.otEvent.findMany({
    orderBy: { date: "desc" },
    include: {
      slots: {
        orderBy: { index: "asc" },
        include: {
          assignments: {
            select: {
              id: true,
              userId: true,
              otSlotId: true,
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
      // keep legacy include for compatibility (may duplicate slot assignments)
      assignments: {
        select: {
          id: true,
          userId: true,
          otSlotId: true,
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
    const {
      date,
      project,
      remark,

      // NEW (multi-slot)
      slots,

      // legacy support (single)
      taskNotes,
      startTime,
      endTime,
      selection,
      overrides,
      assignments,
      userIds,
      workRoles,
    } = body || {};

    if (!project || typeof project !== "string") {
      return NextResponse.json({ error: "Missing project" }, { status: 400 });
    }

    // ---- NEW multi-slot path ----
    if (Array.isArray(slots) && slots.length > 0) {
      // gather all users across all slots
      const allUserIds = new Set<string>();
      for (const sl of slots) {
        const asg = Array.isArray(sl?.assignments) ? sl.assignments : [];
        for (const a of asg) allUserIds.add(String(a?.userId || ""));
      }
      const ids = [...allUserIds].filter(Boolean);
      if (ids.length === 0) return NextResponse.json({ error: "No users selected" }, { status: 400 });

      const users = await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, active: true, defaultWorkRole: true },
      });
      const found = new Map(users.map((u) => [u.id, u]));
      const missing = ids.filter((id) => !found.has(id));
      if (missing.length) return NextResponse.json({ error: `Unknown userIds: ${missing.join(", ")}` }, { status: 400 });

      // validate slots and compute min/max for legacy fields
      let minStart: Date | null = null;
      let maxEnd: Date | null = null;

      const normalizedSlots = slots.map((sl: any, i: number) => {
        const st = toDate(sl?.startTime);
        const et = toDate(sl?.endTime);
        if (!st || !et) throw new Error(`Slot ${i + 1}: Invalid startTime/endTime`);
        if (et.getTime() <= st.getTime()) throw new Error(`Slot ${i + 1}: End must be later than start`);

        const sel = parseSelection(sl?.selection);
        if (!sel) throw new Error(`Slot ${i + 1}: Invalid selection`);

        const asg = Array.isArray(sl?.assignments) ? sl.assignments : [];
        if (asg.length === 0) throw new Error(`Slot ${i + 1}: No users selected`);

        // de-dup within slot by userId
        const seen = new Set<string>();
        const normalizedAsg: { userId: string; workRole: WorkRole }[] = asg
          .map((a: any) => ({ userId: String(a?.userId || ""), workRole: a?.workRole }))
          .filter((a) => a.userId && !seen.has(a.userId) && (seen.add(a.userId), true));

        const ov = (sl?.overrides && typeof sl.overrides === "object") ? sl.overrides : {};

        minStart = minStart ? minDate(minStart, st) : st;
        maxEnd = maxEnd ? maxDate(maxEnd, et) : et;

        return {
          index: Number.isFinite(sl?.index) ? Number(sl.index) : i,
          start: st,
          end: et,
          selection: sel,
          assignments: normalizedAsg,
          overrides: ov as Record<string, any>,
        };
      });

      // event date: prefer provided date else minStart date
      const eventDate = date ? parseDateInput(date) : (minStart ? new Date(`${minStart.toISOString().slice(0, 10)}T00:00:00`) : null);
      if (!eventDate) return NextResponse.json({ error: "Invalid date" }, { status: 400 });
      if (!minStart || !maxEnd) return NextResponse.json({ error: "Invalid slots" }, { status: 400 });

      // legacy taskCodes: use first slot selection for backward compat
      const legacyTaskCodes = JSON.stringify(normalizedSlots[0].selection);

      const created = await prisma.$transaction(async (tx) => {
        const ev = await tx.otEvent.create({
          data: {
            date: eventDate,
            project,
            taskNotes: taskNotes || null,
            startTime: minStart!,
            endTime: maxEnd!,
            taskCodes: legacyTaskCodes,
            remark: remark || null,
            createdById: adminId!,
          },
          select: { id: true },
        });

        for (let i = 0; i < normalizedSlots.length; i++) {
          const sl = normalizedSlots[i];

          const slotRow = await tx.otSlot.create({
            data: {
              otEventId: ev.id,
              index: i,
              startTime: sl.start,
              endTime: sl.end,
              taskCodes: JSON.stringify(sl.selection),
            },
            select: { id: true },
          });

          const assignmentsData = sl.assignments
            .map((a) => {
              const u = found.get(a.userId)!;
              if (!u.active) return null;

              const picked = isWorkRole(a.workRole) ? a.workRole : u.defaultWorkRole;
              if (!isWorkRole(picked)) return null;

              const rm = computeDefaultPayRM({ workRole: picked, start: sl.start, end: sl.end, selection: sl.selection });
              const amountDefault = rmToCents(rm);

              const raw = sl.overrides?.[a.userId];
              const overrideRM = raw === "" || raw === null || raw === undefined ? null : safeNumber(raw);
              const amountOverride = overrideRM === null ? null : rmToCents(overrideRM);

              return {
                otEventId: ev.id,
                otSlotId: slotRow.id,
                userId: a.userId,
                workRole: picked,
                amountDefault,
                amountOverride,
              };
            })
            .filter(Boolean) as any[];

          if (assignmentsData.length === 0) {
            throw new Error(`Slot ${i + 1}: No active users to assign`);
          }

          await tx.otAssignment.createMany({ data: assignmentsData });
        }

        return ev;
      });

      return NextResponse.json({ ok: true, id: created.id });
    }

    // ---- LEGACY single-slot path (still supported) ----
    if (!date || !startTime || !endTime) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }

    const eventDate = parseDateInput(date);
    if (!eventDate) return NextResponse.json({ error: "Invalid date" }, { status: 400 });

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

    const created = await prisma.$transaction(async (tx) => {
      const ev = await tx.otEvent.create({
        data: {
          date: eventDate,
          project,
          taskNotes: taskNotes || null,
          startTime: start,
          endTime: end,
          taskCodes: JSON.stringify(sel),
          remark: remark || null,
          createdById: adminId!,
        },
        select: { id: true },
      });

      // create a slot[0] for legacy event so otSlotId is always populated
      const slot0 = await tx.otSlot.create({
        data: {
          otEventId: ev.id,
          index: 0,
          startTime: start,
          endTime: end,
          taskCodes: JSON.stringify(sel),
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
            otEventId: ev.id,
            otSlotId: slot0.id,
            userId: a.userId,
            workRole: picked,
            amountDefault,
            amountOverride,
          };
        })
        .filter(Boolean) as any[];

      if (assignmentsData.length === 0) throw new Error("No active users to assign");

      await tx.otAssignment.createMany({ data: assignmentsData });

      return ev;
    });

    return NextResponse.json({ ok: true, id: created.id });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500 });
  }
}

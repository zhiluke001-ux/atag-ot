// src/app/api/admin/ot-events/[id]/route.ts
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

  const claim = input.claim ?? null;
  const codes = Array.isArray(input.codes) ? input.codes : [];

  if (!isClaim(claim)) return null;
  if (!codes.every(isTaskCode)) return null;

  return { ...input, claim, codes } as TaskSelection;
}

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session || (session.user as any)?.role !== "ADMIN") return null;
  return session;
}

function getId(params: any): string | null {
  const id = params?.id;
  if (typeof id !== "string" || !id.trim()) return null;
  return id;
}

/**
 * Recompute assignment amountDefault for a given event time/selection/role.
 * Note: status/paidAt not touched here.
 */
async function recomputeAllAssignmentsForEvent(args: {
  eventId: string;
  start: Date;
  end: Date;
  selection: TaskSelection;
  overrides?: Record<string, any> | null;
  assignments?: { userId: string; workRole: WorkRole }[] | null;
}) {
  const { eventId, start, end, selection, overrides, assignments } = args;

  // Load existing
  const existing = await prisma.otAssignment.findMany({
    where: { otEventId: eventId },
    select: { id: true, userId: true, workRole: true, status: true, amountOverride: true },
  });

  // If UI passed assignments list: sync membership + role
  // Otherwise keep existing membership/roles and only recompute by their current role.
  const syncList = Array.isArray(assignments) ? assignments : null;

  if (syncList) {
    // de-dup by userId
    const seen = new Set<string>();
    const normalized = syncList
      .map((a) => ({ userId: String((a as any)?.userId || ""), workRole: (a as any)?.workRole }))
      .filter((a) => a.userId && !seen.has(a.userId) && (seen.add(a.userId), true));

    // validate + fetch users for defaults
    const ids = normalized.map((x) => x.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, active: true, defaultWorkRole: true },
    });
    const found = new Map(users.map((u) => [u.id, u]));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw new Error(`Unknown userIds: ${missing.join(", ")}`);

    // delete assignments removed from list
    const keepIds = new Set(ids);
    const toDelete = existing.filter((a) => !keepIds.has(a.userId)).map((a) => a.id);
    if (toDelete.length) {
      await prisma.otAssignment.deleteMany({ where: { id: { in: toDelete } } });
    }

    // upsert each selected user assignment
    for (const x of normalized) {
      const u = found.get(x.userId)!;
      if (!u.active) continue;

      const rolePicked = isWorkRole(x.workRole) ? x.workRole : u.defaultWorkRole;
      if (!isWorkRole(rolePicked)) continue;

      const defaultRM = computeDefaultPayRM({ workRole: rolePicked, start, end, selection });
      const amountDefault = rmToCents(defaultRM);

      const raw = overrides?.[x.userId];
      const overrideRM = raw === "" || raw === null || raw === undefined ? null : safeNumber(raw);
      const amountOverride = overrideRM === null ? null : rmToCents(overrideRM);

      const existRow = existing.find((a) => a.userId === x.userId);
      if (!existRow) {
        await prisma.otAssignment.create({
          data: {
            otEventId: eventId,
            userId: x.userId,
            workRole: rolePicked,
            amountDefault,
            amountOverride,
          },
        });
      } else {
        // keep PAID/UNPAID status as-is, only adjust role + default + override
        await prisma.otAssignment.update({
          where: { id: existRow.id },
          data: {
            workRole: rolePicked,
            amountDefault,
            amountOverride,
          },
        });
      }
    }

    return;
  }

  // No syncList: just recompute amountDefault for existing assignments (role stays same).
  for (const a of existing) {
    const rolePicked = a.workRole;
    if (!isWorkRole(rolePicked)) continue;

    const defaultRM = computeDefaultPayRM({ workRole: rolePicked, start, end, selection });
    const amountDefault = rmToCents(defaultRM);

    // allow updating overrides by userId if passed
    let amountOverride: number | null = a.amountOverride ?? null;
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, a.userId)) {
      const raw = overrides?.[a.userId];
      const overrideRM = raw === "" || raw === null || raw === undefined ? null : safeNumber(raw);
      amountOverride = overrideRM === null ? null : rmToCents(overrideRM);
    }

    await prisma.otAssignment.update({
      where: { id: a.id },
      data: { amountDefault, amountOverride },
    });
  }
}

/** ---------- handlers ---------- */
export async function PATCH(req: Request, ctx: { params: { id: string } }) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const id = getId(ctx?.params);
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    const body = await req.json().catch(() => null);
    const {
      date,
      project,
      taskNotes,
      startTime,
      endTime,
      remark,
      selection,
      overrides,
      assignments, // optional: allow syncing membership/roles
    } = body || {};

    // load existing event to allow partial updates
    const existing = await prisma.otEvent.findUnique({ where: { id }, select: { id: true, date: true, startTime: true, endTime: true, taskCodes: true } });
    if (!existing) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    // determine next values (partial update supported)
    const nextDate = date ? parseDateInput(date) : existing.date;
    if (!nextDate) return NextResponse.json({ error: "Invalid date" }, { status: 400 });

    const nextStart = startTime ? toDate(startTime) : existing.startTime;
    const nextEnd = endTime ? toDate(endTime) : existing.endTime;
    if (!nextStart || !nextEnd) return NextResponse.json({ error: "Invalid startTime/endTime" }, { status: 400 });

    const selObj = selection ? parseSelection(selection) : parseSelection(JSON.parse(existing.taskCodes || "{}"));
    if (!selObj) return NextResponse.json({ error: "Invalid selection" }, { status: 400 });

    // update event
    await prisma.otEvent.update({
      where: { id },
      data: {
        date: nextDate,
        project: typeof project === "string" ? project : undefined,
        taskNotes: taskNotes === undefined ? undefined : taskNotes || null,
        startTime: nextStart,
        endTime: nextEnd,
        taskCodes: JSON.stringify(selObj),
        remark: remark === undefined ? undefined : remark || null,
      },
    });

    // recompute assignments (and optionally sync list)
    const syncAssignments = Array.isArray(assignments)
      ? assignments.map((a: any) => ({ userId: String(a?.userId || ""), workRole: a?.workRole }))
      : null;

    await recomputeAllAssignmentsForEvent({
      eventId: id,
      start: nextStart,
      end: nextEnd,
      selection: selObj,
      overrides: overrides || null,
      assignments: syncAssignments,
    });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: { params: { id: string } }) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const id = getId(ctx?.params);
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    // ensure exists
    const ev = await prisma.otEvent.findUnique({ where: { id }, select: { id: true } });
    if (!ev) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    // delete children first
    await prisma.otAssignment.deleteMany({ where: { otEventId: id } });
    await prisma.otEvent.delete({ where: { id } });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500 });
  }
}

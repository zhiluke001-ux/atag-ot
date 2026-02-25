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

function isWorkRole(x: unknown): x is WorkRole {
  return WORK_ROLES.includes(x as WorkRole);
}
function isClaim(x: unknown): x is ClaimCode | null {
  return CLAIMS.includes(x as any);
}
function isTaskCode(x: unknown): x is TaskCode {
  return TASK_CODES.includes(x as TaskCode);
}

function safeNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseDateInput(date: unknown): Date | null {
  if (typeof date !== "string") return null;

  const iso = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toDate(x: unknown): Date | null {
  const d = new Date(x as any);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Validate important bits only, keep the rest.
 */
function parseSelection(input: unknown): TaskSelection | null {
  if (!input || typeof input !== "object") return null;

  const obj = input as any;

  if (!isClaim(obj.claim ?? null)) return null;

  const codes = Array.isArray(obj.codes) ? obj.codes : [];
  if (!codes.every(isTaskCode)) return null;

  return { ...obj, claim: obj.claim ?? null, codes } as TaskSelection;
}

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session || (session.user as any)?.role !== "ADMIN") return null;
  return session;
}

/** ---------- handlers ---------- */
export async function GET() {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const events = await prisma.otEvent.findMany({
    orderBy: { date: "desc" },
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
  });

  return NextResponse.json({ events });
}

export async function POST(req: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
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

    const body = (await req.json().catch(() => null)) as any;
    const {
      date,
      project,
      taskNotes,
      startTime,
      endTime,
      remark,
      selection,
      overrides,
      assignments, // NEW UI
      userIds, // compat
      workRoles, // compat
    } = body || {};

    if (!date || !project || !startTime || !endTime) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }

    const eventDate = parseDateInput(date);
    if (!eventDate) return NextResponse.json({ error: "Invalid date" }, { status: 400 });

    const start = toDate(startTime);
    const end = toDate(endTime);
    if (!start || !end) return NextResponse.json({ error: "Invalid startTime/endTime" }, { status: 400 });

    const sel = parseSelection(selection);
    if (!sel) return NextResponse.json({ error: "Invalid selection" }, { status: 400 });

    let normalized: { userId: string; workRole: unknown }[] = [];
    if (Array.isArray(assignments) && assignments.length > 0) {
      normalized = assignments.map((a: any) => ({ userId: String(a?.userId || ""), workRole: a?.workRole }));
    } else if (Array.isArray(userIds) && userIds.length > 0) {
      normalized = userIds.map((id: any) => ({ userId: String(id), workRole: workRoles?.[id] }));
    } else {
      return NextResponse.json({ error: "No users selected" }, { status: 400 });
    }

    const seen = new Set<string>();
    normalized = normalized.filter((x) => {
      const uid = String(x.userId || "").trim();
      if (!uid) return false;
      if (seen.has(uid)) return false;
      seen.add(uid);
      x.userId = uid;
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
        date: eventDate,
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

        const picked = isWorkRole(a.workRole) ? (a.workRole as WorkRole) : u.defaultWorkRole;
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

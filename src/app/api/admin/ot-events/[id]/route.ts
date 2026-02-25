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

type SlotPatchInput = {
  id?: string;
  index?: number;
  startTime: string;
  endTime: string;
  selection: any;
  assignments: { userId: string; workRole: any }[];
  overrides?: Record<string, any> | null;
};

function parseSlots(body: any): SlotPatchInput[] | null {
  const slotsRaw = body?.slots;
  if (!Array.isArray(slotsRaw) || slotsRaw.length === 0) return null;

  const out: SlotPatchInput[] = [];
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

    const seen = new Set<string>();
    const normalizedAssignments = assignments
      .map((a: any) => ({ userId: normalizeId(a?.userId), workRole: a?.workRole }))
      .filter((a: any) => a.userId && !seen.has(a.userId) && (seen.add(a.userId), true));

    if (normalizedAssignments.length === 0) return null;

    const slotId = typeof s?.id === "string" && s.id.trim() ? s.id.trim() : undefined;

    out.push({
      id: slotId,
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
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: rawId } = await params;
  const eventId = normalizeId(rawId);
  if (!eventId) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    const body = await req.json().catch(() => null);

    const project = body?.project;
    const remark = body?.remark;

    const slotsInput = parseSlots(body);
    if (!slotsInput) return NextResponse.json({ error: "Missing/invalid slots (need at least 1 slot)" }, { status: 400 });

    // collect all userIds across slots
    const allUserIds = Array.from(new Set(slotsInput.flatMap((s) => s.assignments.map((a) => String(a.userId)))));

    const users = await prisma.user.findMany({
      where: { id: { in: allUserIds } },
      select: { id: true, active: true, defaultWorkRole: true },
    });
    const found = new Map(users.map((u) => [u.id, u]));
    const missing = allUserIds.filter((id) => !found.has(id));
    if (missing.length) return NextResponse.json({ error: `Unknown userIds: ${missing.join(", ")}` }, { status: 400 });

    // We use interactive transaction so slot+assignment sync stays consistent
    await prisma.$transaction(async (tx) => {
      const existingEvent = await tx.otEvent.findUnique({
        where: { id: eventId },
        select: { id: true },
      });
      if (!existingEvent) throw new Error("Event not found");

      const existingSlots = await tx.otSlot.findMany({
        where: { otEventId: eventId },
        select: { id: true },
      });
      const existingSlotIds = new Set(existingSlots.map((s) => s.id));

      // Upsert slots and keep mapping of payload -> real slot id
      const keepIds = new Set<string>();
      const payloadSorted = slotsInput.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const resolvedSlots: { slotId: string; input: SlotPatchInput }[] = [];

      for (let i = 0; i < payloadSorted.length; i++) {
        const s = payloadSorted[i];
        const start = new Date(s.startTime);
        const end = new Date(s.endTime);
        const sel = parseSelection(s.selection)!;

        const idx = typeof s.index === "number" ? s.index : i;

        // if slot id exists and belongs to this event -> update
        if (s.id && existingSlotIds.has(s.id)) {
          await tx.otSlot.update({
            where: { id: s.id },
            data: {
              index: idx,
              startTime: start,
              endTime: end,
              taskCodes: JSON.stringify(sel),
            },
          });
          keepIds.add(s.id);
          resolvedSlots.push({ slotId: s.id, input: s });
        } else {
          // create new slot
          const created = await tx.otSlot.create({
            data: {
              otEventId: eventId,
              index: idx,
              startTime: start,
              endTime: end,
              taskCodes: JSON.stringify(sel),
            },
            select: { id: true },
          });
          keepIds.add(created.id);
          resolvedSlots.push({ slotId: created.id, input: s });
        }
      }

      // delete removed slots (cascade deletes their assignments)
      const toDelete = existingSlots.filter((s) => !keepIds.has(s.id)).map((s) => s.id);
      if (toDelete.length) {
        await tx.otSlot.deleteMany({ where: { id: { in: toDelete } } });
      }

      // sync assignments per slot
      for (const rs of resolvedSlots) {
        const slotId = rs.slotId;
        const input = rs.input;

        const start = new Date(input.startTime);
        const end = new Date(input.endTime);
        const sel = parseSelection(input.selection)!;

        const existingAssignments = await tx.otAssignment.findMany({
          where: { otEventId: eventId, otSlotId: slotId },
          select: { id: true, userId: true, workRole: true, status: true, amountOverride: true },
        });
        const existByUser = new Map(existingAssignments.map((a) => [a.userId, a]));

        const desiredUserIds = new Set(input.assignments.map((a) => String(a.userId)));

        // delete removed assignments
        const removeIds = existingAssignments.filter((a) => !desiredUserIds.has(a.userId)).map((a) => a.id);
        if (removeIds.length) {
          await tx.otAssignment.deleteMany({ where: { id: { in: removeIds } } });
        }

        // upsert desired assignments
        for (const a of input.assignments) {
          const userId = String(a.userId);
          const u = found.get(userId)!;
          if (!u.active) continue;

          const picked = isWorkRole(a.workRole) ? (a.workRole as WorkRole) : u.defaultWorkRole;
          if (!isWorkRole(picked)) continue;

          const rm = computeDefaultPayRM({ workRole: picked, start, end, selection: sel });
          const amountDefault = rmToCents(rm);

          const raw = (input.overrides || null)?.[userId];
          const overrideRM = raw === "" || raw === null || raw === undefined ? null : safeNumber(raw);
          const amountOverride = overrideRM === null ? null : rmToCents(overrideRM);

          const exist = existByUser.get(userId);

          if (!exist) {
            await tx.otAssignment.create({
              data: {
                otEventId: eventId,
                otSlotId: slotId,
                userId,
                workRole: picked,
                amountDefault,
                amountOverride,
              },
            });
          } else {
            // keep status/paid fields untouched; update role/default/override
            await tx.otAssignment.update({
              where: { id: exist.id },
              data: {
                workRole: picked,
                amountDefault,
                amountOverride,
              },
            });
          }
        }
      }

      // update legacy fields on event (min/max + first slot taskCodes) + event-level project/remark
      const latestSlots = await tx.otSlot.findMany({
        where: { otEventId: eventId },
        select: { id: true, startTime: true, endTime: true, taskCodes: true, index: true },
        orderBy: [{ index: "asc" }, { startTime: "asc" }],
      });
      if (!latestSlots.length) throw new Error("Event must have at least 1 slot");

      const minStart = new Date(Math.min(...latestSlots.map((s) => s.startTime.getTime())));
      const maxEnd = new Date(Math.max(...latestSlots.map((s) => s.endTime.getTime())));
      const eventDate = new Date(minStart);
      eventDate.setHours(0, 0, 0, 0);

      await tx.otEvent.update({
        where: { id: eventId },
        data: {
          project: typeof project === "string" ? project : undefined,
          remark: remark === undefined ? undefined : remark || null,

          date: eventDate,
          startTime: minStart,
          endTime: maxEnd,
          taskCodes: latestSlots[0].taskCodes, // legacy compat uses first slot
        },
      });
    });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: rawId } = await params;
  const eventId = normalizeId(rawId);
  if (!eventId) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    const ev = await prisma.otEvent.findUnique({ where: { id: eventId }, select: { id: true } });
    if (!ev) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    // cascade should handle slots + assignments (both relations have onDelete: Cascade)
    await prisma.otEvent.delete({ where: { id: eventId } });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500 });
  }
}

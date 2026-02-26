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
const TASK_CODES: TaskCode[] = ["BACKEND_RM15", "EVENT_AFTER_6PM", "EARLY_CALLING_RM30", "LOADING_UNLOADING_RM30", "GOOGLE_REVIEW_RM10"];

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

type SlotPatchInput = {
  id?: string;
  index?: number;
  startTime: string;
  endTime: string;
  selection?: any;
  taskCodes?: string;
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

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: rawId } = await params;
  const id = normalizeId(rawId);
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    const body = await req.json().catch(() => null);
    const { project, taskNotes, remark, slots } = body || {};

    // ✅ NEW: multi-slot update
    if (Array.isArray(slots) && slots.length > 0) {
      const existing = await prisma.otEvent.findUnique({
        where: { id },
        include: {
          slots: {
            include: {
              assignments: {
                select: {
                  id: true,
                  userId: true,
                  status: true,
                  workRole: true,
                  amountDefault: true,
                  amountOverride: true,
                },
              },
            },
          },
        },
      });
      if (!existing) return NextResponse.json({ error: "Event not found" }, { status: 404 });

      if (typeof project !== "string" || !project.trim()) {
        return NextResponse.json({ error: "Missing project" }, { status: 400 });
      }

      const parsedSlots: {
        id?: string;
        index: number;
        start: Date;
        end: Date;
        selection: TaskSelection;
        assignments: { userId: string; workRole?: WorkRole; amountOverrideRM?: any }[];
      }[] = [];

      for (let i = 0; i < slots.length; i++) {
        const s: SlotPatchInput = slots[i];
        const start = toDate(s?.startTime);
        const end = toDate(s?.endTime);
        if (!start || !end) return NextResponse.json({ error: `Invalid slot time at slot ${i + 1}` }, { status: 400 });
        if (end.getTime() <= start.getTime()) return NextResponse.json({ error: `Slot endTime must be after startTime (slot ${i + 1})` }, { status: 400 });

        const sel = parseSlotSelection(s);
        if (!sel) return NextResponse.json({ error: `Invalid selection at slot ${i + 1}` }, { status: 400 });

        const idx = Number.isFinite(Number(s?.index)) ? Number(s.index) : i;
        const slotId = s?.id ? normalizeId(s.id) || undefined : undefined;

        parsedSlots.push({
          id: slotId,
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
      const missing = uniqueUserIds.filter((x) => !found.has(x));
      if (missing.length) return NextResponse.json({ error: `Unknown userIds: ${missing.join(", ")}` }, { status: 400 });

      const existingSlotsById = new Map(existing.slots.map((s) => [s.id, s]));

      await prisma.$transaction(async (tx) => {
        // 1) Upsert slots
        const keptSlotIds: string[] = [];
        const slotIdByIndex = new Map<number, string>();

        for (const sl of parsedSlots) {
          if (sl.id && existingSlotsById.has(sl.id)) {
            await tx.otSlot.update({
              where: { id: sl.id },
              data: {
                index: sl.index,
                startTime: sl.start,
                endTime: sl.end,
                taskCodes: JSON.stringify(sl.selection),
              },
            });
            keptSlotIds.push(sl.id);
            slotIdByIndex.set(sl.index, sl.id);
          } else {
            const createdSlot = await tx.otSlot.create({
              data: {
                otEventId: id,
                index: sl.index,
                startTime: sl.start,
                endTime: sl.end,
                taskCodes: JSON.stringify(sl.selection),
              },
              select: { id: true },
            });
            keptSlotIds.push(createdSlot.id);
            slotIdByIndex.set(sl.index, createdSlot.id);

            // patch local id so assignment sync can use it
            sl.id = createdSlot.id;
          }
        }

        // 2) Delete removed slots (cascade delete assignments)
        const toDelete = existing.slots.filter((s) => !keptSlotIds.includes(s.id)).map((s) => s.id);
        if (toDelete.length) {
          await tx.otSlot.deleteMany({ where: { id: { in: toDelete } } });
        }

        // 3) Sync assignments per slot
        for (const sl of parsedSlots) {
          const slotId = sl.id || slotIdByIndex.get(sl.index);
          if (!slotId) continue;

          const existingSlot = existingSlotsById.get(slotId);
          const existingAssignments = existingSlot?.assignments || [];

          const existingByUser = new Map(existingAssignments.map((a) => [a.userId, a]));

          // de-dup payload by userId
          const seen = new Set<string>();
          const normalizedAssigns = (sl.assignments || [])
            .map((a) => ({
              userId: normalizeId(a?.userId) || "",
              workRole: a?.workRole,
              amountOverrideRM: (a as any)?.amountOverrideRM,
            }))
            .filter((a) => a.userId && !seen.has(a.userId) && (seen.add(a.userId), true));

          const keepUserIds = new Set(normalizedAssigns.map((a) => a.userId));

          // remove UNPAID ones not in payload (keep PAID)
          const removeIds = existingAssignments
            .filter((a) => !keepUserIds.has(a.userId) && a.status !== "PAID")
            .map((a) => a.id);

          if (removeIds.length) {
            await tx.otAssignment.deleteMany({ where: { id: { in: removeIds } } });
          }

          // upsert
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

            const existRow = existingByUser.get(a.userId);

            if (!existRow) {
              await tx.otAssignment.create({
                data: {
                  otEventId: id,
                  otSlotId: slotId,
                  userId: a.userId,
                  workRole: picked,
                  amountDefault,
                  amountOverride,
                },
              });
            } else {
              // ✅ safety: do not mutate PAID rows automatically
              if (existRow.status === "PAID") continue;

              await tx.otAssignment.update({
                where: { id: existRow.id },
                data: {
                  workRole: picked,
                  amountDefault,
                  amountOverride,
                },
              });
            }
          }
        }

        // 4) Update event (min/max time + legacy taskCodes from slot0)
        const slot0 = parsedSlots[0];
        await tx.otEvent.update({
          where: { id },
          data: {
            date: eventDate,
            project: project.trim(),
            taskNotes: taskNotes === undefined ? undefined : taskNotes || null,
            remark: remark === undefined ? undefined : remark || null,
            startTime: minStart,
            endTime: maxEnd,
            taskCodes: JSON.stringify(slot0.selection),
          },
        });
      });

      return NextResponse.json({ ok: true });
    }

    // ✅ LEGACY PATCH (your old logic can stay, but simplest is reject if no slots)
    return NextResponse.json(
      { error: "This event expects slots[]. Please update using slots payload." },
      { status: 400 }
    );
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: rawId } = await params;
  const id = normalizeId(rawId);
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    const ev = await prisma.otEvent.findUnique({ where: { id }, select: { id: true } });
    if (!ev) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    // delete children first (slots cascade assignments too, but keep explicit delete for safety)
    await prisma.otAssignment.deleteMany({ where: { otEventId: id } });
    await prisma.otSlot.deleteMany({ where: { otEventId: id } });
    await prisma.otEvent.delete({ where: { id } });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500 });
  }
}

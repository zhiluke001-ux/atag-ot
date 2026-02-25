import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computePayBreakdownRM } from "@/lib/pricing";
import type { TaskSelection, WorkRole } from "@/lib/pricing";

export const runtime = "nodejs";

function toCents(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  const n = Number(v);
  if (Number.isFinite(n)) {
    if (n < 1000 && String(v).includes(".")) return Math.round(n * 100);
    return Math.round(n);
  }
  return 0;
}

function safeParseSelection(taskCodes: any): TaskSelection {
  try {
    const j = JSON.parse(typeof taskCodes === "string" ? taskCodes : "{}");
    return {
      claim: j?.claim ?? null,
      codes: Array.isArray(j?.codes) ? j.codes : [],
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

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Prefer session.user.id, fallback by email (in case id not injected yet)
  let userId = (session.user as any)?.id as string | undefined;
  if (!userId && session.user?.email) {
    const u = await prisma.user.findUnique({ where: { email: session.user.email }, select: { id: true } });
    userId = u?.id;
  }
  if (!userId) return NextResponse.json({ error: "Unauthorized (missing userId)" }, { status: 401 });

  const rows = await prisma.otAssignment.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: {
      otEvent: {
        select: {
          date: true,
          project: true,
          startTime: true,
          endTime: true,
          remark: true,
          taskCodes: true, // ✅ add this
        },
      },
    },
  });

  const assignments = rows.map((r) => {
    const def = toCents((r as any).amountDefault);
    const ov = (r as any).amountOverride === null ? null : toCents((r as any).amountOverride);
    const effective = ov ?? def;

    const selection = safeParseSelection((r as any).otEvent?.taskCodes);
    const start = new Date((r as any).otEvent.startTime);
    const end = new Date((r as any).otEvent.endTime);

    const breakdown = computePayBreakdownRM({
      workRole: r.workRole as WorkRole,
      start,
      end,
      selection,
    });

    return {
      id: r.id,
      status: r.status,
      workRole: r.workRole,
      amountDefaultCents: def,
      amountOverrideCents: ov,
      effectiveCents: effective,
      paidAt: r.paidAt,
      otEvent: r.otEvent,
      taskBreakdown: breakdown, // ✅ { items, totalRM, hours }
    };
  });

  return NextResponse.json({ assignments });
}

// src/app/api/admin/assignments/[id]/route.ts
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

async function getId(ctx: { params: any }) {
  const p = await Promise.resolve(ctx.params);
  return p?.id as string | undefined;
}

export async function PATCH(req: Request, ctx: { params: any }) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const id = await getId(ctx);
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const body = await req.json().catch(() => null);
  const { status, amountOverrideRM } = body || {};

  const data: any = {};

  if (status === "PAID") {
    data.status = "PAID";
    data.paidAt = new Date();
    data.paidById = (session.user as any)?.id || null;
  } else if (status === "UNPAID") {
    data.status = "UNPAID";
    data.paidAt = null;
    data.paidById = null;
  }

  if (amountOverrideRM !== undefined) {
    if (amountOverrideRM === null || amountOverrideRM === "") {
      data.amountOverride = null;
    } else {
      const cents = Math.round(Number(amountOverrideRM) * 100);
      if (!Number.isFinite(cents)) {
        return NextResponse.json({ error: "Invalid override" }, { status: 400 });
      }
      data.amountOverride = cents;
    }
  }

  const updated = await prisma.otAssignment.update({
    where: { id },
    data,
    select: { id: true, status: true, amountOverride: true, paidAt: true },
  });

  return NextResponse.json({ ok: true, updated });
}

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const events = await prisma.otEvent.findMany({
    orderBy: { date: "desc" },
    include: {
      assignments: {
        select: {
          id: true,
          userId: true,
          workRole: true,
          user: { select: { name: true, email: true, grade: true } },
        },
        orderBy: { user: { name: "asc" } },
      },
    },
  });

  return NextResponse.json({ events });
}

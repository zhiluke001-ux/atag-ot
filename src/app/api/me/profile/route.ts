// src/app/api/me/profile/route.ts
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const email = session.user?.email || null;

  // Prefer session fields if you already inject them into session
  const sUser: any = session.user || {};
  if (sUser?.id && sUser?.role) {
    return NextResponse.json({
      user: {
        id: String(sUser.id),
        name: String(sUser.name || ""),
        email,
        role: String(sUser.role),
      },
    });
  }

  // Fallback: load from DB (most robust)
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const dbUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true, role: true, active: true },
  });

  if (!dbUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json({ user: dbUser });
}

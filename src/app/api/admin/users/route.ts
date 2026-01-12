// src/app/api/admin/users/route.ts
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

type Role = "USER" | "ADMIN";
type Grade = "JUNIOR" | "SENIOR";
type WorkRole =
  | "JUNIOR_MARSHAL"
  | "SENIOR_MARSHAL"
  | "JUNIOR_EMCEE"
  | "SENIOR_EMCEE";

function isRole(x: any): x is Role {
  return x === "USER" || x === "ADMIN";
}
function isGrade(x: any): x is Grade {
  return x === "JUNIOR" || x === "SENIOR";
}
function isWorkRole(x: any): x is WorkRole {
  return (
    x === "JUNIOR_MARSHAL" ||
    x === "SENIOR_MARSHAL" ||
    x === "JUNIOR_EMCEE" ||
    x === "SENIOR_EMCEE"
  );
}

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session || (session.user as any)?.role !== "ADMIN") return null;
  return session;
}

export async function GET() {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      grade: true,
      defaultWorkRole: true, // ✅ new
      active: true,
      createdAt: true,
      updatedAt: true, // ✅ helpful for admin UI
    },
  });

  return NextResponse.json({ users });
}

export async function PATCH(req: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const { id, role, grade, defaultWorkRole, active } = body || {};

  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  // Validate enums if provided (don’t silently write garbage)
  if (role !== undefined && role !== null && !isRole(role)) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }
  if (grade !== undefined && grade !== null && !isGrade(grade)) {
    return NextResponse.json({ error: "Invalid grade" }, { status: 400 });
  }
  if (defaultWorkRole !== undefined && defaultWorkRole !== null && !isWorkRole(defaultWorkRole)) {
    return NextResponse.json({ error: "Invalid defaultWorkRole" }, { status: 400 });
  }
  if (active !== undefined && typeof active !== "boolean") {
    return NextResponse.json({ error: "Invalid active" }, { status: 400 });
  }

  // Prevent demoting the last active admin
  if (role === "USER") {
    const adminCount = await prisma.user.count({ where: { role: "ADMIN", active: true } });
    const target = await prisma.user.findUnique({ where: { id }, select: { role: true, active: true } });
    if (target?.role === "ADMIN" && target.active && adminCount <= 1) {
      return NextResponse.json({ error: "Cannot demote the last admin" }, { status: 400 });
    }
  }

  const data: any = {};
  if (role !== undefined && role !== null) data.role = role;
  if (grade !== undefined && grade !== null) data.grade = grade;
  if (defaultWorkRole !== undefined && defaultWorkRole !== null) data.defaultWorkRole = defaultWorkRole;
  if (active !== undefined) data.active = active;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const updated = await prisma.user.update({
    where: { id },
    data,
    select: {
      id: true,
      role: true,
      grade: true,
      defaultWorkRole: true,
      active: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({ ok: true, updated });
}

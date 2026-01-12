// src/app/(app)/layout.tsx (or your AppLayout file)
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import SignOutButton from "@/components/SignOutButton";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  const role = (session.user as any).role;

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <div className="border-b-2 border-black bg-white">
        <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link className="font-semibold text-gray-900" href="/rates">
              ATAG OT
            </Link>

            <Link className="text-sm text-gray-900 hover:underline" href="/rates">
              Rates
            </Link>

            {role === "ADMIN" && (
              <>
                <Link className="text-sm text-gray-900 hover:underline" href="/admin/approved-ot">
                  Approved OT
                </Link>
                <Link className="text-sm text-gray-900 hover:underline" href="/admin/users">
                  Users
                </Link>
              </>
            )}

            <Link className="text-sm text-gray-900 hover:underline" href="/me/pay">
              My Pay
            </Link>
          </div>

          {/* make sure button doesn't look washed-out on some devices */}
          <div className="text-gray-900">
            <SignOutButton />
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-4 py-6">{children}</div>
    </div>
  );
}

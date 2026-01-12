"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";
import Link from "next/link";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);

    const res = await signIn("credentials", {
      email,
      password,
      redirect: true,
      callbackUrl: "/rates",
    });

    // If redirect true, errors show in URL sometimes; keep minimal.
    if ((res as any)?.error) setErr("Invalid login");
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm bg-white p-6 rounded-xl shadow-sm border">
        <h1 className="text-xl font-semibold">Login</h1>
        <p className="text-sm text-gray-600 mt-1">Full-timer OT system</p>

        <div className="mt-4 space-y-3">
          <input className="w-full border rounded px-3 py-2"
            placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="w-full border rounded px-3 py-2"
            placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {err && <div className="text-sm text-red-600">{err}</div>}
          <button className="w-full rounded bg-black text-white py-2 hover:opacity-90">
            Sign in
          </button>
        </div>

        <div className="text-sm text-gray-600 mt-4">
          No account? <Link className="underline" href="/register">Register</Link>
        </div>
      </form>
    </div>
  );
}

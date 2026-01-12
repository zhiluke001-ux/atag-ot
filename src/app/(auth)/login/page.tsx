"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";
import Link from "next/link";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);

    try {
      const res = await signIn("credentials", {
        email,
        password,
        redirect: true,
        callbackUrl: "/rates",
      });

      // If redirect true, errors can still be returned in some cases
      if ((res as any)?.error) setErr("Invalid login");
    } finally {
      setLoading(false);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-gray-900 " +
    "placeholder:text-gray-500 placeholder:opacity-100 " +
    "focus:outline-none focus:ring-2 focus:ring-black/20 focus:border-gray-400 " +
    "disabled:opacity-60";

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-white p-6 rounded-2xl shadow-sm border border-gray-200"
      >
        <h1 className="text-2xl font-semibold text-gray-900">Login</h1>
        <p className="text-sm text-gray-700 mt-1">Full-timer OT system</p>

        <div className="mt-5 space-y-3">
          <input
            className={inputClass}
            placeholder="Email"
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          <input
            className={inputClass}
            placeholder="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {err && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
              {err}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-black text-white py-3 font-medium hover:opacity-90 disabled:opacity-60"
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </div>

        <div className="text-sm text-gray-700 mt-4">
          No account?{" "}
          <Link className="underline text-gray-900" href="/register">
            Register
          </Link>
        </div>
      </form>
    </div>
  );
}

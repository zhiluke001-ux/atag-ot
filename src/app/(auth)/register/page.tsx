"use client";

import { useState } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";

export default function RegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    setBusy(true);

    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setErr(data.error || "Register failed");
        return;
      }

      setMsg("Registered! Logging you in...");

      await signIn("credentials", {
        email,
        password,
        redirect: true,
        callbackUrl: "/rates",
      });
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "w-full rounded-lg border-2 border-black bg-white px-4 py-3 text-gray-900 " +
    "placeholder:text-gray-500 placeholder:opacity-100 " +
    "focus:outline-none focus:ring-0 focus:border-black " +
    "disabled:opacity-60";

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-white p-6 rounded-2xl shadow-sm border-2 border-black"
      >
        <h1 className="text-2xl font-semibold text-gray-900">Register</h1>
        <p className="text-sm text-gray-700 mt-1">Create your full-timer account</p>

        <div className="mt-5 space-y-3">
          <input
            className={inputClass}
            placeholder="Name"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />

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
            placeholder="Password (min 6 chars)"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {err && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {err}
            </div>
          )}
          {msg && (
            <div className="text-sm text-gray-800 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
              {msg}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-black text-white py-3 font-medium hover:opacity-90 disabled:opacity-60"
          >
            {busy ? "Creating..." : "Create account"}
          </button>
        </div>

        <div className="text-sm text-gray-700 mt-4">
          Already have an account?{" "}
          <Link className="underline text-gray-900" href="/login">
            Login
          </Link>
        </div>
      </form>
    </div>
  );
}

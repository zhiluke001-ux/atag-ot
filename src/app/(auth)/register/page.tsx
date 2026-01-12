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

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-white p-6 rounded-xl shadow-sm border"
      >
        <h1 className="text-xl font-semibold">Register</h1>
        <p className="text-sm text-gray-600 mt-1">Create your full-timer account</p>

        <div className="mt-4 space-y-3">
          <input
            className="w-full border rounded px-3 py-2"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />

          <input
            className="w-full border rounded px-3 py-2"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          <input
            className="w-full border rounded px-3 py-2"
            placeholder="Password (min 6 chars)"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {err && <div className="text-sm text-red-600">{err}</div>}
          {msg && <div className="text-sm text-gray-700">{msg}</div>}

          <button
            disabled={busy}
            className="w-full rounded bg-black text-white py-2 hover:opacity-90 disabled:opacity-60"
          >
            {busy ? "Creating..." : "Create account"}
          </button>
        </div>

        <div className="text-sm text-gray-600 mt-4">
          Already have an account?{" "}
          <Link className="underline" href="/login">
            Login
          </Link>
        </div>
      </form>
    </div>
  );
}

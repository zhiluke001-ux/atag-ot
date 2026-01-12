"use client";

import { useEffect, useState } from "react";

type U = {
  id: string;
  name: string;
  email: string;
  role: "USER" | "ADMIN";
  grade: "JUNIOR" | "SENIOR";
  active: boolean;
  createdAt: string;
};

export default function AdminUsersPage() {
  const [users, setUsers] = useState<U[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    setMsg(null);
    const res = await fetch("/api/admin/users");
    if (!res.ok) {
      setMsg("Forbidden (Admin only)");
      return;
    }
    const j = await res.json();
    setUsers(j.users);
  }

  useEffect(() => { load(); }, []);

  async function save(u: U, patch: Partial<U>) {
    setMsg(null);
    const res = await fetch("/api/admin/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: u.id, ...patch }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg(j.error || "Update failed");
      return;
    }
    setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, ...patch } : x)));
    setMsg("Updated");
    setTimeout(() => setMsg(null), 1000);
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Admin — Users</h1>
      {msg && <div className="text-sm text-gray-700">{msg}</div>}

      <div className="bg-white border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left p-3">Name</th>
              <th className="text-left p-3">Email</th>
              <th className="text-left p-3">Grade</th>
              <th className="text-left p-3">Role</th>
              <th className="text-left p-3">Active</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t">
                <td className="p-3">{u.name}</td>
                <td className="p-3">{u.email}</td>
                <td className="p-3">
                  <select
                    className="border rounded px-2 py-1"
                    value={u.grade}
                    onChange={(e) => save(u, { grade: e.target.value as any })}
                  >
                    <option value="JUNIOR">JUNIOR</option>
                    <option value="SENIOR">SENIOR</option>
                  </select>
                </td>
                <td className="p-3">
                  <select
                    className="border rounded px-2 py-1"
                    value={u.role}
                    onChange={(e) => save(u, { role: e.target.value as any })}
                  >
                    <option value="USER">USER</option>
                    <option value="ADMIN">ADMIN</option>
                  </select>
                </td>
                <td className="p-3">
                  <input
                    type="checkbox"
                    checked={u.active}
                    onChange={(e) => save(u, { active: e.target.checked })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button className="text-sm underline" onClick={load}>Reload</button>
    </div>
  );
}

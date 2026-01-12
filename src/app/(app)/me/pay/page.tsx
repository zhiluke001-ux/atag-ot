"use client";

import { useEffect, useMemo, useState } from "react";
import { centsToRm, WORK_ROLE_LABEL, formatPayBreakdownInline } from "@/lib/pricing";

type PayRow = {
  id: string;
  status: "UNPAID" | "PAID";
  workRole: string;

  amountDefaultCents: number;
  amountOverrideCents: number | null;
  effectiveCents: number;

  paidAt: string | null;

  otEvent: {
    date: string;
    project: string;
    startTime: string;
    endTime: string;
    remark: string | null;
    taskCodes?: string;
  };

  taskBreakdown?: {
    hours: number;
    totalRM: number;
    items: { key: string; label: string; amountRM: number }[];
  };
};

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString();
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function MyPayPage() {
  const [rows, setRows] = useState<PayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setMsg(null);
    try {
      const res = await fetch("/api/me/pay", { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(j?.error || "Failed to load pay");
        setRows([]);
        return;
      }
      setRows(Array.isArray(j.assignments) ? j.assignments : []);
    } catch (e: any) {
      setMsg(e?.message || "Failed to load pay");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const totals = useMemo(() => {
    let unpaid = 0;
    let paid = 0;
    for (const r of rows) {
      if (r.status === "PAID") paid += Number(r.effectiveCents || 0);
      else unpaid += Number(r.effectiveCents || 0);
    }
    return { unpaid, paid, count: rows.length };
  }, [rows]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">My Pay</h1>
          <div className="text-sm text-gray-600 mt-1">Approved OT assignments + tasks breakdown.</div>
        </div>

        <button className="text-sm px-3 py-1.5 border rounded bg-white hover:bg-gray-50" onClick={load}>
          Refresh
        </button>
      </div>

      {msg && <div className="text-sm text-red-600">{msg}</div>}

      <div className="grid md:grid-cols-3 gap-3">
        <div className="bg-white border rounded-xl p-4">
          <div className="text-xs text-gray-600">Unpaid Total</div>
          <div className="text-xl font-semibold mt-1">RM{centsToRm(totals.unpaid)}</div>
        </div>
        <div className="bg-white border rounded-xl p-4">
          <div className="text-xs text-gray-600">Paid Total</div>
          <div className="text-xl font-semibold mt-1">RM{centsToRm(totals.paid)}</div>
        </div>
        <div className="bg-white border rounded-xl p-4">
          <div className="text-xs text-gray-600">Assignments</div>
          <div className="text-xl font-semibold mt-1">{totals.count}</div>
        </div>
      </div>

      <div className="bg-white border rounded-xl overflow-hidden">
        <div className="p-4 border-b flex items-center justify-between">
          <div className="font-semibold">Details</div>
          {loading && <div className="text-sm text-gray-500">Loading…</div>}
        </div>

        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-2">Date</th>
                <th className="text-left p-2">Project</th>
                <th className="text-left p-2">Time</th>
                <th className="text-left p-2">Role</th>
                <th className="text-left p-2">Task & Pay</th>
                <th className="text-right p-2">Effective</th>
                <th className="text-center p-2">Status</th>
              </tr>
            </thead>

            <tbody>
              {!loading && rows.length === 0 && (
                <tr className="border-t">
                  <td className="p-4 text-gray-500" colSpan={7}>
                    No assignments found.
                  </td>
                </tr>
              )}

              {rows.map((r) => {
                const isPaid = r.status === "PAID";
                const inline = formatPayBreakdownInline((r.taskBreakdown?.items || []) as any);

                return (
                  <tr key={r.id} className={`border-t ${isPaid ? "bg-gray-50 text-gray-600" : "bg-white"}`}>
                    <td className="p-2 whitespace-nowrap">{fmtDate(r.otEvent.date)}</td>
                    <td className="p-2 min-w-[220px]">
                      <div className="font-medium">{r.otEvent.project}</div>
                      {r.otEvent.remark && <div className="text-xs text-gray-600 mt-0.5">Remark: {r.otEvent.remark}</div>}
                    </td>
                    <td className="p-2 whitespace-nowrap">
                      {fmtTime(r.otEvent.startTime)} - {fmtTime(r.otEvent.endTime)}
                    </td>
                    <td className="p-2 whitespace-nowrap text-xs">
                      {(WORK_ROLE_LABEL as any)?.[r.workRole] || r.workRole}
                    </td>

                    <td className="p-2 text-xs min-w-[280px]">
                      <div className="text-gray-800">{inline}</div>
                    </td>

                    <td className="p-2 text-right whitespace-nowrap font-semibold">RM{centsToRm(r.effectiveCents)}</td>
                    <td className="p-2 text-center whitespace-nowrap">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-xs border ${
                          isPaid ? "bg-white border-gray-200" : "bg-yellow-50 border-yellow-200 text-yellow-800"
                        }`}
                      >
                        {isPaid ? "PAID" : "UNPAID"}
                      </span>
                      {isPaid && r.paidAt && <div className="text-[11px] mt-1">{fmtDate(r.paidAt)}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

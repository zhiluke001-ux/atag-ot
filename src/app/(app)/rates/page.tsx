export default function RatesPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Rates</h1>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-white border rounded-xl p-4">
          <h2 className="font-semibold">Marshal (Physical)</h2>
          <div className="mt-3 text-sm text-gray-700">
            <p><b>Senior:</b> Hourly RM30 | Half-day RM100 | Full-day RM180 | 2D1N RM270 | 3D2N RM350</p>
            <p className="mt-2"><b>Junior:</b> Hourly RM20 | Half-day RM80 | Full-day RM150 | 2D1N RM230 | 3D2N RM300</p>
          </div>
        </div>

        <div className="bg-white border rounded-xl p-4">
          <h2 className="font-semibold">Special Rules</h2>
          <div className="mt-3 text-sm text-gray-700 space-y-2">
            <p><b>Backend:</b> RM15 per hour (Annual Dinner / Karaoke / Packing / Set Up)</p>
            <p><b>Event (starts after 6PM):</b> Senior RM30/hr, Junior RM20/hr (e.g. 7PM–9PM)</p>
          </div>
        </div>
      </div>
    </div>
  );
}

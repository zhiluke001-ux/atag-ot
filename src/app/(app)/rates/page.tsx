// src/app/(app)/rates/page.tsx (or wherever your RatesPage lives)
export default function RatesPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-gray-900">Rates</h1>

      <div className="grid md:grid-cols-2 gap-4">
        {/* Left card */}
        <div className="bg-white border-2 border-black rounded-2xl p-6">
          <h2 className="font-semibold text-gray-900">Physical</h2>

          <div className="mt-4 text-sm text-gray-900 leading-relaxed">
            <p>
              <b>Senior Marshal:</b> Hourly RM30 | Half-day RM100 | Full-day RM180 | 2D1N RM270 | 3D2N RM350
            </p>
            <p className="mt-3">
              <b>Junior Marshal:</b> Hourly RM20 | Half-day RM80 | Full-day RM150 | 2D1N RM230 | 3D2N RM300
            </p>

            <p className="mt-5">
              <b>Senior Emcee:</b> Half-day RM120 | Full-day RM200
            </p>
            <p className="mt-3">
              <b>Junior Emcee:</b> Half-day RM100 | Full-day RM180
            </p>
          </div>
        </div>

        {/* Right card */}
        <div className="bg-white border-2 border-black rounded-2xl p-6">
          <h2 className="font-semibold text-gray-900">Special Rules</h2>

          <div className="mt-4 text-sm text-gray-900 space-y-3 leading-relaxed">
            <p>
              <b>Backend:</b> RM15 per hour (Annual Dinner / Karaoke / Packing / Set Up)
            </p>
            <p>
              <b>Event starts after 6PM (RM30 | RM20 per hour)
            </p>
            <p>
              <b>Early Calling:</b> RM30 
            </p>
            <p>
              <b>Loading &amp; Unloading:</b> RM30 
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

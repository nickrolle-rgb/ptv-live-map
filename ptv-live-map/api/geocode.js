export const config = { runtime: 'edge' };

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

export default async function handler(req) {
  const q = new URL(req.url).searchParams.get('q')?.trim() ?? '';
  if (q.length < 3) {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const params = new URLSearchParams({
    q,
    format: 'jsonv2',
    limit: '6',
    countrycodes: 'au',
  });

  try {
    const upstream = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: {
        // Nominatim's usage policy requires a valid identifying User-Agent on every
        // request (a stock http-library UA isn't enough) — browsers won't let
        // client-side JS set this header at all, which is why this proxy exists
        // rather than calling Nominatim directly from the journey panel.
        'User-Agent': 'ptv-live-map/1.0 (+https://ptv-live-map.vercel.app)',
      },
    });
    if (!upstream.ok) throw new Error(`Upstream request failed with status ${upstream.status}`);
    const results = await upstream.json();

    const places = results.map((r) => ({
      lat: Number(r.lat),
      lon: Number(r.lon),
      label: r.display_name,
    }));

    return new Response(JSON.stringify(places), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Identical repeat queries (a user retyping, or navigating back) are served
        // from cache rather than hitting Nominatim again — courteous given its
        // 1-request-per-second usage policy, on top of the client-side debounce.
        'Cache-Control': 's-maxage=300, stale-while-revalidate=600',
      },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: 'Failed to geocode address' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

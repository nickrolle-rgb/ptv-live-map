// Journey planning Phase 5: full static-schedule planning ("how do I get there, at any
// time, with a correct itinerary" — the thing Phase 3's live-first matching structurally
// can't do, since it only sees currently-active trips). See PRINCIPLES.md's roadmap.
//
// Deliberately a Node.js Function, not Edge (unlike every other file in api/) — this was
// investigated and empirically validated as its own step before writing the real search
// algorithm: Edge Functions cap their bundle at 2-4MB, well under the ~16MB combined
// train+V/Line schedule data (build-schedule.js) this needs to hold in memory, while
// Node.js Functions allow up to 250MB uncompressed. Node.js is Vercel's default runtime
// when `config.runtime` is omitted, so there's no equivalent export here. The handler
// signature also differs from this folder's Edge functions — classic (req, res), not the
// Fetch API (Request) => Response shape.
import trainSchedule from '../src/data/schedule/train-schedule.json' with { type: 'json' };
import vlineSchedule from '../src/data/schedule/vline-schedule.json' with { type: 'json' };
import trainStopNames from '../src/data/train-stop-names.json' with { type: 'json' };
import vlineStopNames from '../src/data/vline-stop-names.json' with { type: 'json' };
import { planJourney } from '../src/schedule-search.js';

// Built once at module scope, not per-request, so it's reused across warm invocations
// of this function instance (and so schedule-search.js's interchange-group cache, keyed
// by this object's identity, actually pays off). Safe to merge with a plain spread:
// train and V/Line share one PTV-wide stop_id space, confirmed against real data (both
// list identical [name, lat, lon] triples for shared physical stops like Southern
// Cross) before relying on it here.
const stopRegistry = { ...trainStopNames, ...vlineStopNames };
const schedules = [
  { mode: 'train', data: trainSchedule },
  { mode: 'vline', data: vlineSchedule },
];

function parseCoord(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export default function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const originLat = parseCoord(url.searchParams.get('originLat'));
  const originLon = parseCoord(url.searchParams.get('originLon'));
  const destLat = parseCoord(url.searchParams.get('destLat'));
  const destLon = parseCoord(url.searchParams.get('destLon'));
  const departureParam = url.searchParams.get('departure');
  const departureEpochMs = departureParam ? Number(departureParam) : Date.now();

  if (originLat === null || originLon === null || destLat === null || destLon === null) {
    res.status(400).json({ ok: false, reason: 'missing_or_invalid_coordinates' });
    return;
  }
  if (!Number.isFinite(departureEpochMs)) {
    res.status(400).json({ ok: false, reason: 'invalid_departure' });
    return;
  }

  try {
    const result = planJourney({
      origin: { lat: originLat, lon: originLon },
      destination: { lat: destLat, lon: destLon },
      departureEpochMs,
      schedules,
      stopRegistry,
    });
    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, reason: 'planning_failed' });
  }
}

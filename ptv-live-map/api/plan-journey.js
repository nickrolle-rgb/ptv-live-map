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
import tramSchedule from '../src/data/schedule/tram-schedule.json' with { type: 'json' };
import trainStopNames from '../src/data/train-stop-names.json' with { type: 'json' };
import vlineStopNames from '../src/data/vline-stop-names.json' with { type: 'json' };
import tramStopNames from '../src/data/tram-stop-names.json' with { type: 'json' };
import { planJourney, planJourneyArrivingBy } from '../src/schedule-search.js';

// Built once at module scope, not per-request, so it's reused across warm invocations
// of this function instance (and so schedule-search.js's interchange-group cache, keyed
// by this object's identity, actually pays off). Safe to merge with a plain spread:
// train and V/Line share one PTV-wide stop_id space, confirmed against real data (both
// list identical [name, lat, lon] triples for shared physical stops like Southern
// Cross) before relying on it here. Tram does *not* share that space (confirmed zero
// overlapping stop_ids, and an entirely different naming convention — see
// schedule-search.js's buildInterchangeGroups for why that's fine: interchanges are
// resolved by physical proximity, not by stop_id or name matching, specifically so tram
// can be spread in here safely without needing a shared id space of its own.
const stopRegistry = { ...trainStopNames, ...vlineStopNames, ...tramStopNames };
const schedules = [
  { mode: 'train', data: trainSchedule },
  { mode: 'vline', data: vlineSchedule },
  { mode: 'tram', data: tramSchedule },
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
  // arriveBy takes precedence over departure when both are given — an explicit "arrive
  // by" request states the actual intent more precisely than a departure time would.
  const arriveByParam = url.searchParams.get('arriveBy');
  const departureParam = url.searchParams.get('departure');

  if (originLat === null || originLon === null || destLat === null || destLon === null) {
    res.status(400).json({ ok: false, reason: 'missing_or_invalid_coordinates' });
    return;
  }

  try {
    if (arriveByParam) {
      const arriveByEpochMs = Number(arriveByParam);
      if (!Number.isFinite(arriveByEpochMs)) {
        res.status(400).json({ ok: false, reason: 'invalid_arrive_by' });
        return;
      }
      const result = planJourneyArrivingBy({
        origin: { lat: originLat, lon: originLon },
        destination: { lat: destLat, lon: destLon },
        arriveByEpochMs,
        schedules,
        stopRegistry,
      });
      res.status(200).json(result);
      return;
    }

    const departureEpochMs = departureParam ? Number(departureParam) : Date.now();
    if (!Number.isFinite(departureEpochMs)) {
      res.status(400).json({ ok: false, reason: 'invalid_departure' });
      return;
    }
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

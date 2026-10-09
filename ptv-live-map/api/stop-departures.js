// Next timetabled departures from a stop, for the map's stop popups where the live feed
// has nothing to say (PTV's tram trip-updates only list a few timing-point stops ahead of
// each tram, so most tram stops never appear in it). A Node.js Function for the same
// reason as plan-journey.js: the schedule data is far past Edge's bundle limit.
import trainSchedule from '../src/data/schedule/train-schedule.json' with { type: 'json' };
import vlineSchedule from '../src/data/schedule/vline-schedule.json' with { type: 'json' };
import tramSchedule from '../src/data/schedule/tram-schedule.json' with { type: 'json' };
import { stopDepartures } from '../src/schedule-search.js';

// One stable array per mode, so schedule-search.js's per-date connections cache (keyed
// by array identity) is reused across requests and only builds that mode's connections.
const SCHEDULES = {
  train: [{ mode: 'train', data: trainSchedule }],
  vline: [{ mode: 'vline', data: vlineSchedule }],
  tram: [{ mode: 'tram', data: tramSchedule }],
};
const MAX_STOP_IDS = 20;

export default function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const schedules = SCHEDULES[url.searchParams.get('mode')];
  const stopIds = (url.searchParams.get('stopIds') ?? '').split(',').filter(Boolean).slice(0, MAX_STOP_IDS);
  const from = Number(url.searchParams.get('from') ?? Date.now());
  if (!schedules || stopIds.length === 0 || !Number.isFinite(from)) {
    res.status(400).json({ ok: false, reason: 'invalid_request' });
    return;
  }
  try {
    res.status(200).json({ ok: true, departures: stopDepartures({ schedules, stopIds, fromEpochMs: from }) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, reason: 'internal_error' });
  }
}

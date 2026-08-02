import { describe, it, expect } from 'vitest';
import { melbourneDateAndSeconds, planJourney, planJourneyArrivingBy } from './schedule-search.js';

// ---------------------------------------------------------------------------
// melbourneDateAndSeconds — DST boundary tests.
//
// Expected local times below were cross-checked against the runtime's own
// Australia/Melbourne tzdata (`new Date(...).toLocaleString('en-AU', { timeZone:
// 'Australia/Melbourne' })`) at authoring time, then hardcoded as literals here —
// so this test is checking melbourneDateAndSeconds's *own* date-math (dateStr/day
// rollover, seconds-of-day) against a frozen expectation, not re-deriving it from
// Intl at run time. A regression (e.g. someone "simplifying" this to a hardcoded
// UTC+10 offset) would silently produce wrong times for roughly half the year.
// ---------------------------------------------------------------------------
describe('melbourneDateAndSeconds — DST boundaries', () => {
  it('spring forward 2026-10-04: 01:59 AEST steps to 03:00 AEDT (2am-3am does not exist locally)', () => {
    const before = melbourneDateAndSeconds(Date.UTC(2026, 9, 3, 15, 59, 0)); // 2026-10-03T15:59:00Z
    const after = melbourneDateAndSeconds(Date.UTC(2026, 9, 3, 16, 0, 0)); // 2026-10-03T16:00:00Z, 1 min later in UTC
    expect(before).toEqual({ dateStr: '20261004', seconds: 1 * 3600 + 59 * 60 });
    expect(after).toEqual({ dateStr: '20261004', seconds: 3 * 3600 });
    // One minute of real (UTC) time produced a 61-minute jump in local wall-clock time.
    expect(after.seconds - before.seconds).toBe(61 * 60);
  });

  it('fall back 2026-04-05: 02:59 AEDT steps to 02:00 AEST (02:00-03:00 happens twice locally)', () => {
    const before = melbourneDateAndSeconds(Date.UTC(2026, 3, 4, 15, 59, 0)); // 2026-04-04T15:59:00Z
    const after = melbourneDateAndSeconds(Date.UTC(2026, 3, 4, 16, 0, 0)); // 2026-04-04T16:00:00Z, 1 min later in UTC
    expect(before).toEqual({ dateStr: '20260405', seconds: 2 * 3600 + 59 * 60 });
    expect(after).toEqual({ dateStr: '20260405', seconds: 2 * 3600 });
    // Local wall-clock time went *backwards* even though real time moved forward —
    // any caller assuming seconds-of-day is monotonic in epochMs will break here.
    expect(after.seconds).toBeLessThan(before.seconds);
  });

  it('plain winter (AEST, UTC+10) instant resolves as expected with no DST involved', () => {
    // 2026-08-05T00:05:00 local (Melbourne winter, fixed UTC+10) == 2026-08-04T14:05:00Z
    const result = melbourneDateAndSeconds(Date.UTC(2026, 7, 4, 14, 5, 0));
    expect(result).toEqual({ dateStr: '20260805', seconds: 5 * 60 });
  });
});

// ---------------------------------------------------------------------------
// planJourney — synthetic network fixtures.
//
// A minimal three/four-stop network laid out with real lat/lon deltas (0.01 deg
// latitude =~ 1.11km) so findWalkableStops' walking-cap logic behaves realistically,
// not just algorithmically. Stop naming ("Mid Interchange" shared by S2/S2B) exists
// specifically to exercise buildInterchangeGroups' same-name transfer modelling.
// ---------------------------------------------------------------------------
const S1 = { id: 'S1', name: 'Origin Stop', lat: -37.80000, lon: 144.95000 };
const S2 = { id: 'S2', name: 'Mid Interchange', lat: -37.81000, lon: 144.95000 };
const S2B = { id: 'S2B', name: 'Mid Interchange', lat: -37.81001, lon: 144.95001 }; // ~1.5m from S2
const S3 = { id: 'S3', name: 'Dest Stop', lat: -37.82000, lon: 144.95000 };

const stopRegistry = Object.fromEntries(
  [S1, S2, S2B, S3].map((s) => [s.id, [s.name, s.lat, s.lon]])
);

const WEEKDAY_CAL = { days: [1, 1, 1, 1, 1, 0, 0], start: '20260101', end: '20261231' }; // Mon-Fri

function baseScheduleData() {
  return {
    stopIds: ['S1', 'S2', 'S2B', 'S3'],
    routeIds: ['R1', 'R2'],
    serviceIds: ['WEEKDAY'],
    trips: {
      // S1 -> S2, departs 08:00, arrives 08:10.
      T1: { r: 0, s: 0, stops: [[0, null, 8 * 3600], [1, 8 * 3600 + 600, null]] },
      // S2B -> S3, departs 08:15, arrives 08:25 — requires transferring S2 -> S2B first.
      T2: { r: 1, s: 0, stops: [[2, null, 8 * 3600 + 900], [3, 8 * 3600 + 1500, null]] },
    },
    calendar: { WEEKDAY: WEEKDAY_CAL },
    calendarDates: {},
  };
}

// 2026-08-05 is a Wednesday (within WEEKDAY_CAL); 07:45 local on that date — before
// both T1 (08:00) and T2 (08:15) so the planner has to actually find them, not just
// happen to query into their gap. Confirmed via Date.UTC + Australia/Melbourne offset
// (winter, fixed UTC+10, no DST ambiguity).
const QUERY_BEFORE_0800 = Date.UTC(2026, 7, 4, 21, 45, 0); // 2026-08-04T21:45:00Z == 2026-08-05T07:45:00+10:00

function parseHHMM(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

describe('planJourney — basic direct + transfer routing', () => {
  it('finds a direct-then-transfer itinerary and respects the minimum transfer time', () => {
    const result = planJourney({
      origin: { lat: S1.lat, lon: S1.lon },
      destination: { lat: S3.lat, lon: S3.lon },
      departureEpochMs: QUERY_BEFORE_0800,
      schedules: [{ mode: 'train', data: baseScheduleData() }],
      stopRegistry,
    });
    expect(result.ok).toBe(true);
    expect(result.legs).toHaveLength(2);
    expect(result.legs[0].boardStop).toBe('Origin Stop');
    expect(result.legs[0].alightStop).toBe('Mid Interchange');
    expect(result.legs[0].boardTime).toBe('08:00');
    expect(result.legs[0].alightTime).toBe('08:10');
    expect(result.legs[1].boardStop).toBe('Mid Interchange');
    expect(result.legs[1].alightStop).toBe('Dest Stop');
    expect(result.legs[1].boardTime).toBe('08:15');
    expect(result.legs[1].alightTime).toBe('08:25');
    expect(result.legs[1].changedPlatform).toBe(true);
    // 5 minutes scheduled gap (08:10 -> 08:15) is >= MIN_TRANSFER_SEC (120s) + a
    // negligible walk between S2/S2B, so the transfer is honored, not padded further.
    expect(result.legs[1].transferMinutes).toBe(5);
    expect(result.arriveBy).toBe('08:25');
  });

  it('never produces a leg that arrives before it boards, or a transfer that goes backward in time', () => {
    // Property-style check across several query instants on the same network.
    const queryTimes = [
      Date.UTC(2026, 7, 4, 22, 0, 0), // 08:00 local — right at T1's departure
      Date.UTC(2026, 7, 4, 21, 30, 0), // 07:30 local — well before
      Date.UTC(2026, 7, 4, 22, 5, 0), // 08:05 local — after T1 has left; still boardable? no, but must not go backward
    ];
    queryTimes.forEach((epochMs) => {
      const result = planJourney({
        origin: { lat: S1.lat, lon: S1.lon },
        destination: { lat: S3.lat, lon: S3.lon },
        departureEpochMs: epochMs,
        schedules: [{ mode: 'train', data: baseScheduleData() }],
        stopRegistry,
      });
      if (!result.ok) return; // no journey at all is fine — the invariant is about found ones
      let prevAlight = null;
      result.legs.forEach((leg) => {
        expect(parseHHMM(leg.boardTime)).toBeLessThanOrEqual(parseHHMM(leg.alightTime));
        if (prevAlight !== null) expect(parseHHMM(leg.boardTime)).toBeGreaterThanOrEqual(prevAlight);
        prevAlight = parseHHMM(leg.alightTime);
      });
      expect(result.totalMinutes).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('planJourney — interchange walk-distance cap', () => {
  it('does not model a same-named-stop transfer as walkable beyond MAX_INTERCHANGE_WALK_MINUTES', () => {
    const farData = baseScheduleData();
    const farRegistry = {
      ...stopRegistry,
      S2B: ['Mid Interchange', -37.95000, 144.95000], // ~16.7km from S2 — far beyond any walkable interchange
    };
    const result = planJourney({
      origin: { lat: S1.lat, lon: S1.lon },
      destination: { lat: S3.lat, lon: S3.lon },
      departureEpochMs: QUERY_BEFORE_0800,
      schedules: [{ mode: 'train', data: farData }],
      stopRegistry: farRegistry,
    });
    // T2 only boards from S2B; with no interchange edge from S2 (arrival stop) to the
    // now-distant S2B, and no other path to S3, the journey must fail rather than
    // silently modelling an impossible 16km "transfer".
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_journey_found');
  });
});

describe('planJourney — GTFS calendar_dates exceptions', () => {
  it('excludes a normally-active service on a calendar_dates type=2 (removed) date', () => {
    const data = baseScheduleData();
    data.calendarDates = { WEEKDAY: [{ date: '20260805', type: 2 }] };
    const result = planJourney({
      origin: { lat: S1.lat, lon: S1.lon },
      destination: { lat: S3.lat, lon: S3.lon },
      departureEpochMs: QUERY_BEFORE_0800,
      schedules: [{ mode: 'train', data }],
      stopRegistry,
    });
    expect(result.ok).toBe(false);
  });

  it('includes a normally-inactive service on a calendar_dates type=1 (added) date', () => {
    const data = baseScheduleData();
    data.serviceIds = ['NEVER'];
    data.calendar = { NEVER: { days: [0, 0, 0, 0, 0, 0, 0], start: '20260101', end: '20261231' } };
    data.calendarDates = { NEVER: [{ date: '20260805', type: 1 }] };
    const result = planJourney({
      origin: { lat: S1.lat, lon: S1.lon },
      destination: { lat: S3.lat, lon: S3.lon },
      departureEpochMs: QUERY_BEFORE_0800,
      schedules: [{ mode: 'train', data }],
      stopRegistry,
    });
    expect(result.ok).toBe(true);
    expect(result.arriveBy).toBe('08:25');
  });
});

describe('planJourney — midnight rollover (GTFS >24h overflow times)', () => {
  it('finds a trip whose service belongs to the day before, running past midnight into the query day', () => {
    const data = {
      stopIds: ['S1', 'S2', 'S2B', 'S3'],
      routeIds: ['R1'],
      serviceIds: ['OVERNIGHT'],
      trips: {
        // Departs S1 at 24:20 (GTFS overflow: 00:20 the next calendar day), arrives S3
        // at 24:40 (00:40 next day) — both stored as this trip's service-day time.
        LATE: { r: 0, s: 0, stops: [[0, null, 24 * 3600 + 1200], [3, 24 * 3600 + 2400, null]] },
      },
      calendar: { OVERNIGHT: { days: [0, 0, 0, 0, 0, 0, 0], start: '20260101', end: '20261231' } },
      // Active only on 2026-08-04 — its overflow trip lands in the early hours of 08-05.
      calendarDates: { OVERNIGHT: [{ date: '20260804', type: 1 }] },
    };
    // Query at 2026-08-05 00:05 local — after midnight, before the overnight trip departs.
    const queryEpochMs = Date.UTC(2026, 7, 4, 14, 5, 0);
    const result = planJourney({
      origin: { lat: S1.lat, lon: S1.lon },
      destination: { lat: S3.lat, lon: S3.lon },
      departureEpochMs: queryEpochMs,
      schedules: [{ mode: 'train', data }],
      stopRegistry,
    });
    expect(result.ok).toBe(true);
    expect(result.legs).toHaveLength(1);
    expect(result.legs[0].boardTime).toBe('00:20');
    expect(result.legs[0].alightTime).toBe('00:40');
    expect(result.arriveBy).toBe('00:40');
  });

  it('does NOT surface that same overnight trip to a query on the wrong day', () => {
    const data = {
      stopIds: ['S1', 'S2', 'S2B', 'S3'],
      routeIds: ['R1'],
      serviceIds: ['OVERNIGHT'],
      trips: {
        LATE: { r: 0, s: 0, stops: [[0, null, 24 * 3600 + 1200], [3, 24 * 3600 + 2400, null]] },
      },
      calendar: { OVERNIGHT: { days: [0, 0, 0, 0, 0, 0, 0], start: '20260101', end: '20261231' } },
      calendarDates: { OVERNIGHT: [{ date: '20260804', type: 1 }] },
    };
    // One day later — the overnight trip's only active date (08-04) is now two service
    // days in the past, so neither D nor D-1 (the only days buildConnections considers)
    // includes it.
    const queryEpochMs = Date.UTC(2026, 7, 5, 14, 5, 0); // 2026-08-06 00:05 local
    const result = planJourney({
      origin: { lat: S1.lat, lon: S1.lon },
      destination: { lat: S3.lat, lon: S3.lon },
      departureEpochMs: queryEpochMs,
      schedules: [{ mode: 'train', data }],
      stopRegistry,
    });
    expect(result.ok).toBe(false);
  });
});

describe('planJourneyArrivingBy', () => {
  // Local midnight on 2026-08-05 (winter, fixed UTC+10 — see melbourneDateAndSeconds
  // tests above for why winter dates are used to sidestep unrelated DST edge cases here).
  const arriveBy = (hh, mm) => Date.UTC(2026, 7, 4, hh - 10, mm, 0);

  it('finds the latest departure that still arrives by the target, when the target exactly matches the only achievable arrival', () => {
    const result = planJourneyArrivingBy({
      origin: { lat: S1.lat, lon: S1.lon },
      destination: { lat: S3.lat, lon: S3.lon },
      arriveByEpochMs: arriveBy(8, 25), // exactly matches T1->T2's 08:25 arrival
      schedules: [{ mode: 'train', data: baseScheduleData() }],
      stopRegistry,
    });
    expect(result.ok).toBe(true);
    // Departing any later than 08:00 misses T1 entirely (the only route to S3 in this
    // fixture), so 08:00 — T1's own departure — is the latest still-workable departure.
    expect(result.legs[0].boardTime).toBe('08:00');
    expect(result.arriveBy).toBe('08:25');
    expect(result.requestedArriveBy).toBe('08:25');
  });

  it('is unreachable when the target arrival is before the only achievable arrival', () => {
    const result = planJourneyArrivingBy({
      origin: { lat: S1.lat, lon: S1.lon },
      destination: { lat: S3.lat, lon: S3.lon },
      arriveByEpochMs: arriveBy(8, 24), // one minute before the earliest possible arrival
      schedules: [{ mode: 'train', data: baseScheduleData() }],
      stopRegistry,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unreachable_by_target');
  });

  it('is unreachable when the target is before the network\'s first trip even departs', () => {
    const result = planJourneyArrivingBy({
      origin: { lat: S1.lat, lon: S1.lon },
      destination: { lat: S3.lat, lon: S3.lon },
      arriveByEpochMs: arriveBy(7, 0), // T1 doesn't depart until 08:00
      schedules: [{ mode: 'train', data: baseScheduleData() }],
      stopRegistry,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unreachable_by_target');
  });

  it('a generous target still resolves to the same actual (earliest possible) arrival, not the target itself', () => {
    const result = planJourneyArrivingBy({
      origin: { lat: S1.lat, lon: S1.lon },
      destination: { lat: S3.lat, lon: S3.lon },
      arriveByEpochMs: arriveBy(9, 0), // an hour later than necessary
      schedules: [{ mode: 'train', data: baseScheduleData() }],
      stopRegistry,
    });
    expect(result.ok).toBe(true);
    expect(result.arriveBy).toBe('08:25'); // this fixture has no later alternative departure
    expect(result.requestedArriveBy).toBe('09:00');
  });

  it('propagates a time-independent failure (no walkable stop at all) immediately, not as "unreachable"', () => {
    // findWalkableStops falls back to the single nearest stop (however far) rather than
    // returning empty when nothing is within the cap — 'no_walkable_stops' only actually
    // fires when the stop registry itself has nothing in it at all.
    const result = planJourneyArrivingBy({
      origin: { lat: S1.lat, lon: S1.lon },
      destination: { lat: S3.lat, lon: S3.lon },
      arriveByEpochMs: arriveBy(8, 25),
      schedules: [{ mode: 'train', data: baseScheduleData() }],
      stopRegistry: {},
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_walkable_stops');
  });

  it('never returns a journey that actually arrives after the requested target', () => {
    // Property-style sweep across several targets, including ones with no achievable
    // journey at all.
    [arriveBy(8, 10), arriveBy(8, 25), arriveBy(8, 30), arriveBy(12, 0)].forEach((target) => {
      const result = planJourneyArrivingBy({
        origin: { lat: S1.lat, lon: S1.lon },
        destination: { lat: S3.lat, lon: S3.lon },
        arriveByEpochMs: target,
        schedules: [{ mode: 'train', data: baseScheduleData() }],
        stopRegistry,
      });
      if (!result.ok) return;
      // Both are same-day "HH:MM" strings (planJourneyArrivingBy only searches within
      // the target's own calendar day), so comparing as minutes-of-day is safe here.
      expect(parseHHMM(result.arriveBy)).toBeLessThanOrEqual(parseHHMM(result.requestedArriveBy));
    });
  });
});

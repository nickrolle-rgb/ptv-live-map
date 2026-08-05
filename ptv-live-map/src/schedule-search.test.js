import { describe, it, expect } from 'vitest';
import { melbourneDateAndSeconds, melbourneWallClockToEpochMs, planJourney, planJourneyArrivingBy } from './schedule-search.js';

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

describe('melbourneWallClockToEpochMs — inverse of melbourneDateAndSeconds', () => {
  it('round-trips a plain winter instant', () => {
    const epochMs = melbourneWallClockToEpochMs('20260805', 5 * 60);
    expect(epochMs).toBe(Date.UTC(2026, 7, 4, 14, 5, 0));
    expect(melbourneDateAndSeconds(epochMs)).toEqual({ dateStr: '20260805', seconds: 5 * 60 });
  });

  it('round-trips a summer (AEDT, UTC+11) instant', () => {
    // Mid-January is unambiguously AEDT — a good sanity check independent of either
    // transition date.
    const epochMs = melbourneWallClockToEpochMs('20260115', 12 * 3600);
    expect(melbourneDateAndSeconds(epochMs)).toEqual({ dateStr: '20260115', seconds: 12 * 3600 });
  });

  it('resolves wall-clock times either side of the spring-forward gap to their real, hour-apart instants', () => {
    // 01:30 AEST and 03:10 AEDT look 100 minutes apart by raw digits, but the 02:00-03:00
    // hour never happened locally on 2026-10-04 (see the DST-boundary tests above), so
    // they're really only 40 real minutes apart.
    const departEpochMs = melbourneWallClockToEpochMs('20261004', 1 * 3600 + 30 * 60); // 01:30
    const arriveEpochMs = melbourneWallClockToEpochMs('20261004', 3 * 3600 + 10 * 60); // 03:10
    expect(departEpochMs).toBe(Date.UTC(2026, 9, 3, 15, 30, 0));
    expect(arriveEpochMs).toBe(Date.UTC(2026, 9, 3, 16, 10, 0));
    expect((arriveEpochMs - departEpochMs) / 60000).toBe(40);
  });

  it('resolves the fall-back date\'s wall-clock times to the second (AEST) occurrence of the repeated hour', () => {
    // 02:30 on 2026-04-05 happens twice (02:30 AEDT, then again as 02:30 AEST an hour
    // later). This function can't disambiguate from naive GTFS seconds-since-midnight
    // alone (see its header) and always resolves to the later, AEST occurrence — its
    // initial guess assumes AEST and, for a target in this window, already reads back
    // correctly with no correction needed.
    const epochMs = melbourneWallClockToEpochMs('20260405', 2 * 3600 + 30 * 60);
    expect(melbourneDateAndSeconds(epochMs)).toEqual({ dateStr: '20260405', seconds: 2 * 3600 + 30 * 60 });
    // The AEDT occurrence is Date.UTC(2026,3,4,15,30,0); this resolves to the AEST one,
    // an hour later.
    expect(epochMs).toBe(Date.UTC(2026, 3, 4, 16, 30, 0));
  });
});

// ---------------------------------------------------------------------------
// planJourney — synthetic network fixtures.
//
// A minimal three/four-stop network laid out with real lat/lon deltas (0.03 deg
// latitude =~ 3.34km, comfortably past DEFAULT_WALK_CAP_MINUTES's ~1.23km reach — see
// journey.js — so adjacent stops require an actual trip, not a walk) so
// findWalkableStops' walking-cap logic behaves realistically, not just algorithmically.
// Stop naming ("Mid Interchange" shared by S2/S2B) exists specifically to exercise
// buildInterchangeGroups' same-name transfer modelling.
// ---------------------------------------------------------------------------
const S1 = { id: 'S1', name: 'Origin Stop', lat: -37.80000, lon: 144.95000 };
const S2 = { id: 'S2', name: 'Mid Interchange', lat: -37.83000, lon: 144.95000 };
const S2B = { id: 'S2B', name: 'Mid Interchange', lat: -37.83001, lon: 144.95001 }; // ~1.5m from S2
const S3 = { id: 'S3', name: 'Dest Stop', lat: -37.86000, lon: 144.95000 };

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

  it('surfaces platform_code when the stop registry carries one, and null when it does not', () => {
    // S1 has no 4th (platform) element at all — mirrors tram/V-Line stop-names.json,
    // which never carries platform_code (see build-stop-names.js). S2/S2B do carry one,
    // mirroring train stops, including two different platforms at the "same" interchange
    // (a real same-name-different-platform transfer should report the change).
    const platformRegistry = {
      ...stopRegistry,
      S2: [S2.name, S2.lat, S2.lon, '3'],
      S2B: [S2B.name, S2B.lat, S2B.lon, '3A'],
    };
    const result = planJourney({
      origin: { lat: S1.lat, lon: S1.lon },
      destination: { lat: S3.lat, lon: S3.lon },
      departureEpochMs: QUERY_BEFORE_0800,
      schedules: [{ mode: 'train', data: baseScheduleData() }],
      stopRegistry: platformRegistry,
    });
    expect(result.ok).toBe(true);
    expect(result.legs[0].boardPlatform).toBeNull(); // S1 — no platform data at all
    expect(result.legs[0].alightPlatform).toBe('3'); // S2
    expect(result.legs[1].boardPlatform).toBe('3A'); // S2B
    expect(result.legs[1].alightPlatform).toBeNull(); // S3 — no platform data at all
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

describe('planJourney — same-trip pass-through (rider stays aboard through an intermediate stop)', () => {
  // Every other synthetic fixture in this file uses 2-stop trips, so none of them
  // exercise the `last.tripId === hop.tripId` merge branch in planJourney's leg-building
  // loop — the mechanism that keeps a rider staying aboard through an intermediate
  // boardable stop from being reported as two legs with a phantom transfer at that stop.
  const P1 = { id: 'P1', name: 'Pass Origin', lat: -37.80000, lon: 144.95000 };
  const PM = { id: 'PM', name: 'Pass Mid', lat: -37.83000, lon: 144.95000 }; // boardable, but nobody transfers here
  const P3 = { id: 'P3', name: 'Pass Dest', lat: -37.86000, lon: 144.95000 };
  const passRegistry = Object.fromEntries([P1, PM, P3].map((s) => [s.id, [s.name, s.lat, s.lon]]));

  const data = {
    stopIds: ['P1', 'PM', 'P3'],
    routeIds: ['R1'],
    serviceIds: ['WEEKDAY'],
    trips: {
      // Single trip, three stops: depart P1 08:00, through PM (arrive 08:10, depart
      // 08:11), arrive P3 08:20. No transfer/interchange involved anywhere in this.
      T1: { r: 0, s: 0, stops: [[0, null, 8 * 3600], [1, 8 * 3600 + 600, 8 * 3600 + 660], [2, 8 * 3600 + 1200, null]] },
    },
    calendar: { WEEKDAY: WEEKDAY_CAL },
    calendarDates: {},
  };

  it('merges the ride through an intermediate boardable stop into a single leg, not two', () => {
    const result = planJourney({
      origin: { lat: P1.lat, lon: P1.lon },
      destination: { lat: P3.lat, lon: P3.lon },
      departureEpochMs: QUERY_BEFORE_0800,
      schedules: [{ mode: 'train', data }],
      stopRegistry: passRegistry,
    });
    expect(result.ok).toBe(true);
    expect(result.legs).toHaveLength(1);
    expect(result.legs[0].tripId).toBe('T1');
    expect(result.legs[0].boardStop).toBe('Pass Origin');
    expect(result.legs[0].boardTime).toBe('08:00');
    expect(result.legs[0].alightStop).toBe('Pass Dest');
    expect(result.legs[0].alightTime).toBe('08:20');
    // No transfer happened (only one leg) — must not report a phantom wait/transfer at
    // the intermediate stop, and that stop must not leak in as its own board/alight point.
    expect(result.legs[0].transferMinutes).toBeNull();
    expect(result.legs.some((leg) => leg.boardStop === 'Pass Mid' || leg.alightStop === 'Pass Mid')).toBe(false);
    expect(result.totalMinutes).toBe(35); // 07:45 query -> 08:20 real, no lost time
  });
});

describe('planJourney — multi-leg reconstruction (predecessor overwrite mid-sweep)', () => {
  // Regression coverage for the prevHop-snapshot mechanism documented at length in
  // schedule-search.js (the "Two different connections can each legitimately improve
  // the other's stop" comment on the backtrack site). A literal mutual A<->B cycle
  // isn't actually constructible under real forward-flowing GTFS times (a connection
  // back from B to A can never arrive earlier than an already-recorded arrival at A,
  // since that would require negative travel time) — but the *mechanism* the comment
  // guards against — a stop's predecessor entry being overwritten mid-sweep by a
  // better connection, where the earlier entry already seeded a later hop's prevHop
  // snapshot — is directly constructible and exactly what this test forces:
  //
  //   T1 (S4->A, slow direct)         depart 08:00  arrive 08:20
  //   T2a (S4->M, fast alternative)    depart 07:55  arrive 08:05
  //   T2b (M->A, fast alternative)     depart 08:08  arrive 08:15  <- beats T1, overwrites predecessor[A]
  //   T3 (A->S5, onward leg)           depart 08:20  arrive 08:30
  //
  // T3's prevHop is captured *after* T2b's overwrite, so reconstruction must walk
  // S4->M->A->S5 (3 legs, all via the fast path) with no trace of T1's now-discarded
  // direct hop — not a truncated or mixed chain.
  const M = { id: 'M', name: 'Mid Stop', lat: -37.81500, lon: 144.95000 };
  const S4 = { id: 'S4', name: 'Multi Origin', lat: -37.80000, lon: 144.95000 };
  const A = { id: 'A', name: 'Junction Stop', lat: -37.83000, lon: 144.95000 };
  const S5 = { id: 'S5', name: 'Multi Dest', lat: -37.86000, lon: 144.95000 };
  const fullRegistry = Object.fromEntries(
    [S4, M, A, S5].map((s) => [s.id, [s.name, s.lat, s.lon]])
  );

  const data = {
    stopIds: ['S4', 'M', 'A', 'S5'],
    routeIds: ['SLOW', 'FAST1', 'FAST2', 'ONWARD'],
    serviceIds: ['WEEKDAY'],
    trips: {
      // S4 -> A direct, slow: depart 08:00, arrive 08:20.
      T1_SLOW: { r: 0, s: 0, stops: [[0, null, 8 * 3600], [2, 8 * 3600 + 1200, null]] },
      // S4 -> M, depart 07:55, arrive 08:05.
      T2A_FAST: { r: 1, s: 0, stops: [[0, null, 8 * 3600 - 300], [1, 8 * 3600 + 300, null]] },
      // M -> A, depart 08:08, arrive 08:15 — beats T1_SLOW's 08:20.
      T2B_FAST: { r: 2, s: 0, stops: [[1, null, 8 * 3600 + 480], [2, 8 * 3600 + 900, null]] },
      // A -> S5 onward leg, depart 08:20, arrive 08:30.
      T3_ONWARD: { r: 3, s: 0, stops: [[2, null, 8 * 3600 + 1200], [3, 8 * 3600 + 1800, null]] },
    },
    calendar: { WEEKDAY: WEEKDAY_CAL },
    calendarDates: {},
  };

  it('reconstructs the full 3-leg chain via the faster path once a mid-sweep predecessor overwrite occurs', () => {
    const result = planJourney({
      origin: { lat: S4.lat, lon: S4.lon },
      destination: { lat: S5.lat, lon: S5.lon },
      departureEpochMs: QUERY_BEFORE_0800,
      schedules: [{ mode: 'train', data }],
      stopRegistry: fullRegistry,
    });
    expect(result.ok).toBe(true);
    expect(result.legs).toHaveLength(3);
    expect(result.legs[0].boardStop).toBe('Multi Origin');
    expect(result.legs[0].alightStop).toBe('Mid Stop');
    expect(result.legs[0].boardTime).toBe('07:55');
    expect(result.legs[0].alightTime).toBe('08:05');
    expect(result.legs[1].boardStop).toBe('Mid Stop');
    expect(result.legs[1].alightStop).toBe('Junction Stop');
    expect(result.legs[1].boardTime).toBe('08:08');
    expect(result.legs[1].alightTime).toBe('08:15');
    expect(result.legs[2].boardStop).toBe('Junction Stop');
    expect(result.legs[2].alightStop).toBe('Multi Dest');
    expect(result.legs[2].boardTime).toBe('08:20');
    expect(result.legs[2].alightTime).toBe('08:30');
    // The now-discarded slow direct trip must leave no trace in the reconstructed legs.
    expect(result.legs.some((leg) => leg.tripId === 'T1_SLOW')).toBe(false);
    // arriveBy/totalMinutes (computed independently from earliestArrival) must agree
    // exactly with what the displayed legs show — the precise invariant the real bug
    // this mechanism guards against violated (a duration the legs didn't account for).
    expect(result.arriveBy).toBe('08:30');
    expect(result.totalMinutes).toBe(45); // query at 07:45 -> arrive 08:30
  });
});

describe('planJourney — interchange walk-distance cap', () => {
  it('does not model a same-named-stop transfer as walkable beyond MAX_INTERCHANGE_WALK_MINUTES', () => {
    const farData = baseScheduleData();
    const farRegistry = {
      ...stopRegistry,
      S2B: ['Mid Interchange', -37.95000, 144.95000], // ~13.3km from S2 — far beyond any walkable interchange
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

describe('planJourney — cross-mode interchange by proximity, not name (tram<->train)', () => {
  // Regression coverage for buildInterchangeGroups' proximity rewrite — mirrors the real
  // Flinders Street case that motivated it: two stops ~1.5m apart (same tiny offset as
  // S2/S2B above) that share no stop_id *and* no name at all, on two entirely separate
  // per-mode schedule datasets, exactly matching train vs tram's real data shape (train:
  // "Flinders Street Station"; tram: "Flinders Street Railway Station/Elizabeth St #1").
  const ORIGIN = { id: 'CM_ORIGIN', name: 'Cross Origin', lat: -37.80000, lon: 144.95000 };
  const TRAIN_HUB = { id: 'CM_TRAIN_HUB', name: 'Flinders Street Station', lat: -37.83000, lon: 144.95000 };
  const TRAM_HUB = { id: 'CM_TRAM_HUB', name: 'Flinders Street Railway Station/Elizabeth St #1', lat: -37.83001, lon: 144.95001 };
  const DEST = { id: 'CM_DEST', name: 'Cross Dest', lat: -37.86000, lon: 144.95000 };
  const crossRegistry = Object.fromEntries(
    [ORIGIN, TRAIN_HUB, TRAM_HUB, DEST].map((s) => [s.id, [s.name, s.lat, s.lon]])
  );

  const trainData = {
    stopIds: ['CM_ORIGIN', 'CM_TRAIN_HUB'],
    routeIds: ['TRAIN_R'],
    serviceIds: ['WEEKDAY'],
    // Origin -> Flinders Street (train), depart 08:00, arrive 08:10.
    trips: { CM_T1: { r: 0, s: 0, stops: [[0, null, 8 * 3600], [1, 8 * 3600 + 600, null]] } },
    calendar: { WEEKDAY: WEEKDAY_CAL },
    calendarDates: {},
  };
  const tramData = {
    stopIds: ['CM_TRAM_HUB', 'CM_DEST'],
    routeIds: ['TRAM_R'],
    serviceIds: ['WEEKDAY'],
    // Flinders Street (tram) -> Dest, depart 08:15, arrive 08:25 — only reachable by
    // transferring from the train stop above, which shares no name or stop_id with this one.
    trips: { CM_T2: { r: 0, s: 0, stops: [[0, null, 8 * 3600 + 900], [1, 8 * 3600 + 1500, null]] } },
    calendar: { WEEKDAY: WEEKDAY_CAL },
    calendarDates: {},
  };

  it('finds a train->tram itinerary via a differently-named, physically-close interchange', () => {
    const result = planJourney({
      origin: { lat: ORIGIN.lat, lon: ORIGIN.lon },
      destination: { lat: DEST.lat, lon: DEST.lon },
      departureEpochMs: QUERY_BEFORE_0800,
      schedules: [
        { mode: 'train', data: trainData },
        { mode: 'tram', data: tramData },
      ],
      stopRegistry: crossRegistry,
    });
    expect(result.ok).toBe(true);
    expect(result.legs).toHaveLength(2);
    expect(result.legs[0].alightStop).toBe('Flinders Street Station');
    expect(result.legs[1].boardStop).toBe('Flinders Street Railway Station/Elizabeth St #1');
    expect(result.legs[1].alightStop).toBe('Cross Dest');
    expect(result.arriveBy).toBe('08:25');
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

describe('planJourney / planJourneyArrivingBy — journeys spanning the spring-forward DST transition', () => {
  const D1 = { id: 'D1', name: 'DST Origin', lat: -37.80000, lon: 144.95000 };
  const D2 = { id: 'D2', name: 'DST Dest', lat: -37.86000, lon: 144.95000 };
  const dstRegistry = Object.fromEntries([D1, D2].map((s) => [s.id, [s.name, s.lat, s.lon]]));
  const SUNDAY_CAL = { days: [0, 0, 0, 0, 0, 0, 1], start: '20260101', end: '20261231' }; // Sunday only

  const dstData = {
    stopIds: ['D1', 'D2'],
    routeIds: ['R1'],
    serviceIds: ['SUN'],
    trips: {
      // Scheduled local wall-clock: depart 01:30, arrive 03:10. 2026-10-04 is the
      // spring-forward Sunday (see the DST-boundary tests above), so this window fully
      // contains the missing 02:00-03:00 hour — real elapsed time is 40 minutes
      // (15:30Z -> 16:10Z), not the 100 minutes these raw digits naively imply.
      T1: { r: 0, s: 0, stops: [[0, null, 1 * 3600 + 1800], [1, 3 * 3600 + 600, null]] },
    },
    calendar: { SUN: SUNDAY_CAL },
    calendarDates: {},
  };
  // Local midnight, 2026-10-04 (AEST still — the transition is later that morning).
  const queryEpochMs = Date.UTC(2026, 9, 3, 14, 0, 0);

  it('reports the real elapsed duration, not the raw wall-clock-digit difference', () => {
    const result = planJourney({
      origin: { lat: D1.lat, lon: D1.lon },
      destination: { lat: D2.lat, lon: D2.lon },
      departureEpochMs: queryEpochMs,
      schedules: [{ mode: 'train', data: dstData }],
      stopRegistry: dstRegistry,
    });
    expect(result.ok).toBe(true);
    // Display strings still show plain wall-clock digits, as a real departure board would.
    expect(result.legs[0].boardTime).toBe('01:30');
    expect(result.legs[0].alightTime).toBe('03:10');
    // Real elapsed time from local midnight (query) to 03:10 AEDT arrival: 90 real
    // minutes to 01:30 (no DST involved yet) + 40 real minutes from 01:30 to 03:10
    // (crossing the gap) = 130 -- not 190 (midnight-to-01:30's 90 + the naive 100-minute
    // digit-diff for 01:30->03:10, which double-counts the lost hour).
    expect(result.totalMinutes).toBe(130);
    expect(result.arrivalEpochMs).toBe(Date.UTC(2026, 9, 3, 16, 10, 0));
  });

  it('planJourneyArrivingBy finds this trip reachable when the target is its real (not naively-computed) arrival instant', () => {
    const realArrivalEpochMs = Date.UTC(2026, 9, 3, 16, 10, 0); // true instant of 03:10 AEDT
    const result = planJourneyArrivingBy({
      origin: { lat: D1.lat, lon: D1.lon },
      destination: { lat: D2.lat, lon: D2.lon },
      arriveByEpochMs: realArrivalEpochMs,
      schedules: [{ mode: 'train', data: dstData }],
      stopRegistry: dstRegistry,
    });
    // Before the arrivalEpochMs fix, this incorrectly reported 'unreachable_by_target':
    // the old departureEpochMs + totalMinutes*60000 estimate overstated the arrival by
    // the missing hour, pushing it past the target.
    expect(result.ok).toBe(true);
    expect(result.legs[0].tripId).toBe('T1');
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

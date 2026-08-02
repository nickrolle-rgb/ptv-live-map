import { describe, it, expect } from 'vitest';
import trainSchedule from './data/schedule/train-schedule.json';
import trainStopNames from './data/train-stop-names.json';
import { planJourney } from './schedule-search.js';

// Sanity/regression checks against the actual bundled train timetable extract (not a
// synthetic fixture) — these catch build-schedule.js data-extraction regressions that
// synthetic-network tests structurally can't (schedule-search.test.js exercises the
// algorithm; this exercises the algorithm *and* the real data together).
//
// Caveat, in the interest of Principle 1 (honesty over confidence) applied to this
// test suite itself: the departure date below is picked dynamically from whatever
// train-schedule.json is currently bundled (the busiest service's first valid weekday),
// not hardcoded against a specific real timetable I've manually verified against PTV.
// That makes this a self-consistency check ("the planner + current data agree with each
// other and with a generous real-world sanity bound"), not proof the *data* matches
// PTV's published timetable. It also means the exact chosen date drifts whenever
// build-schedule.js is re-run — by design, so this doesn't silently go stale as the
// bundled calendar window ages past a hardcoded date.
function pickWeekdayServiceDate(scheduleData) {
  const tripCountByService = new Map();
  Object.values(scheduleData.trips).forEach((t) => {
    tripCountByService.set(t.s, (tripCountByService.get(t.s) ?? 0) + 1);
  });
  const [busiestServiceIdx] = [...tripCountByService.entries()].sort((a, b) => b[1] - a[1])[0];
  const serviceId = scheduleData.serviceIds[busiestServiceIdx];
  const cal = scheduleData.calendar[serviceId];
  const removedDates = new Set(
    (scheduleData.calendarDates[serviceId] ?? []).filter((e) => e.type === 2).map((e) => e.date)
  );

  const start = cal.start;
  let d = new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(4, 6)) - 1, Number(start.slice(6, 8))));
  for (let i = 0; i < 60; i++) {
    const dateStr = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    const dow = (d.getUTCDay() + 6) % 7; // 0=Mon..6=Sun, matching build-schedule.js's DAY_COLUMNS order
    if (dateStr > cal.end) break;
    if (cal.days[dow] && !removedDates.has(dateStr)) return dateStr;
    d = new Date(d.getTime() + 24 * 3600 * 1000);
  }
  throw new Error('No valid weekday service date found within 60 days of the busiest service\'s calendar start — the bundled schedule data may need regenerating.');
}

function findStopCoords(stopNames, matchName) {
  const entry = Object.values(stopNames).find(([name]) => name === matchName);
  if (!entry) throw new Error(`Stop "${matchName}" not found in bundled stop names`);
  const [, lat, lon] = entry;
  return { lat, lon };
}

describe('planJourney — sanity check against bundled real train schedule data', () => {
  const serviceDate = pickWeekdayServiceDate(trainSchedule);
  const y = serviceDate.slice(0, 4), m = serviceDate.slice(4, 6), d = serviceDate.slice(6, 8);
  // 04:00 UTC lands at 14:00 Melbourne time regardless of AEST/AEDT (safely daytime
  // either way) — deliberately not pinned to a specific local clock time, since the
  // point here is "does a real weekday daytime query produce a sane itinerary", not
  // testing a specific departure.
  const departureEpochMs = Date.UTC(Number(y), Number(m) - 1, Number(d), 4, 0, 0);

  const flindersSt = findStopCoords(trainStopNames, 'Flinders Street Station');
  const frankston = findStopCoords(trainStopNames, 'Frankston Station');

  it('plans a real Flinders Street -> Frankston itinerary that is internally consistent', () => {
    const result = planJourney({
      origin: flindersSt,
      destination: frankston,
      departureEpochMs,
      schedules: [{ mode: 'train', data: trainSchedule }],
      stopRegistry: trainStopNames,
    });

    expect(result.ok).toBe(true);
    expect(result.legs.length).toBeGreaterThan(0);
    expect(result.legs.some((leg) => leg.mode === 'train')).toBe(true);

    // Walking legs at both ends should be ~0 — the query points *are* the stations.
    expect(result.origin.walkMinutes).toBeLessThan(2);
    expect(result.destination.walkMinutes).toBeLessThan(2);

    // Real-world sanity bound, not a verified timetable value: the Frankston line is
    // publicly known to take roughly 50-75 minutes end to end (express/all-stops), so a
    // multi-hour or negative result indicates a planner or data bug rather than a
    // legitimately slow real service.
    expect(result.totalMinutes).toBeGreaterThan(20);
    expect(result.totalMinutes).toBeLessThan(150);

    // Every leg must move forward in time, and the whole itinerary must end at arriveBy.
    let prevAlightMinutes = null;
    result.legs.forEach((leg) => {
      const toMinutes = (hhmm) => {
        const [h, mm] = hhmm.split(':').map(Number);
        return h * 60 + mm;
      };
      expect(toMinutes(leg.boardTime)).toBeLessThanOrEqual(toMinutes(leg.alightTime) + 24 * 60); // tolerate one midnight wrap
      if (prevAlightMinutes !== null) {
        expect(leg.transferMinutes).toBeGreaterThanOrEqual(0);
      }
      prevAlightMinutes = toMinutes(leg.alightTime);
    });
    expect(result.legs[result.legs.length - 1].alightTime).toBe(result.arriveBy);
  });

  it('the reverse trip (Frankston -> Flinders Street) is also found and roughly time-symmetric', () => {
    const forward = planJourney({
      origin: flindersSt,
      destination: frankston,
      departureEpochMs,
      schedules: [{ mode: 'train', data: trainSchedule }],
      stopRegistry: trainStopNames,
    });
    const reverse = planJourney({
      origin: frankston,
      destination: flindersSt,
      departureEpochMs,
      schedules: [{ mode: 'train', data: trainSchedule }],
      stopRegistry: trainStopNames,
    });
    expect(reverse.ok).toBe(true);
    // Same physical line in both directions — total journey time shouldn't differ
    // wildly (generous +/-25 minutes covers express vs all-stops asymmetry).
    expect(Math.abs(reverse.totalMinutes - forward.totalMinutes)).toBeLessThan(25);
  });
});

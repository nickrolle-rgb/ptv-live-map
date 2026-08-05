# Principles

## Core use case

A single glance tells me where my tram/train actually is right now and how many
minutes until it's here — without planning a trip first — and I can trust it as
much as looking down the platform myself.

## Priorities

Location, Route name, Interruptions/Service Type, Arrival/Departure time, Next Stop,
Accurate Movement, Heading/Speed/Vehicle ID/Capacity — in that order. Lower items
are nice-to-haves; higher items are the point of the app.

## Principles

Each principle has a test attached. If a change can't be checked against one of
these, it isn't accountable — it's a vibe.

### 1. Honesty over confidence

Never display a claim (position, stop, ETA) with more certainty than the underlying
data supports. When two feeds disagree, or data is stale past a documented
threshold, show uncertainty — or nothing — rather than a confident wrong answer.

**Test:** for any displayed vehicle, you can point to the feed timestamp/field
justifying what's shown; anything past a documented staleness/sanity window is
visibly flagged, never asserted as plain fact.

### 2. Priority order is the release gate

Location → Route name → Interruptions/Service type → Arrival/Departure → Next stop
→ Accurate movement → Heading/Speed/Vehicle ID/Capacity. Lower-tier polish doesn't
ship while a higher tier is known-broken.

**Test:** before any change ships, name which tier it serves, and confirm nothing
above that tier is currently regressed.

### 3. See it without planning it

The differentiator vs. Google Maps: live vehicles are visible with zero setup — no
destination, no route selection.

**Test:** cold-open the app with no input; within 2 seconds you can see moving
vehicles and roughly how far the next one is.

### 4. Decluttered, not empty

The differentiator vs. the PTV app: less visual noise, but never at the cost of
hiding vehicles — and its genuinely good ideas get adopted, not reinvented worse
out of pride.

**Test:** side-by-side against the PTV app for the same stop — do we match its
usability while still showing vehicles on the map, which it doesn't?

**Reference example (2026-07-31):** PTV app's stop detail view (South Yarra
Railway Station #127) does several things worth learning from, if a stop-centric
departure view is ever built here:
- Departures grouped by direction ("Towards Toorak" / "Towards West Coburg"), not
  a flat list.
- Scheduled time *and* live countdown shown together ("Scheduled 8:15 pm" +
  "9 mins") — an absolute anchor next to the relative one, so a drifting or wrong
  countdown is self-evident rather than something you just have to trust. This is
  arguably a stronger instance of Principle 1 than anything we currently do.
- Disruptions flagged per-departure/trip, not per-route — more granular than this
  app's current `routeStatus()`, which flags a whole route once.
- Accessibility (low-floor tram) shown inline — a data point not currently
  surfaced here at all.
- Route filter chips scoped to the one stop being viewed.

This is a *stop-centric departure board* (tap a stop, see next N services by
direction) — a different piece of UI from the live map this app has today, not a
tweak to an existing screen. Noted here as a reference, not yet scoped as a
committed feature.

### 5. Every number traces to a named field

Position, ETA, disruption text, crowding — each must map to a specific upstream
feed field (or an explicitly-labeled derived estimate). Nothing fabricated or
guessed gets presented as reported fact.

**Test:** pick any value on screen; name the GTFS-RT field or static dataset it
came from.

## Deferred, not excluded

Route/journey planning (getting from A to B) shipped once Location through Next Stop
was solid, not before — per Principle 2, building a trip planner on shaky position/stop
data would have laundered that shakiness into a bigger-looking feature. Two planners
exist side by side: a live-first one (matches currently-active trips, so it inherits
Phase 3's live blind spots) and a full static-schedule one (Connection Scan Algorithm
over bundled GTFS timetables — correct at any query time, no live blind spot, but only
as current as the last data refresh). Both cover train, V/Line, and tram.

Bus is deferred from the static-schedule planner specifically, and it's a data-scale
problem, not a priority one: real GTFS extracts (2026-08-05) show combined tram+bus
stop_times at ~11.1M rows/894MB against train+V/Line's ~738K rows/59MB. Tram alone
turned out to be a meaningful chunk of that on its own (~90k trips, 76MB/17MB gzipped —
still bundleable directly). Metro bus is a different order of magnitude (~950 routes,
~555MB of stop_times) that the planner's current approach — load one mode's whole
schedule into memory, connection-scan across all of it — can't reasonably do; it needs
geographic pre-filtering (candidate routes near the walkable stops at each end) before
touching bus data at all, which is a real design piece, not a rerun of the tram/V-Line
build. If a narrower slice is ever wanted, Geelong's local network is cleanly
identifiable within the bus export by route_id pattern (`##-G##-aus-#`) at 67 of the
740 routes in that file — tractable on its own; Geelong is not, however, its own
separate/smaller GTFS export the way the naming suggests it might be.

## Non-goal

Not trying to out-feature the PTV app on breadth (fares, accessibility routing,
timetable browsing beyond what a live stop needs). The bet is specifically: live
vehicle visibility + trustworthy data, with journey planning built on top of that
solid foundation rather than ahead of it — nothing broader than that.

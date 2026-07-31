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

Route/journey planning (getting from A to B) is on the roadmap, not off it — but
per Principle 2 it's gated behind confidence in Location through Next Stop first.
Building a trip planner on top of shaky position/stop data would just launder that
shakiness into a bigger-looking feature; the order matters.

## Non-goal

Not trying to out-feature the PTV app on breadth (fares, accessibility routing,
timetable browsing beyond what a live stop needs). The bet is specifically: live
vehicle visibility + trustworthy data, with journey planning added later once
that foundation is solid — nothing broader than that.

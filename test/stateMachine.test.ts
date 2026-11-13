import { test } from "node:test";
import assert from "node:assert/strict";
import { TRIP_STATES, canTransition, isTerminal, nextState, InvalidTransitionError, type TripEvent } from "../src/services/trip/stateMachine.js";

test("happy path: requested → accepted → driver_arrived → started → completed", () => {
  let s = nextState("requested", "accept");
  assert.equal(s, "accepted");
  s = nextState(s, "arrive");
  assert.equal(s, "driver_arrived");
  s = nextState(s, "start");
  assert.equal(s, "started");
  s = nextState(s, "complete");
  assert.equal(s, "completed");
  assert.ok(isTerminal(s));
});

test("cancel allowed before the trip starts, not after", () => {
  for (const s of ["requested", "accepted", "driver_arrived"] as const) assert.equal(nextState(s, "cancel"), "cancelled");
  assert.throws(() => nextState("started", "cancel"), InvalidTransitionError);
  assert.throws(() => nextState("completed", "cancel"), InvalidTransitionError);
});

test("no skipping steps and no going back", () => {
  assert.throws(() => nextState("requested", "start"), InvalidTransitionError);
  assert.throws(() => nextState("accepted", "complete"), InvalidTransitionError);
  assert.throws(() => nextState("driver_arrived", "accept"), InvalidTransitionError);
  assert.throws(() => nextState("started", "arrive"), InvalidTransitionError);
});

test("terminal states accept no events", () => {
  const events: TripEvent[] = ["accept", "arrive", "start", "complete", "cancel"];
  for (const s of TRIP_STATES.filter(isTerminal)) for (const e of events) assert.equal(canTransition(s, e), false);
  assert.deepEqual(TRIP_STATES.filter(isTerminal).sort(), ["cancelled", "completed"]);
});

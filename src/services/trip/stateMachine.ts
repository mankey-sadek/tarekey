/**
 * دورة حياة الرحلة كـ State Machine:
 *
 *   requested ──accept──▶ accepted ──arrive──▶ driver_arrived ──start──▶ started ──complete──▶ completed
 *       │                    │                      │
 *       └──────cancel────────┴────────cancel────────┴──▶ cancelled
 *
 * - مفيش رجوع لورا، ومفيش تخطي (مينفعش تبدأ رحلة قبل ما الكابتن يوصل).
 * - completed و cancelled حالات نهائية.
 * - الإلغاء مش مسموح بعد ما الرحلة تبدأ (لازم تخلص).
 */
export const TRIP_STATES = [
  "requested",
  "accepted",
  "driver_arrived",
  "started",
  "completed",
  "cancelled",
] as const;
export type TripState = (typeof TRIP_STATES)[number];

export type TripEvent = "accept" | "arrive" | "start" | "complete" | "cancel";

const TRANSITIONS: Record<TripState, Partial<Record<TripEvent, TripState>>> = {
  requested: { accept: "accepted", cancel: "cancelled" },
  accepted: { arrive: "driver_arrived", cancel: "cancelled" },
  driver_arrived: { start: "started", cancel: "cancelled" },
  started: { complete: "completed" },
  completed: {},
  cancelled: {},
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: TripState,
    readonly event: TripEvent,
  ) {
    super(`Invalid transition: cannot "${event}" a trip in state "${from}"`);
    this.name = "InvalidTransitionError";
  }
}

export function nextState(from: TripState, event: TripEvent): TripState {
  const to = TRANSITIONS[from][event];
  if (!to) throw new InvalidTransitionError(from, event);
  return to;
}

export function canTransition(from: TripState, event: TripEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

export function isTerminal(state: TripState): boolean {
  return Object.keys(TRANSITIONS[state]).length === 0;
}

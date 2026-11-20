// Wire message types and rejection reasons shared by server and clients.

export const MSG = Object.freeze({
  HELLO: 'hello',
  SNAPSHOT: 'snapshot',
  GRAB: 'grab',
  GRAB_RESULT: 'grab-result',
  MOVE: 'move',
  MOVE_REJECTED: 'move-rejected',
  RELEASE: 'release',
  RELEASE_RESULT: 'release-result',
  CONTROL: 'control',
  ERROR: 'error',
  // Handover (two strategies: explicit confirm / generation-tagged timed lease)
  HANDOVER_STATE: 'handover-state',
  HANDOVER_CONFIRM: 'handover-confirm',
  HANDOVER_RESULT: 'handover-result',
  // Assembly commit points
  SLOT_LOCK: 'slot-lock',
  SLOT_RESULT: 'slot-result',
  PRESS: 'press',
  PRESS_RESULT: 'press-result',
  // Client belief reports -> server-side experiment metrics
  REPORT_STATE: 'report-state',
  METRICS: 'metrics',
});

export const REASON = Object.freeze({
  HELD_BY_OTHER: 'held-by-other',
  ALREADY_HELD: 'already-held',
  NOT_HOLDER: 'not-holder',
  NOT_HELD: 'not-held',
  STALE_EPOCH: 'stale-epoch',
  NO_ENTITY: 'no-entity',
  BAD_PAYLOAD: 'bad-payload',
  // handover
  HANDOVER_PENDING: 'handover-pending',
  NO_PENDING: 'no-pending-handover',
  STALE_REQUEST: 'stale-request',
  CONFIRM_TIMEOUT: 'confirm-timeout',
  REQUESTER_GONE: 'requester-gone',
  // slot / button
  NO_SLOT: 'no-slot',
  NOT_AT_SLOT: 'not-at-slot',
  ALREADY_LOCKED: 'already-locked',
  LOCKED: 'locked',
});

// Every rejected commit names the step that did not take effect, so a late
// client can tell exactly which of its actions the authority dropped.
export const STEP = Object.freeze({
  MOVE: 'move',
  ROTATE: 'rotate',
  RELEASE: 'release',
  SLOT_LOCK: 'slot-lock',
  PRESS: 'press',
  CONFIRM: 'handover-confirm',
});

export const STRATEGY = Object.freeze({
  CONFIRM: 'confirm',
  LEASE: 'lease',
});

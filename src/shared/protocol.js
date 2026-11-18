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
});

export const REASON = Object.freeze({
  HELD_BY_OTHER: 'held-by-other',
  ALREADY_HELD: 'already-held',
  NOT_HOLDER: 'not-holder',
  NOT_HELD: 'not-held',
  STALE_EPOCH: 'stale-epoch',
  NO_ENTITY: 'no-entity',
  BAD_PAYLOAD: 'bad-payload',
});

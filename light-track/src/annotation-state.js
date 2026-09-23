// UI operations have one pending transaction; dirty labels cannot be abandoned.
const transitions = {
  READY: { EDIT: 'DIRTY', BEGIN: 'BUSY' },
  DIRTY: { EDIT: 'DIRTY', BEGIN: 'BUSY' },
  BUSY: { DONE: 'READY', RESTORE: 'DIRTY' },
};
export function annotationTransition(state, event) {
  const next = transitions[state]?.[event];
  if (!next) throw new Error(`Invalid annotation transition: ${state} / ${event}`);
  return next;
}

const collectionTransitions = {
  IDLE: { START: 'CONNECTING' },
  CONNECTING: { READY: 'WAITING', STOP: 'STOPPING', FAIL: 'ERROR' },
  WAITING: { VALID: 'COLLECTING', INVALID: 'WAITING', STOP: 'STOPPING', FAIL: 'ERROR' },
  COLLECTING: { VALID: 'COLLECTING', INVALID: 'WAITING', STOP: 'STOPPING', FAIL: 'ERROR' },
  ERROR: { START: 'CONNECTING', STOP: 'STOPPING' },
  STOPPING: { STOPPED: 'IDLE', FAIL: 'ERROR' },
};
export function collectionTransition(state, event) {
  const next = collectionTransitions[state]?.[event];
  if (!next) throw new Error(`Invalid collection transition: ${state} / ${event}`);
  return next;
}

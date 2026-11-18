// Pure client-side control state machine.
// A grab GESTURE is strictly separate from being GRANTED control:
// rendering of parts always follows authoritative snapshots, never the gesture.
//
// States: 'idle' -> 'gesturing' -> 'holding' -> 'idle'

export function reduceControl(state, event) {
  switch (event.type) {
    case 'gesture':
      return state === 'idle' ? 'gesturing' : state;
    case 'granted':
      return 'holding';
    case 'denied':
      return state === 'gesturing' ? 'idle' : state;
    case 'release':
      return state === 'holding' ? 'idle' : state;
    case 'snapshot': {
      // Authoritative correction from the server.
      if (event.holder === event.me) {
        return state === 'idle' ? state : 'holding';
      }
      return state === 'idle' ? state : 'idle';
    }
    default:
      return state;
  }
}

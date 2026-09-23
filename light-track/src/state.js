export const initialState = () => ({ phase:'stopped' });
const inactive = state => ['stopped','requesting'].includes(state.phase);
export function transition(state,event) {
  switch (event.type) {
    case 'REQUEST': return state.phase==='stopped'?{phase:'requesting'}:state;
    case 'START': return inactive(state)?{phase:'observing'}:state;
    case 'FRAME': return inactive(state)?state:{phase:!event.hasModel?'model-required':event.low?'low-reliability':'estimating'};
    case 'STALE': return inactive(state)?state:{phase:'stale-input'};
    case 'RESET': return inactive(state)?state:{phase:'observing'};
    case 'STOP': return initialState();
    default: return state;
  }
}

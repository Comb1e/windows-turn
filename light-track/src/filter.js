export class OneEuroFilter {
  constructor(settings) { this.settings = settings; this.reset(); }
  reset() { this.time=null; this.raw=null; this.value=null; this.derivative=0; }
  update(value, timestampMs) {
    if (!Number.isFinite(value) || !Number.isFinite(timestampMs)) throw new Error('Invalid filter input.');
    if (this.time !== null && timestampMs <= this.time) return this.value;
    const dt = this.time === null ? null : (timestampMs-this.time)/1000;
    if (dt === null || dt > this.settings.resetGapSeconds) {
      this.time=timestampMs; this.raw=value; this.value=value; this.derivative=0; return value;
    }
    const alpha = cutoff => 1/(1+1/(2*Math.PI*cutoff*dt));
    const aD=alpha(this.settings.derivativeCutoff), d=(value-this.raw)/dt;
    this.derivative=aD*d+(1-aD)*this.derivative;
    const a=alpha(this.settings.minCutoff+this.settings.beta*Math.abs(this.derivative));
    this.value=a*value+(1-a)*this.value; this.raw=value; this.time=timestampMs;
    return this.value;
  }
}

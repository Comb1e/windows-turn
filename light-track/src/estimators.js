import { Estimator } from './model.js';

export class LightingEstimator {
  constructor(model,config) {this.estimator=new Estimator(model,config);this.capture=model.capture;this.angleRange=model.angleRange;}
  reset() {this.estimator.reset();}
  update(frame,timestamp,{lighting}) {
    if(this.capture && (frame.width!==this.capture.width || frame.height!==this.capture.height)) {
      throw new Error(`Lighting model requires ${this.capture.width}×${this.capture.height} processed frames; received ${frame.width}×${frame.height}. Use the capture settings saved in the model.`);
    }
    const legacy=this.estimator.update(lighting,timestamp);
    return {angle:legacy.angle,timestamp,state:'tracking',quality:{reliability:legacy.reliability},referenceId:null,legacy};
  }
}

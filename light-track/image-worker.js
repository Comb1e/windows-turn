import { PythonWorker } from './python-worker.js';

/** Shared worker transport preserves one occupied request across timeouts. */
export class ImageWorker {
  constructor(root,config) {
    this.config=config;
    this.transport=new PythonWorker(root,{...config,tracking:{...config.tracking,workerTimeoutMs:config.imageInference.workerTimeoutMs}},undefined,'image_worker.py');
    this.binding=null;
  }
  async frame(session,meta,bytes,features) {
    const binding=`${session.id}:${session.modelGeneration}:${session.model.modelId}`;
    if(this.transport.pending)throw new Error('Image worker busy; keep only the newest frame');
    if(this.binding!==binding) {
      const info=await this.transport.request('reset',{sessionId:binding,model:session.model,backend:this.config.imageInference.backend});
      if(info.sessionId!==binding)throw new Error('Mismatched image worker initialization');
      this.binding=binding;
    }
    const result=await this.transport.request('frame',{...meta,sessionId:binding,rgba:bytes.toString('base64'),features});
    if(result.sessionId!==binding||result.frameId!==meta.frameId||result.timestampMs!==meta.timestampMs)throw new Error('Obsolete image worker response');
    return {...result,spread:0,distance:0};
  }
  close(){this.binding=null;this.transport.close();}
}

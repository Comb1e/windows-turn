/** One running request and one replaceable pending frame per independent service. */
export class LatestQueue {
  constructor(run,onError=()=>{}){this.run=run;this.onError=onError;this.pending=null;this.running=null;this.closed=false;this.dropped=0;}
  push(value){if(this.closed)return;if(this.pending)this.dropped++;this.pending=value;this.drain();}
  drain(){
    if(this.running||!this.pending||this.closed)return;
    const value=this.pending;this.pending=null;
    this.running=Promise.resolve().then(()=>this.run(value)).catch(this.onError).finally(()=>{this.running=null;this.drain();});
  }
  close(){this.closed=true;this.pending=null;}
}

export async function requestJson(base,path,{method='GET',body,headers={},timeoutMs=20000}={}) {
  const response=await fetch(new URL(path,base),{method,headers:{...(body&&!Buffer.isBuffer(body)?{'Content-Type':'application/json'}:{}),...headers},
    body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
  const data=await response.json();
  if(!response.ok)throw Object.assign(new Error(data.error||`Service returned ${response.status}`),{status:response.status});
  return data;
}

export class ServiceClient {
  constructor(kind,url,camera,settings,onResult,onError,sessionOptions={}){Object.assign(this,{kind,url,camera,settings,onResult,onError,sessionOptions});this.id=null;this.closed=false;this.retryAt=0;this.minimumGeneration=0;
    this.queue=new LatestQueue(frame=>this.process(frame),error=>{this.onError(error);});}
  connect(){
    if(!this.connecting)this.connecting=this.open().finally(()=>{this.connecting=null;});return this.connecting;
  }
  async open(){
    if(this.closed||Date.now()<this.retryAt)return false;
    try{
      const result=await requestJson(this.url,'/v1/sessions',{method:'POST',body:{camera:this.camera,...this.sessionOptions},timeoutMs:this.settings.requestTimeoutMs});
      if(this.closed){await requestJson(this.url,`/v1/sessions/${result.sessionId}`,{method:'DELETE'});return false;}
      this.id=result.sessionId;this.info=result;this.minimumGeneration=result.modelGeneration??0;return true;
    } catch(error){this.retryAt=Date.now()+this.settings.retryMs;this.onError(error);return false;}
  }
  async process(frame){
    if(!this.id&&!await this.connect())return;
    const id=this.id;
    try{
      const result=await requestJson(this.url,`/v1/sessions/${id}/frames`,{method:'POST',body:frame.bytes,timeoutMs:this.settings.requestTimeoutMs,headers:{
        'Content-Type':'application/octet-stream','X-Frame-Id':String(frame.frameId),'X-Timestamp-Ms':String(frame.timestampMs),
        'X-Width':String(frame.width),'X-Height':String(frame.height),'X-Camera-Settings':encodeURIComponent(JSON.stringify(frame.camera))}});
      if(!this.closed&&this.id===id&&result.sessionId===id&&result.frameId===frame.frameId&&result.timestampMs===frame.timestampMs
        &&(result.modelGeneration??0)>=this.minimumGeneration)this.onResult(result,frame);
    } catch(error){
      // Keep ownership after a processing timeout; retrying cannot overtake the server's busy slot.
      if(error.status===409&&/expired/i.test(error.message))this.id=null;
      throw error;
    }
  }
  async call(operation,body,method='POST'){
    if(!this.id)throw new Error(`${this.kind} service is unavailable`);
    return requestJson(this.url,`/v1/sessions/${this.id}/${operation}`,{method,body,timeoutMs:this.settings.requestTimeoutMs});
  }
  async activate(profileId){
    this.sessionOptions={profileId,mode:profileId?'measurement':'features-only',initialization:'model-output'};
    if(!this.id&&!await this.connect())throw new Error('Lighting service is unavailable');
    const result=await this.call('profile',{profileId});this.minimumGeneration=result.modelGeneration;return result;
  }
  async close(){this.closed=true;this.queue.close();const id=this.id;this.id=null;
    if(id)await requestJson(this.url,`/v1/sessions/${id}`,{method:'DELETE',timeoutMs:this.settings.healthTimeoutMs}).catch(()=>{});}
}

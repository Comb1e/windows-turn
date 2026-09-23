import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { trainingPython, runTrainingCommand } from './training-runtime.js';
import { validateModel } from './src/model.js';

/** Explicit fitting lifecycle; only completed immutable profiles are published. */
export class SceneCalibration {
  constructor(root,config,store,training,profiles) {
    Object.assign(this,{root,config,store,training,profiles});this.jobs=new Map();this.closed=false;
  }
  async start({groupId,revision,baseJobId}) {
    if(this.closed)throw new Error('Scene calibration is shutting down');
    if([...this.jobs.values()].some(j=>j.status.state==='Fitting'))throw Object.assign(new Error('Scene calibration is already fitting'),{status:409});
    this.store.path(groupId);this.store.path(baseJobId);
    while(this.jobs.size>=this.config.annotation.training.maxJobs)this.jobs.delete(this.jobs.keys().next().value);
    const job={status:{jobId:randomUUID(),state:'Fitting',groupId,baseJobId,createdAt:new Date().toISOString(),error:null},controller:new AbortController()};
    this.jobs.set(job.status.jobId,job);
    job.done=this.run(job,revision);return {...job.status};
  }
  status(id){const job=this.jobs.get(id);if(!job)throw new Error('Unknown scene calibration job');return {...job.status};}
  async run(job,revision) {
    const {status}=job, pending=join(this.profiles.directory,'.pending-scene-'+status.jobId),output=join(pending,'output');
    let releaseUsage;
    try {
      releaseUsage=await this.store.acquireUsage(status.groupId,'scene-profile fitting');
      const group=await this.store.get(status.groupId);this.store.checkRevision(group,revision);
      if(group.state!=='CLOSED')throw new Error('End the calibration session before fitting');
      const model=validateModel(JSON.parse(await this.training.artifact(status.baseJobId,'model')),this.config.features);
      if(model.kind==='scene-calibrated-model')throw new Error('Choose an uncalibrated base model');
      if(model.coverage?.device!==group.metadata.device)throw new Error('Calibration laptop differs from the base model');
      await mkdir(pending,{recursive:true});
      const input=join(pending,'input.json');
      await writeFile(input,JSON.stringify({group,model,config:this.config,directory:this.store.directory}),{flag:'wx'});
      await runTrainingCommand(trainingPython(this.root),[join(this.root,'research/fit_scene_profile.py'),input,'--output',output],
        {cwd:this.root,signal:job.controller.signal,timeoutMs:this.config.sceneCalibration.maxTrainingMs});
      const fitted=validateModel(JSON.parse(await readFile(join(output,'model.json'),'utf8')),this.config.features);
      this.store.checkRevision(await this.store.get(group.groupId),revision);
      if(job.controller.signal.aborted)throw new Error('Calibration invalidated');
      const profile={kind:'scene-calibration',profileId:status.jobId,name:`${group.metadata.lighting} · ${fitted.referenceCount} references`,
        createdAt:status.createdAt,metadata:group.metadata,provisional:true,coverage:fitted.referenceRange,capture:fitted.capture,
        referenceCount:fitted.referenceCount,baseModelId:model.modelId,modelId:fitted.modelId,
        sourceHash:createHash('sha256').update(JSON.stringify(group)).digest('hex')};
      await writeFile(join(output,'references.json'),JSON.stringify(group),{flag:'wx'});
      await writeFile(join(output,'profile.json'),JSON.stringify(profile),{flag:'wx'});
      await rename(output,this.profiles.path(profile.profileId));
      Object.assign(status,{state:'Ready',profileId:profile.profileId,referenceCount:fitted.referenceCount,coverage:fitted.referenceRange});
    } catch(error){status.state=job.controller.signal.aborted?'Invalidated':'Failed';status.error=error.message;}
    finally {releaseUsage?.();}
  }
  async cancel(id){const job=this.jobs.get(id);if(!job)throw new Error('Unknown scene calibration job');if(job.status.state==='Fitting'){job.controller.abort();await job.done;}return this.status(id);}
  async close(){this.closed=true;for(const job of this.jobs.values())if(job.status.state==='Fitting')job.controller.abort();await Promise.allSettled([...this.jobs.values()].map(j=>j.done));}
}

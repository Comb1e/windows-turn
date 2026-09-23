import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateModel } from './src/model.js';

const json=async path=>JSON.parse(await readFile(path,'utf8'));
const save=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
export class ProfileStore {
  constructor(root,config,settings={}){
    this.root=root;this.config=config;this.c={directory:'data/profiles',...settings};
    this.directory=resolve(root,this.c.directory);
  }
  path(id){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid profile ID');return join(this.directory,id);}
  async selected(){try{return (await json(join(this.directory,'selected.json'))).profileId;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  async list(){
    await mkdir(this.directory,{recursive:true});const profiles=[];
    for(const entry of await readdir(this.directory,{withFileTypes:true}))if(entry.isDirectory()&&/^[a-f0-9-]{36}$/.test(entry.name)){
      try{profiles.push(await json(join(this.path(entry.name),'profile.json')));}catch{/* Incomplete profiles are never published. */}
    }
    return {profiles:profiles.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),selectedProfileId:await this.selected()};
  }
  async get(id){const directory=this.path(id);return {profile:await json(join(directory,'profile.json')),model:validateModel(await json(join(directory,'model.json')),this.config.features)};}
  async select(id){
    if(id!==null)await this.get(id);await mkdir(this.directory,{recursive:true});
    const temporary=join(this.directory,`selected-${randomUUID()}.tmp`);await save(temporary,{profileId:id});await rename(temporary,join(this.directory,'selected.json'));
  }
  async publishImage(id,model,report) {
    this.path(id);validateModel(model,this.config.features);
    if(model.version!==2||model.kind!=='image-angle-model'||!report.promotionPassed||!report.runtimeGate)throw new Error('Only evaluated image models can be published');
    await mkdir(this.directory,{recursive:true});
    const pending=join(this.directory,'.pending-image-'+id);await mkdir(pending,{recursive:false});
    const profile={kind:'image-model',profileId:id,name:`Image model · ${model.coverage.screenshots} screenshots`,
      createdAt:new Date().toISOString(),metadata:{device:model.coverage.device,location:'Multiple recorded lighting groups'},
      capture:model.capture,modelId:model.modelId,coverage:model.angleRange,provisional:true};
    await save(join(pending,'model.json'),model);await save(join(pending,'report.json'),report);await save(join(pending,'profile.json'),profile);
    await rename(pending,this.path(id));return profile;
  }
  async export(id){const result=await this.get(id);for(const key of result.profile.kind==='scene-calibration'?['references','report']:result.profile.kind==='image-model'?['report']:['recording','sweep','report','parity'])result[key]=await json(join(this.path(id),key+'.json'));return result;}
}

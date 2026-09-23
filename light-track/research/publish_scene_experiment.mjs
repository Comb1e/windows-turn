import { readFile,writeFile,mkdir,copyFile,rename } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { validateModel } from '../src/model.js';
import { trainingPython,runTrainingCommand } from '../training-runtime.js';
import { ProfileStore } from '../profile-store.js';

const root=fileURLToPath(new URL('..',import.meta.url));
const config=JSON.parse(await readFile(join(root,'config.json')));
const input=resolve(process.argv[2]||'');
if(!process.argv[2])throw new Error('Usage: node research/publish_scene_experiment.mjs <evaluated-directory>');
const id=randomUUID(),directory=resolve(root,config.annotation.training.directory),pending=join(directory,'.pending-'+id),output=join(pending,'output');
await mkdir(output,{recursive:true});
for(const name of ['candidate-model.json','report.json'])await copyFile(join(input,name),join(output,name));
await runTrainingCommand(trainingPython(root),[join(root,'research/publish_image_candidate.py'),output,resolve(root,config.annotation.directory),'--backend',config.imageInference.backend],
  {cwd:root,timeoutMs:config.annotation.training.imageTrainingMs});
const model=validateModel(JSON.parse(await readFile(join(output,'model.json'))),config.features);
const report=JSON.parse(await readFile(join(output,'report.json')));
const timestamp=new Date().toISOString();
const metric=s=>({evaluatedGroups:s.groups,meanGroupMAE:s.mae,meanGroupP95:s.p95,meanGroupWithin5:s.within5});
const job={jobId:id,method:'image',state:'READY',phase:'READY',createdAt:timestamp,completedAt:timestamp,modelId:model.modelId,coverage:model.coverage,
  modelUrl:`/annotations/api/training/${id}/model`,reportUrl:`/annotations/api/training/${id}/report`,
  diagnostic:{baseline:metric(report.protocols.group.summaries.current),selectedProcedure:metric(report.protocols.group.summaries['selected-procedure'])}};
await writeFile(join(output,'job.json'),JSON.stringify(job),{flag:'wx'});
await rename(output,join(directory,id));
// A global image profile also makes the promoted model selectable from Fusion.
await new ProfileStore(root,config).publishImage(id,model,report);
console.log(JSON.stringify({jobId:id,modelId:model.modelId,model:join(directory,id,'model.json'),profileId:id},null,2));

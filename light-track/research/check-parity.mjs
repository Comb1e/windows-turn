import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { validateModel, infer } from '../src/model.js';
import { OneEuroFilter } from '../src/filter.js';

const [modelPath, parityPath]=process.argv.slice(2);
if(!modelPath || !parityPath) throw new Error('Usage: node research/check-parity.mjs <model.json> <parity.json>');
const model=JSON.parse(await readFile(modelPath,'utf8')), parity=JSON.parse(await readFile(parityPath,'utf8'));
validateModel(model,model.featureConfig);
parity.features.forEach((features,i)=>assert.ok(Math.abs(infer(model,features).raw-parity.predictions[i])<1e-8,`Tree prediction ${i} differs`));
const filter=new OneEuroFilter(model.filter);
parity.filter.values.forEach((v,i)=>assert.ok(Math.abs(filter.update(v,parity.filter.timestamps[i])-parity.filter.outputs[i])<1e-8,`Filter output ${i} differs`));
console.log(`Python/browser parity passed: ${parity.features.length} predictions, ${parity.filter.values.length} filter samples.`);

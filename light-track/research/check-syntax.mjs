import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const files=[...(await readdir('.')).filter(f=>f.endsWith('.js')),...(await readdir('src')).filter(f=>f.endsWith('.js')).map(f=>`src/${f}`),...(await readdir('research')).filter(f=>f.endsWith('.mjs')).map(f=>`research/${f}`)];
for(const file of files) {const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(result.status!==0)process.exit(result.status || 1);}
console.log(`Syntax checked ${files.length} application modules.`);

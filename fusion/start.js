import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { specifications, StackLauncher } from './src/launcher.js';

const root=fileURLToPath(new URL('.',import.meta.url));
const options={},args=process.argv.slice(2);
for(let i=0;i<args.length;i++){
  if(args[i]==='--help'){
    console.log('Usage: npm start -- [--config path] [--model path] [--python executable]\nStarts or reuses Keyboard, Light Track and Fusion. Ctrl+C stops only services launched here.\nFor Fusion alone: npm run start:coordinator');process.exit(0);
  }
  if(!['--config','--model','--python'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw new Error('Unknown option. Use npm start -- --help');
  options[args[i].slice(2)]=args[++i];
}
const configPath=resolve(options.config||resolve(root,'config.json'));
const config=JSON.parse(await readFile(configPath,'utf8'));
const defaults=JSON.parse(await readFile(resolve(root,'config.json'),'utf8')).startup;
config.startup={...defaults,...config.startup};
const launcher=new StackLauncher(config.startup,{onStopped:failed=>{if(failed)process.exitCode=1;if(process.connected)process.disconnect();}});
async function shutdown(){await launcher.stop();if(launcher.failed)process.exitCode=1;if(process.connected)process.disconnect();}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void shutdown());
process.on('message',message=>{if(message?.type==='shutdown')void shutdown();});
process.once('disconnect',()=>void shutdown());
try{await launcher.start(specifications(config,root,configPath,options));}
catch(error){console.error(error.message);process.exitCode=1;}

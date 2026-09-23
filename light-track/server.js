import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { LightingServer } from './lighting-server.js';
import { AnnotationServer } from './annotation-server.js';

const root=fileURLToPath(new URL('.',import.meta.url));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json'};
const args=process.argv.slice(2), runtimeConfig={showVideo:true};
let modelPath=null, modelText=null;
try {
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--help') {
      console.log('Usage: npm start -- [--no-video | --video] [--model <path>]\nPreview defaults to visible. Model inference requires a trained artifact. PORT defaults to 1818.');
      process.exit(0);
    } else if(args[i]==='--no-video') runtimeConfig.showVideo=false;
    else if(args[i]==='--video') runtimeConfig.showVideo=true;
    else if(args[i]==='--model' && args[i+1] && !args[i+1].startsWith('--')) modelPath=resolve(args[++i]);
    else throw new Error(`Invalid option: ${args[i]}. Use --help.`);
  }
  const config=JSON.parse(await readFile(resolve(root,'config.json'),'utf8'));
  if(modelPath) {
    if((await stat(modelPath)).size>config.modelSelection.maxBytes) throw new Error(`Model exceeds ${config.modelSelection.maxBytes/1000000} MB. Export a smaller ensemble.`);
    modelText=await readFile(modelPath,'utf8'); JSON.parse(modelText);
  }
  const port=Number(process.env.PORT || 1818);
  if(!Number.isInteger(port) || port<0 || port>65535) throw new Error('PORT must be an integer from 0 to 65535.');
  const annotations=new AnnotationServer(root,config);
  const lighting=new LightingServer(root,config,JSON.parse(await readFile(resolve(root,'service-config.json'),'utf8')),modelText?JSON.parse(modelText):null);
  const server=createServer(async(req,res)=>{
    try {
      const pathname=new URL(req.url,'http://localhost').pathname;
      if(pathname.startsWith('/tracking/')) {res.writeHead(410,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Geometric setup was removed. Use screenshot annotations at /annotate.'}));return;}
      if(pathname.startsWith('/annotations/api/')) {await annotations.handle(req,res);return;}
      if(pathname.startsWith('/v1/')) {await lighting.handle(req,res);return;}
      let content, type='application/json';
      if(pathname==='/runtime-config.json') content=JSON.stringify(runtimeConfig);
      else if(pathname==='/config.json') content=JSON.stringify(config);
      else if(pathname==='/model.json') {
        if(!modelText) {res.writeHead(404).end('Model required');return;}
        content=modelText;
      } else {
        // Serve application assets only; research datasets and arbitrary JSON stay private.
        const asset=pathname==='/'?'index.html':pathname==='/annotate'?'annotation.html':pathname.slice(1);
        if(!['index.html','annotation.html','annotation.css','style.css','config.json'].includes(asset) && !/^src\/[a-z-]+\.js$/.test(asset)) {res.writeHead(404).end('Not found');return;}
        content=await readFile(resolve(root,asset)); type=types[extname(asset)];
      }
      res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(content);
    } catch {res.writeHead(404).end('Not found');}
  });
  server.on('close',()=>{lighting.close();void annotations.close().catch(()=>{});});
  let shuttingDown=false;
  const shutdown=async()=>{if(shuttingDown)return;shuttingDown=true;lighting.close();
    await annotations.close().catch(error=>console.error(error.message));server.close();if(process.connected)process.disconnect();};
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,shutdown);
  process.on('message',message=>{if(message?.type==='shutdown')shutdown();});
  process.once('disconnect',shutdown);
  server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`Port ${port} is already in use. Stop the existing server or set PORT to another port.`:error.message);process.exitCode=1;});
  server.listen(port,'127.0.0.1',()=>console.log(`Light Track ready at http://localhost:${server.address().port}`));
} catch(error) {console.error(`Startup failed: ${error.message}`);process.exitCode=1;}

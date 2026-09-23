import { AnnotationStore } from './annotation-store.js';
import { readBody } from './lighting-server.js';
import { AnnotationCollection } from './annotation-collection.js';
import { AnnotationTraining } from './annotation-training.js';
import { ProfileStore } from './profile-store.js';
import { SceneCalibration } from './scene-calibration.js';

export class AnnotationServer {
  constructor(root, config) {
    this.store = new AnnotationStore(root, config); this.config = config;
    this.collection = new AnnotationCollection(this.store, config);
    this.training = new AnnotationTraining(root, config, this.store);
    this.scene = new SceneCalibration(root,config,this.store,this.training,new ProfileStore(root,config));
  }
  close() { return Promise.all([this.collection.close(), this.training.close(),this.scene.close()]); }
  async handle(req, res) {
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { send(403, { error: 'Use the local annotation page' }); return; }
      const parts = new URL(req.url, 'http://localhost').pathname.split('/').filter(Boolean).slice(2);
      const [resource, id, action, sampleId] = parts;
      if(resource==='scene-calibration') {
        if(parts.length>2){send(404,{error:'Unknown scene calibration route'});return;}
        if(!id&&req.method==='POST')send(202,await this.scene.start(JSON.parse((await readBody(req,this.config.annotation.maxMetadataBytes)).toString())));
        else if(id&&req.method==='GET')send(200,this.scene.status(id));
        else if(id&&req.method==='DELETE')send(200,await this.scene.cancel(id));
        else send(405,{error:'Unsupported scene calibration operation'});
        return;
      }
      if (resource === 'training') {
        if (parts.length > 3) { send(404, { error: 'Unknown training route' }); return; }
        if (!id && req.method === 'POST') send(202, await this.training.start(JSON.parse((await readBody(req,this.config.annotation.maxMetadataBytes)).toString()||'{}')));
        else if (!id && req.method === 'GET') send(200, await this.training.list());
        else if (id && !action && req.method === 'GET') send(200, await this.training.status(id));
        else if (id && action && req.method === 'GET') {
          const content = await this.training.artifact(id, action);
          res.setHeader('Content-Disposition', `attachment; filename="light-track-${id}-${action}.json"`);
          send(200, JSON.parse(content));
        } else send(405, { error: 'Unsupported training operation' });
        return;
      }
      if (resource !== 'groups' || parts.length > 4) { send(404, { error: 'Unknown annotation route' }); return; }
      const body = async () => JSON.parse((await readBody(req, this.config.annotation.maxMetadataBytes)).toString('utf8'));
      if (!id && req.method === 'GET') send(200, await this.store.list());
      else if (!id && req.method === 'POST') send(201, this.store.summary(await this.store.create((await body()).metadata)));
      else if (!action && req.method === 'GET') send(200, this.store.summary(await this.store.get(id)));
      else if (action === 'export' && !sampleId && req.method === 'GET') send(200, await this.store.get(id));
      else if (action === 'close' && !sampleId && req.method === 'POST') {
        const data = await body(), active = this.collection.current;
        if (active?.groupId === id) await this.collection.stop(id, active.id);
        send(200, this.store.summary(await this.store.close(id, data.revision)));
      }
      else if (action === 'collection' && !sampleId && req.method === 'POST') send(201, await this.collection.start(id, await body()));
      else if (action === 'collection' && sampleId && req.method === 'DELETE') send(200, await this.collection.stop(id, sampleId));
      else if (action === 'collection' && sampleId && req.method === 'POST') {
        if (req.headers['content-type'] !== 'application/octet-stream') throw new Error('Send RGBA collection bytes');
        const meta = JSON.parse(decodeURIComponent(req.headers['x-screenshot'] || 'null'));
        send(200, await this.collection.frame(id, sampleId, meta, await readBody(req, this.config.annotation.maxPixels * 4)));
      }
      else if (action === 'images' && !sampleId && req.method === 'POST') {
        if (req.headers['content-type'] !== 'application/octet-stream') throw new Error('Send RGBA screenshot bytes');
        const meta = JSON.parse(decodeURIComponent(req.headers['x-screenshot'] || 'null'));
        if (!meta || typeof meta !== 'object') throw new Error('Missing screenshot metadata');
        send(201, await this.store.append(id, meta, await readBody(req, this.config.annotation.maxPixels * 4)));
      } else if (action === 'images' && sampleId && req.method === 'GET') send(200, await this.store.image(id, sampleId), 'image/png');
      else if (action === 'images' && sampleId && req.method === 'DELETE') send(200, await this.store.deletePhoto(id, sampleId, (await body()).revision));
      else if (action === 'labels' && sampleId && req.method === 'PUT') send(200, await this.store.label(id, sampleId, await body()));
      else send(405, { error: 'Unsupported annotation operation' });
    } catch (error) { send(error.status || (error.code === 'ENOENT' ? 404 : 400), { error: error.message }); }
  }
}

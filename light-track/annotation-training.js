import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateModel } from './src/model.js';
import { trainingPython, runTrainingCommand } from './training-runtime.js';
import { ProfileStore } from './profile-store.js';

export class AnnotationTraining {
  constructor(root, config, store) {
    Object.assign(this, { root, config, store });
    this.directory = resolve(root, config.annotation.training.directory); this.jobs = new Map(); this.closed = false;
  }
  path(id) { this.store.path(id); return join(this.directory, id); }
  async list() {
    let entries;
    try { entries = await readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return [...this.jobs.values()].map(j => j.status); throw error; }
    const saved = new Map();
    for (const entry of entries) if (entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name)) {
      const job = JSON.parse(await readFile(join(this.path(entry.name), 'job.json'), 'utf8')); saved.set(job.jobId, job);
    }
    for (const [id, job] of this.jobs) saved.set(id, job.status);
    return [...saved.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async status(id) {
    this.path(id);
    return this.jobs.get(id)?.status ?? JSON.parse(await readFile(join(this.path(id), 'job.json'), 'utf8'));
  }
  async start({method='legacy'}={}) {
    if(!['legacy','image'].includes(method))throw new Error('Unknown annotation training method');
    if (this.closed) throw new Error('Annotation server is shutting down.');
    if ([...this.jobs.values()].some(j => j.status.state === 'RUNNING')) throw Object.assign(new Error('Annotation training is already running.'), { status: 409 });
    const id = randomUUID(), job = { status: { jobId: id, method, state: 'RUNNING', phase: 'TRAINING', createdAt: new Date().toISOString(), error: null },
      controller: new AbortController() };
    this.jobs.set(id, job);
    while (this.jobs.size > this.config.annotation.training.maxJobs) this.jobs.delete(this.jobs.keys().next().value);
    // Set ownership before the first await so concurrent clicks cannot launch duplicate trainers.
    job.done = this.run(job);
    return { ...job.status };
  }
  async run(job) {
    const status = job.status, pending = join(this.directory, '.pending-' + status.jobId), output = join(pending, 'output');
    let releaseUsage;
    try {
      releaseUsage = await this.store.acquireUsage('*', 'annotation training');
      const groups = await this.store.list();
      if (!groups.some(g => g.state === 'CLOSED' && g.labeled > 0)) throw new Error('End at least one session with saved angle labels before training.');
      await mkdir(pending, { recursive: true });
      const configPath = join(pending, 'config.json');
      await writeFile(configPath, JSON.stringify(this.config), { flag: 'wx' });
      const image=status.method==='image';
      const options = { cwd: this.root, signal: job.controller.signal, timeoutMs: image?this.config.annotation.training.imageTrainingMs:this.config.annotation.training.maxTrainingMs };
      if(image) {
        await runTrainingCommand(trainingPython(this.root),[join(this.root,'research/scene_experiment.py'),this.store.directory,'--output',output,'--app-config',configPath,'--backend',this.config.imageInference.backend],options);
        status.phase='VALIDATING';
        await runTrainingCommand(trainingPython(this.root),[join(this.root,'research/publish_image_candidate.py'),output,this.store.directory,'--backend',this.config.imageInference.backend],options);
      } else {
        await runTrainingCommand(trainingPython(this.root), [join(this.root, 'research/train_annotations.py'), this.store.directory,
          '--output', output, '--config', configPath], options);
        status.phase = 'VALIDATING';
        await runTrainingCommand(process.execPath, [join(this.root, 'research/check-parity.mjs'), join(output, 'model.json'), join(output, 'parity.json')], options);
      }
      const model = validateModel(JSON.parse(await readFile(join(output, 'model.json'), 'utf8')), this.config.features);
      const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
      if(image) {
        const metric=s=>({evaluatedGroups:s.groups,meanGroupMAE:s.mae,meanGroupP95:s.p95,meanGroupWithin5:s.within5});
        report.comparison={baseline:metric(report.protocols.group.summaries.current),selectedProcedure:metric(report.protocols.group.summaries['selected-procedure'])};
      }
      if (job.controller.signal.aborted) throw new Error('Training cancelled');
      const published = { ...status, state: 'READY', phase: 'READY', completedAt: new Date().toISOString(),
        modelId: model.modelId, coverage: model.coverage, modelUrl: `/annotations/api/training/${status.jobId}/model`,
        reportUrl: `/annotations/api/training/${status.jobId}/report`,
        diagnostic: report.comparison ? { baseline: report.comparison.baseline,
          selectedProcedure: report.comparison.selectedProcedure } : null };
      await writeFile(join(output, 'job.json'), JSON.stringify(published), { flag: 'wx' });
      await rename(output, this.path(status.jobId));
      if(image) {
        // A secondary profile-store error must not turn a fully published model
        // into a failed in-memory job that becomes READY again after restart.
        try{await new ProfileStore(this.root,this.config).publishImage(status.jobId,model,report);}
        catch(error){published.profileError=`Model saved; Fusion profile publication failed: ${error.message}`;
          await writeFile(join(this.path(status.jobId),'job.json'),JSON.stringify(published));}
      }
      Object.assign(status, published);
    } catch (error) { status.state = 'FAILED'; status.phase = 'FAILED'; status.error = error.message; }
    finally { releaseUsage?.(); }
  }
  async artifact(id, kind) {
    if (!['model', 'report'].includes(kind) || (await this.status(id)).state !== 'READY') throw new Error('Training artifact is not ready.');
    return readFile(join(this.path(id), kind + '.json'));
  }
  async close() {
    this.closed = true;
    for (const job of this.jobs.values()) if (job.status.state === 'RUNNING') job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map(j => j.done));
  }
}

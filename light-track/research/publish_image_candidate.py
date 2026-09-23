"""Validate an evaluated candidate and its warm runtime before job publication."""
import argparse
import json
from pathlib import Path
import time
import numpy as np
from scene_features import read_rgb, digest_file
from image_runtime import ImagePredictor
from scene_models import ImageRegressor,portable_predict
from scene_features import ImageFeatures,ROOT
from train_annotations import load_groups

def validate_candidate(directory, annotations, backend):
    report=json.loads((directory/'report.json').read_text());model=json.loads((directory/'candidate-model.json').read_text())
    if not report['promotionPassed'] or not model['promotionPassed']:
        raise ValueError('No image candidate passed all promotion gates; the original model is retained')
    from scene_models import promotion
    for protocol in ('group','lighting-description'):
        rows=report['protocols'][protocol]['rows']
        if not promotion(rows['selected-procedure'],rows['current'],report['config']['promotion'])['passed']:
            raise ValueError('Recomputed promotion criteria fail: '+protocol)
    for source in report['provenance']['sources']:
        if digest_file(annotations/source['groupId']/'group.json')!=source['sha256']:
            raise ValueError('Source annotations changed; reevaluate before publication')
    # Independently rebuild the final head and check every saved sample against
    # the exported arrays before allowing an evaluated artifact into live use.
    app=json.loads((ROOT/'config.json').read_text());groups,_,_=load_groups(annotations,app)
    extractor=ImageFeatures(report['config'],backend=report['backend'])
    for group in groups:
        manifest=json.loads((annotations/group['groupId']/'group.json').read_text());samples={s['sampleId']:s for s in manifest['samples']}
        blocks={'legacy':group['x']}
        for family in model['families']:
            if family=='legacy':continue
            values=[]
            for sample_id in group['sampleIds']:
                sample=samples[sample_id]
                values.append(extractor.cached(read_rgb(annotations/group['groupId']/sample['image']),family,sample['imageSha256'],sample.get('camera',{}),ROOT/report['config']['cacheDirectory']))
            blocks[family]=np.asarray(values)
        group['blocks']=blocks
    fitted=ImageRegressor(groups,model['candidate'],report['config'])
    errors=[]
    for group in groups:
        actual,_=portable_predict(model,group['blocks']);expected=fitted.predict(group)
        errors.extend(np.abs(actual-expected))
    if max(errors)>1e-4:raise ValueError('Independent exported image predictor parity failed')
    report['exportParityMaxError']=float(max(errors))
    if 'coverage' not in model:
        manifests=[json.loads((annotations/s['groupId']/'group.json').read_text()) for s in report['provenance']['sources']]
        samples=[s for g in manifests for s in g['samples'] if s['angleDeg'] is not None]
        model['coverage']={'device':manifests[0]['metadata']['device'],'sessions':len(manifests),'screenshots':len(samples),
                           'trainingAngleRange':model['angleRange'],'labelSources':{kind:sum(s.get('labelSource','manual')==kind for s in samples) for kind in ('manual','keyboard')}}
    first=annotations/report['provenance']['sources'][0]['groupId']/'group.json';group=json.loads(first.read_text());sample=group['samples'][0]
    rgb=read_rgb(first.parent/sample['image']);runtime=ImagePredictor(model,backend);settings=report['config']['benchmark'];times=[]
    for i in range(settings['warmup']+settings['iterations']):
        start=time.perf_counter();runtime.predict(rgb,sample['features'],sample.get('camera',{}));elapsed=(time.perf_counter()-start)*1000
        if i>=settings['warmup']:times.append(elapsed)
    benchmark={'backend':runtime.backend,'p95Ms':float(np.quantile(times,.95)),'budgetMs':settings['p95Ms']}
    if benchmark['p95Ms']>settings['p95Ms']:
        raise ValueError(f'Image candidate exceeds measurement budget: {benchmark}')
    report['runtimeGate']=benchmark
    (directory/'model.json').write_text(json.dumps(model,allow_nan=False));(directory/'report.json').write_text(json.dumps(report,indent=2,allow_nan=False))
    return model,report

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('directory',type=Path);parser.add_argument('annotations',type=Path);parser.add_argument('--backend',choices=['cpu','cuda'],required=True)
    args=parser.parse_args();validate_candidate(args.directory,args.annotations,args.backend)

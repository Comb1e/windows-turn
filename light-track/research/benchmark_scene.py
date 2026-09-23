"""Warm extractor/predictor benchmark with explicit CPU and CUDA results."""
import argparse
import json
from pathlib import Path
import time
import numpy as np
from scene_features import CONFIG_PATH, read_rgb
from image_runtime import ImagePredictor

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('model',type=Path);parser.add_argument('group',type=Path);parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--backend',choices=['cpu','cuda'],required=True);parser.add_argument('--contention',default='none')
    args=parser.parse_args();model=json.loads(args.model.read_text());group=json.loads(args.group.read_text());config=json.loads(CONFIG_PATH.read_text())
    images=[(read_rgb(args.group.parent/s['image']),s) for s in group['samples'][:5]]
    load=time.perf_counter();predictor=ImagePredictor(model,args.backend);load=(time.perf_counter()-load)*1000
    times=[];predictions=[]
    for i in range(config['benchmark']['warmup']+config['benchmark']['iterations']):
        image,sample=images[i%len(images)];start=time.perf_counter()
        value=predictor.predict(image,sample['features'],sample.get('camera',{}));elapsed=(time.perf_counter()-start)*1000
        if i>=config['benchmark']['warmup']:times.append(elapsed);predictions.append(value)
    import torch
    result={'backend':predictor.backend,'device':torch.cuda.get_device_name() if predictor.backend=='cuda' else 'CPU',
            'torch':torch.__version__,'loadMs':load,'contention':args.contention,'iterations':len(times),'p50Ms':float(np.median(times)),
            'p95Ms':float(np.quantile(times,.95)),'maxMs':max(times),'predictions':predictions,'warmMs':times,
            'budgetMs':config['benchmark']['p95Ms'],'passesBudget':bool(np.quantile(times,.95)<=config['benchmark']['p95Ms'])}
    args.output.write_text(json.dumps(result,indent=2));print(json.dumps({k:v for k,v in result.items() if k not in ('predictions','warmMs')},indent=2))

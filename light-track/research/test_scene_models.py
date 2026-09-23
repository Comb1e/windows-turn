import copy
import json
from pathlib import Path
import tempfile
import unittest
import numpy as np

from scene_features import CONFIG_PATH, ImageFeatures, lighting_features, texture_features, metadata_features, signature, resize
from scene_models import ImageRegressor, portable_predict, fit_calibration, calibrated, support_split, scores, promotion
from scene_experiment import partition, Experiment

CONFIG=json.loads(CONFIG_PATH.read_text())
APP=json.loads((CONFIG_PATH.parents[1]/'config.json').read_text())
APP['sceneAdapter']=json.loads((CONFIG_PATH.parents[1]/'service-config.json').read_text())['adaptation']


def group(index=0,count=18):
    y=np.linspace(10,120,count);x=np.column_stack([y/100+index*.01,np.sin(y/100),np.zeros(count)])
    return {'groupId':str(index),'sampleIds':[f'{index}-{i}' for i in range(count)],'hashes':[f'{index}-{i}' for i in range(count)],
            'sources':['manual']*count,'metadata':{'lighting':str(index),'device':'test'},'y':y,'x':x,
            'blocks':{'lighting':x,'legacy':x}}


class SceneModelsTests(unittest.TestCase):
    def test_features_stable_finite_and_aspect_preserving_on_boundaries(self):
        for rgb in [np.zeros((48,64,3),np.uint8),np.full((48,64,3),255,np.uint8),np.full((48,64,3),(255,0,0),np.uint8)]:
            for fn in (lighting_features,texture_features):
                values=fn(rgb,CONFIG);self.assertTrue(np.isfinite(values).all());np.testing.assert_array_equal(values,fn(rgb,CONFIG))
        self.assertEqual(resize(np.zeros((480,640,3),np.uint8),192).shape,(144,192,3))
        with self.assertRaises(ValueError):resize(np.zeros((0,4,3),np.uint8),192)

    def test_texture_distinguishes_layout_at_equal_mean(self):
        a=np.zeros((48,64,3),np.uint8);a[:,::4]=255;b=np.zeros_like(a);b[::4,:]=255
        self.assertEqual(a.mean(),b.mean());self.assertGreater(np.linalg.norm(texture_features(a,CONFIG)-texture_features(b,CONFIG)),1)

    def test_metadata_availability_and_forbidden_identity_fields(self):
        base=metadata_features({},CONFIG);value=metadata_features({'deviceId':'secret','angleDeg':99,'timestampMs':10},CONFIG)
        np.testing.assert_array_equal(base,value)
        self.assertFalse(np.array_equal(base,metadata_features({'exposureTime':0},CONFIG)))
        self.assertTrue(np.isfinite(metadata_features({'exposureTime':float('nan')},CONFIG)).all())

    def test_cache_keys_include_image_config_and_metadata(self):
        rgb=np.full((24,32,3),128,np.uint8)
        with tempfile.TemporaryDirectory() as directory:
            extractor=ImageFeatures(CONFIG)
            extractor.cached(rgb,'metadata','hash',{},directory);extractor.cached(rgb,'metadata','hash',{'exposureTime':1},directory)
            self.assertEqual(len(list(Path(directory).glob('*.npy'))),2)
            changed=copy.deepcopy(CONFIG);changed['epsilon']*=2
            self.assertNotEqual(signature(extractor.manifest('texture')),signature(ImageFeatures(changed).manifest('texture')))

    def test_all_predictor_types_export_with_unseen_input_parity(self):
        groups=[group(i) for i in range(3)];probe=group(10)
        for head in CONFIG['heads']:
            fit=ImageRegressor(groups,{'families':['lighting'],'head':head,'id':'test'},CONFIG)
            actual,_=portable_predict(fit.export(),probe['blocks'])
            np.testing.assert_allclose(actual,fit.predict(probe),atol=1e-4,rtol=0)

    def test_reference_budgets_do_not_shrink_or_overlap_queries(self):
        g=group();g['hashes'][4]=g['hashes'][0]
        for count in (3,5,10):
            support,query=support_split(g,count,0,CONFIG)
            self.assertEqual(len(support),count);self.assertFalse(set(np.asarray(g['hashes'])[support])&set(np.asarray(g['hashes'])[query]))
        self.assertIsNone(support_split(group(count=12),10,0,CONFIG))

    def test_outer_pixels_and_labels_do_not_change_training_selection(self):
        groups=[group(i) for i in range(4)];groups[1]['hashes'][0]=groups[0]['hashes'][0]
        training=partition(groups,[groups[0]])
        self.assertNotIn(groups[0]['hashes'][0],training[0]['hashes'])
        config={**CONFIG,'featureSets':[['lighting']],'heads':CONFIG['heads'][:2]}
        exp=Experiment(groups,APP,config);before=exp.select(training,exp.candidates)
        changed=copy.deepcopy(groups);changed[0]['y']+=10000;changed[0]['blocks']['lighting']+=10000
        exp2=Experiment(changed,APP,config);after=exp2.select(partition(changed,[changed[0]]),exp2.candidates)
        self.assertEqual(before,after)

    def test_affine_and_residual_calibration_have_independent_controls(self):
        raw=np.arange(5.)*15+20;y=raw+8;descriptor=np.column_stack([raw/100,raw/200])
        affine=fit_calibration(raw,descriptor,y,{'kind':'affine'},APP['sceneAdapter'])
        np.testing.assert_allclose(calibrated(np.array([35.,65.]),descriptor[:2],affine,[0,180]),[43,73],atol=1e-8)
        residual=fit_calibration(raw,descriptor,y,{'kind':'residual','alpha':.1,'width':1},APP['sceneAdapter'])
        self.assertLess(np.mean(abs(calibrated(raw,descriptor,residual,[0,180])-y)),1)

    def test_promotion_cannot_hide_group_tail_or_high_angle_regressions(self):
        rows=[{'groupId':str(i),'sampleIds':['a','b','c'],'metrics':scores([20,70,110],[30,80,120])} for i in range(3)]
        improved=copy.deepcopy(rows)
        for r in improved:r['metrics']=scores([20,70,110],[21,71,111])
        self.assertTrue(promotion(improved,rows,CONFIG['promotion'])['passed'])
        improved[0]['metrics']=scores([20,70,110],[20,70,160])
        self.assertFalse(promotion(improved,rows,CONFIG['promotion'])['passed'])
        self.assertFalse(promotion(rows[:2],rows[:2],CONFIG['promotion'])['passed'])

    def test_missing_assets_fail_without_network_or_backend_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError,'unavailable'):ImageFeatures(CONFIG,directory).manifest('dino')


if __name__=='__main__':unittest.main()

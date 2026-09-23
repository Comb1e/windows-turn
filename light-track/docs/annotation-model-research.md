# Annotation model improvement — 2026-09-16

Light Track 0.13.0 improves training on the existing 499-feature screenshot records. No images, measured angles, provenance, manifests, or stored feature vectors are converted. Models still use the v1 feature schema and ordinary tree arrays accepted by the existing browser, service, and Python replay code.

## Research consulted

| Source | Relevant finding and application |
| --- | --- |
| Geusebroek et al., **Color Invariance**, IEEE TPAMI 23(12), 1338–1350, 2001. [University publication and abstract](https://ivi.fnwi.uva.nl/isis/publications/bibtexbrowser.php?key=GeusebroekTPAMI2001&bib=all.bib) | Illumination changes can obscure useful color information. This motivates testing intensity-normalized color features. Our existing RGB/sum ratios are a simple approximation; this implementation does **not** reproduce the paper's physical differential invariants or guarantee invariance to colored lights, clipping, or camera white balance. |
| Breiman, **Random Forests**, 2001. [DOI](https://doi.org/10.1023/A:1010933404324); [scikit-learn RandomForestRegressor](https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.RandomForestRegressor.html) | Averaging randomized trees controls variance; larger leaves smooth regression. Compare the original Extra Trees with forests using feature subsampling and four-sample leaves. Both export through the existing tree interface. |
| Grinsztajn, Oyallon and Varoquaux, **Why do tree-based models still outperform deep learning on tabular data?**, 2022. [Paper and abstract](https://arxiv.org/abs/2207.08815) | Their tabular benchmark supports retaining a strong tree baseline. It does not prove superiority for this camera task or this much smaller dataset. No pretrained neural model or new runtime is justified by our local results. |
| Cawley and Talbot, **On Over-fitting in Model Selection and Subsequent Selection Bias in Performance Evaluation**, JMLR 11, 2079–2107, 2010. [Paper](https://jmlr.org/papers/v11/cawley10a.html) | Choosing a candidate using the same scores reported as its evaluation is optimistic. Final candidate tuning is reported separately from an outer diagnostic that repeats all tuning inside each fitting partition. |
| Dalal and Triggs, **Histograms of Oriented Gradients for Human Detection**, CVPR 2005; [scikit-image HOG explanation and example](https://scikit-image.org/docs/stable/auto_examples/features_detection/plot_hog.html) | Normalized gradient histograms preserve edges with some resistance to illumination changes. A grayscale HOG-inspired pilot improved some keyboard groups but underperformed color forests on mean group error and required additional image features. It was not adopted. |
| [scikit-learn kernel ridge regression](https://scikit-learn.org/stable/modules/kernel_ridge.html) | Regularized RBF regression is practical with a few hundred samples. Lighting-feature and HOG pilots were less successful overall than color forests and would require a different inference interface. |

All linked abstracts/project documentation were read on 2026-09-16. No annotation data was uploaded for research. Exploratory local files are under the ignored `artifacts/annotation-improvement-2026-09-16/` directory.

## Method

The original trainer always fitted 64 Extra Trees, depth 10, minimum leaf size 1, over all 499 features. It could fit its training labels closely while producing large errors for a withheld session. Training fit is not an accuracy estimate.

The default bounded candidate set contains that exact baseline and five alternatives: Extra Trees over chromaticity; Extra Trees with four-sample leaves over chromaticity or chromaticity plus relative luminance; and Random Forests with 25% feature sampling over chromaticity with either one- or four-sample leaves. Chromaticity selects 147 existing color-ratio features. Relative color adds 48 normalized spatial luminance features. No new pixel processing is required.

Each group has equal total fitting weight, and normalization is fitted with the same weights. Candidate scoring gives every held-out group equal influence, regardless of screenshot count or label source. An alternative needs at least three evaluable groups and a 2% relative reduction in mean group absolute error; otherwise the original trainer is retained. Single-group, two-group, constant-angle, sparse, and repeated-angle data remain usable. Tuning evaluates at most five evenly spaced whole groups from the stable group ordering; final fitting still uses **every** labeled sample, and the outer diagnostic evaluates **every** group.

For each outer diagnostic, exclude the entire group and any exact PNG duplicates from all fitting groups **before** normalization and inner candidate selection. Refit selection on the remaining groups, predict the untouched group, and compare with the original baseline on the identical partition. Preserve sample identities through duplicate removal. The report exposes inner tuning decisions, per-group errors, manual/keyboard source diagnostics, missing angle coverage, and the baseline comparison. The final fit uses the candidate selected across all groups, so tuning scores for that candidate are distinct from the nested diagnostic of the selection procedure.

Export remaps tree split indices from each feature subset back to the original v1 positions. All 499 normalization entries remain in the artifact. The existing distance diagnostic continues to examine all original features, so a changed lighting environment can still lower reliability even if the selected forest ignores some brightness features. Filter settings, camera binding, teacher provenance, and false independent-validation flags are retained.

## Local evaluation

Data: four ended groups, 212 screenshots (23 manual, 189 keyboard), one laptop, 640×480 at 60° FOV, labels spanning 9–120°. These are development data, with strongly uneven angle coverage. Existing keyboard labels are supervision, not independent physical measurements of model accuracy. The candidate family was informed by exploration of these data; even nested results require confirmation on newly captured sessions.

| Whole-group diagnostic, equal weight per group | Original method | Selection procedure |
| --- | ---: | ---: |
| Mean absolute error | 19.926° | 17.094° |
| Mean of group 95th-percentile errors | 37.054° | 34.557° |
| Mean fraction within 5° | 26.10% | 36.74% |

The mean error reduction is **14.21%**. This is an improvement on the recorded groups, not an independent acceptance result.

| Held-out group prefix | Labels | Original MAE | Nested MAE |
| --- | --- | ---: | ---: |
| 361e67dc | 11 manual | 17.175° | 12.110° |
| 68631139 | 12 manual, 91–119.7° | 45.080° | 38.939° |
| 9d8e1da4 | 117 keyboard | 8.841° | 8.411° |
| a6d1e916 | 72 keyboard | 8.609° | 8.915° |

One group's mean error slightly worsens, and large-angle transfer remains poor. Adding more frames of the same small-angle sequence does not establish large-angle or new-lighting performance. New whole sessions with externally measured large angles are the most useful next validation data.

The all-data tuning winner is `color-forest-smooth`: 64 Random Forest trees, depth 10, four-sample leaves, 25% feature subsampling, chromaticity features. Its **tuning** mean group MAE is 14.481°; do not substitute this more optimistic score for the nested result above. Its forest has 2,596 nodes compared with 22,308 in the previous 212-image model (88.4% fewer). The artifact is approximately 141 KB versus 973 KB. Pixel feature extraction is unchanged, so this is not a claim of a corresponding camera FPS gain.

Reproduction used Python 3.13.14, NumPy 2.5.3, scikit-learn 1.9.1, OpenCV 4.14.0, and configured seed 42. Reports record these software versions because forest fitting may change across library versions. Existing source manifest hashes/revisions identify the inputs.

```powershell
# New output directory each time; input annotations are read-only.
.\.venv\Scripts\python.exe research/train_annotations.py data/annotations --output artifacts/annotation-comparison
node research/check-parity.mjs artifacts/annotation-comparison/model.json artifacts/annotation-comparison/parity.json
# Optional exact original method, using the current configured tree settings:
.\.venv\Scripts\python.exe research/train_annotations.py data/annotations --baseline --output artifacts/annotation-baseline
```

`report.json` contains `modelSelection` tuning scores and `comparison` nested scores. In the annotation page, **Train model** uses this method automatically and displays the comparison when available. Published models remain separate immutable jobs and can be selected or replaced using the existing model picker.

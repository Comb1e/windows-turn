"""Structural evidence for a broad laptop boundary, independent of angle fitting.

This is deliberately not a semantic keyboard classifier. A supported transition
must persist away from the line and lead into a comparatively consistent surface.
"""
from functools import lru_cache

import numpy as np


@lru_cache(maxsize=16)
def _surface_basis(count, degree):
    basis = np.polynomial.polynomial.polyvander(np.linspace(-1, 1, count), degree)
    return basis, np.linalg.pinv(basis)


def surface_texture_span(samples, trend_degree):
    """Measure texture after removing broad shading along each sampled line.

    Fit at most three coefficients across the whole line, independently for
    every candidate. Local surface texture is not fitted away.
    Contrast and regional support continue to use the original intensities.
    """
    basis, inverse = _surface_basis(samples.shape[-1], trend_degree)
    texture = samples - (samples @ inverse.T) @ basis.T
    return np.quantile(texture, .9, axis=-1) - np.quantile(texture, .1, axis=-1)


def boundary_evidence(gray, rows, xs, polarity, min_contrast, strength, limits):
    """Check one or many sampled lines; return a mask over the leading axes.

    Rows end in the column-sample axis. The same checks run before candidate
    selection and after line refinement, so hints never bypass verification.
    """
    height = gray.shape[0]
    supported = np.ones(rows.shape, dtype=bool)
    usable = np.ones(rows.shape[:-1], dtype=bool)
    minimum_step = np.maximum(min_contrast, strength * limits.edge_min_sustained_ratio)
    minimum_visible = max(2, round(height * limits.edge_min_visible_context_fraction))
    for fraction in (limits.edge_context_near_fraction, limits.edge_context_far_fraction):
        depth = max(1, round(height * fraction))
        # A cropped base still has a usable upper reference. Sample the deepest
        # real lower pixel in each column, requiring a visible strip, not padding.
        below_depth = np.minimum(depth, height - 1 - rows)
        usable &= ((rows - depth >= 0) & (below_depth >= minimum_visible)).all(axis=-1)
        above = gray[np.clip(rows - depth, 0, height - 1), xs]
        below = gray[np.clip(rows + below_depth, 0, height - 1), xs]
        difference = polarity * (above - below)
        step = np.quantile(difference, .3, axis=-1)
        usable &= step >= minimum_step
        supported &= difference >= minimum_step[..., None]
        # Illumination can differ across the width of a reflective laptop. Check
        # texture in the same regions used for support instead of requiring one
        # polynomial to describe the entire surface.
        for region in np.array_split(below, limits.edge_support_regions, axis=-1):
            variation = surface_texture_span(region, limits.edge_surface_trend_degree)
            usable &= variation <= limits.edge_max_surface_variation_ratio * np.maximum(step, min_contrast)
    # A touchpad-sized central segment must not impersonate the entire base.
    for region in np.array_split(supported, limits.edge_support_regions, axis=-1):
        usable &= region.mean(axis=-1) >= limits.edge_min_region_support
    return usable

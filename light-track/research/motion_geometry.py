"""Relative camera rotation helpers; never produce an absolute hinge angle."""
import base64
import math
import cv2
import numpy as np

def rotation_vector(rotation):
    return cv2.Rodrigues(np.asarray(rotation, dtype=np.float64))[0].ravel()

def rotation_distance(a, b):
    return float(np.degrees(np.linalg.norm(rotation_vector(a @ b.T))))

def camera_matrix(width, height, fov):
    focal = width / (2 * math.tan(math.radians(fov) / 2))
    return np.array([[focal, 0, width / 2], [0, focal, height / 2], [0, 0, 1.]])

def cells_covered(points, width, height, config):
    cells = np.floor(np.asarray(points) * [config['gridColumns']/width, config['gridRows']/height]).astype(int)
    return len(set(map(tuple, cells.tolist())))

def rays(points, k):
    vectors = np.c_[points, np.ones(len(points))] @ np.linalg.inv(k).T
    return vectors / np.linalg.norm(vectors, axis=1, keepdims=True)

def fit_rotation(a, b):
    u, _, vt = np.linalg.svd(b.T @ a)
    return u @ np.diag([1, 1, np.linalg.det(u @ vt)]) @ vt

def estimate_motion(points0, points1, k, shape, config, axis=None):
    """Compete rotation, planar, and general rigid-scene hypotheses.

    Essential and homography models explicitly permit translation; image shift
    is never interpreted directly as a physical hinge angle. Ambiguous pose
    decompositions are rejected rather than picking an arbitrary solution.
    """
    p, q = np.asarray(points0, np.float64), np.asarray(points1, np.float64)
    height, width = shape
    minimum = config['minTracks']
    if len(p) < minimum:
        return None, {'reason': 'Too few consistent tracks', 'tracks': len(p)}
    a, b = rays(p, k), rays(q, k)
    threshold = config['ransacPixels']

    def supported(mask):
        return (mask.sum() >= minimum and mask.mean() >= config['minInlierFraction']
                and cells_covered(p[mask], width, height, config) >= config['minCells']
                and cells_covered(q[mask], width, height, config) >= config['minCells'])

    def axis_ok(r):
        if axis is None:
            return True
        rv = rotation_vector(r)
        off = rv - axis * np.dot(rv, axis)
        return np.degrees(np.linalg.norm(off)) <= config['maxOffAxisDegrees']

    # Robust bearing alignment handles stationary/near-pure rotation, where
    # the essential matrix is poorly conditioned. A fixed RNG makes replay
    # reproducible without sharing OpenCV's process-global random state.
    rng = np.random.default_rng(42)
    best_mask = np.zeros(len(p), bool)
    for indices in [np.arange(len(p))] + [rng.choice(len(p), 3, replace=False) for _ in range(config['rotationRansacIterations'])]:
        r = fit_rotation(a[indices], b[indices])
        projected = (a @ r.T) @ k.T
        predicted = projected[:, :2] / np.maximum(projected[:, 2:], 1e-9)
        mask = np.linalg.norm(predicted-q, axis=1) <= config['rotationResidualPixels']
        if mask.sum() > best_mask.sum():
            best_mask = mask
    if supported(best_mask):
        r = fit_rotation(a[best_mask], b[best_mask])
        if axis_ok(r):
            return r, {'method': 'rotation', 'tracks': len(p), 'inliers': int(best_mask.sum()),
                       'inlierFraction': float(best_mask.mean())}

    candidates = []

    def add(r, t, mask, method):
        mask = mask.astype(bool).ravel()
        if not supported(mask) or not axis_ok(r):
            return
        # Cheirality and two-view reprojection discard invalid decompositions.
        pp, qq = p[mask], q[mask]
        xyz = cv2.triangulatePoints(k @ np.c_[np.eye(3), np.zeros(3)], k @ np.c_[r, t], pp.T, qq.T)
        good_w = np.abs(xyz[3]) > 1e-10
        xyz[:, good_w] /= xyz[3, good_w]
        x0 = xyz[:3].T
        x1 = x0 @ r.T + t
        z0, z1 = x0 @ k.T, x1 @ k.T
        with np.errstate(divide='ignore', invalid='ignore'):
            errors = np.maximum(np.linalg.norm(z0[:, :2]/z0[:, 2:]-pp, axis=1),
                                np.linalg.norm(z1[:, :2]/z1[:, 2:]-qq, axis=1))
        good = good_w & (x0[:, 2] > 0) & (x1[:, 2] > 0) & (errors <= threshold)
        verified = np.zeros(len(p), bool)
        verified[np.flatnonzero(mask)[good]] = True
        if supported(verified):
            candidates.append((r, {'method': method, 'tracks': len(p), 'inliers': int(verified.sum()),
                                   'inlierFraction': float(verified.mean()), 'reprojectionPixels': float(np.median(errors[good]))}))

    try:
        h, hm = cv2.findHomography(p, q, cv2.RANSAC, threshold, maxIters=1000, confidence=.999)
        if h is not None and hm is not None:
            _, rotations, translations, _ = cv2.decomposeHomographyMat(h, k)
            for r, t in zip(rotations, translations):
                add(r, t.ravel(), hm, 'homography')
        e, em = cv2.findEssentialMat(p, q, k, method=cv2.RANSAC, prob=.999, threshold=threshold)
        if e is not None and em is not None:
            for block in np.vsplit(e, len(e)//3):
                _, r, t, mask = cv2.recoverPose(block, p, q, k, mask=em.copy())
                add(r, t.ravel(), mask, 'essential')
    except cv2.error:
        return None, {'reason': 'Degenerate scene geometry', 'tracks': len(p)}
    if not candidates:
        return None, {'reason': 'Insufficient rigid-scene support', 'tracks': len(p)}
    candidates.sort(key=lambda c: (-c[1]['inliers'], c[1]['reprojectionPixels']))
    best, quality = candidates[0]
    competitive = [c for c in candidates if c[1]['inliers'] >= quality['inliers'] * config['poseCompetitionFraction']]
    if any(rotation_distance(best, r) > config['ambiguityDegrees'] for r, _ in competitive):
        return None, {'reason': 'Ambiguous camera rotation', 'tracks': len(p)}
    return best, quality

def distributed_corners(gray, config):
    height, width = gray.shape
    out = []
    cols, rows = config['gridColumns'], config['gridRows']
    for y in range(rows):
        for x in range(cols):
            x0, x1 = x*width//cols, (x+1)*width//cols
            y0, y1 = y*height//rows, (y+1)*height//rows
            points = cv2.goodFeaturesToTrack(gray[y0:y1, x0:x1], config['maxCorners']//(cols*rows),
                                            config['cornerQuality'], config['cornerDistance'])
            if points is not None:
                out.extend(points.reshape(-1, 2) + [x0, y0])
    return np.asarray(out, np.float32).reshape(-1, 2)

def track_pair(previous, gray, points, config):
    p = points.reshape(-1, 1, 2)
    window = (config['flowWindowPixels'], config['flowWindowPixels'])
    q, status, _ = cv2.calcOpticalFlowPyrLK(previous, gray, p, None, winSize=window, maxLevel=config['flowPyramidLevels'])
    if q is None:
        return np.empty((0, 2)), np.empty((0, 2))
    back, back_status, _ = cv2.calcOpticalFlowPyrLK(gray, previous, q, None, winSize=window, maxLevel=config['flowPyramidLevels'])
    if back is None:
        return np.empty((0, 2)), np.empty((0, 2))
    good = status.ravel().astype(bool) & back_status.ravel().astype(bool)
    good &= np.linalg.norm((back-p).reshape(-1, 2), axis=1) <= config['forwardBackwardPixels']
    end = q.reshape(-1, 2)
    good &= (end[:, 0] >= 0) & (end[:, 0] < gray.shape[1]) & (end[:, 1] >= 0) & (end[:, 1] < gray.shape[0])
    return p.reshape(-1, 2)[good], end[good]

def decode_frame(data, config):
    width, height = data.get('width'), data.get('height')
    if type(width) is not int or type(height) is not int or min(width, height) < 64 or width*height > config['tracking']['maxPixels']:
        raise ValueError('Invalid frame dimensions')
    raw = base64.b64decode(data['gray'], validate=True)
    if len(raw) != width*height:
        raise ValueError('Grayscale byte count does not match dimensions')
    return np.frombuffer(raw, np.uint8).reshape(height, width)

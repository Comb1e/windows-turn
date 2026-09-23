"""Relative rotation only; never creates an absolute-angle reference at rest."""
import json
from pathlib import Path
import sys

import cv2
import numpy as np

from motion_geometry import camera_matrix, decode_frame, distributed_corners, estimate_motion, rotation_vector, track_pair


class MotionTracker:
    def __init__(self, config):
        self.config = config
        self.reset()

    def reset(self, options=None):
        options = options or {}
        self.previous = self.points = self.time = None
        self.fov = options.get('horizontalFovDegrees') or self.config['camera']['horizontalFovDegrees']
        calibration = options.get('motionCalibration') or {}
        vector = calibration.get('degreesPerRadian')
        self.vector = np.asarray(vector, float) if vector is not None else None
        if self.vector is not None and (self.vector.shape != (3,) or not np.isfinite(self.vector).all()):
            raise ValueError('Invalid motion calibration vector')

    def update(self, gray, timestamp):
        c = self.config['tracking']
        if not np.isfinite(timestamp) or timestamp < 0 or (self.time is not None and timestamp <= self.time):
            raise ValueError('Motion capture timestamps must increase')
        result = {'velocityDegS': None, 'rotationVector': None, 'quality': 'unavailable', 'fromTimestampMs': self.time}
        if (self.previous is not None and self.previous.shape == gray.shape and timestamp-self.time <= c['maxGapMs']
                and len(self.points) >= c['minTracks'] and gray.std() >= c['minContrast']):
            p, q = track_pair(self.previous, gray, self.points, c)
            rotation, quality = estimate_motion(p, q, camera_matrix(gray.shape[1], gray.shape[0], self.fov), gray.shape, c)
            result['details'] = quality
            if rotation is not None:
                rv = rotation_vector(rotation)
                dt = (timestamp-self.time)/1000
                if np.degrees(np.linalg.norm(rv))/dt <= c['maxSpeedDegrees']:
                    result.update(rotationVector=rv.tolist(), quality='rotation-only')
                    if self.vector is not None:
                        velocity = float(rv @ self.vector / dt)
                        if abs(velocity) <= c['maxSpeedDegrees']:
                            result.update(velocityDegS=velocity, quality='calibrated-motion')
        self.previous, self.points, self.time = gray.copy(), distributed_corners(gray, c), timestamp
        return result


def main():
    config = json.loads((Path(__file__).resolve().parents[1]/'config.json').read_text(encoding='utf-8'))
    cv2.setNumThreads(1)
    tracker = MotionTracker(config)
    print(json.dumps({'ready': True}), flush=True)
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            if request['command'] == 'reset':
                tracker.reset(request.get('data'))
                result = {'reset': True}
            elif request['command'] == 'frame':
                data = request['data']
                result = tracker.update(decode_frame(data, config), data['timestamp'])
            else:
                raise ValueError('Unknown motion command')
            response = {'id': request['id'], 'result': result}
        except Exception as error:
            response = {'id': request.get('id'), 'error': str(error)}
        print(json.dumps(response, allow_nan=False), flush=True)


if __name__ == '__main__':
    main()

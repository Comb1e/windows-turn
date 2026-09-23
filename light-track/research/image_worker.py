"""Line-framed local worker used by standalone lighting and Fusion's frame service."""
import base64
import json
import sys
import time
import numpy as np
from image_runtime import ImagePredictor


def run():
    predictor = None; session = None; sequence = -1; last_time = -1
    print(json.dumps({'ready': True}), flush=True)
    for line in sys.stdin:
        request = {}; result = None
        try:
            request = json.loads(line); data = request['data']
            if request['command'] == 'reset':
                next_predictor = ImagePredictor(data['model'], data.get('backend', 'cpu'))
                predictor = next_predictor; session = data['sessionId']; sequence = -1; last_time = -1
                result = {'sessionId': session, 'backend': predictor.backend}
            elif request['command'] == 'frame':
                if not predictor or data['sessionId'] != session:
                    raise ValueError('Obsolete image worker session')
                frame_id = data['frameId']; timestamp = data['timestampMs']; width, height = data['width'], data['height']
                if (type(frame_id) is not int or frame_id <= sequence or not np.isfinite(timestamp) or timestamp <= last_time
                        or type(width) is not int or type(height) is not int or min(width, height) < 1 or width * height > 409600):
                    raise ValueError('Invalid or reordered image frame')
                payload = base64.b64decode(data['rgba'], validate=True)
                if len(payload) != width * height * 4:
                    raise ValueError('Invalid RGBA byte count')
                sequence, last_time = frame_id, timestamp
                rgb = np.frombuffer(payload, np.uint8).reshape(height, width, 4)[:, :, :3].copy()
                started = time.perf_counter(); raw = predictor.predict(rgb, data['features'], data.get('camera', {}))
                result = {'sessionId': session, 'frameId': frame_id, 'timestampMs': timestamp,
                          'raw': raw, 'backend': predictor.backend, 'processingMs': (time.perf_counter() - started) * 1000}
            else:
                raise ValueError('Unknown image worker command')
            print(json.dumps({'id': request['id'], 'result': result}, allow_nan=False), flush=True)
        except Exception as error:
            print(json.dumps({'id': request.get('id'), 'error': str(error)}), flush=True)


if __name__ == '__main__':
    run()

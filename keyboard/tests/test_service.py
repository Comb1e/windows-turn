import json
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import cv2
import pytest

from keyboard_hinge.annotation import load_samples
from keyboard_hinge.config import Config, Limits
from keyboard_hinge.edge import fit_edge_model
from keyboard_hinge.service import make_server, ServiceError
from test_edge import edge_dataset


@pytest.fixture
def service(edge_dataset, tmp_path):
    directory, path, scene = edge_dataset
    model = fit_edge_model(load_samples(path, directory, Limits()), directory)
    model_path = tmp_path / 'model.json'
    model.save(model_path)
    config_path = tmp_path / 'config.json'
    config_path.write_text('{"camera":{"index":0,"width":640,"height":480}}')
    settings = dict(host='127.0.0.1', port=0, leaseIdleSeconds=30, maxBodyBytes=2000000, readTimeoutSeconds=2)
    server = make_server(model_path, Config.read(config_path, require_measurements=False), settings)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server, scene
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def call(server, route, data=None, method='POST', headers=None):
    headers = headers or {}
    if isinstance(data, dict):
        data = json.dumps(data).encode()
        headers['Content-Type'] = 'application/json'
    request = Request(f'http://127.0.0.1:{server.server_address[1]}{route}', data=data, method=method, headers=headers)
    try:
        response = urlopen(request, timeout=3)
    except HTTPError as error:
        response = error
    with response:
        return response.status, json.load(response)


def test_rgba_contract_resolution_timestamps_and_authoritative_reading(service):
    server, scene = service
    status, health = call(server, '/v1/health', method='GET')
    assert status == 200 and health['angleRange'] == [10, 45]
    assert call(server, '/v1/sessions', {'camera': {'width': 960, 'height': 540}})[0] == 400
    _, result = call(server, '/v1/sessions', {'camera': {'width': 640, 'height': 480}})
    sid = result['sessionId']
    assert call(server, '/v1/sessions', {'camera': {'width': 640, 'height': 480}})[0] == 409
    pixels = cv2.cvtColor(scene(25)[0], cv2.COLOR_BGR2RGBA).tobytes()
    headers = {'Content-Type': 'application/octet-stream', 'X-Frame-Id': '1', 'X-Timestamp-Ms': '1000', 'X-Width': '640', 'X-Height': '480'}
    status, reading = call(server, f'/v1/sessions/{sid}/frames', pixels, headers=headers)
    assert status == 200 and not reading['valid'] and reading['angleDeg'] is None and reading['edge'] is None
    headers.update({'X-Frame-Id': '2', 'X-Timestamp-Ms': '1050'})
    assert not call(server, f'/v1/sessions/{sid}/frames', pixels, headers=headers)[1]['valid']
    headers.update({'X-Frame-Id': '3', 'X-Timestamp-Ms': '1100'})
    status, reading = call(server, f'/v1/sessions/{sid}/frames', pixels, headers=headers)
    assert status == 200 and reading['valid'] and reading['angleDeg'] == pytest.approx(25, abs=.5)
    assert reading['timestampMs'] == 1100 and server.service.session.last_time == 1.1
    assert call(server, f'/v1/sessions/{sid}/frames', pixels, headers=headers)[0] == 400
    assert call(server, f'/v1/sessions/{sid}/frames', pixels[:-4], headers={**headers, 'X-Frame-Id': '4', 'X-Timestamp-Ms': '1200'})[0] == 400
    assert call(server, f'/v1/sessions/{sid}/frames', pixels, headers={**headers, 'Origin': 'https://example.com'})[0] == 403
    _, reset = call(server, f'/v1/sessions/{sid}/reset', {})
    assert reset['sessionId'] != sid
    assert call(server, f'/v1/sessions/{sid}/frames', pixels, headers=headers)[0] == 409
    assert call(server, f"/v1/sessions/{reset['sessionId']}", method='DELETE')[0] == 200


def test_busy_requests_are_rejected_without_opening_a_camera(service):
    server, _ = service
    with server.service.lock:
        assert call(server, '/v1/sessions', {'camera': {'width': 640, 'height': 480}})[0] == 409
    assert not hasattr(server.service, 'capture')


def test_false_boundaries_never_leave_service_as_angles_or_calibration_labels(service):
    from test_edge_identity import distractor
    server, scene = service
    _, session = call(server, '/v1/sessions', {'camera': {'width': 640, 'height': 480}})
    assert session['boundaryValidation'] == 'surface-context-and-temporal-confirmation-v3'
    route = f"/v1/sessions/{session['sessionId']}/frames"
    frames = [distractor('table-trim')] * 3 + [distractor('touchpad-seam')] * 3 + [scene(25)[0]] * 3
    frames += [distractor('touchpad-seam')]
    for index, frame in enumerate(frames):
        headers = {'Content-Type': 'application/octet-stream', 'X-Frame-Id': str(index),
                   'X-Timestamp-Ms': str(1000+index*67), 'X-Width': '640', 'X-Height': '480'}
        status, reading = call(server, route, cv2.cvtColor(frame, cv2.COLOR_BGR2RGBA).tobytes(), headers=headers)
        assert status == 200 and reading['frameId'] == index and reading['timestampMs'] == 1000+index*67
        if index == 8:
            assert reading['valid'] and reading['angleDeg'] == pytest.approx(25, abs=.5)
        else:
            assert not reading['valid'] and reading['angleDeg'] is None and reading['edge'] is None
            assert reading['quality']['confidence'] == 0 and reading['quality']['reason']


def test_unavailable_identity_is_reported_and_cannot_publish_keyboard_labels(service):
    from keyboard_hinge.identity import UnavailableVerifier
    server, scene = service
    server.service.verifier = UnavailableVerifier('dino', 'Missing identity weights')
    _, health = call(server, '/v1/health', method='GET')
    assert not health['identity']['available']
    _, session = call(server, '/v1/sessions', {'camera': {'width': 640, 'height': 480}})
    frame = cv2.cvtColor(scene(25)[0], cv2.COLOR_BGR2RGBA).tobytes()
    for index in range(6):
        headers = {'Content-Type': 'application/octet-stream', 'X-Frame-Id': str(index),
                   'X-Timestamp-Ms': str(1000 + index * 67), 'X-Width': '640', 'X-Height': '480'}
        code, reading = call(server, f"/v1/sessions/{session['sessionId']}/frames", frame, headers=headers)
        assert code == 200 and not reading['valid'] and reading['angleDeg'] is None and reading['edge'] is None
        assert reading['quality']['identity']['status'] == 'unavailable'
    _, reset = call(server, f"/v1/sessions/{session['sessionId']}/reset", {})
    assert reset['sessionId'] != session['sessionId']
    assert call(server, f"/v1/sessions/{session['sessionId']}/frames", frame, headers=headers)[0] == 409

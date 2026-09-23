"""Shared camera and corner-selection interfaces for calibration and tracking."""
from contextlib import contextmanager

import cv2
import numpy as np
from .annotation import validate_edge
from .config import EDGE_LABELS


WINDOW = "Keyboard hinge"


@contextmanager
def open_camera(config, calibration=None):
    if calibration is not None and (config.width, config.height) != calibration.size:
        raise ValueError(f"Configured camera resolution {config.width}x{config.height} differs from required "
                         f"{calibration.size[0]}x{calibration.size[1]}; use the model or camera file's resolution")
    capture = cv2.VideoCapture(config.camera_index)
    try:
        if not capture.isOpened():
            raise ValueError("Cannot open webcam; check camera index and Windows camera permissions")
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, config.width)
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, config.height)
        yield capture
    finally:
        capture.release()
        cv2.destroyAllWindows()


def read_frame(capture, camera=None):
    success, frame = capture.read()
    if not success or frame is None:
        raise ValueError("Webcam stopped supplying frames")
    if camera is not None:
        camera.check_frame(frame)
    return frame


def overlay(frame, lines, color=(0, 230, 255)):
    output = frame.copy()
    for index, line in enumerate(lines):
        origin = (12, 28 + index * 27)
        cv2.putText(output, line, origin, cv2.FONT_HERSHEY_SIMPLEX, .6, (0, 0, 0), 4, cv2.LINE_AA)
        cv2.putText(output, line, origin, cv2.FONT_HERSHEY_SIMPLEX, .6, color, 1, cv2.LINE_AA)
    return output


def keypress():
    key = cv2.waitKey(20) & 0xFF
    if cv2.getWindowProperty(WINDOW, cv2.WND_PROP_VISIBLE) < 1:
        raise KeyboardInterrupt
    if key in (27, ord("q")):
        raise KeyboardInterrupt
    return key


def select_corners(frame, labels, count=4):
    """Select corresponding points on a frozen, unmirrored image."""
    selected = []

    def click(event, x, y, flags, param):
        if event == cv2.EVENT_LBUTTONDOWN and len(selected) < count:
            selected.append((x, y))
        elif event == cv2.EVENT_RBUTTONDOWN and selected:
            selected.pop()

    cv2.namedWindow(WINDOW, cv2.WINDOW_AUTOSIZE)
    cv2.setMouseCallback(WINDOW, click)
    try:
        while True:
            instruction = f"Click {labels[len(selected)]}" if len(selected) < count else "Enter: accept selection"
            output = overlay(frame, [instruction, "Right click: undo | R: reset | Q/Esc: quit"])
            for i, point in enumerate(selected):
                cv2.circle(output, point, 5, (0, 255, 0), -1)
                cv2.putText(output, str(i + 1), point, cv2.FONT_HERSHEY_SIMPLEX, .7, (0, 255, 0), 2)
            if len(selected) > 1:
                cv2.polylines(output, [np.asarray(selected, np.int32)], len(selected) == 4, (0, 255, 0), 1)
            cv2.imshow(WINDOW, output)
            key = keypress()
            if key == ord("r"):
                selected.clear()
            if key in (10, 13) and len(selected) == count:
                corners = np.asarray(selected, np.float64)
                if count == 2:
                    try:
                        return np.asarray(validate_edge(corners, (frame.shape[1], frame.shape[0])))
                    except ValueError as error:
                        selected.clear()
                        print(error)
                        continue
                if cv2.isContourConvex(corners.astype(np.float32).reshape(-1, 1, 2)):
                    return corners
                selected.clear()
                print("Corners must form a convex perimeter. Select them again.")
    finally:
        cv2.setMouseCallback(WINDOW, lambda *args: None)


def select_edge(frame):
    return select_corners(frame, EDGE_LABELS, count=2)


def freeze_base(capture, camera, labels, message):
    while True:
        frame = read_frame(capture, camera)
        cv2.imshow(WINDOW, overlay(frame, [message, "Space: freeze visible base | Q/Esc: quit"]))
        if keypress() == 32:
            return frame, select_corners(frame, labels)

import argparse
from dataclasses import replace
from contextlib import nullcontext
import json
from pathlib import Path
import sys
import time

import cv2
import numpy as np

from .annotation import AnnotationStore, load_samples, serve
from .calibration import approximate_camera, calibrate_hinge_annotations, capture_camera, capture_hinge
from .capture import WINDOW, keypress, open_camera, overlay, read_frame, select_corners, select_edge
from .config import Config, read_json, write_json
from .evaluation import evaluate
from .geometry import Camera, Hinge
from .tracking import Session, State
from .uncalibrated import UncalibratedModel, UncalibratedSession, fit_model
from .edge import EdgeModel, EdgeSession, fit_edge_model, read_uncalibrated_model


def run_live(config, camera, session, jsonl, mode):
    if jsonl:
        Path(jsonl).parent.mkdir(parents=True, exist_ok=True)
    sink = Path(jsonl).open("a", encoding="utf-8") if jsonl else nullcontext(None)
    with sink as stream, open_camera(config, camera) as capture:
        def record(timestamp):
            if stream:
                stream.write(json.dumps({**session.record(timestamp), "mode": mode}, allow_nan=False) + "\n")
                stream.flush()

        try:
            while True:
                frame = read_frame(capture, camera)
                now = time.monotonic()
                result = session.update(frame, now)
                angle = (f"{result.angle_deg:.1f} deg | confidence {result.confidence:.2f}"
                         if result.angle_deg is not None else "Angle unavailable")
                quality = result.reason or (f"Reprojection {result.pose.reprojection_px:.2f}px" if result.pose else "Empirical estimate")
                instruction = ("Automatic boundary detection | S: select two endpoints | Q/Esc: quit" if isinstance(session, EdgeSession)
                               else "S: select/reselect keyboard | Q/Esc: quit")
                preview = overlay(frame, [f"{mode}: {session.state.value}", angle, quality,
                                          instruction])
                if isinstance(session, (UncalibratedSession, EdgeSession)):
                    projected = session.corners
                elif result.pose is not None:
                    projected = cv2.projectPoints(config.points, cv2.Rodrigues(result.pose.rotation)[0],
                                                  result.pose.translation, camera.matrix, camera.distortion)[0]
                else:
                    projected = None
                if projected is not None and np.isfinite(projected).all() and np.max(np.abs(projected)) < 1e6:
                    cv2.polylines(preview, [projected.astype(np.int32)], not isinstance(session, EdgeSession), (0, 255, 0), 2)
                cv2.imshow(WINDOW, preview)
                record(now)
                if keypress() == ord("s"):
                    corners = select_edge(frame) if isinstance(session, EdgeSession) else select_corners(frame, config.labels)
                    if isinstance(session, (UncalibratedSession, EdgeSession)):
                        session.initialize(frame, corners, now)
                    else:
                        session.initialize(frame, config.points, corners, now)
                    record(now)
        except (ValueError, cv2.error) as error:
            session.reject(State.LOST, str(error))
            record(time.monotonic())
            raise


def run(config, camera, hinge, jsonl, mode="calibrated"):
    run_live(config, camera, Session(camera, hinge, config.limits), jsonl, mode)


def dataset_arguments(command):
    command.add_argument("--annotations", default="data/annotations.json")
    command.add_argument("--input", help="Image directory; defaults to annotations path without .json")


def parser():
    root = argparse.ArgumentParser(description="Estimate laptop opening from a visible boundary or fixed keyboard corners")
    root.add_argument("--config", default="config.json", help="Camera settings, optional measured rectangle, and quality limits")
    commands = root.add_subparsers(dest="command", required=True)
    api = commands.add_parser("serve", help="Serve camera-free RGBA frame inference for a fusion client")
    api.add_argument("--model", default="data/angle-model.json")
    api.add_argument("--service-config", default="service-config.json")
    api.add_argument("--port", type=int)
    cam = commands.add_parser("calibrate-camera", help="Collect checkerboard views and calibrate webcam")
    cam.add_argument("--columns", type=int, default=9, help="Checkerboard INNER corners horizontally")
    cam.add_argument("--rows", type=int, default=6, help="Checkerboard INNER corners vertically")
    cam.add_argument("--square-mm", type=float, required=True)
    cam.add_argument("--output", default="data/camera.json")
    approx = commands.add_parser("camera-approximate", help="Create assumed intrinsics from resolution and FOV")
    approx.add_argument("--horizontal-fov-deg", type=float, help="Override camera.horizontal_fov_deg from config (default 60)")
    approx.add_argument("--output", default="data/camera.json")
    hinge = commands.add_parser("calibrate-hinge", help="Capture base at two measured opening angles")
    hinge.add_argument("--camera", default="data/camera.json")
    hinge.add_argument("--angles", type=float, nargs=2, required=True, metavar=("FIRST", "SECOND"))
    hinge.add_argument("--output", default="data/hinge.json")
    live = commands.add_parser("run", help="Select base and track geometric hinge angle")
    live.add_argument("--camera", default="data/camera.json")
    live.add_argument("--hinge", default="data/hinge.json")
    live.add_argument("--jsonl", help="Append per-frame measurements; invalid angles are null")
    ann = commands.add_parser("annotate", help="Serve browser UI for angles and two edge points or four corners")
    ann.add_argument("--input", default="data/annotations")
    ann.add_argument("--output", default="data/annotations.json")
    ann.add_argument("--host", default="127.0.0.1")
    ann.add_argument("--port", type=int, default=8765)
    ah = commands.add_parser("calibrate-hinge-annotations", help="Fit hinge from annotated reference photos")
    dataset_arguments(ah)
    ah.add_argument("--references", nargs="+", help="Image IDs for fitting; default: all annotations")
    ah.add_argument("--camera", default="data/camera.json")
    ah.add_argument("--output", default="data/hinge.json")
    ev = commands.add_parser("evaluate-annotations", help="Report errors for geometric or empirical estimates")
    dataset_arguments(ev)
    ev.add_argument("--camera", default="data/camera.json")
    ev.add_argument("--hinge", default="data/hinge.json")
    ev.add_argument("--model", help="Evaluate an uncalibrated model instead of camera/hinge geometry")
    ev.add_argument("--include-training", action="store_true", help="Include fitting images in aggregate errors (not independent validation)")
    ev.add_argument("--report", help="Save per-image results and metrics as JSON")
    train = commands.add_parser("train-uncalibrated", help="Fit a fast empirical model without camera calibration or dimensions")
    dataset_arguments(train)
    train.add_argument("--items", nargs="+", help="Image IDs for training; default: all annotations")
    train.add_argument("--output", default="data/angle-model.json")
    train.add_argument("--method", choices=("corners", "edge"), help="Use four fixed corners or a moving image boundary")
    fov_options = train.add_mutually_exclusive_group()
    fov_options.add_argument("--use-fov", dest="use_fov", action="store_true", default=None,
                             help="Add approximate plane-normal features using configured horizontal FOV")
    fov_options.add_argument("--no-fov", dest="use_fov", action="store_false",
                             help="Use only normalized corner shapes; no FOV needed")
    fov_options.add_argument("--horizontal-fov-deg", type=float, help="Enable FOV features with this value")
    live_uncal = commands.add_parser("run-uncalibrated", help="Track an empirical angle model without camera calibration")
    live_uncal.add_argument("--model", default="data/angle-model.json")
    live_uncal.add_argument("--jsonl", help="Append per-frame measurements; invalid angles are null")
    live_uncal.add_argument("--identity", choices=("disabled", "dino", "persam", "yolo"), default="disabled", help="Experimental object identity gate; default detector is unchanged")
    live_uncal.add_argument("--identity-config", default="identity-config.json")
    return root


def camera_mode(path):
    approximate = read_json(path).get("source") == "approximate"
    if approximate:
        print("Using approximate intrinsics (assumed FOV, zero distortion); validate against measured angles.")
    return "approximate intrinsics" if approximate else "calibrated"


def print_evaluation(rows, metrics):
    for row in rows:
        expected = f"{row['expected']:.2f}" if row["expected"] is not None else "invalid"
        estimate = f"{row['estimated']:.2f}" if row["estimated"] is not None else "unavailable"
        error = f"{row['error']:.2f}" if row["error"] is not None else "n/a"
        role = " [used for fit]" if row["used_for_fit"] else ""
        print(f"{row['item_id']}{role}: expected={expected} estimated={estimate} abs_error={error} deg {row['reason']}")
    print(json.dumps(metrics, indent=2, allow_nan=False))
    if not metrics["count"]:
        print("No independent evaluation images. Capture additional labeled photos or use --include-training to inspect fitting errors.")
    elif not metrics["success"]:
        print("No successful estimates; inspect failure reasons before live use.")


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        needs_dimensions = args.command in {"run", "calibrate-hinge", "calibrate-hinge-annotations"} or (
            args.command == "evaluate-annotations" and not args.model)
        config = Config.read(args.config, require_measurements=needs_dimensions)
        if args.command == "serve":
            from .service import make_server
            settings = read_json(args.service_config)
            if args.port is not None:
                settings["port"] = args.port
            with make_server(args.model, config, settings) as server:
                print(f"Keyboard service ready at http://{settings['host']}:{server.server_address[1]}", flush=True)
                server.serve_forever()
        elif args.command == "annotate":
            with serve(AnnotationStore(args.input, args.output, config.limits), args.host, args.port, config) as server:
                print(f"Annotation UI: http://{args.host}:{server.server_address[1]}/", flush=True)
                print("Open this URL in your browser. Camera access works on localhost; Ctrl+C stops the server.", flush=True)
                server.serve_forever()
        elif args.command == "camera-approximate":
            fov = config.horizontal_fov_deg if args.horizontal_fov_deg is None else args.horizontal_fov_deg
            camera = approximate_camera(config.width, config.height, fov)
            write_json(args.output, {**camera.payload(), "source": "approximate", "horizontal_fov_deg": fov})
            print(f"Saved approximate camera intrinsics to {args.output}; horizontal FOV {fov:g} deg")
        elif args.command == "calibrate-camera":
            capture_camera(config, args.columns, args.rows, args.square_mm, args.output)
        elif args.command == "train-uncalibrated":
            samples = load_samples(args.annotations, args.input or Path(args.annotations).with_suffix(""),
                                   config.limits, item_ids=args.items)
            use_fov = config.uncalibrated_use_fov if args.use_fov is None else args.use_fov
            fov = args.horizontal_fov_deg if args.horizontal_fov_deg is not None else (config.horizontal_fov_deg if use_fov else None)
            method = args.method or config.uncalibrated_method
            if args.method is None and samples and all(s.annotation.corner_mode == "visible-edge" for s in samples):
                method = "edge"
            if method == "edge":
                model = fit_edge_model(samples, args.input or Path(args.annotations).with_suffix(""), config.limits, fov)
            else:
                if any(s.annotation.corner_mode != "physical" for s in samples):
                    raise ValueError("Two-point edge annotations require --method edge")
                model = fit_model(samples, config.limits, fov)
            model.save(args.output)
            mae = model.validation["metrics"]["mean_abs_error"]
            print(f"Saved uncalibrated model to {args.output}; leave-one-angle-out MAE {mae:.2f} deg")
            print(f"Training range: {model.training_range[0]:g}–{model.training_range[1]:g} deg; live resolution: {model.image_size}")
            print(f"Method: {method}. " + (f"FOV assistance: {fov:g} deg" if fov is not None else "FOV assistance: off"))
            print("Cross-validation is a small-data diagnostic; evaluate additional independently labeled photos.")
            automatic = model.validation.get("automatic_detection")
            if automatic:
                metrics = automatic["metrics"]
                print(f"Automatic detection on fitting photos: {metrics['success']}/{metrics['count']} recognized (not independent validation).")
            if mae > config.limits.uncalibrated_max_validation_mae_deg:
                print(f"Low-quality fit: validation MAE exceeds {config.limits.uncalibrated_max_validation_mae_deg:g} deg. Review labels and collect more openings.")
        elif args.command == "run-uncalibrated":
            model = read_uncalibrated_model(args.model)
            if (config.width, config.height) != model.image_size:
                print(f"Using model resolution {model.image_size[0]}x{model.image_size[1]} "
                      f"instead of configured {config.width}x{config.height}.")
                config = replace(config, width=model.image_size[0], height=model.image_size[1])
            from .identity import load_verifier
            if args.identity != 'disabled' and not isinstance(model, EdgeModel):
                raise ValueError('Identity verification requires a moving-edge model')
            verifier = load_verifier({"method": args.identity, "config": args.identity_config}, model.image_size)
            session = EdgeSession(model, config.limits, verifier) if isinstance(model, EdgeModel) else UncalibratedSession(model, config.limits)
            mode = "approximate / moving edge" if isinstance(model, EdgeModel) else "approximate / uncalibrated"
            run_live(config, session.camera, session, args.jsonl, mode)
        elif args.command == "evaluate-annotations":
            if args.model:
                model = read_uncalibrated_model(args.model)
                rows, metrics = evaluate(args.annotations, None, config, None, args.input, model=model,
                                         include_training=args.include_training)
                print("Evaluating approximate / uncalibrated estimates.")
            else:
                camera = Camera.read(args.camera)
                camera_mode(args.camera)
                hinge = Hinge.read(args.hinge, camera, config.points)
                refs = read_json(args.hinge).get("reference_ids", [])
                if not refs:
                    print("Legacy hinge file has no reference image IDs; ensure evaluation photos are independent.")
                rows, metrics = evaluate(args.annotations, camera, config, hinge, args.input, reference_ids=refs,
                                         include_training=args.include_training)
            print_evaluation(rows, metrics)
            if args.report:
                write_json(args.report, {"rows": rows, "metrics": metrics})
        else:
            camera = Camera.read(args.camera)
            mode = camera_mode(args.camera)
            if args.command == "calibrate-hinge":
                capture_hinge(config, camera, args.angles, args.output)
            elif args.command == "calibrate-hinge-annotations":
                _, residual = calibrate_hinge_annotations(config, camera, args.annotations, args.output,
                                                         args.input, args.references)
                print(f"Saved hinge calibration to {args.output}; mount agreement {residual:.3f} deg")
            else:
                run(config, camera, Hinge.read(args.hinge, camera, config.points), args.jsonl, mode)
    except KeyboardInterrupt:
        print("Stopped.")
        return 0
    except (ValueError, OSError, KeyError, TypeError, cv2.error) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())

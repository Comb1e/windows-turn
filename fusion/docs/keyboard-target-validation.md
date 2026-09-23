# Keyboard target priority — Fusion 0.2.2

Validated on 2026-09-17. The controller must use the keyboard angle as its correction target whenever a fresh valid keyboard observation exists. Brightness supplies a fallback after keyboard loss. The displayed angle follows the existing smooth correction trajectory.

## Reproduced counterexample

A deterministic 60 Hz driver supplied a stationary 25° keyboard reading every 300 ms, brightness at 110°, and conflicting scene motion of +60°/s. The keyboard samples were within the 500 ms freshness limit but too sparse for the 250 ms velocity window. Comparing the committed 0.2.1 controller with 0.2.2 using identical inputs gave:

| After three seconds | 0.2.1 | 0.2.2 |
| --- | ---: | ---: |
| Keyboard measurement | 25° | 25° |
| Displayed angle | 59.153958° | 25° |
| Input motion source | Scene | Unavailable (zero input) |

The old controller replaced unavailable keyboard velocity with scene velocity. That velocity extrapolated the measurement between captures and moved future trajectory endpoints away from the stationary keyboard angle. Checking only `measurementAngleDeg` could not detect this failure. Separately, filtered motion carried from a previous source could age-shift a newly acquired keyboard target.

The fix binds input motion to its target source and retains a no-extrapolation policy with keyboard observations. The keyboard target remains exact while physical filter state decays continuously. It does not blend keyboard and brightness angles or add a filter. Future waypoints may still use measured keyboard velocity for moving targets.

## Verification

- All **32 Fusion tests** pass, including the original 28 tests.
- New controller cases cover stationary 10°, 25° and 46° keyboard angles against both +60°/s and −60°/s scene motion, sparse but fresh readings, and low reported keyboard confidence. All converge within the existing one-second deadline.
- Moving-keyboard tests check exact target identity between samples while preserving keyboard-derived feedforward. Source reacquisition checks continuity of position, velocity, acceleration and jerk against the previously evaluated trajectory, with the original deadline unchanged.
- Boundaries cover the 200 ms keyboard grace, the 500 ms freshness/display hold, stale freeze, missing measurements, rejected reordered samples, resumed keyboard priority and brightness fallback. Existing reversal, physical-range, stale-gap, trajectory extrema, profile/calibration and source-jump checks remain passing.
- The real coordinator HTTP/SSE test uses sparse keyboard updates against conflicting scene motion, checks convergence and `/api/angle` target reporting, then loses and reacquires the keyboard. Publications use the configured **60 Hz** loop. Camera pixels and measurement services are simulated.
- UI orchestration verifies the target and displayed angle separately, held/unavailable labels and obsolete-session rejection.
- All **4 renderer CTest suites** pass, including its native HTTP client against the actual Fusion coordinator. Renderer projection and input handling were not modified.

Physical-camera accuracy and live lid movement still require the user's hardware observations. Abrupt late changes can miss an already imminent correction deadline; the existing overdue status reports this. Sparse keyboard motion can lag without enough samples for a reliable slope. Stale freezing and physical-range clipping remain explicit exceptions to derivative continuity. No display refresh settings were changed.

## References actually consulted

- [Ruckig project](https://github.com/pantor/ruckig), especially its current-state/target-state API and replanning description: a design reference for keeping an authoritative target separate from retained trajectory state. No Ruckig implementation was copied or dependency added.
- Lars Berscheid and Torsten Kröger, [Jerk-limited Real-time Trajectory Generation with Arbitrary Target States](https://arxiv.org/abs/2105.04830), 2021: the abstract's separation of target position, velocity and acceleration informed the source-bound target/motion contract. This change retains Fusion's existing septic controller and makes no time-optimality claim.
- Existing `fusion/src/controller.js`, `motion-feedforward.js`, `trajectory.js` and controller/trajectory tests: the actual continuity, source-selection and deadline contracts preserved by the fix.

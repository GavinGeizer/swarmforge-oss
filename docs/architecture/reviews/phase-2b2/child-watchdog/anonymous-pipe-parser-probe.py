#!/usr/bin/env python3
"""Supplemental inert child-parser evidence; not provider/renewal qualification.

Shell-created anonymous pipe only. No FIFO files, FFI, network, credentials,
SwarmForge CLI, arbitrary payload or production changes. Consumer is unchanged
src/hosted-child-script.ts from the pinned source revision.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import time

SOURCE_REVISION = "f24b4a8380dbd4082b2c2b47b1bf0f87f6a41091"
CASES = {
    "full_31s": (31000, 2000),
    "malformed": (3000, 2500),
    "expired_frame": (3000, 2500),
    "oversized": (3000, 2500),
    "late": (3000, 300),
    "buffered_late": (3000, 400),
}


def boot_ms():
    # Independent evidence implementation: Linux reports centisecond uptime.
    whole, fraction = Path("/proc/uptime").read_text().split()[0].split(".")
    return int(whole) * 1000 + int(fraction) * 10


def diagnostic(kind, **data):
    print(json.dumps({"kind": kind, **data}), file=sys.stderr, flush=True)


def produce(case):
    if case not in CASES:
        raise ValueError("unknown static fixture")
    anonymous_pipe = stat.S_ISFIFO(os.fstat(sys.stdout.fileno()).st_mode)
    diagnostic("producer_pipe", anonymous_pipe=anonymous_pipe)
    if not anonymous_pipe:
        raise RuntimeError("producer stdout is not a shell-created OS pipe")
    end = int(os.environ["SWARMFORGE_HOSTED_ABSOLUTE_BOOT_MS"])
    previous = int(os.environ["SWARMFORGE_HOSTED_LEASE_BOOT_MS"])
    started = time.monotonic()
    count = 0
    try:
        while True:
            if case == "full_31s":
                lease = min(boot_ms() + 2000, end)
                payload = f"{lease} {end}\n"
            elif case == "malformed":
                time.sleep(0.1 if count == 0 else 0)
                payload = "garbage\n"
            elif case == "expired_frame":
                time.sleep(0.1 if count == 0 else 0)
                payload = "1 2\n"
            elif case == "oversized":
                time.sleep(0.1 if count == 0 else 0)
                payload = "X" * 257
            else:
                if count == 0:
                    time.sleep(0.5 if case == "late" else 0.45)
                observed = boot_ms()
                diagnostic("late_frame_attempt", case=case, observed_boot_ms=observed,
                           previous_lease_boot_ms=previous, previous_expired=observed > previous)
                payload = f"{min(observed + 2000, end)} {end}\n"
            sys.stdout.write(payload)
            sys.stdout.flush()
            count += 1
            if count == 1:
                diagnostic("first_frame_delivered", case=case, bytes=len(payload),
                           elapsed_ms=round((time.monotonic() - started) * 1000))
            time.sleep(0.5 if case == "full_31s" else 0.1)
    except BrokenPipeError:
        diagnostic("consumer_closed_pipe", case=case, delivered_frames=count)
        # Avoid Python's second flush turning expected consumer exit into failure.
        os.close(sys.stdout.fileno())
        os._exit(0)


# All shell commands and child entry are static. Paths/fixture name are quoted
# positional parameters. Child environment is rebuilt explicitly with only
# PATH, TZ, bounded duration and numeric initial authority deadlines.
PIPELINE = r'''
"$1" "$2" produce "$3" | {
  if [ "$3" = buffered_late ]; then
    env -i PATH=/usr/bin:/bin TZ=UTC \
      SWARMFORGE_HOSTED_DURATION="$SWARMFORGE_HOSTED_DURATION" \
      SWARMFORGE_HOSTED_LEASE_BOOT_MS="$SWARMFORGE_HOSTED_LEASE_BOOT_MS" \
      SWARMFORGE_HOSTED_ABSOLUTE_BOOT_MS="$SWARMFORGE_HOSTED_ABSOLUTE_BOOT_MS" \
      "$4" --no-env-file --config=/dev/null "$5" <&0 &
    child_pid=$!
    sleep 0.1
    kill -STOP "$child_pid" || exit 90
    sleep 0.6
    kill -CONT "$child_pid" || exit 91
    wait "$child_pid"
    child_status=$?
  else
    env -i PATH=/usr/bin:/bin TZ=UTC \
      SWARMFORGE_HOSTED_DURATION="$SWARMFORGE_HOSTED_DURATION" \
      SWARMFORGE_HOSTED_LEASE_BOOT_MS="$SWARMFORGE_HOSTED_LEASE_BOOT_MS" \
      SWARMFORGE_HOSTED_ABSOLUTE_BOOT_MS="$SWARMFORGE_HOSTED_ABSOLUTE_BOOT_MS" \
      "$4" --no-env-file --config=/dev/null "$5"
    child_status=$?
  fi
  "$1" "$2" exited "$3" "$child_status"
  exit "$child_status"
}
'''


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "produce":
        produce(sys.argv[2])
        return
    if len(sys.argv) > 1 and sys.argv[1] == "exited":
        print(json.dumps({"case": sys.argv[2], "child_exit": int(sys.argv[3]),
                          "child_exit_observed_mono_ns": time.monotonic_ns()}), flush=True)
        return
    root = Path(__file__).resolve().parents[5]
    child = root / "src/hosted-child-script.ts"
    bun = shutil.which("bun")
    if not bun:
        raise RuntimeError("Bun unavailable")
    actual = {}
    for name in ("src/hosted-child.ts", "src/hosted-child-script.ts"):
        pinned = subprocess.check_output(["git", "show", f"{SOURCE_REVISION}:{name}"], cwd=root)
        content = (root / name).read_bytes()
        if pinned != content:
            raise RuntimeError(f"consumer differs from pinned revision: {name}")
        actual[name] = hashlib.sha256(content).hexdigest()
    print(json.dumps({"source_revision": SOURCE_REVISION, "source_sha256": actual,
                      "qualification": "supplemental actual child parser only; no production provider transport"}), flush=True)
    failures = 0
    for case, (duration, lease_ms) in CASES.items():
        now = boot_ms()
        env = {
            "PATH": "/usr/bin:/bin", "TZ": "UTC",
            "SWARMFORGE_HOSTED_DURATION": str(duration),
            "SWARMFORGE_HOSTED_LEASE_BOOT_MS": str(now + lease_ms),
            "SWARMFORGE_HOSTED_ABSOLUTE_BOOT_MS": str(now + duration + 1000),
        }
        start = time.monotonic_ns()
        completed = subprocess.run(
            ["/bin/bash", "-c", PIPELINE, "anonymous-pipe-parser-probe",
             sys.executable, str(Path(__file__).resolve()), case, bun, str(child)],
            cwd=root, env=env, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=38,
        )
        events = [json.loads(line) for line in completed.stdout.splitlines() if line]
        diagnostic_events = [json.loads(line) for line in completed.stderr.splitlines() if line.startswith("{")]
        exit_event = next((event for event in events if "child_exit" in event), None)
        elapsed = ((exit_event["child_exit_observed_mono_ns"] - start) / 1_000_000
                   if exit_event else None)
        expected = 0 if case == "full_31s" else 4
        passed = (exit_event is not None and exit_event["child_exit"] == expected
                  and completed.returncode == expected
                  and any(event.get("anonymous_pipe") is True for event in diagnostic_events))
        if case == "full_31s":
            passed = passed and elapsed >= 31000
        if case == "buffered_late":
            passed = (passed and any(event.get("previous_expired") is True for event in diagnostic_events)
                      and any(event.get("kind") == "first_frame_delivered" for event in diagnostic_events))
        result = {"case": case, "pass": passed, "expected_child_exit": expected,
                  "pipeline_exit": completed.returncode, "consumer_elapsed_ms": elapsed,
                  "exit_event": exit_event, "producer_evidence": diagnostic_events,
                  "stderr_other": [line for line in completed.stderr.splitlines() if not line.startswith("{")]}
        print(json.dumps(result), flush=True)
        failures += not passed
    print(json.dumps({"supplemental_cases": len(CASES), "failed": failures,
                      "production_provider_renewal_transport_qualified": False}), flush=True)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()

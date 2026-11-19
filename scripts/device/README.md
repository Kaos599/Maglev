# Device checks

Scripts that run against a real phone over adb. They never install, uninstall, clear data or change settings,
and they delete only the files they created.

## test-link-faults.sh

Checks link downloads against `faultserver.py`, a small server on this Mac that breaks downloads on purpose.
The phone and the Mac must be on the same Wi-Fi; set `MAGLEV_HOST_IP` if `en0` is not the right address.

    scripts/device/test-link-faults.sh

Every file is checked by SHA-256 against the bytes the server sent. What each row proves:

- **baseline**: 4 parts land at the right offsets.
- **drop30 / short**: a part whose connection is cut, or whose body ends early, resumes from its own offset.
- **cap3-limit2**: a server that accepts 2 connections and refuses the rest with 429 (like proof.ovh.net).
  The accepted parts keep going and the refused ones wait; it fails if Maglev falls back to one connection.
- **plain / noheadrange**: servers without range support get one connection and a correct file.
- **1 MB / 9 MB**: the 8 MiB split threshold.
- **speed**: with each connection capped at 3 MB/s, 4 parts must be at least 3x faster than 1.

Run it before a release; it takes a few minutes.

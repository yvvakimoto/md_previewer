#!/usr/bin/env bash
# Re-dump a subset of samples and diff against the baseline in _dom/base.
# Usage: tools/preview-harness/gate.sh <label> <file.md> [more.md ...]
set -u
label="$1"; shift
out="_dom/$label"
rm -rf "$out"
python tools/preview-harness/domdump.py "$@" --out "$out" --modes scroll,deck,list --dark >/dev/null 2>&1
fail=0
for f in "$out"/*.txt; do
  b="_dom/base/$(basename "$f")"
  if [ ! -f "$b" ]; then echo "NEW (no baseline): $(basename "$f")"; fail=1; continue; fi
  if ! diff -q "$b" "$f" >/dev/null; then echo "DIFF: $(basename "$f")"; fail=1; fi
done
[ "$fail" -eq 0 ] && echo "*** $label gate PASSED ($(ls "$out"/*.txt | wc -l) digests identical) ***"
exit $fail

#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <ns3-root> <fixture-dir> <output-dir>" >&2
  exit 2
fi

to_posix_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$1"
  else
    printf '%s\n' "$1"
  fi
}

NS3_ROOT="$(to_posix_path "$1")"
FIXTURE_DIR="$(to_posix_path "$2")"
OUTPUT_DIR="$(to_posix_path "$3")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_FILE="$SCRIPT_DIR/scratch/leo-int-system-validation.cc"

if [[ ! -f "$NS3_ROOT/ns3" ]]; then
  echo "ns-3 launcher not found: $NS3_ROOT/ns3" >&2
  exit 3
fi
if [[ ! -f "$FIXTURE_DIR/config.json" ]]; then
  echo "Experiment 13 fixture not found: $FIXTURE_DIR" >&2
  exit 4
fi

mkdir -p "$OUTPUT_DIR" "$NS3_ROOT/scratch"
cp "$SOURCE_FILE" "$NS3_ROOT/scratch/leo-int-system-validation.cc"
rm -f "$OUTPUT_DIR"/ns3-result-*.csv

cd "$NS3_ROOT"
if [[ ! -f build-status.py ]]; then
  ./ns3 configure \
    --build-profile=optimized \
    --disable-examples \
    --disable-tests \
    --enable-modules="core;network;internet;point-to-point"
fi
./ns3 build scratch/leo-int-system-validation

for load in 0.6 1 1.4 2; do
  for variant in no-int full-int leo-selective; do
    output="$OUTPUT_DIR/ns3-result-${variant}-${load}.csv"
    echo "[Experiment 13 ns-3] load=$load variant=$variant"
    ./ns3 run "scratch/leo-int-system-validation \
      --inputDir=$FIXTURE_DIR \
      --output=$output \
      --variant=$variant \
      --loadScale=$load \
      --seed=11 \
      --sliceCount=20 \
      --sliceDuration=1 \
      --mtuBytes=1500 \
      --queuePackets=100 \
      --ipUdpOverhead=28 \
      --reportTimeout=2"
  done
done

echo "Experiment 13 ns-3 outputs: $OUTPUT_DIR"

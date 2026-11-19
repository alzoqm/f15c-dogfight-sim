#!/bin/sh
# 새 v2 스냅숏(ckpt/v2_it*.pt)이 생길 때마다 벤치마크해서 bench_progress.txt에 한 줄씩 기록
cd "$(dirname "$0")"
export PYTHONIOENCODING=utf-8 AIM_SETTLE=0.3
touch bench_done.txt
while true; do
  for f in $(ls ckpt/v2_it*.pt 2>/dev/null | sort); do
    grep -qx "$f" bench_done.txt && continue
    sleep 5
    out=$(python bench.py "$f" --n 48 2>&1)
    echo "== $f" >> bench_progress.txt
    echo "$out" >> bench_progress.txt
    echo "$f $(echo "$out" | tail -1)" >> bench_summary.txt
    echo "$f" >> bench_done.txt
  done
  sleep 60
done

#!/bin/sh
# 밤샘 감시: 100회마다 새 스냅숏을 현재 전설(ckpt/legend_v2.pt)과 시뮬레이터 맞대결(128판).
# 점수 0.58 이상인 후보가 나오면 종료(→ 검증·승격), 아니면 최대 MAXMIN분 뒤 종료(→ 상태 점검). 결과는 h2h_summary.txt
# 평가는 2스레드로 제한 (학습 작업자 12개의 CPU를 뺏지 않도록)
cd "$(dirname "$0")"
export PYTHONIOENCODING=utf-8 AIM_SETTLE=0.3 OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 MKL_NUM_THREADS=2
MAXMIN=${1:-120}
MINIT=${2:-900}
start=$(date +%s)
touch h2h_done.txt
while true; do
  for f in $(ls ckpt/v2_it*.pt 2>/dev/null | sort); do
    it=$(echo "$f" | sed 's/.*v2_it\([0-9]*\)\.pt/\1/' | sed 's/^0*//')
    it=${it:-0}
    [ $((it % 100)) -ne 0 ] && continue
    grep -qx "$f" h2h_done.txt && continue
    [ "$it" -le "$MINIT" ] && { echo "$f" >> h2h_done.txt; continue; }
    sleep 5
    out=$(python h2h.py "$f" ckpt/legend_v2.pt --n 64 2>&1 | tail -1)
    echo "$(date +%H:%M) $out" >> h2h_summary.txt
    echo "$f" >> h2h_done.txt
    sc=$(echo "$out" | sed 's/.*점수 //')
    if python -c "import sys; sys.exit(0 if float('$sc') >= 0.58 else 1)" 2>/dev/null; then
      # 무작위 조건에서 앞서면 게임 조건(머지 출발, 양쪽 전설 성능)으로 한 번 더
      og=$(python h2h.py "$f" ckpt/legend_v2.pt --n 48 --game 2>&1 | tail -1)
      echo "$(date +%H:%M) $og" >> h2h_summary.txt
      sg=$(echo "$og" | sed 's/.*점수 //')
      if python -c "import sys; sys.exit(0 if float('$sg') >= 0.57 else 1)" 2>/dev/null; then
        echo "PROMOTE_CANDIDATE $f $out / $og"; exit 0
      fi
    fi
  done
  now=$(date +%s)
  [ $(( (now - start) / 60 )) -ge "$MAXMIN" ] && { echo "TIMEOUT check-in"; tail -3 h2h_summary.txt; exit 0; }
  sleep 60
done

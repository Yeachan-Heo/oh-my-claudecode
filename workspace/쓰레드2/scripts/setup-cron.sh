#!/bin/bash
# BiniLab 스케줄 등록 (crontab에 추가)
# Usage: bash scripts/setup-cron.sh [--remove]
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$1" = "--remove" ]; then
  crontab -l 2>/dev/null | grep -v 'binilab' | crontab -
  echo "BiniLab cron 제거 완료"
  exit 0
fi

# 기존 binilab 항목 제거 후 추가
(crontab -l 2>/dev/null | grep -v 'binilab'; echo "
# BiniLab 자동 파이프라인
0 8 * * * cd $PROJECT_DIR && npx tsx scripts/run-daily.ts --phase morning >> /tmp/binilab-morning.log 2>&1 # binilab
0 20 * * * cd $PROJECT_DIR && npx tsx scripts/run-daily.ts --phase evening >> /tmp/binilab-evening.log 2>&1 # binilab
") | crontab -

echo "BiniLab cron 등록 완료"
echo "확인: crontab -l | grep binilab"

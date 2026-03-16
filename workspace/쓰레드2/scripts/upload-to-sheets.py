#!/usr/bin/env python3
"""
upload-to-sheets.py — raw_posts JSON → Google Sheets 레퍼런스 시트 업로드

Usage:
  .venv/bin/python scripts/upload-to-sheets.py                    # 모든 raw_posts 업로드
  .venv/bin/python scripts/upload-to-sheets.py --run-id run_20260315_0327  # 특정 run만
  .venv/bin/python scripts/upload-to-sheets.py --dry-run          # 시트 반영 없이 미리보기
"""

import json
import glob
import os
import sys
import argparse
from datetime import datetime

import gspread

# ─── Config ──────────────────────────────────────────────
SPREADSHEET_ID = '1U-m4sJvV_EyELTRk7ECDYXLLlvF8Kqf4YmrjzVnDJgE'
SHEET_NAME = '레퍼런스'
RAW_POSTS_DIR = os.path.join(os.path.dirname(__file__), '..', 'data', 'raw_posts')

# 레퍼런스 시트 컬럼 순서 (reference_template.csv 기준)
COLUMNS = [
    # 채널 정보
    'channel_id', 'display_name', 'follower_count', 'category',
    # 훅 본문
    'hook_post_id', 'hook_post_url', 'hook_date', 'hook_text',
    'hook_view_count', 'hook_like_count', 'hook_reply_count', 'hook_repost_count',
    'hook_has_image', 'hook_media_urls',
    # 셀프답글
    'reply_post_id', 'reply_post_url', 'reply_text',
    'reply_view_count', 'reply_like_count', 'reply_media_urls',
    # 전환율
    'conversion_rate',
    # 링크
    'thread_type', 'link_location', 'link_url', 'link_domain',
    # 메타
    'run_id', 'crawl_timestamp', 'login_status', 'block_detected',
]


def load_raw_posts(run_id_filter=None):
    """raw_posts 디렉토리에서 JSON 파일들을 로드하여 행 데이터로 변환"""
    rows = []
    files = sorted(glob.glob(os.path.join(RAW_POSTS_DIR, '*.json')))

    for filepath in files:
        filename = os.path.basename(filepath)
        # Skip checkpoint files
        if filename.startswith('checkpoint'):
            continue

        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            print(f'  SKIP {filename}: {e}')
            continue

        meta = data.get('meta', {})
        run_id = meta.get('run_id', '')

        # run_id 필터
        if run_id_filter and run_id != run_id_filter:
            continue

        channel_id = meta.get('channel_id', '')
        channel_info = meta.get('channel_info', {})
        collected_at = meta.get('collected_at', '')

        units = data.get('thread_units', [])
        print(f'  {filename}: {len(units)} units (run={run_id})')

        for unit in units:
            # 미디어 URLs → 쉼표 구분 문자열
            hook_media = ', '.join(unit.get('hook_media_urls', []) or [])
            reply_media = ', '.join(unit.get('reply_media_urls', []) or [])

            row = [
                # 채널 정보
                unit.get('channel_id', channel_id),
                unit.get('display_name', channel_info.get('display_name', '')),
                unit.get('follower_count', channel_info.get('follower_count', '')),
                unit.get('category', channel_info.get('category', '')),
                # 훅 본문
                unit.get('hook_post_id', ''),
                unit.get('hook_post_url', ''),
                unit.get('hook_date', ''),
                unit.get('hook_text', ''),
                safe_num(unit.get('hook_view_count')),
                safe_num(unit.get('hook_like_count')),
                safe_num(unit.get('hook_reply_count')),
                safe_num(unit.get('hook_repost_count')),
                'TRUE' if unit.get('hook_has_image') else 'FALSE',
                hook_media,
                # 셀프답글
                unit.get('reply_post_id', ''),
                unit.get('reply_post_url', ''),
                unit.get('reply_text', ''),
                safe_num(unit.get('reply_view_count')),
                safe_num(unit.get('reply_like_count')),
                reply_media,
                # 전환율
                safe_num(unit.get('conversion_rate')),
                # 링크
                unit.get('thread_type', ''),
                unit.get('link_location', ''),
                unit.get('link_url', ''),
                unit.get('link_domain', ''),
                # 메타
                run_id,
                collected_at,
                'logged_in',
                'FALSE',
            ]
            rows.append(row)

    return rows


def safe_num(val):
    """숫자/None → 시트용 값 변환"""
    if val is None or val == '' or val == -1:
        return ''
    if isinstance(val, (int, float)):
        return val
    # 문자열 숫자 시도
    try:
        if '.' in str(val):
            return float(val)
        return int(val)
    except (ValueError, TypeError):
        return str(val)


def upload_to_sheets(rows, dry_run=False):
    """Google Sheets 레퍼런스 시트에 업로드"""
    print(f'\n총 {len(rows)}행 준비됨')

    if dry_run:
        print('\n[DRY RUN] 처음 3행 미리보기:')
        for i, row in enumerate(rows[:3]):
            print(f'  Row {i+1}: channel={row[0]}, hook_id={row[4]}, type={row[21]}, views={row[8]}')
        print(f'  ... 총 {len(rows)}행')
        return

    if len(rows) == 0:
        print('업로드할 데이터 없음')
        return

    print('Google Sheets 연결 중...')
    gc = gspread.oauth()
    sh = gc.open_by_key(SPREADSHEET_ID)
    ws = sh.worksheet(SHEET_NAME)

    # 기존 데이터 확인 — 헤더 행 다음부터 추가
    existing = ws.get_all_values()
    if len(existing) == 0:
        # 헤더 행 추가
        ws.update([COLUMNS], 'A1')
        start_row = 2
        print('헤더 행 추가됨')
    else:
        start_row = len(existing) + 1
        print(f'기존 {len(existing)}행 존재 — {start_row}행부터 추가')

    # 중복 제거: 기존 hook_post_id 수집
    existing_post_ids = set()
    if len(existing) > 1:
        # hook_post_id는 5번째 컬럼 (index 4)
        header = existing[0]
        try:
            hook_id_col = header.index('hook_post_id')
        except ValueError:
            hook_id_col = 4  # fallback

        for row in existing[1:]:
            if len(row) > hook_id_col and row[hook_id_col]:
                existing_post_ids.add(row[hook_id_col])

    # 중복 필터링
    new_rows = []
    dup_count = 0
    for row in rows:
        hook_id = row[4]  # hook_post_id
        if hook_id and hook_id in existing_post_ids:
            dup_count += 1
            continue
        new_rows.append(row)
        existing_post_ids.add(hook_id)

    if dup_count > 0:
        print(f'중복 제거: {dup_count}건 스킵')

    if len(new_rows) == 0:
        print('새로운 데이터 없음 (모두 중복)')
        return

    # Batch update (최대 1000행씩)
    BATCH_SIZE = 1000
    total_uploaded = 0

    for i in range(0, len(new_rows), BATCH_SIZE):
        batch = new_rows[i:i + BATCH_SIZE]
        cell_range = f'A{start_row + i}'
        ws.update(batch, cell_range, value_input_option='USER_ENTERED')
        total_uploaded += len(batch)
        print(f'  배치 업로드: {total_uploaded}/{len(new_rows)}행')

    print(f'\n업로드 완료: {total_uploaded}행 추가 (시작: {start_row}행)')
    print(f'스프레드시트: https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}')


def main():
    parser = argparse.ArgumentParser(description='raw_posts → Google Sheets 업로드')
    parser.add_argument('--run-id', help='특정 run_id만 업로드')
    parser.add_argument('--dry-run', action='store_true', help='시트 반영 없이 미리보기')
    args = parser.parse_args()

    print('=== raw_posts → Google Sheets 업로드 ===')
    print(f'소스: {RAW_POSTS_DIR}')
    if args.run_id:
        print(f'필터: run_id={args.run_id}')

    rows = load_raw_posts(run_id_filter=args.run_id)
    upload_to_sheets(rows, dry_run=args.dry_run)


if __name__ == '__main__':
    main()

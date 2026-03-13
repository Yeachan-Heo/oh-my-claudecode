#!/usr/bin/env python3
"""
Google Sheets 업로더 — JSON 수집 결과를 '레퍼런스' 시트에 기록
- 기존 행 아래에 추가 (append)
- hook_post_id 기준 중복 체크 → 이미 있는 포스트는 skip
- 미디어 URL은 개별 컬럼으로 분리 (이미지/동영상 구분)

Usage: python upload-sheets.py <json_file>
"""

import json
import sys
from datetime import datetime

import gspread

SPREADSHEET_ID = '1U-m4sJvV_EyELTRk7ECDYXLLlvF8Kqf4YmrjzVnDJgE'
WORKSHEET_NAME = '레퍼런스'

MAX_MEDIA = 5  # 미디어 슬롯 최대 개수

# hook_post_id 컬럼 인덱스 (0-based) — hook_post_url 제거 후 인덱스 변경 없음
HOOK_POST_ID_COL = 4

# 기본 컬럼 (hook_post_url, hook_media_urls 제거)
BASE_HEADERS = [
    'channel_id', 'display_name', 'follower_count', 'category',
    'hook_post_id', 'hook_date', 'hook_text',
    'hook_view_count', 'hook_like_count', 'hook_reply_count', 'hook_repost_count',
    'hook_has_image',
    'reply_post_id', 'reply_post_url', 'reply_text',
    'reply_view_count', 'reply_like_count', 'reply_media_urls',
    'conversion_rate',
    'thread_type', 'link_location', 'link_url', 'link_domain',
    'run_id', 'crawl_timestamp', 'login_status', 'block_detected',
]

# 끝에 미디어 개별 컬럼 추가
MEDIA_HEADERS = []
for i in range(1, MAX_MEDIA + 1):
    MEDIA_HEADERS.append(f'hook_media_{i}_url')
    MEDIA_HEADERS.append(f'hook_media_{i}_type')

HEADERS = BASE_HEADERS + MEDIA_HEADERS


def classify_media(url):
    """URL을 보고 이미지/동영상 구분"""
    url_lower = url.lower()
    if any(ext in url_lower for ext in ['.mp4', '.mov', '.webm', '/video']):
        return '동영상'
    return '이미지'


def format_row(unit, meta):
    """thread_unit dict → Sheets row list"""
    def fmt(val):
        if val is None:
            return ''
        if isinstance(val, bool):
            return 'TRUE' if val else 'FALSE'
        if isinstance(val, list):
            return ', '.join(str(v) for v in val[:5])
        return str(val)

    row = []
    for col in BASE_HEADERS:
        if col == 'run_id':
            row.append(meta.get('run_id', ''))
        elif col == 'crawl_timestamp':
            row.append(meta.get('collected_at', datetime.now().isoformat()))
        elif col == 'login_status':
            row.append('logged_in')
        elif col == 'block_detected':
            row.append('FALSE')
        elif col == 'conversion_rate':
            val = unit.get(col)
            row.append(f'{val}' if val is not None else '')
        else:
            row.append(fmt(unit.get(col, '')))

    # 미디어 URL 개별 컬럼
    media_urls = unit.get('hook_media_urls', []) or []
    for i in range(MAX_MEDIA):
        if i < len(media_urls):
            url = media_urls[i]
            row.append(url)
            row.append(classify_media(url))
        else:
            row.append('')
            row.append('')

    return row


def main():
    if len(sys.argv) < 2:
        print('Usage: python upload-sheets.py <json_file>')
        sys.exit(1)

    json_path = sys.argv[1]
    with open(json_path) as f:
        data = json.load(f)

    meta = data['meta']
    units = data['thread_units']
    print(f'📊 {len(units)}개 쓰레드 단위 → Google Sheets 업로드')

    # Connect to Google Sheets
    gc = gspread.oauth()
    sh = gc.open_by_key(SPREADSHEET_ID)

    # Get or create worksheet
    try:
        ws = sh.worksheet(WORKSHEET_NAME)
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(title=WORKSHEET_NAME, rows=1000, cols=len(HEADERS))

    # Read existing data
    existing = ws.get_all_values()

    # 헤더가 변경됐으면 전체 초기화
    if not existing or existing[0] != HEADERS:
        # 기존 데이터 전부 지우고 새 헤더로
        if existing and len(existing) > 1:
            print(f'  ⚠️  헤더 변경 감지 — 기존 {len(existing) - 1}행 보존하며 헤더 갱신')
        ws.clear()
        ws.update(range_name='A1', values=[HEADERS])
        existing = [HEADERS]
        print('  ✅ 새 헤더 작성 완료')

    # Collect existing hook_post_ids for dedup
    existing_ids = set()
    for row in existing[1:]:
        if len(row) > HOOK_POST_ID_COL and row[HOOK_POST_ID_COL]:
            existing_ids.add(row[HOOK_POST_ID_COL])

    print(f'  📋 기존 데이터: {len(existing) - 1}행, 고유 post_id: {len(existing_ids)}개')

    # Format rows, filtering out duplicates
    new_rows = []
    skipped = 0
    for unit in units:
        post_id = unit.get('hook_post_id', '')
        if post_id in existing_ids:
            skipped += 1
            continue
        new_rows.append(format_row(unit, meta))
        existing_ids.add(post_id)

    if skipped > 0:
        print(f'  ⏭️  중복 {skipped}개 skip')

    if not new_rows:
        print('  ℹ️  새로 추가할 데이터 없음 (전부 중복)')
        return

    # Append after last existing row
    start_row = len(existing) + 1
    ws.update(range_name=f'A{start_row}', values=new_rows)

    print(f'  ✅ {len(new_rows)}행 기록 완료 (행 {start_row}~{start_row + len(new_rows) - 1})')
    print(f'  📎 https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}')


if __name__ == '__main__':
    main()

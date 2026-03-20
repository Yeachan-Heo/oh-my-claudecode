#!/usr/bin/env python3
"""
discover-youtube-channels.py — YouTube 뷰티 채널 발굴 (API 쿼터 0)

yt-dlp + scrapetube로 채널 검색/검증. YouTube Data API 쿼터를 사용하지 않는다.

Usage:
  python3 scripts/discover-youtube-channels.py search                    # 뷰티 키워드 8개로 자동 검색
  python3 scripts/discover-youtube-channels.py search "올리브영 추천"     # 특정 키워드 검색
  python3 scripts/discover-youtube-channels.py search --min-subs 50000   # 구독자 기준 변경
  python3 scripts/discover-youtube-channels.py channel UCxxxxxxxx        # 단일 채널 검증
  python3 scripts/discover-youtube-channels.py audit                     # 기존 시드 채널 감사
"""

import argparse
import json
import os
import re
import subprocess
import sys

try:
    import scrapetube
except ImportError:
    print("scrapetube 미설치. 실행: pip install --break-system-packages scrapetube")
    sys.exit(1)


# ─── Channel Info (yt-dlp, no API) ────────────────────────

def get_channel_info(channel_id: str) -> dict | None:
    """yt-dlp로 채널 정보를 가져온다 (API 쿼터 0)."""
    try:
        url = f"https://www.youtube.com/channel/{channel_id}/videos"
        result = subprocess.run(
            ["yt-dlp", "-J", "--flat-playlist", "--playlist-end", "1", url],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            print(f"  yt-dlp 실패 ({channel_id}): {result.stderr[:100]}")
            return None

        data = json.loads(result.stdout)
        return {
            "channel_id": data.get("channel_id", channel_id),
            "name": data.get("channel", "") or data.get("uploader", ""),
            "handle": (data.get("uploader_id", "") or "").lstrip("@"),
            "subscribers": data.get("channel_follower_count", 0) or 0,
            "sub_text": format_subs(data.get("channel_follower_count", 0) or 0),
            "description": (data.get("description", "") or "")[:200],
        }
    except subprocess.TimeoutExpired:
        print(f"  타임아웃 ({channel_id})")
        return None
    except Exception as e:
        print(f"  채널 정보 실패 ({channel_id}): {e}")
        return None


def format_subs(count: int) -> str:
    """숫자를 읽기 좋은 형태로. 208000 → '20.8만'"""
    if count >= 1_000_000:
        return f"{count / 1_000_000:.1f}백만"
    if count >= 10_000:
        return f"{count / 10_000:.1f}만"
    if count >= 1_000:
        return f"{count / 1_000:.1f}K"
    return str(count)


# ─── Recent Videos (scrapetube, no API) ───────────────────

def get_recent_videos(channel_id: str, limit: int = 10) -> list[dict]:
    """채널의 최근 영상을 scrapetube로 가져온다 (API 쿼터 0)."""
    try:
        videos = scrapetube.get_channel(channel_id, limit=limit, sort_by="newest")
        result = []
        for v in videos:
            title = v.get("title", {}).get("runs", [{}])[0].get("text", "")
            video_id = v.get("videoId", "")
            view_text = v.get("viewCountText", {}).get("simpleText", "0")
            pub_text = v.get("publishedTimeText", {}).get("simpleText", "")

            result.append({
                "video_id": video_id,
                "title": title,
                "views": view_text,
                "published": pub_text,
            })
        return result
    except Exception as e:
        print(f"  영상 조회 실패 ({channel_id}): {e}")
        return []


def count_recent_videos(videos: list[dict], days: int = 7) -> int:
    """publishedTimeText 기반으로 최근 N일 내 영상 수 추정."""
    count = 0
    for v in videos:
        pub = v.get("published", "")
        # 시간/분 단위 = 오늘
        if any(x in pub for x in ["시간 전", "분 전", "hours ago", "hour ago", "minutes ago"]):
            count += 1
        # N일 전 (N <= days)
        else:
            day_match = re.search(r"(\d+)\s*(일 전|days? ago)", pub)
            if day_match and int(day_match.group(1)) <= days:
                count += 1
    return count


# ─── Beauty Check ─────────────────────────────────────────

BEAUTY_KEYWORDS = [
    "뷰티", "메이크업", "화장", "스킨케어", "리뷰", "추천", "올리브영",
    "파운데이션", "립", "쿠션", "세럼", "토너", "크림", "선크림",
    "피부", "모공", "트러블", "건조", "지성", "민감", "하울",
    "beauty", "makeup", "skincare", "cosmetic", "코덕",
]


def is_beauty_channel(info: dict, videos: list[dict]) -> bool:
    """채널이 뷰티 콘텐츠인지 확인."""
    text = f"{info.get('name', '')} {info.get('description', '')}"
    text += " ".join(v.get("title", "") for v in videos)
    text = text.lower()
    matches = sum(1 for kw in BEAUTY_KEYWORDS if kw.lower() in text)
    return matches >= 3


def guess_category(ch: dict) -> str:
    """채널 정보로 카테고리 추정."""
    text = f"{ch.get('name', '')} {ch.get('description', '')} {' '.join(ch.get('sample_titles', []))}".lower()
    if any(kw in text for kw in ["피부", "트러블", "여드름", "모공", "민감"]):
        return "피부고민"
    if any(kw in text for kw in ["가성비", "올리브영", "다이소", "만원"]):
        return "가성비"
    if any(kw in text for kw in ["비교", "vs", "순위", "top", "best"]):
        return "비교"
    if any(kw in text for kw in ["루틴", "하울", "겟레디", "grwm"]):
        return "루틴"
    if any(kw in text for kw in ["메이크업", "makeup", "튜토리얼"]):
        return "메이크업"
    if any(kw in text for kw in ["남자", "남성", "맨"]):
        return "남성뷰티"
    return "리뷰"


# ─── Search Channels ──────────────────────────────────────

def search_channels_via_videos(query: str, max_results: int = 30) -> list[str]:
    """키워드로 영상 검색 후 채널 ID 추출 (scrapetube, API 쿼터 0)."""
    try:
        videos = scrapetube.get_search(query, limit=max_results)
        channel_ids = set()
        for v in videos:
            cid = (v.get("longBylineText", {}).get("runs", [{}])[0]
                   .get("navigationEndpoint", {}).get("browseEndpoint", {}).get("browseId", ""))
            if cid and cid.startswith("UC"):
                channel_ids.add(cid)
        return list(channel_ids)
    except Exception as e:
        print(f"  검색 실패 ({query}): {e}")
        return []


# ─── Validate Channel ─────────────────────────────────────

def validate_channel(channel_id: str, min_subs: int = 100_000, min_videos_7d: int = 2) -> dict | None:
    """채널이 조건을 충족하는지 검증."""
    info = get_channel_info(channel_id)
    if not info:
        return None

    name = info["name"]
    subs = info["subscribers"]

    # 구독자 체크
    if subs < min_subs:
        print(f"  ✗ {name} — 구독자 {info['sub_text']} (미달)")
        return None

    # 최근 영상 체크
    videos = get_recent_videos(channel_id, limit=10)
    recent_count = count_recent_videos(videos, days=7)

    if recent_count < min_videos_7d:
        print(f"  ✗ {name} — 7일 내 영상 {recent_count}개 (미달)")
        return None

    # 뷰티 콘텐츠 체크
    if not is_beauty_channel(info, videos):
        print(f"  ✗ {name} — 뷰티 콘텐츠 아님")
        return None

    print(f"  ✓ {name} (@{info['handle']}) — {info['sub_text']} 구독, 7일 내 {recent_count}영상")
    return {
        **info,
        "recent_videos": recent_count,
        "sample_titles": [v["title"] for v in videos[:3]],
    }


# ─── Commands ─────────────────────────────────────────────

def cmd_search(args):
    """키워드로 채널 검색 + 검증."""
    queries = [args.query] if args.query != "auto" else [
        "뷰티 리뷰 추천",
        "화장품 솔직 리뷰",
        "올리브영 추천템",
        "스킨케어 루틴",
        "메이크업 튜토리얼 한국",
        "피부 관리 꿀팁",
        "뷰티 하울",
        "화장품 비교",
    ]

    all_channel_ids = set()
    for q in queries:
        print(f"\n🔍 검색: '{q}'")
        ids = search_channels_via_videos(q, max_results=30)
        print(f"  채널 {len(ids)}개 발견")
        all_channel_ids.update(ids)

    print(f"\n총 고유 채널: {len(all_channel_ids)}개")
    print(f"검증 기준: 구독자 {args.min_subs:,}+, 7일 내 영상 {args.min_videos}+, 뷰티 콘텐츠\n")

    validated = []
    for i, cid in enumerate(all_channel_ids):
        print(f"[{i+1}/{len(all_channel_ids)}] {cid}")
        result = validate_channel(cid, args.min_subs, args.min_videos)
        if result:
            validated.append(result)
        if len(validated) >= args.max_channels:
            print(f"\n목표 {args.max_channels}개 달성!")
            break

    # Output
    print(f"\n{'='*60}")
    print(f"검증 통과: {len(validated)}개 채널")
    print(f"{'='*60}")

    for i, ch in enumerate(validated):
        print(f"\n{i+1}. {ch['name']} (@{ch['handle']})")
        print(f"   ID: {ch['channel_id']}")
        print(f"   구독자: {ch['sub_text']}")
        print(f"   7일 내 영상: {ch['recent_videos']}개")
        print(f"   최근 영상: {', '.join(ch['sample_titles'][:2])}")

    # TypeScript output for channels.ts
    if validated:
        print(f"\n{'='*60}")
        print("channels.ts용 TypeScript:")
        print(f"{'='*60}")
        for ch in validated:
            handle = ch["handle"] if ch["handle"] else ch["name"]
            cat = guess_category(ch)
            print(f"  {{ channelId: '{ch['channel_id']}', handle: '@{handle}', name: '{ch['name']}', category: '{cat}' }},")

    # JSON output
    if args.json:
        with open(args.json, "w") as f:
            json.dump(validated, f, ensure_ascii=False, indent=2)
        print(f"\nJSON 저장: {args.json}")


def cmd_channel(args):
    """단일 채널 검증."""
    result = validate_channel(args.channel_id, args.min_subs, args.min_videos)
    if result:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print("조건 미충족 또는 채널 정보 조회 실패")


def cmd_audit(args):
    """기존 시드 채널 감사."""
    channels_path = os.path.join(os.path.dirname(__file__), "..", "src", "scraper", "youtube", "channels.ts")
    try:
        with open(channels_path) as f:
            content = f.read()
        ids = re.findall(r"channelId:\s*'(UC[^']+)'", content)
    except FileNotFoundError:
        print(f"channels.ts not found: {channels_path}")
        return

    print(f"기존 시드 채널 {len(ids)}개 감사 중...\n")
    keep = []
    remove = []
    for cid in ids:
        result = validate_channel(cid, args.min_subs, args.min_videos)
        if result:
            keep.append(result)
        else:
            remove.append(cid)

    print(f"\n유지: {len(keep)}개, 제거: {len(remove)}개")
    if remove:
        print(f"제거 대상: {remove}")


# ─── Main ─────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="YouTube 뷰티 채널 발굴 (API 쿼터 0, yt-dlp + scrapetube)")
    sub = parser.add_subparsers(dest="command")

    # search
    p_search = sub.add_parser("search", help="키워드로 채널 검색")
    p_search.add_argument("query", nargs="?", default="auto", help="검색 키워드 (auto=미리 정의된 8개)")
    p_search.add_argument("--min-subs", type=int, default=100_000, help="최소 구독자 (기본 100K)")
    p_search.add_argument("--min-videos", type=int, default=2, help="7일 내 최소 영상 수 (기본 2)")
    p_search.add_argument("--max-channels", type=int, default=40, help="최대 채널 수 (기본 40)")
    p_search.add_argument("--json", help="결과 JSON 파일 경로")

    # channel
    p_channel = sub.add_parser("channel", help="단일 채널 검증")
    p_channel.add_argument("channel_id", help="YouTube 채널 ID (UC...)")
    p_channel.add_argument("--min-subs", type=int, default=100_000)
    p_channel.add_argument("--min-videos", type=int, default=2)

    # audit
    p_audit = sub.add_parser("audit", help="기존 시드 채널 감사")
    p_audit.add_argument("--min-subs", type=int, default=100_000)
    p_audit.add_argument("--min-videos", type=int, default=2)

    args = parser.parse_args()

    if args.command == "search":
        cmd_search(args)
    elif args.command == "channel":
        cmd_channel(args)
    elif args.command == "audit":
        cmd_audit(args)
    else:
        # Default: auto search
        args.query = "auto"
        args.min_subs = 100_000
        args.min_videos = 2
        args.max_channels = 40
        args.json = None
        cmd_search(args)


if __name__ == "__main__":
    main()

#!/usr/bin/env tsx
/**
 * collect-youtube-comments.ts — YouTube 뷰티 영상 댓글 수집
 *
 * Usage:
 *   npx tsx scripts/collect-youtube-comments.ts --search "화장품 추천"
 *   npx tsx scripts/collect-youtube-comments.ts --search --max-videos 10
 *   npx tsx scripts/collect-youtube-comments.ts --all
 *   npx tsx scripts/collect-youtube-comments.ts --max-videos 5 --max-comments 200 --days 3
 */

import 'dotenv/config';
import { collectYouTube } from '../src/scraper/youtube/collector.js';
import type { YouTubeCliOptions } from '../src/scraper/youtube/types.js';

function parseArgs(): YouTubeCliOptions {
  const args = process.argv.slice(2);
  let channels: YouTubeCliOptions['channels'] = 'search'; // 기본: 검색 모드
  let searchQuery: string | undefined;
  let maxVideosPerChannel = 5;
  let maxCommentsPerVideo = 300;
  let daysBack = 2;
  let fromIndex = 0;
  let toIndex = 0; // 0 = 전체 (collector.ts에서 allChannels.length로 처리)

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--all':
        channels = 'all';
        break;
      case '--db':
        channels = 'db';
        break;
      case '--search':
        channels = 'search';
        if (args[i + 1] && !args[i + 1].startsWith('--')) {
          searchQuery = args[++i];
        }
        break;
      case '--max-videos':
        maxVideosPerChannel = parseInt(args[++i], 10) || 5;
        break;
      case '--max-comments':
        maxCommentsPerVideo = parseInt(args[++i], 10) || 300;
        break;
      case '--days':
        daysBack = parseInt(args[++i], 10) || 2;
        break;
      case '--from':
        fromIndex = parseInt(args[++i], 10) || 0;
        break;
      case '--to':
        toIndex = parseInt(args[++i], 10) || 0;
        break;
      case '--help':
        console.log(`
YouTube 뷰티 댓글 수집

Usage:
  --search [query]     키워드 검색 모드 (기본: 미리 정의된 뷰티 키워드)
  --all                시드 채널 모드 (channels.ts 리스트)
  --db               DB 채널 모드 (youtube_channels 테이블)
  --max-videos N       채널/검색당 최대 영상 수 (기본: 5)
  --max-comments N     영상당 최대 댓글 수 (기본: 300)
  --days N             최근 N일 이내 영상만 (기본: 2)
  --from N             채널 시작 인덱스 (0부터, 병렬 실행용)
  --to N               채널 끝 인덱스 (exclusive, 병렬 실행용)

병렬 실행 예시:
  npm run collect:youtube -- --all --from 0 --to 20 &
  npm run collect:youtube -- --all --from 20 --to 40 &
  npm run collect:youtube -- --all --from 40 --to 59 &

Requires: YOUTUBE_API_KEY in .env
        `);
        process.exit(0);
    }
  }

  return { channels, searchQuery, maxVideosPerChannel, maxCommentsPerVideo, daysBack, fromIndex, toIndex };
}

async function main(): Promise<void> {
  if (!process.env.YOUTUBE_API_KEY) {
    console.error('YOUTUBE_API_KEY가 .env에 설정되지 않았습니다.');
    console.error('Google Cloud Console에서 YouTube Data API v3 키를 생성하세요.');
    process.exit(1);
  }

  const opts = parseArgs();
  await collectYouTube(opts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

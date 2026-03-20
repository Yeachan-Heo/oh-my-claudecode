#!/usr/bin/env tsx
/**
 * collect-instiz.ts -- 인스티즈(instiz.net) 뷰티/인기글 게시판 수집
 *
 * HTTP + cheerio 기반으로 인스티즈 게시글과 댓글을 수집한다.
 * 수집된 데이터는 community_posts 테이블에 source_platform='instiz'로 저장한다.
 *
 * Usage:
 *   npx tsx scripts/collect-instiz.ts --board name_beauty --pages 1 --limit 10
 *   npx tsx scripts/collect-instiz.ts --board pt --pages 3 --limit 30 --comments
 *   npx tsx scripts/collect-instiz.ts --board name_beauty --limit 5
 */

import { collectInstiz } from '../src/scraper/instiz/collector.js';
import type { InstizCliOptions } from '../src/scraper/instiz/types.js';

function parseArgs(): InstizCliOptions {
  const args = process.argv.slice(2);
  let board: 'name_beauty' | 'pt' = 'name_beauty';
  let pages = 1;
  let limit = 10;
  let comments = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--board': {
        const b = args[i + 1];
        if (b === 'name_beauty' || b === 'pt') {
          board = b;
        }
        i++;
        break;
      }
      case '--pages':
        pages = parseInt(args[i + 1], 10) || 1;
        i++;
        break;
      case '--limit':
        limit = parseInt(args[i + 1], 10) || 10;
        i++;
        break;
      case '--comments':
        comments = true;
        break;
      case '--help':
      case '-h':
        console.log(`
인스티즈(instiz.net) 수집기

사용법:
  npx tsx scripts/collect-instiz.ts [옵션]

옵션:
  --board <name_beauty|pt>  게시판 선택 (기본: name_beauty)
  --pages <N>               수집할 페이지 수 (기본: 1)
  --limit <N>               최대 수집 게시글 수 (기본: 10)
  --comments                댓글도 수집
  --help                    도움말 표시

게시판:
  name_beauty  뷰티 게시판 (여성 니즈 수집 최적)
  pt           인기글 게시판

예시:
  npx tsx scripts/collect-instiz.ts --board name_beauty --pages 1 --limit 10
  npx tsx scripts/collect-instiz.ts --board pt --pages 3 --comments
        `.trim());
        process.exit(0);
    }
  }

  return { board, pages, limit, comments };
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const result = await collectInstiz(opts.board, opts.pages, opts.limit, opts.comments);

  // Exit with error if nothing was collected
  if (result.total === 0 && result.failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

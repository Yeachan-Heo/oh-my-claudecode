/**
 * @file YouTube 뷰티 채널 시드 리스트 + 검색 확장.
 *
 * 59개 채널 — scrapetube 발굴(50) + 기존 큐레이션(9).
 * 채널 추가/제거는 이 파일만 수정.
 */

import type { YouTubeChannel } from './types.js';

/**
 * 시드 채널 리스트.
 *
 * 선정 기준: 한국어, 뷰티 콘텐츠, 최근 활동 채널.
 * 2026-03-20 scrapetube + YouTube Data API v3로 전수 검증.
 *
 * 구독자순 정렬 (내림차순).
 */
export const SEED_CHANNELS: YouTubeChannel[] = [
  // ── 메이크업 (12) ──
  { channelId: 'UCuZu8NrpBG4WPXRi-hPBl-A', handle: '@hyojin94517', name: '조효진 Hyojin Cho', category: '메이크업' },
  { channelId: 'UCnFFOjljp1_sacTz7PfIIyg', handle: '@LeoJMakeup', name: 'LeoJ Makeup', category: '메이크업' },
  { channelId: 'UCUrCIBJ3ScRAOLgPElscZqA', handle: '@in_bora_', name: 'INBORA인보라', category: '메이크업' },
  { channelId: 'UCW67yGQxNNMnLqRHyaTjygA', handle: '@hongsmakeup', name: "Hong's MakeuPlay 홍이모", category: '메이크업' },
  { channelId: 'UCcNYkzLMSkSiYaiAYjUNzRg', handle: '@kimcrysta1', name: '김크리스탈 KimCrystal', category: '메이크업' },
  { channelId: 'UCr_QBNzvSm_a7mreIpTregw', handle: '@mingarden_', name: 'MINGARDEN', category: '메이크업' },
  { channelId: 'UC57_jVZTM427hTqYMXf7utA', handle: '@you_needn', name: 'You need 윤이든', category: '메이크업' },
  { channelId: 'UClsaLJyAdDlXjyAizmKt-1Q', handle: '@meenjechoi', name: '민제 meenje', category: '메이크업' },
  { channelId: 'UC3d_8LhMCYir5GUu5_B3J5Q', handle: '@Sooandyou', name: '수앤유 Sooandyou', category: '메이크업' },
  { channelId: 'UCYuMEcmNpz03jmS9DSNJexw', handle: '@hyerim_official', name: '혜리미 HYERIMI', category: '메이크업' },
  { channelId: 'UCigdynJBb_8ZofZ3JDhcSZA', handle: '@makeup_maker_', name: '상은언니', category: '메이크업' },
  { channelId: 'UCChdHmdkgTpk0iyuODYxJIw', handle: '@haenibeauty', name: '해니 haeni beauty', category: '메이크업' },
  { channelId: 'UCRXL4vnST2AE6UtjrYMv4tw', handle: '@뽀용뇽', name: '뽀용뇽', category: '메이크업' },

  // ── 리뷰 (10) ──
  { channelId: 'UCnekLiljel-Px4ClMC7b3mg', handle: '@calarygirl', name: '회사원A', category: '리뷰' },
  { channelId: 'UCj8zZ1a8Lqtj4wY2bHbcIaQ', handle: '@lifestyle_doctor', name: '정세연의 라이프연구소', category: '리뷰' },
  { channelId: 'UCB0iI4S727iXExTQvEVG4UQ', handle: '@madeinmia', name: '미아 Mia', category: '리뷰' },
  { channelId: 'UCYsv-IHC-B-DiVMmJuqibcg', handle: '@Jaina0', name: 'Jaina', category: '리뷰' },
  { channelId: 'UCfM7HC0wkS_cWVIcgpy2XPA', handle: '@myerry', name: '몌 myerry', category: '리뷰' },
  { channelId: 'UChHcae6qoUV72jYtBwORM_Q', handle: '@bilbo_park', name: '빌보의 취향', category: '리뷰' },
  { channelId: 'UCqrNqg3UgVoD3Sa-F_TxuSA', handle: '@director_pihyunjung', name: '디렉터 파이', category: '리뷰' },
  { channelId: 'UCZCvbWrBFGQeZwf5qczqLFg', handle: '@yootrueonair', name: 'YOOTRUE ON AIR', category: '리뷰' },
  { channelId: 'UC0-yyrDjTJ1YFzmV12vEp0Q', handle: '@ssinxxi123', name: '시네 si-ne', category: '리뷰' },
  { channelId: 'UCGr3FB8OwSwNwk2FEpCGxPQ', handle: '@jju_unni', name: '뷰티트레이너 쭈언니', category: '리뷰' },
  { channelId: 'UCJtAFDmVo5_9dnobfV-rl1g', handle: '@cjoliveyoung', name: '올영TV', category: '리뷰' },

  // ── 가성비 (12) ──
  { channelId: 'UCb3RcfZTXh4_ZMZy-sLaLPw', handle: '@AFROM', name: '에이프롬 ÁFROM', category: '가성비' },
  { channelId: 'UClJNgnMWzvEzJuLcpH7m4vQ', handle: '@jaymeeforyou', name: '제이미포유 Jaymeeforyou', category: '가성비' },
  { channelId: 'UC7ThrNGPoJLuaicyKJ4350w', handle: '@byulbyulbeauty', name: '별별뷰티-Byul Byul Beauty', category: '가성비' },
  { channelId: 'UC9JU9mfYpg4KqxNZtD91GQg', handle: '@oddlife', name: '오드라이프oddlife', category: '가성비' },
  { channelId: 'UCwwfbGYkRBNAJ-qH2ttoqbg', handle: '@yiting346', name: '훠니 Huoney', category: '가성비' },
  { channelId: 'UCvGvf3Lk0Z5reU544g_SzPg', handle: '@B.T.E', name: '비트 BTE', category: '가성비' },
  { channelId: 'UCI2q5X6A7spXyBITMu6aBaQ', handle: '@missokorea2025', name: '똑똑한 소비천재, 미소코리아', category: '가성비' },
  { channelId: 'UCX6EQB-J3U9Voh4kMmqf8aw', handle: '@Ara_spring', name: '아라 Ara_spring', category: '가성비' },
  { channelId: 'UCiAzDHGJTIjlXZZKj9aErWw', handle: '@Minning', name: '미닝 Minning', category: '가성비' },
  { channelId: 'UCT3XCWBiNy-mnS0awYq_trw', handle: '@Jun_dol', name: '준돌', category: '가성비' },
  { channelId: 'UCK_SS-VZj0tQORGbdDnel8A', handle: '@YUCHAE', name: '유채 YUCHAE', category: '가성비' },

  // ── 피부고민 (9) ──
  { channelId: 'UCrlUlicedicJ5mlibqC62Eg', handle: '@beautyacne_inssi', name: '뷰드름 유튜버 인씨', category: '피부고민' },
  { channelId: 'UCUH_M0bX4f1JZns0WdBJVKQ', handle: '@thecellskin', name: '피부심 심현철', category: '피부고민' },
  { channelId: 'UCHa6h8DGLYkAljbskQbIXHw', handle: '@toxin1204', name: '톡신TOXIN', category: '피부고민' },
  { channelId: 'UCDTlhztDq-s7OJZBL1Ymf2A', handle: '@피부는성현철', name: '피부는 성현철', category: '피부고민' },
  { channelId: 'UCat2CSzaple02nnhbUSJ2zg', handle: '@aura_m', name: '아우라M', category: '피부고민' },
  { channelId: 'UCV5Q_31yEqkV15Q-AHZWE5A', handle: '@dailyjenna', name: '제나 dailyjenna', category: '피부고민' },
  { channelId: 'UCLvk76DFmbHIveAvYUDajUg', handle: '@BeautyNANI', name: '뷰티나니 BeautyNANI', category: '피부고민' },
  { channelId: 'UCM0pggwtvnALuXmFQIxXlGA', handle: '@romanticminseo', name: '로맨틱민서 MINSEO', category: '피부고민' },
  { channelId: 'UCtCRr4rDWjpRi8LSWexmCKg', handle: '@yocookie', name: 'yo cookie', category: '피부고민' },

  // ── 루틴 (10) ──
  { channelId: 'UC5xK2Xdrud3-KGjkS1Igumg', handle: '@ssinnim', name: 'ssin 씬님', category: '루틴' },
  { channelId: 'UCH2mJnztSdNh8ADp2KmtUMQ', handle: '@yootrue', name: 'Yoo True', category: '루틴' },
  { channelId: 'UC8P33HyFhfqThDUGk0disqw', handle: '@JEYU', name: '재유JEYU', category: '루틴' },
  { channelId: 'UCANG9nPHHhmyOtMVk0bWgaA', handle: '@DailyDaye', name: '다예 Daily Daye', category: '루틴' },
  { channelId: 'UCSx-2fuyotB8WA8KytyhACg', handle: '@ocean_beauty', name: '오션 OCEAN', category: '루틴' },
  { channelId: 'UCgRElRhf8PWv95nqExiQXHA', handle: '@simtohl', name: '심톨 SIMTOHL', category: '루틴' },
  { channelId: 'UCB44fSGXvnBP6CVp10CenPg', handle: '@Hyovely', name: '효블리 Hyovely', category: '루틴' },
  { channelId: 'UC406mRyBRckVwCg5eFyOl3g', handle: '@salondety', name: '살롱드태윤', category: '루틴' },
  { channelId: 'UCbFbzOHmp04AS2ZkFSpQ4Og', handle: '@inayommi', name: '일단이나연 NAYEON', category: '루틴' },
  { channelId: 'UCmPkZXhVfyLLWyHQM-l_KqA', handle: '@bbomni', name: '뽐니 bbomni', category: '루틴' },

  // ── 비교 (4) ──
  { channelId: 'UCBlIcpkzSdcmp5G0XS7UsZA', handle: '@DamsBeauty', name: '담쓰 Dams Beauty', category: '비교' },
  { channelId: 'UCPkgjWwYOiMKqNJpwdA8lPA', handle: '@SoraSalon', name: '소살 Sora Salon', category: '비교' },
  { channelId: 'UCpSa5CzQedAxXFGfmeeFdIw', handle: '@vivi.', name: '박비비 VIVI', category: '비교' },
  { channelId: 'UCrqaC5YBq05K1ZnkmSW0j-g', handle: '@just_sonjoohee', name: '저스트손주희', category: '비교' },

  // ── 남성뷰티 (1) ──
  { channelId: 'UChaTUCM7bPBTJaIZQ83PNwQ', handle: '@스완_현실남자관리', name: '스완SWAN_현실남자관리', category: '남성뷰티' },
];

/**
 * 채널 검색 키워드.
 * searchVideos()에 전달하여 영상 직접 검색에 사용.
 */
export const SEARCH_KEYWORDS = [
  '화장품 추천 2026',
  '스킨케어 루틴 추천',
  '뷰티 솔직 리뷰',
  '올영 추천템',
  '피부 고민 해결',
  '가성비 화장품',
  '민감성 피부 추천',
  '여드름 스킨케어',
  '다이소 뷰티 추천',
  '건조 피부 보습',
];

/**
 * 영상 제목에서 니즈 밀도를 예측하는 키워드.
 * 이 키워드를 포함하는 영상은 수집 우선순위 상향.
 */
export const HIGH_NEED_KEYWORDS = [
  '추천', '리뷰', '비교', '솔직', '찐후기',
  '루틴', '하울', '고민', '해결', '꿀팁',
  'vs', 'TOP', '순위', '가성비', '인생템',
];

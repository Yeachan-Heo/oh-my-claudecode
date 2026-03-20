/**
 * @file GraphQL response interceptor for Threads search pages.
 *
 * Captures structured data from Threads' internal GraphQL API responses
 * via page.on('response'), providing accurate metrics (exact like_count,
 * unix timestamps, clean text) instead of DOM-parsed approximations.
 *
 * Usage:
 *   const interceptor = createGraphQLInterceptor(page);
 *   await page.goto(searchUrl);
 *   // ... scroll ...
 *   const posts = interceptor.getCollectedPosts();
 *   interceptor.destroy();
 */

import type { Page, Response as PlaywrightResponse } from 'playwright';

// ─── Types ───────────────────────────────────────────────

export interface GraphQLExtractedPost {
  post_id: string;
  author: string;
  text: string;
  permalink: string;
  like_count: number;
  reply_count: number;
  repost_count: number;
  has_image: boolean;
  time_text: string | null;
  // GraphQL-only fields
  timestamp_unix: number | null;
  quote_count: number;
  reshare_count: number;
  media_urls: string[];
  link_url: string | null;
  source: 'graphql';
}

export interface GraphQLInterceptor {
  getCollectedPosts(): GraphQLExtractedPost[];
  clearPosts(): void;
  destroy(): void;
}

// ─── Raw GraphQL Types (subset) ──────────────────────────

interface RawGraphQLPost {
  pk?: string | number;
  code?: string;
  user?: { username?: string; pk?: string | number };
  caption?: {
    text?: string;
    text_fragments?: unknown;
  };
  like_count?: number;
  taken_at?: number;
  image_versions2?: { candidates?: Array<{ url?: string }> };
  carousel_media?: Array<{
    image_versions2?: { candidates?: Array<{ url?: string }> };
  }>;
  text_post_app_info?: {
    direct_reply_count?: number;
    repost_count?: number;
    quote_count?: number;
    reshare_count?: number;
    text_fragments?: {
      fragments?: Array<{
        fragment_type?: string;
        link_fragment?: { url?: string } | null;
        plaintext?: string;
        linkified_web_url?: string | null;
      }>;
    };
    link_preview_attachment?: {
      url?: string;
      display_url?: string;
    } | null;
    link_preview_response?: {
      url?: string;
    } | null;
  };
  media_type?: number;
}

// ─── Helpers ─────────────────────────────────────────────

/**
 * Extract posts from the searchResults shape:
 *   data.searchResults.edges[].node.thread.thread_items[].post
 */
function extractFromSearchResults(data: Record<string, unknown>): RawGraphQLPost[] {
  const searchResults = data.searchResults as {
    edges?: Array<{
      node?: {
        thread?: {
          thread_items?: Array<{ post?: RawGraphQLPost }>;
        };
      };
    }>;
  } | undefined;

  if (!searchResults?.edges) return [];

  const posts: RawGraphQLPost[] = [];
  for (const edge of searchResults.edges) {
    const threadItems = edge?.node?.thread?.thread_items;
    if (!threadItems) continue;
    for (const item of threadItems) {
      if (item?.post) posts.push(item.post);
    }
  }
  return posts;
}

/**
 * Extract posts from the userData shape (profile feed, newer Threads API):
 *   data.userData.user.threads_feed.threads[].thread_items[].post
 *   (also handles data.xdt_api__v1__text_feed__* keys)
 */
function extractFromUserData(data: Record<string, unknown>): RawGraphQLPost[] {
  // Shape 1: data.userData.user.threads_feed.threads[]
  const userData = data.userData as {
    user?: {
      threads_feed?: {
        threads?: Array<{
          thread_items?: Array<{ post?: RawGraphQLPost }>;
        }>;
      };
    };
  } | undefined;

  const threads = userData?.user?.threads_feed?.threads;
  if (threads) {
    const posts: RawGraphQLPost[] = [];
    for (const thread of threads) {
      const threadItems = thread?.thread_items;
      if (!threadItems) continue;
      for (const item of threadItems) {
        if (item?.post) posts.push(item.post);
      }
    }
    if (posts.length > 0) return posts;
  }

  // Shape 2: data.<xdt_key>.edges[].node.thread_items[].post
  // Threads uses dynamically-named keys like xdt_api__v1__text_feed_timeline_connection_with_viewer__results
  for (const key of Object.keys(data)) {
    if (!key.startsWith('xdt_')) continue;
    const val = data[key] as {
      edges?: Array<{
        node?: {
          thread_items?: Array<{ post?: RawGraphQLPost }>;
        };
      }>;
    } | undefined;
    if (!val?.edges) continue;
    const posts: RawGraphQLPost[] = [];
    for (const edge of val.edges) {
      const threadItems = edge?.node?.thread_items;
      if (!threadItems) continue;
      for (const item of threadItems) {
        if (item?.post) posts.push(item.post);
      }
    }
    if (posts.length > 0) return posts;
  }

  return [];
}

/**
 * Extract posts from the mediaData shape (profile feed):
 *   data.mediaData.edges[].node.thread_items[].post
 */
function extractFromMediaData(data: Record<string, unknown>): RawGraphQLPost[] {
  const mediaData = data.mediaData as {
    edges?: Array<{
      node?: {
        thread_items?: Array<{ post?: RawGraphQLPost }>;
      };
    }>;
  } | undefined;

  if (!mediaData?.edges) return [];

  const posts: RawGraphQLPost[] = [];
  for (const edge of mediaData.edges) {
    const threadItems = edge?.node?.thread_items;
    if (!threadItems) continue;
    for (const item of threadItems) {
      if (item?.post) posts.push(item.post);
    }
  }
  return posts;
}

/**
 * Convert a raw GraphQL post to our ExtractedPost format.
 */
function mapToExtractedPost(raw: RawGraphQLPost): GraphQLExtractedPost | null {
  const code = raw.code;
  const username = raw.user?.username;

  if (!code || !username) return null;

  const text = raw.caption?.text ?? '';

  // Extract link URL from text_fragments or link_preview
  let linkUrl: string | null = null;
  const fragments = raw.text_post_app_info?.text_fragments?.fragments;
  if (fragments) {
    for (const frag of fragments) {
      if (frag.link_fragment?.url) {
        linkUrl = frag.link_fragment.url;
        break;
      }
      if (frag.linkified_web_url) {
        linkUrl = frag.linkified_web_url;
        break;
      }
    }
  }
  if (!linkUrl && raw.text_post_app_info?.link_preview_attachment?.url) {
    linkUrl = raw.text_post_app_info.link_preview_attachment.url;
  }
  if (!linkUrl && raw.text_post_app_info?.link_preview_response?.url) {
    linkUrl = raw.text_post_app_info.link_preview_response.url;
  }

  // Extract media URLs
  const mediaUrls: string[] = [];
  if (raw.image_versions2?.candidates?.length) {
    // Take the first (highest quality) candidate
    const firstCandidate = raw.image_versions2.candidates[0];
    if (firstCandidate?.url) mediaUrls.push(firstCandidate.url);
  }
  if (raw.carousel_media) {
    for (const media of raw.carousel_media) {
      const candidate = media.image_versions2?.candidates?.[0];
      if (candidate?.url) mediaUrls.push(candidate.url);
    }
  }

  const hasImage = mediaUrls.length > 0
    || (raw.image_versions2?.candidates?.length ?? 0) > 0
    || (raw.carousel_media?.length ?? 0) > 0;

  const takenAt = raw.taken_at ?? null;
  const timeText = takenAt ? new Date(takenAt * 1000).toISOString() : null;

  return {
    post_id: code,
    author: username,
    text,
    permalink: `https://www.threads.net/@${username}/post/${code}`,
    like_count: raw.like_count ?? 0,
    reply_count: raw.text_post_app_info?.direct_reply_count ?? 0,
    repost_count: raw.text_post_app_info?.repost_count ?? 0,
    has_image: hasImage,
    time_text: timeText,
    timestamp_unix: takenAt,
    quote_count: raw.text_post_app_info?.quote_count ?? 0,
    reshare_count: raw.text_post_app_info?.reshare_count ?? 0,
    media_urls: mediaUrls,
    link_url: linkUrl,
    source: 'graphql',
  };
}

// ─── Public API ──────────────────────────────────────────

/**
 * Create a GraphQL interceptor that captures post data from Threads API responses.
 *
 * Registers a `page.on('response')` listener that parses GraphQL responses
 * and accumulates posts in an internal Map (deduplicated by post_id).
 *
 * Call `destroy()` when done to remove the listener.
 */
export function createGraphQLInterceptor(page: Page): GraphQLInterceptor {
  const postsMap = new Map<string, GraphQLExtractedPost>();

  const handler = async (response: PlaywrightResponse): Promise<void> => {
    const url = response.url();
    if (!url.includes('/graphql/query') && !url.includes('/api/graphql')) return;

    try {
      const rawText = await response.text();
      // Strip anti-XSSI prefix if present
      const cleanText = rawText.startsWith('for (;;);') ? rawText.slice(9) : rawText;
      const json = JSON.parse(cleanText) as { data?: Record<string, unknown> };

      if (!json.data) return;

      // Try all known shapes in priority order
      let rawPosts: RawGraphQLPost[] = [];

      if (json.data.searchResults) {
        rawPosts = extractFromSearchResults(json.data);
      } else if (json.data.mediaData) {
        rawPosts = extractFromMediaData(json.data);
      } else if (json.data.userData) {
        rawPosts = extractFromUserData(json.data);
      } else {
        // Fallback: scan for any xdt_* key (dynamic Threads API key names)
        rawPosts = extractFromUserData(json.data);
      }

      if (rawPosts.length === 0) return;

      for (const raw of rawPosts) {
        const mapped = mapToExtractedPost(raw);
        if (mapped && !postsMap.has(mapped.post_id)) {
          postsMap.set(mapped.post_id, mapped);
        }
      }
    } catch {
      // Silently ignore parse errors — not all responses are JSON
    }
  };

  page.on('response', handler);

  return {
    getCollectedPosts(): GraphQLExtractedPost[] {
      return Array.from(postsMap.values());
    },

    clearPosts(): void {
      postsMap.clear();
    },

    destroy(): void {
      page.removeListener('response', handler);
      postsMap.clear();
    },
  };
}

#!/usr/bin/env node

import { pathToFileURL } from 'url';
import {
  collectFeaturedContributors,
  extractRepoSlug,
  FEATURED_CONTRIBUTORS_END_MARKER,
  FEATURED_CONTRIBUTORS_MIN_STARS,
  FEATURED_CONTRIBUTORS_START_MARKER,
  FEATURED_CONTRIBUTORS_TITLE,
  formatStarCount,
  loadRepoSlugFromPackageJson,
  pickTopPersonalRepo,
  renderFeaturedContributorsSection,
  runFeaturedContributorsCli,
  sortFeaturedContributors,
  syncFeaturedContributorsReadme,
  upsertFeaturedContributorsSection,
} from '../src/lib/featured-contributors.js';

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFeaturedContributorsCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

export {
  collectFeaturedContributors,
  extractRepoSlug,
  FEATURED_CONTRIBUTORS_END_MARKER,
  FEATURED_CONTRIBUTORS_MIN_STARS,
  FEATURED_CONTRIBUTORS_START_MARKER,
  FEATURED_CONTRIBUTORS_TITLE,
  formatStarCount,
  loadRepoSlugFromPackageJson,
  pickTopPersonalRepo,
  renderFeaturedContributorsSection,
  runFeaturedContributorsCli,
  sortFeaturedContributors,
  syncFeaturedContributorsReadme,
  upsertFeaturedContributorsSection,
};

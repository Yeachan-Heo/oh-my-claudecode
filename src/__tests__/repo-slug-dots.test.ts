import { describe, it, expect } from "vitest";

describe('BUG 5: extractRepoSlug accepts dots', () => {
  it('parses repo with dots: next.js', async () => {
    const { extractRepoSlug } = await import(
      '../lib/featured-contributors.js'
    );
    expect(extractRepoSlug('https://github.com/vercel/next.js')).toBe(
      'vercel/next.js',
    );
  });

  it('parses repo with dots: socket.io.git', async () => {
    const { extractRepoSlug } = await import(
      '../lib/featured-contributors.js'
    );
    expect(extractRepoSlug('https://github.com/socketio/socket.io.git')).toBe(
      'socketio/socket.io',
    );
  });

  it('parses repo with dots: vue.js.git', async () => {
    const { extractRepoSlug } = await import(
      '../lib/featured-contributors.js'
    );
    expect(extractRepoSlug('https://github.com/vuejs/vue.js.git')).toBe(
      'vuejs/vue.js',
    );
  });

  it('still parses standard repos without dots', async () => {
    const { extractRepoSlug } = await import(
      '../lib/featured-contributors.js'
    );
    expect(extractRepoSlug('https://github.com/facebook/react')).toBe(
      'facebook/react',
    );
  });

  it('still parses SSH URLs', async () => {
    const { extractRepoSlug } = await import(
      '../lib/featured-contributors.js'
    );
    expect(extractRepoSlug('git@github.com:vuejs/vue.js.git')).toBe(
      'vuejs/vue.js',
    );
  });
});

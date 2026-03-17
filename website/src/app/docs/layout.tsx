import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import type { ReactNode } from 'react';
import { source } from '@/lib/source';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{
        title: 'Oh My ClaudeCode',
        url: '/docs',
      }}
      sidebar={{
        defaultOpenLevel: 1,
      }}
      links={[
        {
          text: 'GitHub',
          url: 'https://github.com/Yeachan-Heo/oh-my-claudecode',
          external: true,
        },
      ]}
    >
      {children}
    </DocsLayout>
  );
}

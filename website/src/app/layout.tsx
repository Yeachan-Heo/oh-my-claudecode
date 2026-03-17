import 'fumadocs-ui/style.css';
import './global.css';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Oh My ClaudeCode — Docs',
  description:
    'Official documentation for oh-my-claudecode, a multi-agent orchestration layer for Claude Code.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <body>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}

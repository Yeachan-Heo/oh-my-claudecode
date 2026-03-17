'use client';

import { useState, useCallback } from 'react';

const INSTALL_COMMAND =
  'claude plugin add @anthropics/claude-code-plugin -- oh-my-claudecode';

export function CopyInstallCommand() {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select text
    }
  }, []);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="group mt-8 flex w-full max-w-lg items-center gap-3 rounded-lg border border-fd-border bg-fd-card px-5 py-3.5 text-left font-mono text-sm transition-colors hover:bg-fd-accent/50"
      title="클릭하여 복사"
    >
      <span className="select-none text-fd-muted-foreground">$</span>
      <span className="flex-1 truncate text-fd-foreground">
        {INSTALL_COMMAND}
      </span>
      <span className="flex-none select-none text-xs text-fd-muted-foreground transition-colors group-hover:text-fd-foreground">
        {copied ? '복사됨' : '복사'}
      </span>
    </button>
  );
}

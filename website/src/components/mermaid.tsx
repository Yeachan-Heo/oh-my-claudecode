'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import mermaid from 'mermaid';

export function Mermaid({ chart }: { chart: string }) {
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState('');

  useEffect(() => {
    const isDark = resolvedTheme === 'dark';
    mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? 'dark' : 'default',
      look: 'handDrawn',
      fontFamily: 'inherit',
    });

    const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
    mermaid.render(id, chart.trim()).then(({ svg }) => {
      setSvg(svg);
    });
  }, [chart, resolvedTheme]);

  return (
    <div
      className="my-6 flex justify-center [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

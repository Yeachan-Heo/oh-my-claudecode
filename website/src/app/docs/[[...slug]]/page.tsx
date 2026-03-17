import {
  DocsPage,
  DocsBody,
  DocsTitle,
  DocsDescription,
} from 'fumadocs-ui/page';
import { notFound } from 'next/navigation';
import { source } from '@/lib/source';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { Mermaid } from '@/components/mermaid';

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDXContent = page.data.body;

  // For single-page sections with anchor links in meta.json,
  // override footer to show correct prev/next pages
  const anchorPageNav: Record<string, { previous?: { name: string; url: string }; next?: { name: string; url: string } }> = {
    'getting-started': { previous: { name: 'Docs', url: '/docs' }, next: { name: 'Core Concepts', url: '/docs/concepts' } },
    'concepts': { previous: { name: 'Getting Started', url: '/docs/getting-started' }, next: { name: 'Guides', url: '/docs/guides' } },
    'guides': { previous: { name: 'Core Concepts', url: '/docs/concepts' }, next: { name: 'Agents', url: '/docs/agents' } },
  };
  const slugKey = params.slug?.length === 1 ? params.slug[0] : null;
  const customNav = slugKey ? anchorPageNav[slugKey] : null;

  return (
    <DocsPage toc={page.data.toc} footer={customNav ? { items: customNav } : undefined}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDXContent components={{ ...defaultMdxComponents, Steps, Step, Tab, Tabs, Mermaid }} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  return {
    title: `${page.data.title} — OMC Docs`,
    description: page.data.description,
  };
}

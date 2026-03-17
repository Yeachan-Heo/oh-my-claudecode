import Link from 'next/link';
import { JetBrains_Mono } from 'next/font/google';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { CopyInstallCommand } from '@/components/copy-install';

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['700'],
  display: 'swap',
  variable: '--font-hero',
});

const baseOptions = {
  nav: {
    title: 'Oh My ClaudeCode',
    url: '/',
    transparentMode: 'top' as const,
  },
  githubUrl: 'https://github.com/Yeachan-Heo/oh-my-claudecode',
  links: [
    {
      text: 'Docs',
      url: '/docs',
    },
  ],
};

const AGENTS = {
  'Build & Analysis': [
    'explore',
    'analyst',
    'planner',
    'architect',
    'debugger',
    'executor',
    'deep-executor',
    'verifier',
  ],
  Review: ['code-reviewer', 'security-reviewer'],
  Domain: [
    'test-engineer',
    'build-fixer',
    'designer',
    'writer',
    'qa-tester',
    'scientist',
    'document-specialist',
    'git-master',
    'code-simplifier',
  ],
  Coordination: ['critic'],
};

const PIPELINE_STEPS = [
  { label: '아이디어', role: 'User' },
  { label: '분석', role: 'Analyst' },
  { label: '설계', role: 'Architect' },
  { label: '계획', role: 'Planner' },
  { label: '실행', role: 'Executor' },
  { label: 'QA', role: 'UltraQA' },
  { label: '검증', role: 'Verifier' },
];

const SKILLS = [
  {
    name: 'autopilot',
    desc: '아이디어에서 코드까지, 자율 실행합니다.',
  },
  {
    name: 'ralph',
    desc: '완료될 때까지 멈추지 않는 실행 루프입니다.',
  },
  {
    name: 'team',
    desc: 'N개 에이전트가 동시에 작업합니다.',
  },
  {
    name: 'ralplan',
    desc: '합의에 도달할 때까지 반복하는 계획입니다.',
  },
];

export default function HomePage() {
  return (
    <HomeLayout {...baseOptions}>
      {/* ── Hero ── */}
      <section className="relative flex min-h-[85vh] flex-col items-center justify-center px-6 py-28 text-center">
        <div className="absolute inset-0 -z-10 overflow-hidden">
          <div className="hero-grid absolute inset-0 opacity-[0.03] dark:opacity-[0.04]" />
        </div>

        <p className="mb-4 text-sm font-medium tracking-widest uppercase text-fd-muted-foreground">
          Multi-Agent Orchestration for Claude Code
        </p>

        <h1 className={`hero-title text-5xl font-bold tracking-tight sm:text-6xl md:text-7xl lg:text-8xl ${jetbrainsMono.className}`}>
          Oh My
          <br />
          ClaudeCode
        </h1>

        <p className="mx-auto mt-6 max-w-xl text-lg text-fd-muted-foreground sm:text-xl">
          Claude Code를 위한 멀티 에이전트 오케스트레이션 레이어.
          <br className="hidden sm:block" />
          20개 에이전트와 28개 스킬이 협업합니다.
        </p>

        <CopyInstallCommand />

        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          <Link
            href="/docs/getting-started"
            className="inline-flex h-11 items-center rounded-lg bg-fd-primary px-6 text-sm font-medium text-fd-primary-foreground transition-colors hover:bg-fd-primary/90"
          >
            시작하기
          </Link>
          <Link
            href="/docs"
            className="inline-flex h-11 items-center rounded-lg border border-fd-border bg-fd-background px-6 text-sm font-medium text-fd-foreground transition-colors hover:bg-fd-accent"
          >
            문서 보기
          </Link>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="border-t border-fd-border px-6 py-24">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
            무엇이 다른가요?
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-center text-fd-muted-foreground">
            Claude Code 위에서 동작하는 전문 에이전트 레이어입니다.
          </p>

          <div className="mt-16 grid gap-8 sm:grid-cols-2">
            {[
              {
                title: '20개 전문 에이전트',
                desc: '탐색, 계획, 구현, 검증, 리뷰까지 각 역할에 특화된 에이전트가 분담합니다.',
                tag: 'Agents',
              },
              {
                title: '28개 자동화 스킬',
                desc: 'autopilot, ralph, ultrawork -- 한 마디면 복잡한 파이프라인이 실행됩니다.',
                tag: 'Skills',
              },
              {
                title: '팀 오케스트레이션',
                desc: '여러 Claude 에이전트를 동시에 생성하고, 작업을 분배하고, 결과를 합칩니다.',
                tag: 'Teams',
              },
              {
                title: '매직 키워드',
                desc: '"autopilot build me X" -- 자연어로 파이프라인을 시작합니다. 명령어를 외울 필요가 없습니다.',
                tag: 'Keywords',
              },
            ].map((feature) => (
              <div
                key={feature.title}
                className="group relative rounded-xl border border-fd-border bg-fd-card/50 p-8 transition-colors hover:bg-fd-card"
              >
                <span className="mb-4 inline-block rounded-md bg-fd-primary/10 px-2.5 py-1 text-xs font-semibold tracking-wide text-fd-primary dark:bg-fd-primary/5">
                  {feature.tag}
                </span>
                <h3 className="text-lg font-semibold">{feature.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">
                  {feature.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How it Works ── */}
      <section className="border-t border-fd-border bg-fd-card/30 px-6 py-24">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
            autopilot 파이프라인
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-center text-fd-muted-foreground">
            아이디어 하나로 분석, 설계, 계획, 실행, QA, 검증까지 자동으로 진행됩니다.
          </p>

          {/* Desktop: horizontal flow */}
          <div className="mt-16 hidden md:block">
            <div className="relative flex items-start justify-between">
              {/* Connecting line */}
              <div className="absolute left-[calc(theme(spacing.8))] right-[calc(theme(spacing.8))] top-8 h-px bg-fd-border" />

              {PIPELINE_STEPS.map((step, i) => (
                <div key={step.label} className="relative flex flex-col items-center" style={{ width: `${100 / PIPELINE_STEPS.length}%` }}>
                  <div className="relative z-10 flex h-16 w-16 items-center justify-center rounded-full border-2 border-fd-border bg-fd-background text-sm font-bold transition-colors">
                    {String(i + 1).padStart(2, '0')}
                  </div>
                  <span className="mt-3 text-sm font-semibold">{step.label}</span>
                  <span className="mt-1 text-xs text-fd-muted-foreground">{step.role}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Mobile: vertical timeline */}
          <div className="mt-12 md:hidden">
            <div className="relative ml-8 border-l border-fd-border pl-8">
              {PIPELINE_STEPS.map((step, i) => (
                <div key={step.label} className="relative pb-8 last:pb-0">
                  <div className="absolute -left-[calc(theme(spacing.8)+theme(spacing.4)+1px)] flex h-8 w-8 items-center justify-center rounded-full border border-fd-border bg-fd-background text-xs font-bold">
                    {String(i + 1).padStart(2, '0')}
                  </div>
                  <div>
                    <span className="text-sm font-semibold">{step.label}</span>
                    <span className="ml-2 text-xs text-fd-muted-foreground">{step.role}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Agents ── */}
      <section className="border-t border-fd-border px-6 py-24">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
            전문 에이전트
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-center text-fd-muted-foreground">
            4개 레인, 20개 에이전트. 각자의 역할에 최적화되어 있습니다.
          </p>

          <div className="mt-16 grid gap-6 sm:grid-cols-2">
            {Object.entries(AGENTS).map(([lane, agents]) => (
              <div
                key={lane}
                className="rounded-xl border border-fd-border p-6"
              >
                <div className="mb-4 flex items-center gap-3">
                  <h3 className="text-base font-semibold">{lane}</h3>
                  <span className="rounded-full bg-fd-muted px-2 py-0.5 text-xs text-fd-muted-foreground">
                    {agents.length}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {agents.map((agent) => (
                    <span
                      key={agent}
                      className="inline-block rounded-md bg-fd-muted px-2.5 py-1 font-mono text-xs text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
                    >
                      {agent}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-8 text-center">
            <Link
              href="/docs/agents"
              className="text-sm font-medium text-fd-muted-foreground underline decoration-fd-border underline-offset-4 transition-colors hover:text-fd-foreground"
            >
              전체 에이전트 보기
            </Link>
          </div>
        </div>
      </section>

      {/* ── Skills ── */}
      <section className="border-t border-fd-border bg-fd-card/30 px-6 py-24">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
            주요 스킬
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-center text-fd-muted-foreground">
            복잡한 워크플로우를 한 단어로 실행합니다.
          </p>

          <div className="mt-16 grid gap-px overflow-hidden rounded-xl border border-fd-border bg-fd-border sm:grid-cols-2">
            {SKILLS.map((skill) => (
              <div
                key={skill.name}
                className="flex flex-col gap-2 bg-fd-background p-8"
              >
                <code className="w-fit rounded-md bg-fd-muted px-2.5 py-1 font-mono text-sm font-semibold">
                  /{skill.name}
                </code>
                <p className="text-sm text-fd-muted-foreground">
                  {skill.desc}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-8 text-center">
            <Link
              href="/docs/skills"
              className="text-sm font-medium text-fd-muted-foreground underline decoration-fd-border underline-offset-4 transition-colors hover:text-fd-foreground"
            >
              전체 스킬 보기
            </Link>
          </div>
        </div>
      </section>

      {/* ── Get Started ── */}
      <section className="border-t border-fd-border px-6 py-24">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            3단계로 시작합니다
          </h2>

          <div className="mx-auto mt-16 grid max-w-xl gap-8 text-left">
            {[
              {
                step: '01',
                title: 'Plugin 설치',
                desc: 'Claude Code에 oh-my-claudecode 플러그인을 설치합니다.',
              },
              {
                step: '02',
                title: 'omc-setup 실행',
                desc: '"setup omc"를 입력하면 자동으로 환경이 구성됩니다.',
              },
              {
                step: '03',
                title: 'autopilot 시작',
                desc: '"autopilot build me X"를 입력하면 에이전트들이 일을 시작합니다.',
              },
            ].map((item) => (
              <div key={item.step} className="flex gap-6">
                <span className="flex-none font-mono text-3xl font-bold text-fd-muted-foreground/40">
                  {item.step}
                </span>
                <div>
                  <h3 className="text-base font-semibold">{item.title}</h3>
                  <p className="mt-1 text-sm text-fd-muted-foreground">
                    {item.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <Link
            href="/docs/getting-started"
            className="mt-12 inline-flex h-11 items-center rounded-lg bg-fd-primary px-8 text-sm font-medium text-fd-primary-foreground transition-colors hover:bg-fd-primary/90"
          >
            시작하기
          </Link>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-fd-border px-6 py-12">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-4 sm:flex-row">
          <span className="text-sm text-fd-muted-foreground">
            Oh My ClaudeCode
          </span>
          <div className="flex gap-6">
            <Link
              href="/docs"
              className="text-sm text-fd-muted-foreground transition-colors hover:text-fd-foreground"
            >
              Docs
            </Link>
            <a
              href="https://github.com/Yeachan-Heo/oh-my-claudecode"
              target="_blank"
              rel="noreferrer"
              className="text-sm text-fd-muted-foreground transition-colors hover:text-fd-foreground"
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </HomeLayout>
  );
}

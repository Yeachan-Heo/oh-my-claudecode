# Model × Agent Compatibility Matrix

Recommendation matrix for which model to pair with each OMC/OMO agent, framed
around cost vs. quality. This page exists so the recurring "어떤 모델을 어느
agent에 박아야 함?" question stops being tribal Discord knowledge.

This is a **usage matrix, not a benchmark report**. Numbers and per-task scores
are deliberately out of scope.

## Recommendation matrix

| Agent | Role | Recommended (premium) | Recommended (cost-effective) | Avoid | Notes |
|---|---|---|---|---|---|
| Prometheus | Planning | Claude Opus 4.7, GPT-5.5 high | Sonnet 4.6 | — | Heavy reasoning; runs 1–2x per session |
| Hyperplan | Planning | Claude Opus 4.7, GPT-5.5 high | Sonnet 4.6 | — | Same as Prometheus |
| Sisyphus | Implementation | Sonnet 4.6 | DeepSeek V4 Pro, Kimi K2.5 | — | Token-heavy; cost matters most here |
| Hephaestus | Implementation | Sonnet 4.6, Kimi K2.5 | DeepSeek V4 Pro | **GPT-\* (tool-calling/format breakage)** | Tuned for non-GPT |
| Oracle | Review | Claude Opus 4.7, GPT-5.5 high | Sonnet 4.6 | — | Quality > cost; called sparingly |
| Aletheia | Review | Sonnet 4.6 | DeepSeek V4 Pro | — | |
| Hermes | Coordination | Sonnet 4.6 | DeepSeek V4 Flash | — | Coordinator only, not direct executor |

## Design rules

These four rules drive every recommendation above. If you only remember one
thing, remember rule 3.

1. **Planning/Review = expensive; Implementation = cheap.**
   Token weight typically differs 5–20× between a single Prometheus/Oracle pass
   and a full Sisyphus implementation loop. Spend on the rare, decisive calls;
   economize on the high-volume ones.
2. **Hephaestus should not be paired with GPT-family models.**
   Tool-calling and structured-output formats break. Use Sonnet 4.6 / Kimi K2.5
   for premium and DeepSeek V4 Pro for cost-effective. This is the "Hephaestus
   is trash with non-GPT models" folklore turned the right way up.
3. **Sisyphus is the highest-value cost lever.**
   Because Sisyphus dominates total tokens in any non-trivial session, swapping
   it from Opus → Sonnet (or → DeepSeek V4 Pro) typically moves total spend
   more than any other single change. Tune this slot first.
4. **DeepSeek V4 Pro/Flash is now a first-class budget option.**
   Treat V4 Pro as the default cost-effective choice for execution agents
   (Sisyphus, Hephaestus, Aletheia) and V4 Flash as the default coordinator
   model. It is no longer an experimental fallback.

## Starter presets

Pick the preset that matches your budget posture and adjust from there. Each
block is a self-contained example — drop into your provider/agent config and
edit per agent as needed.

### Premium (max quality)

Use when correctness dominates cost: production-impacting refactors, security
reviews, architecture decisions.

```yaml
agents:
  Prometheus:  { model: claude-opus-4-7 }
  Hyperplan:   { model: claude-opus-4-7 }
  Sisyphus:    { model: claude-sonnet-4-6 }
  Hephaestus:  { model: claude-sonnet-4-6 }   # never GPT-*
  Oracle:      { model: claude-opus-4-7 }
  Aletheia:    { model: claude-sonnet-4-6 }
  Hermes:      { model: claude-sonnet-4-6 }
```

### Balanced (default)

Recommended starting point. Keeps planning/review on a strong model while
moving the token-heavy implementation slot to a cost-effective one.

```yaml
agents:
  Prometheus:  { model: claude-sonnet-4-6 }
  Hyperplan:   { model: claude-sonnet-4-6 }
  Sisyphus:    { model: deepseek-v4-pro }
  Hephaestus:  { model: kimi-k2-5 }            # never GPT-*
  Oracle:      { model: claude-sonnet-4-6 }
  Aletheia:    { model: deepseek-v4-pro }
  Hermes:      { model: deepseek-v4-flash }
```

### Budget (cost-first)

For long-running loops, batch refactors, or experimentation where total spend
matters more than peak per-call quality. Keep Oracle on a strong model so the
final review pass still catches regressions.

```yaml
agents:
  Prometheus:  { model: claude-sonnet-4-6 }
  Hyperplan:   { model: claude-sonnet-4-6 }
  Sisyphus:    { model: deepseek-v4-pro }
  Hephaestus:  { model: deepseek-v4-pro }      # never GPT-*
  Oracle:      { model: claude-sonnet-4-6 }
  Aletheia:    { model: deepseek-v4-pro }
  Hermes:      { model: deepseek-v4-flash }
```

## Out of scope

- Provider routing internals (tracked elsewhere).
- Benchmarks — this page is a usage matrix, not a benchmark report.
- Hermes deep-coordination patterns.

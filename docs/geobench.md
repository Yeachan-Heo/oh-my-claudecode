# GEO benchmark for oh-my-claudecode

This repository includes a [`geobench`](https://github.com/NomaDamas/geobench) product spec for measuring LLM answer visibility: hit rate, MRR, share of voice, citation rate/share, and confidence intervals.

```bash
/path/to/geobench/dist/geobench estimate --product geobench/oh-my-claudecode.yaml --providers openai --tier cheap
/path/to/geobench/dist/geobench profile geobench/oh-my-claudecode.yaml
/path/to/geobench/dist/geobench bench --product geobench/oh-my-claudecode.yaml --providers openai --tier cheap --mode benchmark
```

Publish aggregate metrics only; do not publish raw provider answers, secrets, or private run logs.

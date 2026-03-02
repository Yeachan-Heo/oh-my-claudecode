---
name: omc-export
description: Export current session conversation to session-YYYY-MM-DD.md
aliases:
  - session-export
  - export-session
---

# OMC Export (POC)

Export the current Claude Code session conversation to markdown.

## Goal

Create a markdown file named `session-YYYY-MM-DD.md` in the current working directory.

## Steps

1. Detect the most recent Claude transcript JSONL under `~/.claude/projects/`.
2. Parse the transcript lines.
3. Extract user + assistant messages.
4. Write markdown with this structure:

```md
# Session Export — YYYY-MM-DD

Source: /absolute/path/to/transcript.jsonl
Generated: YYYY-MM-DD HH:MM:SS UTC

---

## user
...

## assistant
...
```

## Execution (POC script)

Use this one-shot command:

```bash
python3 - <<'PY'
import json
import os
from datetime import datetime, timezone
from pathlib import Path

root = Path.home() / '.claude' / 'projects'
files = sorted(root.rglob('*.jsonl'), key=lambda p: p.stat().st_mtime, reverse=True)
if not files:
    raise SystemExit('No transcript jsonl found under ~/.claude/projects')

src = files[0]
out_name = f"session-{datetime.now(timezone.utc).strftime('%Y-%m-%d')}.md"
out_path = Path.cwd() / out_name

lines = []
for raw in src.read_text(encoding='utf-8', errors='ignore').splitlines():
    raw = raw.strip()
    if not raw:
        continue
    try:
        obj = json.loads(raw)
    except Exception:
        continue

    role = obj.get('type')
    if role == 'user':
        text = obj.get('message', {}).get('content')
        if isinstance(text, str) and text.strip():
            lines.append(('user', text.strip()))
    elif role == 'assistant':
        msg = obj.get('message', {})
        content = msg.get('content')
        if isinstance(content, str) and content.strip():
            lines.append(('assistant', content.strip()))
        elif isinstance(content, list):
            chunks = []
            for c in content:
                if isinstance(c, dict) and c.get('type') == 'text' and isinstance(c.get('text'), str):
                    t = c['text'].strip()
                    if t:
                        chunks.append(t)
            if chunks:
                lines.append(('assistant', '\n\n'.join(chunks)))

now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
header = [
    f"# Session Export — {datetime.now(timezone.utc).strftime('%Y-%m-%d')}",
    '',
    f"Source: {src}",
    f"Generated: {now}",
    '',
    '---',
    '',
]

body = []
for role, text in lines:
    body.append(f"## {role}")
    body.append(text)
    body.append('')

out_path.write_text('\n'.join(header + body), encoding='utf-8')
print(f'Exported: {out_path}')
PY
```

## Output check

After export, confirm:

- file exists (`session-YYYY-MM-DD.md`)
- file has at least one `## user` or `## assistant` block

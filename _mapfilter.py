#!/usr/bin/env python3
"""Filter skills/map/SKILL.md table rows: drop any row referencing a skill
directory that does not exist in the current tree. Usage: python _mapfilter.py"""
import io, os, re

have = {d for d in os.listdir('skills') if os.path.isdir(os.path.join('skills', d))}
agents = {f[:-4] for f in os.listdir('agents') if f.endswith('.md')} if os.path.isdir('agents') else set()
lines = io.open('skills/map/SKILL.md', encoding='utf-8').read().split('\n')
out, dropped = [], []
for line in lines:
    if line.startswith('| '):
        refs = re.findall(r'`([a-z0-9][a-z0-9-]+)`', line)
        bad = [r for r in refs if r not in have and r not in agents and not r.startswith('oh-my-claudecode')]
        if bad:
            dropped.append((bad, line[:60]))
            continue
    out.append(line)
io.open('skills/map/SKILL.md', 'w', encoding='utf-8', newline='').write('\n'.join(out))
print('dropped rows:', len(dropped))
for bad, l in dropped:
    print('  ', bad, '|', l)

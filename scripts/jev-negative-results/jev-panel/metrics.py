# Scores a replay of the Jev panel against ground-truth labels.
#   python3 -I metrics.py <labels.jsonl> <replay-output.jsonl>
# labels.jsonl: one row per case { id, prawda: { <question>: "tak" | "nie", ... }, agent_id, wejscie: { stan: { zadanie_w_toku } } }
# replay-output.jsonl: the output of replay-labelled.mjs.
# Definitions (per question, per moment):
#   hints      = cases where the question's answer would have produced a hint (decision[question] is true)
#   hits       = hints on cases whose ground truth for that question is "tak" (yes)
#   precision  = hits / hints            (the report calls it "trafnosc", accuracy of a hint)
#   sensitivity= hits / positives        (the report calls it "czulosc")
#   false per 100 = hints that are not hits, per 100 scored cases
# "list is out of date" = the hint after Jev's choice (field `wybrane`) is `zrobione` or `notka`; its ground truth is "zrobione" or "notka" being "tak".
import json, sys, collections, math, statistics

labels = [json.loads(line) for line in open(sys.argv[1], encoding='utf-8') if line.strip()]
replay = {}
for line in open(sys.argv[2], encoding='utf-8'):
    if not line.strip():
        continue
    row = json.loads(line)
    if 'id' in row:
        replay[row['id']] = row
E_ = {str(e['id']): e for e in labels}
replay = {str(k): v for k, v in replay.items()}
ids = [i for i in E_ if i in replay and not replay[i].get('blad')]
QUESTIONS = ('zrobione', 'notka', 'zrodlo', 'poboczne', 'utknal', 'deleguj')
positives = {q: {i for i in ids if E_[i]['prawda'].get(q) == 'tak'} for q in QUESTIONS}


def line(name, hits, positive):
    h = len(hits)
    t = len([i for i in hits if i in positive])
    n = len(positive)
    if not h:
        return f'  {name}: hints 0'
    out = f'  {name}: hints {h}, hits {t}, precision {t}/{h}={100 * t / h:.0f}%'
    out += f', sensitivity {t}/{n}={100 * t / n:.0f}%' if n else ', sensitivity: no positive cases'
    return out


print('cases', len(ids))
for where in ('paczka', 'koniec', 'razem'):
    print('== questions (Jev yes/no before the choice):', where)
    for q in QUESTIONS:
        hits = [i for i in ids if replay[i]['decyzja'][q][where] is True]
        print(line(q, hits, positives[q]))

positive_list = positives['zrobione'] | positives['notka']
print('== list out of date (zrobione or notka), hint after the choice of Jev')
for where in ('paczka', 'koniec'):
    hits = [i for i in ids if (replay[i].get('wybrane') or {}).get(where) in ('zrobione', 'notka')]
    print(line(where, hits, positive_list))
hits = [i for i in ids if replay[i]['decyzja']['zrobione']['paczka'] is True or replay[i]['decyzja']['notka']['paczka'] is True]
print(line('paczka: at least one of zrobione/notka (before the choice)', hits, positive_list))

def task(i):
    return (E_[i].get('agent_id'), E_[i]['wejscie']['stan'].get('zadanie_w_toku'))

tasks_positive = {task(i) for i in positive_list if E_[i]['wejscie']['stan'].get('zadanie_w_toku')}
tasks_hinted = {task(i) for i in ids if (replay[i].get('wybrane') or {}).get('paczka') in ('zrobione', 'notka') and E_[i]['wejscie']['stan'].get('zadanie_w_toku')}
if tasks_hinted:
    both = tasks_hinted & tasks_positive
    print(f'  per task: tasks with an out-of-date list {len(tasks_positive)}, with a hint {len(tasks_hinted)}, correct {len(both)}: precision {100 * len(both) / len(tasks_hinted):.0f}% sensitivity {100 * len(both) / max(1, len(tasks_positive)):.0f}%')
false_hints = len([i for i in ids if (replay[i].get('wybrane') or {}).get('paczka') in ('zrobione', 'notka') and i not in positive_list])
print(f'  false list hints per 100 batch queries: {100 * false_hints / len(ids):.1f}')
print('  chosen (batch):', dict(collections.Counter((replay[i].get('wybrane') or {}).get('paczka') for i in ids)))
print('  chosen (end):', dict(collections.Counter((replay[i].get('wybrane') or {}).get('koniec') for i in ids if replay[i].get('koniec'))))

print('== input')
for where in ('paczka', 'koniec'):
    rs = [replay[i][where] for i in ids if replay[i].get(where)]
    if not rs:
        continue
    full = sum(1 for r in rs if r.get('wejscie_pelne'))
    empty = sum(1 for r in rs if r.get('tekst_agenta_znakow', 0) == 0)
    degraded = sum(1 for r in rs if r.get('wynik') != 'active')
    ms = sorted(r['ms'] for r in rs if r.get('ms') is not None)
    p95 = ms[min(len(ms), math.ceil(0.95 * len(ms))) - 1] if ms else None
    print(f'  {where}: queries {len(rs)}, full input {full} ({100 * full / len(rs):.0f}%), empty agent text {empty}, no Jev answer {degraded}, ms median {statistics.median(ms) if ms else None} p95 {p95}')

---
name: data-analyze
description: Exploratory data analysis for CSV/JSON/SQL, automated report generation, and log/error pattern analysis
level: 3
aliases: [data, analyze, eda, logs, report-gen]
argument-hint: [eda <file>|report <file>|logs <path>] - default is eda
---

# Data Analyze Skill

Perform exploratory data analysis, generate reports, and analyze logs using the Python REPL. Works with CSV, JSON, SQL databases, and log files.

## Usage

```
/oh-my-claudecode:data-analyze
/oh-my-claudecode:data-analyze eda data.csv
/oh-my-claudecode:data-analyze report results.json
/oh-my-claudecode:data-analyze logs /var/log/app/
```

Or say: "analyze this data", "generate a report", "find patterns in logs", "EDA on this CSV"

## Modes

| Mode | Input | Output |
|------|-------|--------|
| `eda` | CSV, JSON, Parquet, SQL | Statistical summary, distributions, correlations, visualizations |
| `report` | Any data file | Formatted Markdown/HTML report with tables and charts |
| `logs` | Log files, error logs | Pattern detection, error clustering, timeline analysis |

## Workflow

### Mode: EDA (Exploratory Data Analysis)

#### 1. Load and Profile Data

```python
# Using python_repl for persistent state
import pandas as pd
import numpy as np

# Load data (detect format automatically)
df = pd.read_csv('data.csv')  # or read_json, read_parquet, read_sql
print(f"Shape: {df.shape}")
print(f"Columns: {list(df.columns)}")
print(f"Dtypes:\n{df.dtypes}")
print(f"Missing values:\n{df.isnull().sum()}")
print(f"Memory: {df.memory_usage(deep=True).sum() / 1024**2:.1f} MB")
```

#### 2. Statistical Summary

```python
# Numeric columns
print(df.describe())

# Categorical columns
for col in df.select_dtypes(include='object').columns:
    print(f"\n{col}: {df[col].nunique()} unique values")
    print(df[col].value_counts().head(10))

# Correlations
numeric_df = df.select_dtypes(include=[np.number])
if len(numeric_df.columns) > 1:
    print("\nCorrelation matrix:")
    print(numeric_df.corr().round(2))
```

#### 3. Distribution Analysis

```python
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

# Histograms for numeric columns
fig, axes = plt.subplots(nrows=len(numeric_cols), figsize=(10, 4*len(numeric_cols)))
for i, col in enumerate(numeric_cols):
    df[col].hist(ax=axes[i] if len(numeric_cols) > 1 else axes, bins=30)
    axes_i = axes[i] if len(numeric_cols) > 1 else axes
    axes_i.set_title(col)
plt.tight_layout()
plt.savefig('distributions.png', dpi=100)
```

#### 4. Generate EDA Report

Output a structured analysis:

```
[DATA ANALYSIS] EDA Report
═══════════════════════════════════════════

Dataset: {filename}
Rows: {n}  |  Columns: {n}  |  Size: {size}

┌──────────────────────────────────────────┐
│ DATA QUALITY                              │
├──────────────────┬───────────────────────┤
│ Completeness     │ {pct}% (missing: {n}) │
│ Duplicates       │ {n} rows              │
│ Outliers         │ {n} detected          │
│ Type consistency │ {status}              │
└──────────────────┴───────────────────────┘

Key Findings:
1. {finding with statistical evidence}
2. {finding with statistical evidence}
3. {finding with statistical evidence}

Recommendations:
- {data cleaning suggestion}
- {analysis direction suggestion}
```

### Mode: Report Generation

#### 1. Analyze Data

Run the EDA workflow above, then format as a complete report:

```markdown
# Data Report: {title}

Generated: {date}
Source: {filename}

## Executive Summary
{2-3 sentence summary of key findings}

## Data Overview
| Metric | Value |
|--------|-------|
| Records | {n} |
| Fields | {n} |
| Date range | {range} |
| Completeness | {pct}% |

## Key Metrics
{tables with aggregated statistics}

## Visualizations
{embedded charts or chart file references}

## Detailed Findings
{numbered findings with supporting data}

## Recommendations
{actionable next steps}

## Methodology
{tools used, assumptions made, limitations}
```

#### 2. Export

Save report to:
- `report.md` — Markdown (default)
- `report.html` — HTML with styled tables (if requested)
- Charts saved as PNG alongside the report

### Mode: Log Analysis

#### 1. Parse Logs

```python
import re
from collections import Counter
from datetime import datetime

# Read log file(s)
log_lines = open('app.log').readlines()
print(f"Total lines: {len(log_lines)}")

# Extract error patterns
errors = [l for l in log_lines if 'ERROR' in l or 'FATAL' in l]
warnings = [l for l in log_lines if 'WARN' in l]
print(f"Errors: {len(errors)}, Warnings: {len(warnings)}")

# Cluster errors by message pattern
error_patterns = Counter()
for e in errors:
    # Normalize: remove timestamps, IDs, specific values
    pattern = re.sub(r'\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2}', 'TIMESTAMP', e)
    pattern = re.sub(r'[0-9a-f]{8,}', 'ID', pattern)
    error_patterns[pattern[:100]] += 1

print("\nTop error patterns:")
for pattern, count in error_patterns.most_common(10):
    print(f"  [{count}x] {pattern}")
```

#### 2. Timeline Analysis

```python
# Extract timestamps and error rates over time
timestamps = []
for line in errors:
    match = re.search(r'(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2})', line)
    if match:
        timestamps.append(match.group(1))

# Group by hour/minute to find spikes
from collections import Counter
hourly = Counter(t[:13] for t in timestamps)
print("\nError rate by hour:")
for hour, count in sorted(hourly.items()):
    bar = '█' * min(count, 50)
    print(f"  {hour} | {bar} ({count})")
```

#### 3. Generate Log Report

```
[LOG ANALYSIS] Report
═══════════════════════════════════════════

Source: {log_path}
Period: {start} to {end}
Lines analyzed: {n}

Error Summary:
  FATAL: {n}
  ERROR: {n}
  WARN:  {n}

Top Error Patterns:
  1. [{count}x] {pattern} — First seen: {time}
  2. [{count}x] {pattern} — First seen: {time}
  3. [{count}x] {pattern} — First seen: {time}

Timeline:
  {spike detection — "Error spike at {time}: {n} errors in {period}"}

Root Cause Candidates:
  1. {hypothesis based on error clustering}
  2. {hypothesis based on timeline correlation}

Recommended Actions:
  1. {highest priority fix}
  2. {investigation to perform}
```

## Agent Delegation

For complex data analysis, delegate to the scientist agent:

```
Task(subagent_type="oh-my-claudecode:scientist", model="sonnet", prompt="ANALYZE DATA:
File: {path}
Question: {what to investigate}
Use python_repl for all analysis. Include statistical tests where appropriate.
Report findings with confidence intervals and effect sizes.")
```

## Exit Conditions

| Condition | Action |
|-----------|--------|
| **EDA complete** | Display summary report with key findings |
| **Report generated** | Save report file and display location |
| **Logs analyzed** | Display error patterns and timeline |
| **File not found** | Ask user for correct path |
| **Unsupported format** | Suggest conversion or alternative approach |

## Notes

- **Uses python_repl**: All analysis runs in the persistent Python REPL with pandas, numpy, matplotlib available.
- **Large files**: For files >100MB, sample first (`df.sample(10000)`) then analyze the full set for confirmed findings.
- **SQL support**: Can connect to SQLite databases directly via pandas `read_sql`.
- **Complements /sciomc**: Use `/sciomc` for multi-faceted research questions. Use `/data-analyze` for direct data file analysis.
- **Charts**: Saved as PNG files in the working directory. Reference them in reports.

---

Begin data analysis now. Parse the mode and file argument, then start analysis.

# Community Plugins

Third-party plugins built for OMC and Claude Code.  
Install any of them with `claude plugin marketplace add <repo-url>`.

---

## non-dev-output

> Explains tech in plain language — no commands needed.

**Author**: [@calmtiger86](https://github.com/calmtiger86)  
**Repo**: https://github.com/calmtiger86/non-dev-output  
**Language**: Korean / English / Chinese

### What it does

Two hooks run automatically on every session:

- **SessionStart** — injects a two-block output rule (analogy block + reality block) into Claude's context
- **UserPromptSubmit** — detects confusion signals (`"이해가 안 돼"`, `"I don't understand"`, …) and writing requests (`"블로그 써줘"`, `"write a blog post"`, …), then injects the matching instruction before Claude responds

No slash commands. No manual mode switching.

### Install

```bash
claude plugin marketplace add https://github.com/calmtiger86/non-dev-output
claude plugin install non-dev-output@non-dev-output
```

---

## Submit your plugin

Open a PR adding a new section to this file.  
Follow the format above: name, author, repo, what it does, install command.

---
name: help
description: Guide on using oh-my-claudecode plugin
---

# How OMC Works

**You don't need to learn any commands!** OMC enhances Claude Code with intelligent behaviors that activate automatically.

## What Happens Automatically

| When You... | I Automatically... |
|-------------|-------------------|
| Give me a complex task | Parallelize and delegate to specialist agents |
| Ask me to plan something | Start a planning interview |
| Need something done completely | Persist until verified complete |
| Work on UI/frontend | Activate design sensibility |
| Say "stop" or "cancel" | Intelligently stop current operation |

## Magic Keywords (Optional Shortcuts)

You can include these words naturally in your request for explicit control:

| Keyword | Effect | Example |
|---------|--------|---------|
| **ralph** | Persistence mode | "ralph: fix all the bugs" |
| **ralplan** | Iterative planning | "ralplan this feature" |
| **ulw** | Max parallelism | "ulw refactor the API" |
| **plan** | Planning interview | "plan the new endpoints" |

**ralph includes ultrawork:** When you activate ralph mode, it automatically includes ultrawork's parallel execution. No need to combine keywords.

## Stopping Things

Just say:
- "stop"
- "cancel"
- "abort"

I'll figure out what to stop based on context.

## First Time Setup

If you haven't configured OMC yet:

```
/oh-my-claudecode:omc-setup
```

This is the **only command** you need to know. It downloads the configuration and you're done.

## For 2.x Users

Your old commands still work! `/ralph`, `/ultrawork`, `/plan`, etc. all function exactly as before.

But now you don't NEED them - everything is automatic.

## Need More Help?

- **README**: https://github.com/Yeachan-Heo/oh-my-claudecode
- **Issues**: https://github.com/Yeachan-Heo/oh-my-claudecode/issues

---

*Version: 3.5.5*

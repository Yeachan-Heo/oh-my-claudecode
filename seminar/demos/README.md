# OMC Seminar Demo Scripts

This directory contains demo scripts for showcasing Oh-My-ClaudeCode's capabilities.

## Overview

The seminar includes 5 progressive demos that showcase different aspects of OMC:

1. **Autopilot** (5 min) - Full autonomous execution from idea to working code
2. **Ultrawork** (3 min) - Maximum parallelism with multiple agents
3. **Pipeline** (3 min) - Sequential agent chaining with data passing
4. **Planning** (2 min) - Interactive planning with interview workflow
5. **Ralph** (2 min) - Persistent execution with self-correction

**Total demo time:** ~15 minutes + Q&A buffer

## Global Pre-requisites

### Required Setup
- OMC installed and configured (`/oh-my-claudecode:omc-setup` completed)
- HUD statusline installed (`/oh-my-claudecode:hud setup`)
- Clean workspace directory for demos
- Terminal with good font size for presentation (16-18pt minimum)
- Screen recording software running as backup

### Environment Preparation
```bash
# Create demo workspace
mkdir -p ~/demo-workspace
cd ~/demo-workspace

# Verify OMC is installed
which omc || echo "Run: /oh-my-claudecode:omc-setup"

# Check HUD is working
echo "HUD should display in your terminal prompt"
```

### Pre-Demo Checklist
- [ ] Terminal font size increased for visibility
- [ ] No active OMC operations running (`/oh-my-claudecode:cancel --all`)
- [ ] Clean state files (`rm -rf .omc/state/*`)
- [ ] Screen recorder ready
- [ ] Fallback terminal outputs printed/accessible
- [ ] Demo workspace prepared

## Demo Flow

### Opening (1 min)
"Today I'll show you Oh-My-ClaudeCode - a multi-agent orchestration system that transforms Claude from a single assistant into a coordinated team of specialists. Instead of doing everything yourself, you conduct a symphony of AI agents, each optimized for specific tasks."

### Demo Sequence (15 min)
1. **Demo 1: Autopilot** - "The flagship experience - say what you want, get working code"
2. **Demo 2: Ultrawork** - "When you need speed - multiple agents working in parallel"
3. **Demo 3: Pipeline** - "For complex workflows - chaining agents with data passing"
4. **Demo 4: Planning** - "For unclear requirements - interactive planning interview"
5. **Demo 5: Ralph** - "For mission-critical tasks - never gives up until verified complete"

### Closing (1 min)
"OMC transforms how you work with Claude - from manual coding to orchestrating specialized agents. All open source at github.com/Yeachan-Heo/oh-my-claudecode."

## Tips for Presenters

### General Tips
- **Announce behaviors**: OMC announces what it's activating ("I'm activating autopilot...")
- **Watch the HUD**: The statusline shows active agents, tasks, and progress
- **Embrace async**: Background tasks run while you talk - no waiting
- **Have fallbacks**: Pre-recorded outputs for each demo in case of issues
- **Highlight automation**: Point out when agents delegate to other agents automatically

### Technical Tips
- **Terminal size**: Ensure output is readable from the back of the room
- **Timing buffer**: Each demo has 30-60s buffer built in
- **State cleanup**: Between demos, verify clean state with `/oh-my-claudecode:cancel`
- **Error handling**: If a demo fails, acknowledge it and move to fallback output
- **Q&A prep**: Common questions are in each demo's "Talking Points"

## Common Issues & Solutions

### Issue: Agent not responding
**Solution**: Check `.omc/logs/agent-lifecycle.log` for errors, or skip to fallback output

### Issue: HUD not showing
**Solution**: Mention it verbally ("The HUD would show 3 active agents here...")

### Issue: Demo taking too long
**Solution**: Jump to next phase or use `/oh-my-claudecode:cancel` and show fallback

### Issue: Terminal output too fast
**Solution**: Scroll back and explain key sections, or pause recording if pre-recorded

## File Structure

```
seminar/demos/
├── README.md (this file)
├── demo-1-autopilot.md
├── demo-2-ultrawork.md
├── demo-3-pipeline.md
├── demo-4-planning.md
└── demo-5-ralph.md
```

## Post-Seminar

- Share demo workspace as GitHub repo
- Provide recording link
- Share OMC installation guide
- Collect feedback on demo clarity

## Questions During Demos

If questions arise during demos:
- **Quick questions** (<30s): Answer immediately
- **Deep questions**: "Great question - let's discuss after demos"
- **Technical details**: "The architecture slide covers this - coming up next"

## Backup Plan

If all demos fail:
- Show pre-recorded terminal outputs from each demo file
- Walk through the expected behavior while showing outputs
- Explain the architecture and benefits verbally
- Show GitHub repo and documentation

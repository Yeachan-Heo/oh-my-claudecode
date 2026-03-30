---
name: visual-context
description: Optimize screenshot, UI mockup, and diagram input for Claude Code - multi-modal context management and visual debugging
level: 2
aliases: [visual, screenshot, mockup, ui-context]
argument-hint: [guide|screenshot|mockup|diagram|compare] - default is guide
---

# Visual Context Skill

Master multi-modal input in Claude Code. Learn how to effectively use screenshots, UI mockups, diagrams, and visual references for precise development.

## Usage

```
/oh-my-claudecode:visual-context
/oh-my-claudecode:visual-context guide
/oh-my-claudecode:visual-context screenshot
/oh-my-claudecode:visual-context mockup
/oh-my-claudecode:visual-context compare
```

Or say: "use this screenshot", "analyze this UI", "compare these designs", "visual debugging"

## Modes

| Mode | Purpose | Input |
|------|---------|-------|
| `guide` | How to use visual context effectively | None |
| `screenshot` | Analyze a screenshot for bugs/issues | Image path |
| `mockup` | Implement from a mockup/design | Image path |
| `diagram` | Understand architecture from diagram | Image path |
| `compare` | Compare two visual states | Two image paths |

## Visual Context Guide

### What Claude Can See

Claude Code can read images directly via the `Read` tool:
- **Screenshots**: Browser screenshots, app UI, terminal output
- **Mockups**: Figma exports, Sketch designs, wireframes
- **Diagrams**: Architecture diagrams, flowcharts, ERDs
- **Charts**: Data visualizations, graphs
- **Formats**: PNG, JPG, GIF, WebP, SVG (as image)

### Best Practices for Visual Input

#### 1. Screenshot Quality

| Good | Bad |
|------|-----|
| Full-page screenshot at 1x-2x resolution | Tiny cropped portion |
| Clear, focused on the relevant area | Multiple unrelated elements |
| Includes browser URL bar (for context) | Blurry or heavily compressed |
| Dark/light mode consistent with codebase | Low contrast, hard to read |

#### 2. Annotating Screenshots

Before sharing a screenshot, annotate to focus attention:

```bash
# Take a screenshot on macOS
screencapture -w screenshot.png    # Window capture
screencapture -s screenshot.png    # Selection capture
screencapture -C screenshot.png    # Full screen with cursor

# Or use built-in Preview to annotate
# Open screenshot → Tools → Annotate → Circle/Arrow/Text
```

**Annotation tips:**
- Circle or arrow pointing to the bug/issue
- Red boxes around areas that need change
- Numbered annotations for multiple issues
- Text labels explaining what's wrong

#### 3. Providing Context with Images

**Instead of**: "Fix this" + screenshot
**Do this**: "The login button (circled in red) should be blue (#2563EB) and aligned with the email field. See screenshot:" + annotated screenshot

**Instead of**: "Make it look like this" + mockup
**Do this**: "Implement this card component. Key requirements: rounded corners (8px), shadow on hover, badge in top-right. See mockup:" + mockup image

### Token Impact

Images consume tokens based on size:
- Small image (<512px): ~85 tokens
- Medium image (512-1024px): ~170 tokens
- Large image (1024-2048px): ~680 tokens
- Very large image (>2048px): ~1360 tokens

**Optimization**: Resize large screenshots to 1024px width before sending to save context.

```bash
# Resize screenshot to 1024px width (macOS)
sips -Z 1024 screenshot.png

# Or use ImageMagick
convert screenshot.png -resize 1024x screenshot-optimized.png
```

## Workflow

### Mode: Screenshot (Visual Bug Analysis)

#### 1. Read the Screenshot

```
Read the screenshot at {path}. I need to analyze this for:
- Visual bugs (misalignment, wrong colors, broken layout)
- Content issues (wrong text, missing elements)
- Responsiveness issues (overflow, truncation)
- Accessibility issues (contrast, missing labels)
```

#### 2. Catalog Issues

```
[VISUAL ANALYSIS] Screenshot: {path}
═══════════════════════════════════════════

Issues Found:
1. [HIGH] {description} — location: {top-left / center / etc.}
2. [MEDIUM] {description}
3. [LOW] {description}

For each issue:
- What's wrong
- What it should look like
- Which CSS/component to fix
- Estimated fix complexity
```

#### 3. Fix Issues

For each identified issue, locate the relevant component/styles and fix.

### Mode: Mockup (Design Implementation)

#### 1. Analyze the Mockup

Read the mockup image and extract design specifications:

```
From this mockup, extract:
- Layout structure (grid, flex, positioning)
- Typography (font sizes, weights, line heights)
- Colors (exact hex/rgb values)
- Spacing (padding, margins, gaps)
- Interactive states (hover, active, focus)
- Responsive behavior (if multiple breakpoints shown)
- Components to create or modify
```

#### 2. Plan Implementation

Map mockup elements to code:
- Existing components that can be reused
- New components to create
- Style changes needed
- Responsive breakpoints

#### 3. Implement

Generate the code matching the mockup, verifying against the image after each component.

### Mode: Compare (Before/After)

#### 1. Load Both Images

Read two screenshots/mockups for comparison.

#### 2. Diff Analysis

```
[VISUAL COMPARISON]
═══════════════════════════════════════════

Image A: {path_a}
Image B: {path_b}

Differences:
1. {area} — A: {description} → B: {description}
2. {area} — A: {description} → B: {description}

Verdict: {MATCH|MINOR_DIFF|MAJOR_DIFF}
```

**Integration with /visual-verdict:**
For structured pass/fail scoring, use `/oh-my-claudecode:visual-verdict` which provides a 0-100 score.

## Integration with OMC Tools

| Tool | Visual Use |
|------|-----------|
| `/visual-verdict` | Structured screenshot comparison scoring |
| `/oh-my-claudecode:designer` | UI/UX implementation from mockups |
| `python_repl` | Generate charts and visualizations |
| `/perf-audit bundle` | Visualize bundle size distribution |
| `/data-analyze` | Generate data visualizations |

## Exit Conditions

| Condition | Action |
|-----------|--------|
| **Guide shown** | Display best practices |
| **Screenshot analyzed** | List issues with fix plan |
| **Mockup analyzed** | Design spec extracted, implementation plan |
| **Comparison done** | Diff report with verdict |
| **No image provided** | Ask for image path |

## Notes

- **Claude is multimodal**: It can see and understand images natively — no OCR or preprocessing needed.
- **Resolution matters**: 1024-2048px width is the sweet spot for detail vs token cost.
- **Annotate first**: 30 seconds of annotation saves minutes of back-and-forth.
- **Pair with code**: Always provide the relevant file paths alongside visual context.
- **Dark mode awareness**: Screenshots in dark mode may have different colors than the CSS — note the current theme.

---

Begin visual context analysis now. Parse the mode and provide guidance or analyze the provided image.

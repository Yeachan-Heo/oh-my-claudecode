---
name: visual-verdict
description: Structured visual QA verdict for screenshot-to-reference comparisons
level: 2
---

<Purpose>
Use this skill to compare generated UI screenshots against one or more reference images and return a strict JSON verdict that can drive the next edit iteration.
</Purpose>

<Use_When>
- The task includes visual fidelity requirements (layout, spacing, typography, component styling)
- You have a generated screenshot and at least one reference image
- You need deterministic pass/fail guidance before continuing edits
</Use_When>

<Inputs>
- `reference_images[]` (one or more image paths)
- `generated_screenshot` (current output image)
- Optional: `category_hint` (e.g., `hackernews`, `sns-feed`, `dashboard`)
</Inputs>

<Output_Contract>
Return **JSON only** with this exact shape:

```json
{
  "score": 0,
  "verdict": "revise",
  "category_match": false,
  "differences": ["..."],
  "suggestions": ["..."],
  "reasoning": "short explanation"
}
```

Rules:
- `score`: integer 0-100
- `verdict`: short status (`pass`, `revise`, or `fail`)
- `category_match`: `true` when the generated screenshot matches the intended UI category/style
- `differences[]`: concrete visual mismatches (layout, spacing, typography, colors, hierarchy)
- `suggestions[]`: actionable next edits tied to the differences
- `reasoning`: 1-2 sentence summary

<Threshold_And_Loop>
- Target pass threshold is **90+**.
- If `score < 90`, continue editing and rerun `/oh-my-claudecode:visual-verdict` before any further visual review pass.
- Do **not** treat the visual task as complete until the next screenshot clears the threshold.
</Threshold_And_Loop>

<Debug_Visualization>
When mismatch diagnosis is hard:
1. Keep `$visual-verdict` as the authoritative decision.
2. Use pixel-level diff tooling (pixel diff / pixelmatch overlay) as a **secondary debug aid** to localize hotspots.
3. Convert pixel diff hotspots into concrete `differences[]` and `suggestions[]` updates.
</Debug_Visualization>

<Example>
```json
{
  "score": 87,
  "verdict": "revise",
  "category_match": true,
  "differences": [
    "Top nav spacing is tighter than reference",
    "Primary button uses smaller font weight"
  ],
  "suggestions": [
    "Increase nav item horizontal padding by 4px",
    "Set primary button font-weight to 600"
  ],
  "reasoning": "Core layout matches, but style details still diverge."
}
```
</Example>

Task: {{ARGUMENTS}}

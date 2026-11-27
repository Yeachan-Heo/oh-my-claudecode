---
name: reframe
description: "Teach the expert words for what the user is building: borrow the terms their field and neighboring fields use for the same problem, then rewrite their description with them. For \"name this\", \"what is this called\", or a description that keeps missing the real concept."
aliases: []
metadata:
  credits:
    reframe: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Reframe

A description written around the wrong words keeps producing the wrong
plan, no matter how precise it looks. Reframing swaps the operator's
placeholder words for the terms their field actually uses, so the next
prompt, search, or issue lands in the right part of the literature.

Start from the operator's own files, code and description — not a summary.

## Workflow

1. **Disambiguate first.** If the description could name more than one
   problem, list the two or three it could be — each with the one term
   that names it and the sign that would tell it apart from the others —
   then teach the words for the most likely one and say why you picked it.
2. **Give 8 to 12 terms**, ranked by how much each would change what gets
   built. For each: the word and its meaning in one plain sentence, the
   part of their description it names, one real project, paper or system
   that uses it that way (with a link), and what it lets them ask an
   agent for.
3. **Pick 2 or 3 neighboring fields** that solved the same shape of
   problem under other names. For each: what carries over, where the
   analogy breaks, and which terms come back.
4. **Name what they didn't mention** but should care about.
5. **Rewrite their description** with the new words.

## Rules

- Open every link and confirm it uses the term that way. Cut any citation
  you can't confirm.
- No padding: a term that would not change what gets built is dropped,
  not diluted.

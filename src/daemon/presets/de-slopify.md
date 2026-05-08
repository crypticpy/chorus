You are auditing this repository for **AI-generated code smell** — patterns
that suggest a model wrote the code without enough taste pruning.

Walk the working tree and surface concrete, fixable items. Look for:

- Excessive or rote comments (one-line summary that just paraphrases the next
  line; section banners around trivial blocks; "this function does X" docstrings
  on functions whose name already says X).
- Defensive guards for impossible inputs (null-checks on locals just assigned;
  try/catch around pure arithmetic; "in case of future extension" branches that
  no caller hits).
- Premature abstractions: factories, interfaces, or strategy patterns wrapping
  a single concrete implementation; config objects with one field; "Manager"
  classes with one method.
- Dead code paths kept "for symmetry" (else branches that can't fire, options
  no caller passes, exported symbols nothing imports).
- Boilerplate verbosity: variable renames mid-flow, `const x = y; return x;`,
  unnecessary intermediate types, hand-rolled clones of stdlib helpers.

For each finding, name the file path(s), describe the smell in one sentence,
and rate complexity (low = local cleanup, medium = touches one module's API,
high = ripples across callers). Skip false positives — guards on
network/CMS/SQL boundaries are correct, not slop.

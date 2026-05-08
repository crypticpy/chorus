You are auditing this repository for **monolithic files** that should be
split. Find files where one responsibility has grown into many.

Walk the working tree and look for:

- Files over ~300 source lines (excluding generated code, fixtures, JSON).
  Larger isn't automatically wrong — if every function pulls on the same data
  structure, leave it. Wrong is when the file mixes unrelated concerns.
- Files with multiple distinct exported APIs that don't share state (e.g. a
  parser + a serializer + a validator in one module).
- Files whose imports cluster into separable subgraphs — half the imports
  serve one half of the file and never touch the other half.
- "God" objects/classes: long property lists, methods that operate on
  disjoint subsets of state, comments like `// === Section X ===` separating
  what should be different files.

For each finding, propose a split: which functions/types move to which new
file. Name the file path, the proposed split, and a complexity rating
(low = mechanical extraction, medium = needs an import surface change,
high = touches public API or test layout).

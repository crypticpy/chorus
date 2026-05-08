You are auditing this repository for **engineering hygiene** — the slow
quality drag that doesn't bite today but will.

Walk the working tree and surface fixable items. Look for:

- Dead code: exported symbols nothing imports, internal functions only used by
  other dead functions, commented-out blocks left as historical residue,
  feature flags whose other branch hasn't run in a year.
- Untested critical paths: error branches no test exercises, retry logic with
  no failure-injection test, parsers without negative-case coverage. Don't
  flag every uncovered line — flag paths whose failure would be expensive.
- Missing or weak types: `any`, untyped function parameters, structural types
  that should be branded, return types that lose information (e.g. `string`
  where the call site needs a known union).
- Naming and contract drift: function names that lie about what they return,
  exported types whose shape no longer matches their docstring, parameters
  whose order trips up callers.
- Configuration / env smells: hard-coded URLs, secrets in source, magic
  numbers without a named constant.

For each finding, name file + symbol, describe the issue in one sentence,
and rate complexity (low = rename or type tweak, medium = needs a test or
consumer audit, high = touches public surface).

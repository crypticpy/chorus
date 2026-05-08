You are auditing this repository for **bugs and safety issues** — concrete
defects a careful reviewer would flag in a PR.

Walk the working tree and surface fixable items. Look for:

- Logic bugs: off-by-one, wrong comparison operator, swapped arguments,
  unreachable branches that mask a real case, await-less promises, missing
  return in a non-void function.
- Concurrency hazards: race between two writers, a Promise.all that swallows
  rejections, a setTimeout that captures stale closure state, shared mutable
  state across async boundaries.
- Resource leaks: file handles or sockets opened in one branch and only
  closed in another, AbortControllers never aborted, subscriptions never torn
  down, intervals left running after a component unmounts.
- Input-handling failures at trust boundaries: user/network/CMS data parsed
  without validation, SQL built by string concat, auth checks performed after
  the sensitive op rather than before.
- Error-handling smells: catch blocks that log and continue with bad state,
  thrown strings, errors converted to booleans that lose the cause.

For each finding, name file + line, describe the defect in one sentence, and
rate complexity (low = local fix, medium = changes a function signature,
high = needs a wider redesign).

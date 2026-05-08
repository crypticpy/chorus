You are auditing this repository for **architectural drift** — places where
the layering or module boundaries have eroded.

Walk the working tree and surface fixable items. Look for:

- Layering violations: a UI module reaching into the database, a domain
  module importing from the HTTP transport layer, a "lib" module depending
  on application-specific types.
- Circular or near-circular imports between modules that should sit at
  different levels of abstraction.
- Cross-cutting concerns implemented inconsistently: logging, error
  reporting, retry, auth, feature flags duplicated per call site instead of
  centralised, or centralised with multiple competing implementations.
- Public-API leakage: implementation details exposed through a barrel file,
  internal types re-exported by accident, "private" helpers reachable from
  consumers via a deep import.
- Missing seams: code that mocks an external service inline rather than
  through an injected interface, business logic interleaved with I/O.

For each finding, name the modules involved, describe the boundary that's
being violated in one sentence, and rate complexity (low = move a function,
medium = introduce or extract an interface, high = re-shape module
graph / change public exports).

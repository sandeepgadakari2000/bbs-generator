Single-file HTML output. No build step. No npm deps in the browser bundle.
Engine stays pure: no DOM, no window, requireable in Node, unit-tested.
All detailing constants live in the CODE config object. Never inline a
constant at a call site.
Every computed length must expose its term-by-term derivation string.
Visual language: graphite #14171a, sheet #f6f7f6, rules #b6bcb9,
accent #e07b1e, monospace utility type. No other colours.
Units: mm for detailing, m for schedule lengths, kg for weights,
kN and kNm for forces, N/mm² for stresses. State units on every number.
Never silently clamp or round away a value that fails a check — surface it.

Design output states demand, capacity and the ratio — never a bare verdict.
Every computed capacity exposes its term-by-term derivation string.
Code preconditions are checked and refused, never assumed.
Design constants live in a config object, never inlined at a call site.
Tests cite the worked example they check against, by book and page.

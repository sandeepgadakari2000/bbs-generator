Single-file HTML output. No build step. No npm deps in the browser bundle.
Engine stays pure: no DOM, no window, requireable in Node, unit-tested.
All detailing constants live in the CODE config object. Never inline a
constant at a call site.
Every computed length must expose its term-by-term derivation string.
Visual language: graphite #14171a, sheet #f6f7f6, rules #b6bcb9,
accent #e07b1e, monospace utility type. No other colours.
Units: mm for detailing, m for schedule lengths, kg for weights.
Never silently clamp or round away a value that fails a check — surface it.

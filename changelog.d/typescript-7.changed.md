- **Built with TypeScript 7** (7.0.2, the native compiler), up from 5.9.
  The emitted JavaScript is byte-identical. What the package ships beside it
  changes:
  - seven declaration files (`mcpl/push-coalescer`, `mcpl/references`,
    `mcpl/tool-classes`, `mcpl/transport`, `mcpl/types`,
    `modules/workspace/types` and `tune-out/tools`) write string literal
    types with single quotes, as the source does; the types are the same;
  - source maps: of the 108 `.js.map` files that change, 104 move only
    columns and 4 change line mappings, so a stack trace can land on a
    different column, and rarely a different line; all 56 `.d.ts.map` files
    that change map some declarations to other source lines, which can move
    where go-to-definition lands.

  A consumer on TypeScript 7 whose `types` leaves out `node` gets Node-name
  errors from these declarations and their dependencies'; list `node` in
  `types`, as this package's own `tsconfig.json` now does.

- **Built with TypeScript 7** (7.0.2, the native compiler), up from 5.9.
  From the same source, 7 emits byte-identical JavaScript. What the package
  ships beside it changes:
  - seven declaration files (`mcpl/push-coalescer`, `mcpl/references`,
    `mcpl/tool-classes`, `mcpl/transport`, `mcpl/types`,
    `modules/workspace/types` and `tune-out/tools`) write string literal
    types with single quotes, as the source does; the types are the same;
  - source maps: of the 108 `.js.map` files that change, 104 move only
    columns and 4 change line mappings, so a stack trace can land on a
    different column, and rarely a different line; of the 56 `.d.ts.map`
    files that change, 49 map some declarations to other source lines and
    7 gain or lose a line's mapping, which can move where go-to-definition
    lands;
  - `dist/tsconfig.tsbuildinfo`, the compiler's build record, changes.

  `test/stop-with-work-in-flight.test.ts`, whose build ships in `dist/test`,
  now reads its source with `@babel/parser`, a new devDependency, since
  TypeScript 7's package provides no compiler API there.

  As with 5.9's declarations, a consumer on TypeScript 7 with `skipLibCheck`
  off whose `types` leaves out `node` gets Node-name errors from these
  declarations and their dependencies'. Install `@types/node` and list
  `node` in `types`, as this package's own `tsconfig.json` now does.

- **Built with TypeScript 7**, the native compiler, up from 5.9. Measured
  with 7.0.2 against 5.9.3 on the same source, the emitted JavaScript is
  byte-identical. What the package ships beside it changes:
  - seven declaration files under `dist/src/` (`mcpl/push-coalescer`,
    `mcpl/references`, `mcpl/tool-classes`, `mcpl/transport`, `mcpl/types`,
    `modules/workspace/types` and `tune-out/tools`) write string literal
    types with single quotes, as the source does; the types are the same;
  - source maps: of the 42 `.js.map` files that change, 38 move only
    columns; in two a generated line maps to other source lines, and in two
    a generated line gains or loses its mapping, so a stack trace can land
    on a different column, and rarely on a different line or none. Of the
    54 `.d.ts.map` files that change, 48 map some declarations to other
    source lines and 6 gain or lose a line's mapping, which can move where
    go-to-definition lands.

  `test/stop-with-work-in-flight.test.ts` now parses `src` with
  `@babel/parser`, a new devDependency: the main entry of TypeScript 7's
  package has no compiler API, and its `./unstable/*` entries reach the
  native compiler over IPC.

  As with the same source built with 5.9.3, a consumer on TypeScript 7 with
  `skipLibCheck` off whose `types` leaves out `node` can get Node-name errors
  from this package's declarations and its dependencies', unless its program
  already reaches Node's types. Install `@types/node` and list `node` in
  `types`, as this package's own `tsconfig.json` now does.

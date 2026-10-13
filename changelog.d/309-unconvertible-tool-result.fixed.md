- A module's tool result that JSON can't hold, such as a cyclic object, a
  BigInt or a `toJSON` that throws, is now answered as an error result
  naming the tool wherever the framework stores or sends it: a model's
  call, a script's inner call, the `utils` meta-tool for a model,
  `read_image`, and the pair `puppetToolCall` stores. So is a result that
  isn't a result object (`undefined`, `null`, an array, a string, an `Error`
  returned rather than thrown), a result whose getters or Proxy traps throw
  while it's read, and a non-error result whose data is a function or a
  symbol, which JSON leaves out whole. The error keeps the module's own
  error text and its `endTurn` when they can be read. Before, the first
  code to store, send or trace such a result threw, and the agent's turn
  never settled (#309). Those paths now read a module's result once and use
  its JSON form, so its getters and `toJSON` never run a second time. A
  caller that uses the result in process (`ModuleContext.callTool`,
  `executeToolCall`) still gets the module's own result, and
  `puppetToolCall` still returns it, or the error result where it used to
  reject.
- A module's `error` is sent as text: an `Error`'s message, an object's own
  `message`, any other value's JSON, or a BigInt's or symbol's `String()`.
  One that says nothing (`null`, `false` or empty), and a throw with no
  text, read as "Unknown error", as a missing one does. A result's
  `success`, `isError` and `endTurn` are sent as booleans.
- A tool result with no data is stored as empty text, as an empty content
  array is. Before, storing it threw, and the turn never settled. A
  failure the tool doesn't flag as an error for the model
  (`{ success: false, error, isError: false }`) with no data reads as its
  error text, for the model and for a script.

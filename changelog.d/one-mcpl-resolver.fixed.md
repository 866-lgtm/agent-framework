- A programmatic MCPL tool call, through `executeToolCall` or a module's
  `ctx.callTool`, now reaches the server the model's own call reaches: the
  server whose tools/list produced the name, else the longest matching
  prefix. It took the first configured server whose prefix the name began
  with, so where one prefix begins with another's, such as `foo` beside
  `foo--bar` or beside `foo-`, it could reach the shorter prefix's server,
  depending on the order the servers were configured in (#227, #230).

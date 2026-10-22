- **Script authors (`code_execution`):** a tool's text result now reaches a
  script as that text, in its result's `content[0].text`, where it was the
  text JSON-encoded. That covers every MCP tool whose result is text only,
  and every module tool whose `data` is a string. Drop a `JSON.parse` that
  only unquoted such a result. Where the text is itself JSON, one
  `JSON.parse` now returns the data, so drop the second. Unchanged: an
  object, a number, a boolean, or an array other than an MCP content array
  still arrives as its JSON, and a result with structured content keeps its
  blocks as the tool sent them.

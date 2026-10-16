- A tool result's data that isn't a content array of blocks agent-framework
  recognizes was stored, and sent to the agent, as plain JSON, so an RFC-005
  reference in it carried its raw uri into the agent's context and history.
  That JSON now shows, wherever in the data it sits, each reference as its
  stub (or as an unrecognized-block line when it's invalid), and inline data
  that also claims a uri or a disposition as withheld. A reference is a
  `resource` with a uri, at its top level or under `resource` where MCP
  embeds one, or an `image` or `audio` block given by `uri`. A uri that is
  null or absent counts as none, so a record that only shares one of those
  type names is written as before, as is everything else in the data: inline
  media that claims neither, with its bytes, and a `resource_link`'s fields
  among it. The same text reaches a script that calls the tool, the
  direct Agent API's tool result, and a withheld result's kept fields.
  Results stored before the upgrade keep the text they were stored with, any
  uri in it included, which goes on reaching the model until those results
  leave its context.
- Inline `image` or `audio` data beside a uri that isn't a string, such as
  an object, is withheld as inline data beside a string uri already was, in
  every lane, rather than shown as inline media. An `image` or `audio` block
  with neither string data nor a string uri is now said to have data or a
  uri that isn't a string when it has one, where the unrecognized-block line
  said it had neither.

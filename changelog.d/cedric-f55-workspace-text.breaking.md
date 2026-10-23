- **Scripts, hosts and modules that read the workspace's `read`, `grep`,
  `edit` or `edit_many` results:** each now answers as the text the model
  reads, with its fields beside it in `structured`. The model read each as
  one line of JSON, a page's lines escaped inside it. It now reads a header
  of the result's fields, one `key: value` to a line (`path: …`,
  `totalLines: …`, `nextOffsetChars: null`), then labelled sections: a
  page's `--- content ---`, grep's matches by file and version (`N:` for a
  match, `N-` for a line of its context), what grep skipped, and a receipt's
  `--- files ---` and `--- changed ---`. A value holding a line break, such
  as a path, is written as a JSON string. A control character in a file
  reaches the model as itself, where JSON wrote an escape such as `\u001b`.

  **Who needs to act:**
  - a `code_execution` script that parses one of these results' text as
    JSON (`JSON.parse(result.content[0].text)`): read
    `result.structuredContent`, which holds the fields the JSON held;
  - a host or module that reads these results' fields from `result.data`,
    through `executeToolCall` or `ctx.callTool`: read `result.structured`.
    connectome-host reads either since 0.11.0
    (anima-research/connectome-host#324).

  **What a page holds:** a page is held to the call's result limit as its
  text measures it, where it was measured as JSON, and so is a receipt.
  - A model's page holds more of a file whose lines JSON escapes: at the
    default 24,000 characters, a page of this repository's
    `src/modules/workspace/index.ts` now ends at line 475, where it ended at
    line 454. A spilled result's notice sizes the read-back page it suggests
    the same way, so below a cap of about 2,300 characters it suggests a
    longer one.
  - A script's page is never shorter than before, since a page's text is
    shorter than its JSON. A script's answer carries the fields beside the
    text, which the limit doesn't count. Together they can pass what a
    script takes only on a page of more than about 3.7 million characters
    that holds control characters, which JSON writes as six bytes each where
    no other character takes more than three. Such a page answers
    `ResultTooLarge`, which cuts nothing, and the script reads a smaller
    page.

  **Unchanged:** the tools' descriptions and inputs; the words of their
  notes; their errors, which were text already; the results of `write`,
  `delete`, `ls`, `glob`, `status`, `materialize`, `sync` and the other
  workspace tools, whose fields stay in `data`; and a page for a call made
  in process without a result limit, which holds to its line limit alone.

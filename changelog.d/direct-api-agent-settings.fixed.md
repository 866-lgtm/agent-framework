- **The direct API sends the agent's request settings** (`runInference`,
  `runInferenceWithInjections`). Its requests carried the agent's model config
  and `providerParams`, but not the `promptCaching`, `cacheTtl` or
  `prefillUserMessage` that a framework turn's requests carry, so membrane's
  own defaults applied to them. `promptCaching: false` never reached them,
  and membrane's default, which is on unless its `defaultPromptCaching` says
  otherwise, decided their cache markers. Those markers had no TTL, so the
  provider's default applied. Membrane's formatters got no
  `prefillUserMessage`. One method now builds these fields for both paths.
  - The agent's `promptCaching`, default `true`, now governs direct-API
    requests as it does framework turns, over membrane's
    `defaultPromptCaching`. A host that turned caching off only with
    membrane's `defaultPromptCaching: false` now gets cache markers on its
    direct calls, which fail on a transport that rejects them, such as the
    Bedrock legacy Claude models `promptCaching`'s doc names. Such a host
    sets the agent's `promptCaching: false`, as that doc advises.
  - A direct caller that never set `cacheTtl` now sends the agent's
    documented default, `'1h'`, so its cache writes may now be priced at the
    one-hour rate.
- **`prefillUserMessage`'s doc** said native formatting ignores it. Membrane's
  native formatter uses it as the text of a leading user turn that its
  tool-pair normalizer adds, and the doc now says so.

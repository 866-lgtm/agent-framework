- **The direct API sends the agent's request settings** (`runInference`,
  `runInferenceWithInjections`). Its requests carried the agent's model config
  and `providerParams`, but not the `promptCaching`, `cacheTtl` or
  `prefillUserMessage` that a framework turn's requests carry, so membrane's
  own defaults applied to them. `promptCaching: false` never reached them,
  and membrane's default, which is on unless its `defaultPromptCaching` says
  otherwise, decided their cache markers. Those markers had no TTL, so the
  provider's default applied. Membrane's formatters got no
  `prefillUserMessage`. One method now builds these fields for both paths. A
  direct caller that never set `cacheTtl` now sends the documented default,
  `'1h'`, so its cache writes may now be priced at the one-hour rate.

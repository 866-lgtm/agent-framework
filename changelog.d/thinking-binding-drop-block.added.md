- `thinkingBinding.dropBlock` in an agent's config asks the provider to drop
  a signed thinking block whose earlier conversation has changed, as a fold
  changes it, rather than refuse the request. An account that enforces
  thinking-signature binding answers such a request with a 400; with the
  setting, it drops the blocks that no longer match and answers. Where an
  account doesn't enforce it, the provider decides for itself what to do with
  such a block, and the setting has it drop them too. The setting is off by
  default.
  - **What's sent:** `thinking.block_binding.prefix_mismatch_behavior:
    "drop_block"` with the `thinking-binding-controls-2026-08-01` beta, which
    membrane's Anthropic and Bedrock adapters carry. It has no effect through
    other adapters. A model whose thinking is always on (Fable, Mythos) gets
    an adaptive thinking config to carry it, and any other model carries it
    only while thinking is on.
  - **What's reported:** each call's dropped blocks, and any shown to the
    model though they failed the check, appear in its `inference:usage`
    trace as `thinking`. A call that dropped blocks isn't used to calibrate
    the context strategy's token estimates, since the provider doesn't bill a
    block it dropped and the strategy still counts it.

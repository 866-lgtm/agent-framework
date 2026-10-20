- `tune_out` of a channel whose transport is closed now opens it, so the
  subconscious gets the traffic it was told to watch. Until now it recorded
  the tune-out and answered success, and the channel's traffic didn't arrive
  until its server next registered it. Where the transport doesn't end open,
  the answer is still a success, since the tune-out is recorded, and its new
  `openError` field says why none of the channel's messages reach the
  subconscious yet, and when they will. Where the transport wasn't open, the
  answer now comes after the open's round trip.
- `channel_decline` refuses a channel that's tuned out, whatever its
  transport, and says to cancel the tune-out with `tune_out` mode "cancel",
  which delivers what it diverted. Until now a decline of one whose
  transport wasn't open answered success and ended the tune-out without its
  cancel, so its diverted backlog never reached the agent.

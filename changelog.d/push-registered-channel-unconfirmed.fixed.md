- A channel the host knows only from a push event no longer counts as
  confirmed closed. Its transport is unknown until a receipt for this host's
  own request confirms it, as a registered channel's is: after a restart, the
  server may still hold a channel an earlier process opened.
  - Where this host directs the channel's lifecycle, `channel_decline` sends
    its close through the lifecycle queue. Until now it sent nothing. Its
    answer is still `remained closed`.
  - Where this host directs the channel's lifecycle, `channel_close` of such
    a channel already decided closed, as by a decision kept from before a
    restart, sends the close. Until now it answered `already closed` and sent
    nothing.
  - Where this host isn't permitted to open or close the server's channels, a
    refused close no longer says the channel is closed. It says the close
    didn't go through and stays recorded, as for a registered channel.
  - Where this host directs the channel's lifecycle, the channel's traffic no
    longer shows it open when it's decided open or tuned out. It shows open
    once a receipt for this host's own request confirms it, as a registered
    channel does. Until then it isn't among the open channels, and speech
    into it sends `channels/open` before it publishes.

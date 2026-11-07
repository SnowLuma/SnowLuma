# Receive-path health

Refs #634.

The receive watchdog starts only after QQ exposes its `SsoHeartBeat` packet.
After that, any received packet resets the silence window. Silence alone does
not prove a disconnected QQ session: idle accounts can have irregular heartbeat
intervals. A stale receive path contributes to OneBot `status.good=false`, while
the account can remain online. Check actual message traffic and transport errors
before treating this signal as a hard outage.

Set these environment variables before starting SnowLuma:

| Variable                            | Default | Meaning                                                       |
| ----------------------------------- | ------- | ------------------------------------------------------------- |
| `SNOWLUMA_RECEIVE_STALE_AFTER_MS`   | `90000` | Silence before starting the confirmation window               |
| `SNOWLUMA_RECEIVE_STALE_CONFIRM_MS` | `15000` | Additional silence required before marking the path unhealthy |

Both values must be positive integer milliseconds, at most `2147483647`.
Invalid values warn and fall back to their respective defaults. Values are read
when a process session is created; restart SnowLuma after changing them.

For an idle account, `SNOWLUMA_RECEIVE_STALE_AFTER_MS=600000` and
`SNOWLUMA_RECEIVE_STALE_CONFIRM_MS=15000` allow ten minutes plus fifteen seconds
of silence. Longer windows also delay detection of a genuinely stalled receive
path. Defaults remain unchanged for existing installations.

Stale transitions are logged at DEBUG to avoid repetitive terminal warnings.
Recovery remains at INFO and includes the duration of silence. Changing the
log level does not change health events. Outbound transport failures remain a
separate health signal, and incoming packets do not conceal a broken send path.

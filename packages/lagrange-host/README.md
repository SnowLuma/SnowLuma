# SnowLuma Lagrange protocol host

This component embeds the QQ protocol implementation from
[Lagrange.Core](https://github.com/LagrangeDev/Lagrange.Core) at commit
`9efbb19bc5d168de538c586023529729b920681f`.

Lagrange.Core is provided under GPL-3.0 according to its project documentation.
The host communicates with SnowLuma over newline-delimited JSON and adds a
minimal raw-packet event needed by SnowLuma's existing protocol and OneBot
layers. It does not require the desktop QQ client.

Build for the current or selected release target:

```bash
SNOWLUMA_TARGET=linux-x64 node tools/build-lagrange-host.mjs
```

The build clones the pinned upstream commit into `.cache/`, applies
`lagrange-raw-packet.patch`, and writes the self-contained NativeAOT executable
to `packages/runtime/native/`.

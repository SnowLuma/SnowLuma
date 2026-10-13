# Bundled FFmpeg addon

These binaries are unmodified build artifacts from
[NapNeko/ffmpegAddon](https://github.com/NapNeko/ffmpegAddon) (upstream package license: MIT).

- Source commit: [`9ac944793ffdc2a1c5c55f16e24cb32185feb4ec`](https://github.com/NapNeko/ffmpegAddon/commit/9ac944793ffdc2a1c5c55f16e24cb32185feb4ec)
- Successful build: [38025527136](https://github.com/NapNeko/ffmpegAddon/actions/runs/38025527136)
- Each downloaded artifact archive was verified against its GitHub SHA-256 digest before extraction.

| Bundled file | Upstream artifact | Binary SHA-256 |
| --- | --- | --- |
| `ffmpegAddon.win32.x64.node` | `ffmpeg-addon-windows` | `80a4dfbb170f093f4a64fe241b8583fb630c58219100cad7a3cad798f71864db` |
| `ffmpegAddon.linux.x64.node` | `ffmpeg-addon-linux` | `b75e45ba54d3ba5dbea42ed0cbe13cbcc4a2e38e889272aca272913675ff6402` |
| `ffmpegAddon.linux.arm64.node` | `ffmpeg-addon-linux-arm64` | `92f04767db5cb292a2158d8a7451a07c2cba9b4ba8654b18b7f668991c2c160b` |
| `ffmpegAddon.darwin.arm64.node` | `ffmpeg-addon-macos-arm64` | `c578932c04b40e36b32601a86d3833dbd9892df13bd13dbe9355623da0144cbf` |

`getDuration(path)` supports standard SILK and QQ NTSILK containers, including
files without an extension. It measures the encoded frames and rejects truncated
packets. SnowLuma's existing voice upload path uses this duration when accepting
an already encoded SILK file.

Run `pnpm test:native` from the repository root to exercise the bundled addon on
Windows x64 or Linux x64/arm64. The tests generate synthetic audio and cover
SILK/NTSILK durations, truncated packets, and QQ/QQ AI voice transcoding.

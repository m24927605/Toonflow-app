# Audio and Video Preview

Opens MP4, MP3, WAV, PCM, and Opus in the document page; extensions are case-insensitive. Provides play, pause, progress, and volume controls, and videos support full screen. Playback pauses when the tab is hidden.

MP4, MP3, WAV, and Opus in an Ogg container use the client's native decoding. Unsupported codecs or corrupted files show a playback failure message.

Raw PCM defaults to 24000 Hz, mono, 16-bit little-endian integers. At the top of the preview you can choose the actual sample rate, mono/stereo, 8-bit unsigned or 16/24/32-bit integers, 32-bit float, and byte order. Multichannel data must be interleaved, and the data must contain complete sample frames. Signed and float formats are converted to 16-bit WAV for playback; non-finite float values are treated as silence. The preview converts in memory only and does not rewrite the original file.

```sh
bun run --cwd packages/ext/media typecheck
bun run --cwd packages/ext/media build --mode development
```

Development builds sync to `data/ext/ext-media.umd.js`; production builds output to `build/ext/ext-media.umd.js` and are released through the existing extension packaging flow.

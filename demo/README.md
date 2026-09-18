# Demo asset

`truefact-demo.gif` (embedded in the top-level README) is a two-scene cut, generated
from a real checkout and real CLI output — no vhs, no editor, no LLM.

- **Scene 1 — `checkout.html`**: a checkout page whose `POST /submit` gets a real
  500 (served by `record.mjs`). The ✅ banner shows anyway (the optimistic-UI bug);
  the network panel shows the truth. Recorded with a scripted cursor.
- **Scene 2 — `demo.html`**: a terminal playing the verbatim output of
  `truefact assert checkout.jsonl --with assertions.mjs` (exit 1, 2 failed steps).

`checkout.jsonl` is a recorded optimistic-UI run (agent reported success, server 500'd).

Regenerate:

```bash
node demo/record.mjs        # -> demo/checkout.webm + demo/terminal.webm
ffmpeg -y -i demo/checkout.webm -i demo/terminal.webm -filter_complex \
 "[0:v]scale=1000:640:force_original_aspect_ratio=decrease,pad=1000:640:(ow-iw)/2:(oh-ih)/2:color=0x0b0f17,fps=30,setsar=1[a];\
  [1:v]scale=1000:640:force_original_aspect_ratio=decrease,pad=1000:640:(ow-iw)/2:(oh-ih)/2:color=0x0b0f17,fps=30,setsar=1[b];\
  [a][b]concat=n=2:v=1[v]" -map "[v]" -movflags +faststart -pix_fmt yuv420p demo/truefact.mp4
ffmpeg -y -i demo/truefact.mp4 -vf "fps=15,scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" demo/truefact-demo.gif
```

`*.webm` are regenerable intermediates.

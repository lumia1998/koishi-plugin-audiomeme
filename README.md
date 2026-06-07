# koishi-plugin-audiomeme

Play meme sounds from a bundled JSON database.

## Usage

```text
memeaudio
memeaudio <name>
memeaudio.list [page]
memeaudio.list [keyword]
memeaudio.list [page] [keyword]
```

- `memeaudio` shows the first page of available sounds.
- `memeaudio <name>` downloads and plays a sound.
- `memeaudio.list` shows a paginated list without a wide table.
- `memeaudio.list cat` searches by sound name.

## ChatLuna Tool Calls

This plugin can optionally integrate with `chatluna_character`.

- `enableAudioMemeXmlTool`: enables XML audio meme tool calls in ChatLuna replies.
- `injectAudioMemeXmlToolAsReplyTool`: injects the same XML tool as an experimental reply tool field. When this is available, direct XML action execution is disabled to avoid double playback.

XML examples:

```xml
<audiomeme name="bruh" />
<memeaudio name="vine-boom-sound-effect-full" />
<audio-meme key="cat-laugh-meme-1" />
```

Reply tool field name:

```text
audiomeme_play
```

Reply tool payload example:

```json
[{ "name": "bruh" }]
```

## Build

```bash
npm install
npm run build
```

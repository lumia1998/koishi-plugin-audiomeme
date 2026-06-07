# koishi-plugin-audiomeme

播放内置 JSON 数据库中的 meme 音效，并支持 ChatLuna 工具调用。

## Usage

```text
audiomeme
audiomeme <音效名>
audiomeme list [页码]
audiomeme list [关键词]
audiomeme list [页码] [关键词]
audiomeme random
```

- `audiomeme` 显示第一页可用音效。
- `audiomeme <音效名>` 下载并播放指定音效。
- `audiomeme list` 显示分页列表。
- `audiomeme list cat` 按音效名搜索。
- `audiomeme random` 随机播放一个音效。
- 兼容旧命令：`memeaudio`、`memeaudio.list`、`memeaudio.random`。

## Audio Sending

默认使用“远程链接”模式发送音效，适合 OneBot 等适配器，避免本地 `file://` 缓存路径在机器人端不可见导致 0 秒语音。

如需让 Koishi 先下载音频再发送本地文件，可以在配置中把“音效发送模式”改为“缓存文件”。缓存模式会校验已下载文件，发现空文件、HTML 错误页或无效音频时会自动重新下载。

## ChatLuna Tool Calls

本插件可以选择接入 `chatluna_character`。

- `enableAudioMemeXmlTool`：启用 ChatLuna 回复中的 XML 音效工具调用。
- `injectAudioMemeXmlToolAsReplyTool`：将同一个 XML 音效工具注入实验性“工具调用回复”参数中；可用时会关闭直接 XML 动作执行，避免重复播放。

XML 示例：

```xml
<audiomeme name="bruh" />
<memeaudio name="vine-boom-sound-effect-full" />
<audio-meme key="cat-laugh-meme-1" />
```

Reply tool 字段名：

```text
audiomeme_play
```

Reply tool 参数示例：

```json
[{ "name": "bruh" }]
```

## Build

```bash
npm install
npm run build
```

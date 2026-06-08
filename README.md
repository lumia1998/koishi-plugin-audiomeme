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
- `audiomeme list` 以图片显示全部可用音效，超过每页数量时自动分成多张图片。
- `audiomeme list 2` 只显示第 2 页。
- `audiomeme list cat` 按音效名搜索，并以图片显示搜索结果。
- `audiomeme random` 随机播放一个音效。
- 兼容旧命令：`memeaudio`、`memeaudio.list`、`memeaudio.random`。

列表图片每页最多 50 个音效；如果没有安装 `koishi-plugin-puppeteer`，会自动回退为文本列表。

## Audio Sending

默认使用“缓存发送”模式发送音效：插件会先下载并校验音频文件，保存到本地缓存目录，然后读取缓存文件并以音频数据发送。缓存模式会校验已下载文件，发现空文件、HTML 错误页或无效音频时会自动重新下载。

如果你的 OneBot 实现更适合自行拉取远程资源，也可以在配置中把“音效发送模式”改为“远程链接”，让平台直接拉取音频 URL。

## ChatLuna Tool Calls

本插件可以选择接入 `chatluna_character`。

- `enableAudioMemeXmlTool`：启用 ChatLuna 回复中的 XML 音效工具调用。
- `injectAudioMemeXmlToolAsReplyTool`：将同一个 XML 音效工具注入实验性“工具调用回复”参数中；可用时会关闭直接 XML 动作执行，避免重复播放。
- `audioMemeXmlReferencePrompt`：显示给你复制到角色提示词里的 XML 参考提示词；它不会被插件自动注入。

XML 示例：

```xml
<audiomeme name="bruh" />
<memeaudio name="vine-boom-sound-effect-full" />
<audio-meme key="cat-laugh-meme-1" />
```

配置界面中显示的 XML 参考提示词内容如下：

````text
## 动作指令
你可以根据需要在模型回复中输出一个独立的 <actions> 元素。它用于执行非语言的系统指令。如果不需要播放音效，请省略此元素。
- audiomeme: `<audiomeme name=""/>`
  - name: 音效名称，必须使用 audiomeme list 中存在的名称。
  - 可用别名：`<memeaudio name=""/>`、`<audio-meme key=""/>`。
  - 示例：
    - <audiomeme name="bruh"/> ## 吐槽、无语、被整活时使用
    - <audiomeme name="vine-boom-sound-effect-full"/> ## 强调震惊、揭晓或反转时使用
    - <audiomeme name="cat-laugh-meme-1"/> ## 调侃、轻松嘲笑时使用
  - 要求：
    - 每次只在需要气氛音效时输出。
    - name 必须精确匹配音效名称，不要自行翻译或改写。
    - 音效是回复的补充，不要用音效替代必要的文字回复。

格式示例：
```xml
<actions>
  <audiomeme name="bruh"/>
</actions>
```
````

Reply tool 字段名：

```text
audiomeme_play
```

Reply tool 参数示例：

```json
[{ "name": "bruh" }]
```

开启 `injectAudioMemeXmlToolAsReplyTool` 后，插件注入给 ChatLuna Character 的字段是：

```json
{
  "name": "audiomeme_play",
  "schema": {
    "type": "array",
    "description": "在本次回复之后播放 meme 音效。数组中的每一项代表一个要播放的音效动作。",
    "items": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "要播放的音效名称，必须使用 audiomeme list 中存在的名称，例如 bruh。"
        }
      },
      "required": ["name"]
    }
  }
}
```

这个模式下通常不需要再把完整 XML 参考提示词复制到角色提示词里。

## Build

```bash
npm install
npm run build
```

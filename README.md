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

列表图片每页最多 100 个音效；如果没有安装 `koishi-plugin-puppeteer`，会自动回退为文本列表。

## Audio Sending

默认使用“缓存发送”模式发送音效：插件会先下载并校验音频文件，保存到本地缓存目录，然后读取缓存文件并以音频数据发送。缓存模式会校验已下载文件，发现空文件、HTML 错误页或无效音频时会自动重新下载。

如果你的 OneBot 实现更适合自行拉取远程资源，也可以在配置中把“音效发送模式”改为“远程链接”，让平台直接拉取音频 URL。

## ChatLuna Tool Calls

开启 `enableChatLunaTool` 后，插件会向 ChatLuna 注册原生工具 `audiomeme`。

工具描述会自动从 `meme_sounds.json` 生成完整可用音效列表，格式如下：

```text
名字 | url
bruh | https://www.myinstants.com/media/sounds/movie_1.mp3
cat-laugh-meme-1 | https://www.myinstants.com/media/sounds/cat-laugh-meme-1.mp3
...
```

工具参数：

```json
{
  "url": "https://www.myinstants.com/media/sounds/movie_1.mp3",
  "name": "bruh"
}
```

- `url`：必填，必须从工具描述中的可用音效列表原样选择。
- `name`：可选，对应同一行的音效名称。

ChatLuna 调用工具后，插件会按当前“音效发送模式”发送这条 URL 对应的语音。旧版 XML 回复解析和 Character Reply Tool 字段注入已移除。

## Build

```bash
npm install
npm run build
```

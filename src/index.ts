import { Context, Schema, h } from 'koishi'
import axios from 'axios'
import path from 'path'
import fs from 'fs-extra'
import { installChatlunaAudioMemeTools, type AudioMemeToolCall } from './chatluna'

export const name = 'audiomeme'

export const inject = {
  optional: ['chatluna_character', 'puppeteer'],
}

export interface Config {
  cachePath: string
  cleanupInterval: number
  cacheMaxAge: number
  pageSize: number
  downloadTimeout: number
  sendMode: 'remote' | 'cache'
  enableAudioMemeXmlTool: boolean
  injectAudioMemeXmlToolAsReplyTool: boolean
  audioMemeXmlReferencePrompt: string
}

const sounds: MemeSound[] = require('../meme_sounds.json')
const SOUND_NAMES = sounds.map(sound => sound.name).filter(Boolean)
const AVAILABLE_SOUND_NAMES_TEXT = SOUND_NAMES.join('、') || '当前没有可用音效'

const AUDIO_MEME_XML_REFERENCE_PROMPT = `## 动作指令
你可以根据需要在模型回复中输出一个独立的 <actions> 元素。它用于执行非语言的系统指令。如果不需要播放音效，请省略此元素。
- audiomeme: \`<audiomeme name=""/>\`
  - name: 音效名称，必须使用 audiomeme list 中存在的名称。
  - 当前可用音效名称：${AVAILABLE_SOUND_NAMES_TEXT}
  - 可用别名：\`<memeaudio name=""/>\`、\`<audio-meme key=""/>\`。
  - 示例：
    - <audiomeme name="bruh"/> ## 吐槽、无语、被整活时使用
    - <audiomeme name="vine-boom-sound-effect-full"/> ## 强调震惊、揭晓或反转时使用
    - <audiomeme name="cat-laugh-meme-1"/> ## 调侃、轻松嘲笑时使用
  - 要求：
    - 每次只在需要气氛音效时输出。
    - name 必须精确匹配音效名称，不要自行翻译或改写。
    - 音效是回复的补充，不要用音效替代必要的文字回复。

格式示例：
\`\`\`xml
<actions>
  <audiomeme name="bruh"/>
</actions>
\`\`\``

export const Config: Schema<Config> = Schema.object({
  cachePath: Schema.string().default('cache/audiomeme').description('音频文件缓存目录。'),
  cleanupInterval: Schema.number().default(10 * 60 * 1000).description('缓存清理间隔，单位为毫秒，默认 10 分钟。'),
  cacheMaxAge: Schema.number().default(60 * 60 * 1000).description('缓存文件最长保留时间，单位为毫秒，默认 1 小时。'),
  pageSize: Schema.number().min(5).max(50).default(50).description('列表图片每页显示的音效数量，最多 50 个。'),
  downloadTimeout: Schema.number().min(1000).default(30 * 1000).description('音频下载超时时间，单位为毫秒。'),
  sendMode: Schema.union([
    Schema.const('remote').description('远程链接：直接把音频 URL 交给平台发送，推荐 OneBot 使用。'),
    Schema.const('cache').description('缓存发送：下载到 Koishi 缓存目录后读取为音频数据发送。'),
  ]).role('radio').default('cache').description('音效发送模式。'),
  enableAudioMemeXmlTool: Schema.boolean().default(false).description('是否启用 ChatLuna 回复中的 XML 音效工具调用。'),
  injectAudioMemeXmlToolAsReplyTool: Schema.boolean().default(false).description('是否将 XML 音效工具注入实验性“工具调用回复”参数中。'),
  audioMemeXmlReferencePrompt: Schema.string().role('textarea').default(AUDIO_MEME_XML_REFERENCE_PROMPT).description('模型回复 XML 参考提示词。此内容不会自动注入到角色提示词中；若开启“工具调用回复”注入，则模型会看到 audiomeme_play 参数说明，通常不需要再复制完整 XML 提示词。'),
})

interface MemeSound {
  name: string
  url: string
}

interface ListArgs {
  page: number
  keyword?: string
  explicitPage: boolean
}

interface SoundListPage {
  title: string
  keyword?: string
  totalSounds: number
  totalPages: number
  currentPage: number
  start: number
  sounds: MemeSound[]
}

interface ContextWithOptionalPuppeteer extends Context {
  puppeteer?: {
    render: (content: string) => Promise<string>
  }
}

const MAX_LIST_PAGE_SIZE = 50
const MIN_AUDIO_FILE_SIZE = 1024

function matchSounds(sounds: MemeSound[], keyword?: string) {
  if (!keyword) return sounds

  const normalizedKeyword = keyword.toLowerCase()
  return sounds.filter(sound => sound.name.toLowerCase().includes(normalizedKeyword))
}

function parseListArgs(input?: string): ListArgs {
  const normalizedInput = (input || '').trim()
  if (!normalizedInput) return { page: 1, keyword: undefined, explicitPage: false }

  const [first, ...rest] = normalizedInput.split(/\s+/)
  const page = Number(first)
  if (Number.isInteger(page) && page > 0) {
    return {
      page,
      keyword: rest.join(' ') || undefined,
      explicitPage: true,
    }
  }

  return {
    page: 1,
    keyword: normalizedInput,
    explicitPage: false,
  }
}

function normalizePageSize(pageSize: number) {
  if (!Number.isFinite(pageSize)) return MAX_LIST_PAGE_SIZE
  return Math.min(MAX_LIST_PAGE_SIZE, Math.max(1, Math.floor(pageSize)))
}

function pickRandomSound(sounds: MemeSound[]) {
  return sounds[Math.floor(Math.random() * sounds.length)]
}

function hasAudioMagic(buffer: Buffer) {
  if (buffer.length < 4) return false


  if (buffer.subarray(0, 3).toString('ascii') === 'ID3') return true
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return true
  if (buffer.subarray(0, 4).toString('ascii') === 'OggS') return true
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF') return true
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return true

  return false
}

function isLikelyTextResponse(buffer: Buffer) {
  const head = buffer.subarray(0, Math.min(buffer.length, 64)).toString('utf8').trimStart().toLowerCase()
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('{') || head.startsWith('[')
}

async function validateAudioFile(filePath: string) {
  try {
    const stats = await fs.stat(filePath)
    if (!stats.isFile() || stats.size < MIN_AUDIO_FILE_SIZE) return false

    const buffer = await fs.readFile(filePath)
    const head = buffer.subarray(0, 16)
    return hasAudioMagic(head) && !isLikelyTextResponse(head)
  } catch {
    return false
  }
}

function assertAudioResponse(contentType: string | undefined, data: Buffer) {
  if (data.length < MIN_AUDIO_FILE_SIZE) {
    throw new Error(`downloaded audio is too small: ${data.length} bytes`)
  }

  if (contentType && !/audio|mpeg|octet-stream/i.test(contentType)) {
    throw new Error(`unexpected content type: ${contentType}`)
  }

  if (!hasAudioMagic(data.subarray(0, 16)) || isLikelyTextResponse(data)) {
    throw new Error('downloaded file does not look like an audio file')
  }
}

function createSoundListPage(sounds: MemeSound[], page: number, pageSize: number, keyword?: string): SoundListPage {
  const totalPages = Math.max(1, Math.ceil(sounds.length / pageSize))
  const currentPage = Math.min(Math.max(page, 1), totalPages)
  const start = (currentPage - 1) * pageSize
  const pageSounds = sounds.slice(start, start + pageSize)
  const title = keyword
    ? `匹配 "${keyword}" 的音效 (${sounds.length})`
    : `可用音效 (${sounds.length})`

  return {
    title,
    keyword,
    totalSounds: sounds.length,
    totalPages,
    currentPage,
    start,
    sounds: pageSounds,
  }
}

function formatSoundListPage(page: SoundListPage) {
  const lines = [
    `${page.title} - 第 ${page.currentPage}/${page.totalPages} 页`,
    ...page.sounds.map((sound, index) => `${String(page.start + index + 1).padStart(3, ' ')}. ${sound.name}`),
    '',
    `播放：audiomeme <音效名>`,
    `搜索：audiomeme list <关键词>`,
  ]

  if (page.currentPage < page.totalPages) {
    lines.push(`下一页：audiomeme list ${page.currentPage + 1}${page.keyword ? ` ${page.keyword}` : ''}`)
  } else {
    lines.push('已经是最后一页。')
  }

  return lines.join('\n')
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildSoundListHtml(page: SoundListPage) {
  const width = 1160
  const items = page.sounds
    .map((sound, index) => {
      const number = page.start + index + 1
      return `<div class="sound-item"><div class="sound-index">${number}</div><div class="sound-name">${escapeHtml(sound.name)}</div></div>`
    })
    .join('')

  const keyword = page.keyword ? `<div class="filter">搜索：${escapeHtml(page.keyword)}</div>` : ''
  const subtitle = `${page.totalSounds} 个音效 · 第 ${page.currentPage}/${page.totalPages} 页 · 每页最多 ${MAX_LIST_PAGE_SIZE} 个`
  const footer = page.currentPage < page.totalPages
    ? `下一页：audiomeme list ${page.currentPage + 1}${page.keyword ? ` ${page.keyword}` : ''}`
    : '播放：audiomeme <音效名> · 随机：audiomeme random'

  return `<!doctype html><html><head><meta charset="utf-8"/><style>body{margin:0;background:#eef2f6;font-family:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Segoe UI",Arial,sans-serif;color:#1f2937;}#list{width:${width}px;box-sizing:border-box;padding:34px 40px 38px;background:#eef2f6;}.panel{background:#ffffff;border:1px solid #d7dee9;border-radius:8px;overflow:hidden;box-shadow:0 10px 28px rgba(15,23,42,.08);}.header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;padding:26px 30px 22px;border-bottom:1px solid #d7dee9;background:#f8fafc;}.title{font-size:34px;line-height:1.25;font-weight:800;color:#111827;letter-spacing:0;}.subtitle{margin-top:8px;font-size:18px;line-height:1.45;color:#64748b;letter-spacing:0;}.filter{flex:0 0 auto;max-width:380px;padding:10px 14px;border:1px solid #cbd5e1;border-radius:8px;background:#ffffff;color:#475569;font-size:17px;line-height:1.45;word-break:break-word;overflow-wrap:anywhere;}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 14px;padding:24px 30px 28px;}.sound-item{display:grid;grid-template-columns:54px minmax(0,1fr);align-items:center;min-height:52px;border:1px solid #dbe3ee;border-radius:8px;background:#ffffff;overflow:hidden;}.sound-index{height:100%;display:flex;align-items:center;justify-content:center;background:#0f766e;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0;}.sound-name{padding:10px 14px;font-size:20px;line-height:1.35;font-weight:650;color:#263244;letter-spacing:0;word-break:break-word;overflow-wrap:anywhere;}.sound-item:nth-child(4n+2) .sound-index,.sound-item:nth-child(4n+3) .sound-index{background:#4f46e5;}.footer{padding:18px 30px 22px;border-top:1px solid #d7dee9;background:#f8fafc;color:#475569;font-size:18px;line-height:1.45;letter-spacing:0;word-break:break-word;overflow-wrap:anywhere;}</style></head><body><div id="list"><div class="panel"><div class="header"><div><div class="title">${escapeHtml(page.title)}</div><div class="subtitle">${escapeHtml(subtitle)}</div></div>${keyword}</div><div class="grid">${items}</div><div class="footer">${escapeHtml(footer)}</div></div></div></body></html>`
}

async function renderSoundListPage(ctx: Context, logger: ReturnType<Context['logger']>, page: SoundListPage) {
  const fallback = formatSoundListPage(page)
  const puppeteer = (ctx as ContextWithOptionalPuppeteer).puppeteer
  if (!puppeteer) return fallback

  try {
    return await puppeteer.render(buildSoundListHtml(page)) || fallback
  } catch (error) {
    logger.warn('audiomeme list image render failed, fallback to text: %s', String(error))
    return fallback
  }
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('audiomeme')
  const soundsByName = new Map(sounds.map(sound => [sound.name.toLowerCase(), sound]))
  const lastAccess = new Map<string, number>()
  const cacheDir = path.resolve(ctx.baseDir, config.cachePath)

  fs.ensureDirSync(cacheDir)

  const playSound = async (name: string) => {
    const sound = soundsByName.get(name.toLowerCase())
    if (!sound) {
      const suggestions = matchSounds(sounds, name).slice(0, 5).map(s => s.name)
      return suggestions.length
        ? [`未找到音效：${name}`, '你可能想找：', ...suggestions.map(s => `- ${s}`)].join('\n')
        : `未找到音效：${name}`
    }

    if (config.sendMode === 'remote') {
      return h.audio(sound.url)
    }

    const fileName = `${encodeURIComponent(sound.name)}.mp3`
    const filePath = path.join(cacheDir, fileName)
    const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`

    try {
      if (!await validateAudioFile(filePath)) {
        await fs.unlink(filePath).catch(() => {})

        const response = await axios.get(sound.url, {
          responseType: 'arraybuffer',
          timeout: config.downloadTimeout,
        })
        const data = Buffer.from(response.data)
        const contentType = response.headers['content-type']
        assertAudioResponse(typeof contentType === 'string' ? contentType : undefined, data)

        await fs.writeFile(tempFilePath, data)
        if (!await validateAudioFile(tempFilePath)) {
          throw new Error('downloaded audio failed validation')
        }
        await fs.move(tempFilePath, filePath, { overwrite: true })
      }

      lastAccess.set(fileName, Date.now())
      const buffer = await fs.readFile(filePath)
      return h.audio(buffer, 'audio/mpeg')
    } catch (error) {
      await fs.unlink(tempFilePath).catch(() => {})
      logger.error(error)
      return '下载或播放音效失败。'
    }
  }

  const playRandomSound = async () => {
    const sound = pickRandomSound(sounds)
    if (!sound) return '当前没有可用音效。'
    return playSound(sound.name)
  }

  const listSounds = async (input?: string, renderAllPages = true) => {
    const { page, keyword, explicitPage } = parseListArgs(input)
    const matchedSounds = matchSounds(sounds, keyword)
    const pageSize = normalizePageSize(config.pageSize)

    if (!matchedSounds.length) {
      return `没有找到匹配 "${keyword}" 的音效。`
    }

    const totalPages = Math.max(1, Math.ceil(matchedSounds.length / pageSize))
    const pages = renderAllPages && !explicitPage
      ? Array.from({ length: totalPages }, (_, index) => index + 1)
      : [page]
    const renderedPages = []

    for (const pageNumber of pages) {
      const soundListPage = createSoundListPage(matchedSounds, pageNumber, pageSize, keyword)
      renderedPages.push(await renderSoundListPage(ctx, logger, soundListPage))
    }

    return renderedPages.join('\n')
  }

  ctx.command('audiomeme [action:text]', '播放或查看音效 meme')
    .alias('memeaudio')
    .action(async ({ session }, action) => {
      const normalizedAction = (action || '').trim()
      if (!normalizedAction) return listSounds(undefined, false)

      const [command, ...rest] = normalizedAction.split(/\s+/)
      const commandArgs = rest.join(' ')

      if (command === 'list') return listSounds(commandArgs, true)
      if (command === 'random') return playRandomSound()

      return playSound(normalizedAction)
    })

  ctx.command('audiomeme.list [query:text]', '查看音效 meme 列表')
    .alias('memeaudio.list')
    .action(({ session }, query) => {
      return listSounds(query, true)
    })

  ctx.command('audiomeme.random', '随机播放音效 meme')
    .alias('memeaudio.random')
    .action(async () => {
      return playRandomSound()
    })

  installChatlunaAudioMemeTools({
    ctx,
    config,
    logger,
    soundNames: SOUND_NAMES,
    async executeToolCall(_session, toolCall: AudioMemeToolCall) {
      const result = await playSound(toolCall.name)
      return {
        soundName: toolCall.name,
        result,
      }
    },
  })

  ctx.setInterval(async () => {
    const now = Date.now()
    const files = await fs.readdir(cacheDir)

    for (const file of files) {
      const accessTime = lastAccess.get(file)

      // If we have an access time and it's too old, OR if we don't have an access time
      // (meaning it was probably from a previous session and hasn't been used),
      // check the file stats as a fallback or just delete it if it's old enough.

      let shouldDelete = false
      if (accessTime) {
        if (now - accessTime > config.cacheMaxAge) {
          shouldDelete = true
        }
      } else {
        // Fallback to file mtime if not in lastAccess map
        try {
          const stats = await fs.stat(path.join(cacheDir, file))
          if (now - stats.mtimeMs > config.cacheMaxAge) {
            shouldDelete = true
          }
        } catch (e) {
          // Ignore errors
        }
      }

      if (shouldDelete) {
        await fs.unlink(path.join(cacheDir, file)).catch(() => {})
        lastAccess.delete(file)
      }
    }
  }, config.cleanupInterval)
}

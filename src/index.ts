import { Context, Schema, h } from 'koishi'
import axios from 'axios'
import path from 'path'
import fs from 'fs-extra'
import { pathToFileURL } from 'url'
import { installChatlunaAudioMemeTools, type AudioMemeToolCall } from './chatluna'

export const name = 'audiomeme'

export const inject = {
  optional: ['chatluna_character'],
}

export interface Config {
  cachePath: string
  cleanupInterval: number
  cacheMaxAge: number
  pageSize: number
  downloadTimeout: number
  enableAudioMemeXmlTool: boolean
  injectAudioMemeXmlToolAsReplyTool: boolean
}

export const Config: Schema<Config> = Schema.object({
  cachePath: Schema.string().default('cache/audiomeme').description('音频文件缓存目录。'),
  cleanupInterval: Schema.number().default(10 * 60 * 1000).description('缓存清理间隔，单位为毫秒，默认 10 分钟。'),
  cacheMaxAge: Schema.number().default(60 * 60 * 1000).description('缓存文件最长保留时间，单位为毫秒，默认 1 小时。'),
  pageSize: Schema.number().min(5).max(50).default(20).description('列表每页显示的音效数量。'),
  downloadTimeout: Schema.number().min(1000).default(30 * 1000).description('音频下载超时时间，单位为毫秒。'),
  enableAudioMemeXmlTool: Schema.boolean().default(false).description('是否启用 ChatLuna 回复中的 XML 音效工具调用。'),
  injectAudioMemeXmlToolAsReplyTool: Schema.boolean().default(false).description('是否将 XML 音效工具注入实验性“工具调用回复”参数中。'),
})

interface MemeSound {
  name: string
  url: string
}

function matchSounds(sounds: MemeSound[], keyword?: string) {
  if (!keyword) return sounds

  const normalizedKeyword = keyword.toLowerCase()
  return sounds.filter(sound => sound.name.toLowerCase().includes(normalizedKeyword))
}

function parseListArgs(input?: string) {
  const normalizedInput = (input || '').trim()
  if (!normalizedInput) return { page: 1, keyword: undefined as string | undefined }

  const [first, ...rest] = normalizedInput.split(/\s+/)
  const page = Number(first)
  if (Number.isInteger(page) && page > 0) {
    return {
      page,
      keyword: rest.join(' ') || undefined,
    }
  }

  return {
    page: 1,
    keyword: normalizedInput,
  }
}

function pickRandomSound(sounds: MemeSound[]) {
  return sounds[Math.floor(Math.random() * sounds.length)]
}

function formatSoundList(sounds: MemeSound[], page: number, pageSize: number, keyword?: string) {
  const totalPages = Math.max(1, Math.ceil(sounds.length / pageSize))
  const currentPage = Math.min(Math.max(page, 1), totalPages)
  const start = (currentPage - 1) * pageSize
  const pageSounds = sounds.slice(start, start + pageSize)
  const title = keyword
    ? `匹配 "${keyword}" 的音效 (${sounds.length})`
    : `可用音效 (${sounds.length})`

  if (!sounds.length) {
    return `没有找到匹配 "${keyword}" 的音效。`
  }

  return [
    `${title} - 第 ${currentPage}/${totalPages} 页`,
    ...pageSounds.map((sound, index) => `${String(start + index + 1).padStart(3, ' ')}. ${sound.name}`),
    '',
    `播放：audiomeme <音效名>`,
    `搜索：audiomeme list <关键词>`,
    currentPage < totalPages
      ? `下一页：audiomeme list ${currentPage + 1}${keyword ? ` ${keyword}` : ''}`
      : '已经是最后一页。',
  ].join('\n')
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('audiomeme')
  const sounds: MemeSound[] = require('../meme_sounds.json')
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

    const fileName = `${encodeURIComponent(sound.name)}.mp3`
    const filePath = path.join(cacheDir, fileName)

    try {
      if (!await fs.pathExists(filePath)) {
        const response = await axios.get(sound.url, {
          responseType: 'arraybuffer',
          timeout: config.downloadTimeout,
        })
        await fs.writeFile(filePath, response.data)
      }

      lastAccess.set(fileName, Date.now())
      return h.audio(pathToFileURL(filePath).href)
    } catch (error) {
      logger.error(error)
      return '下载或播放音效失败。'
    }
  }

  const playRandomSound = async () => {
    const sound = pickRandomSound(sounds)
    if (!sound) return '当前没有可用音效。'
    return playSound(sound.name)
  }

  const listSounds = (input?: string) => {
    const { page, keyword } = parseListArgs(input)
    const matchedSounds = matchSounds(sounds, keyword)

    return formatSoundList(matchedSounds, page, config.pageSize, keyword)
  }

  ctx.command('audiomeme [action:text]', '播放或查看音效 meme')
    .alias('memeaudio')
    .action(async ({ session }, action) => {
      const normalizedAction = (action || '').trim()
      if (!normalizedAction) return listSounds()

      const [command, ...rest] = normalizedAction.split(/\s+/)
      const commandArgs = rest.join(' ')

      if (command === 'list') return listSounds(commandArgs)
      if (command === 'random') return playRandomSound()

      return playSound(normalizedAction)
    })

  ctx.command('audiomeme.list [query:text]', '查看音效 meme 列表')
    .alias('memeaudio.list')
    .action(({ session }, query) => {
      return listSounds(query)
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

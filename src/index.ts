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
  cachePath: Schema.string().default('cache/audiomeme').description('Cache directory for audio files.'),
  cleanupInterval: Schema.number().default(10 * 60 * 1000).description('Cleanup interval in milliseconds (default 10 minutes).'),
  cacheMaxAge: Schema.number().default(60 * 60 * 1000).description('Maximum age for cached files in milliseconds (default 1 hour).'),
  pageSize: Schema.number().min(5).max(50).default(20).description('Number of meme sounds shown per list page.'),
  downloadTimeout: Schema.number().min(1000).default(30 * 1000).description('Download timeout in milliseconds.'),
  enableAudioMemeXmlTool: Schema.boolean().default(false).description('Enable XML audio meme tool calls from ChatLuna replies.'),
  injectAudioMemeXmlToolAsReplyTool: Schema.boolean().default(false).description('Inject the XML tool as an experimental ChatLuna reply tool field.'),
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

function formatSoundList(sounds: MemeSound[], page: number, pageSize: number, keyword?: string) {
  const totalPages = Math.max(1, Math.ceil(sounds.length / pageSize))
  const currentPage = Math.min(Math.max(page, 1), totalPages)
  const start = (currentPage - 1) * pageSize
  const pageSounds = sounds.slice(start, start + pageSize)
  const title = keyword
    ? `Meme sounds matching "${keyword}" (${sounds.length})`
    : `Meme sounds (${sounds.length})`

  if (!sounds.length) {
    return `No meme sounds found for "${keyword}".`
  }

  return [
    `${title} - page ${currentPage}/${totalPages}`,
    ...pageSounds.map((sound, index) => `${String(start + index + 1).padStart(3, ' ')}. ${sound.name}`),
    '',
    `Play: memeaudio <name>`,
    `Search: memeaudio.list <keyword>`,
    currentPage < totalPages
      ? `Next: memeaudio.list ${currentPage + 1}${keyword ? ` ${keyword}` : ''}`
      : 'End of results.',
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
        ? [`Meme sound not found: ${name}`, 'Maybe you meant:', ...suggestions.map(s => `- ${s}`)].join('\n')
        : `Meme sound not found: ${name}`
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
      return 'Failed to download or play meme sound.'
    }
  }

  ctx.command('memeaudio <name:string>', 'Play a meme sound')
    .action(async ({ session }, name) => {
      if (!name) return formatSoundList(sounds, 1, config.pageSize)

      return playSound(name)
    })

  ctx.command('memeaudio.list [pageOrKeyword:string] [keyword:text]', 'List meme sounds')
    .action(({ session }, pageOrKeyword, keyword) => {
      const page = Number(pageOrKeyword)
      const hasPage = Number.isInteger(page) && page > 0
      const searchKeyword = hasPage ? keyword : [pageOrKeyword, keyword].filter(Boolean).join(' ')
      const matchedSounds = matchSounds(sounds, searchKeyword)

      return formatSoundList(matchedSounds, hasPage ? page : 1, config.pageSize, searchKeyword)
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

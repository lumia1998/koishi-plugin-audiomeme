import type { Context, Fragment, Session } from 'koishi'
import { tool, type StructuredTool, type ToolRunnableConfig } from '@langchain/core/tools'

export interface AudioMemeSound {
  name: string
  url: string
}

export interface AudioMemeToolConfig {
  enableChatLunaTool: boolean
}

export interface InstallChatlunaAudioMemeToolOptions {
  ctx: Context
  config: AudioMemeToolConfig
  logger: ReturnType<Context['logger']>
  sounds: AudioMemeSound[]
  playSound: (sound: AudioMemeSound) => Promise<Fragment | string>
}

interface ChatlunaToolMeta {
  source: 'extension'
  group: string
  tags: string[]
  defaultAvailability: {
    enabled: true
    main: true
    chatluna: true
    characterScope: 'all'
  }
}

interface ChatlunaToolRegistration {
  selector: () => boolean
  authorization?: (session: Session) => boolean
  description: string
  createTool: () => StructuredTool
  meta: ChatlunaToolMeta
}

interface ChatlunaPlatformLike {
  registerTool?: (name: string, tool: ChatlunaToolRegistration) => (() => void) | void
}

interface ContextWithChatluna extends Context {
  chatluna?: {
    platform?: ChatlunaPlatformLike
  }
}

interface AudioMemeToolRunnableConfig extends ToolRunnableConfig {
  configurable?: ToolRunnableConfig['configurable'] & {
    session?: Session
  }
}

const AUDIO_MEME_TOOL_NAME = 'audiomeme'

const AudioMemeToolSchema = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      description: '必须从工具描述的可用音效列表中选择下载地址，并原样传入。',
    },
    name: {
      type: 'string',
      description: '可选，对应的音效名称，必须与同一行的名字一致。',
    },
  },
  required: ['url'],
} as const

type AudioMemeToolInput = {
  url?: unknown
  name?: unknown
}

type CreateStructuredTool = (
  func: (input: AudioMemeToolInput, runConfig?: ToolRunnableConfig) => Promise<string>,
  fields: {
    name: string
    description: string
    schema: typeof AudioMemeToolSchema
  },
) => StructuredTool

const createStructuredTool = tool as unknown as CreateStructuredTool

function normalizeText(value: unknown) {
  return String(value ?? '').trim()
}

function normalizeName(value: unknown) {
  return normalizeText(value).toLowerCase()
}

function normalizeSound(sound: AudioMemeSound): AudioMemeSound | null {
  const name = normalizeText(sound.name)
  const url = normalizeText(sound.url)
  if (!name || !url) return null
  return { name, url }
}

function normalizeSounds(sounds: readonly AudioMemeSound[]) {
  const normalizedSounds: AudioMemeSound[] = []
  const seenNames = new Set<string>()
  const seenUrls = new Set<string>()

  for (const sound of sounds) {
    const normalizedSound = normalizeSound(sound)
    if (!normalizedSound) continue

    const nameSignature = normalizeName(normalizedSound.name)
    const urlSignature = normalizedSound.url
    if (seenNames.has(nameSignature) || seenUrls.has(urlSignature)) continue

    seenNames.add(nameSignature)
    seenUrls.add(urlSignature)
    normalizedSounds.push(normalizedSound)
  }

  return normalizedSounds
}

function createSoundIndexes(sounds: readonly AudioMemeSound[]) {
  const soundsByName = new Map<string, AudioMemeSound>()
  const soundsByUrl = new Map<string, AudioMemeSound>()

  for (const sound of normalizeSounds(sounds)) {
    soundsByName.set(normalizeName(sound.name), sound)
    soundsByUrl.set(sound.url, sound)
  }

  return { soundsByName, soundsByUrl }
}

export function createAudioMemeToolDescription(sounds: readonly AudioMemeSound[]) {
  const rows = normalizeSounds(sounds).map(sound => `${sound.name} | ${sound.url}`)
  const list = rows.length ? rows.join('\n') : '当前没有可用音效 | '

  return [
    '播放一个 meme 音效。你可以根据当前对话的语境、情绪或场景，自主且智能地选择最合适的音效进行播放，以增强你的表达能力和趣味性。',
    '调用时必须从下面的可用音效列表中选择，并将所选行的 url 原样传入 url 参数；切勿自行编造列表中不存在的 URL。',
    '',
    '名字 | url',
    list,
  ].join('\n')
}

function createAudioMemeToolMeta(): ChatlunaToolMeta {
  return {
    source: 'extension',
    group: 'audiomeme',
    tags: ['audiomeme', 'audio', 'meme'],
    defaultAvailability: {
      enabled: true,
      main: true,
      chatluna: true,
      characterScope: 'all',
    },
  }
}

function resolveChatlunaPlatform(ctx: Context): ChatlunaPlatformLike | undefined {
  return (ctx as ContextWithChatluna).chatluna?.platform
}

function resolveSession(runConfig: ToolRunnableConfig | undefined): Session | undefined {
  return (runConfig as AudioMemeToolRunnableConfig | undefined)?.configurable?.session
}

function findSound(input: AudioMemeToolInput, indexes: ReturnType<typeof createSoundIndexes>) {
  const { soundsByName, soundsByUrl } = indexes
  const url = normalizeText(input.url)
  const name = normalizeText(input.name)

  if (url) return soundsByUrl.get(url) ?? null
  if (name) return soundsByName.get(normalizeName(name)) ?? null
  return null
}

function createAudioMemeTool(options: InstallChatlunaAudioMemeToolOptions) {
  const { logger, sounds, playSound } = options
  const description = createAudioMemeToolDescription(sounds)
  const indexes = createSoundIndexes(sounds)

  return createStructuredTool(
    async (input: AudioMemeToolInput, runConfig?: ToolRunnableConfig) => {
      const sound = findSound(input, indexes)
      if (!sound) {
        return '未找到音效。url 必须从 audiomeme 工具描述的可用音效列表中原样选择。'
      }

      const session = resolveSession(runConfig)
      if (!session) {
        return `已匹配音效：${sound.name}\nurl: ${sound.url}\n当前工具调用没有可用会话，无法发送语音。`
      }

      try {
        const result = await playSound(sound)
        await session.send(result)
        logger.info('audiomeme=%s, user=%s, guild=%s', sound.name, session.userId, session.guildId)
        return `已发送音效：${sound.name}\nurl: ${sound.url}`
      } catch (error) {
        logger.warn('ChatLuna audiomeme tool failed: %s', String(error))
        return `发送音效失败：${sound.name}`
      }
    },
    {
      name: AUDIO_MEME_TOOL_NAME,
      description,
      schema: AudioMemeToolSchema,
    },
  )
}

export function installChatlunaAudioMemeTool(options: InstallChatlunaAudioMemeToolOptions): void {
  const { ctx, config, logger, sounds } = options
  const description = createAudioMemeToolDescription(sounds)
  let disposeTool: (() => void) | null = null
  let registeredPlatform: ChatlunaPlatformLike | null = null
  let warnedMissingService = false

  const disposeCurrentTool = () => {
    disposeTool?.()
    disposeTool = null
    registeredPlatform = null
  }

  const register = (bindCtx: Context) => {
    if (!config.enableChatLunaTool) {
      disposeCurrentTool()
      return
    }

    const platform = resolveChatlunaPlatform(bindCtx)
    if (!platform?.registerTool) {
      if (!warnedMissingService) {
        warnedMissingService = true
        logger.warn('ChatLuna service is unavailable, skip registering audiomeme tool')
      }
      return
    }

    if (registeredPlatform === platform && disposeTool) return

    disposeCurrentTool()
    const audioMemeTool = createAudioMemeTool(options)
    const dispose = platform.registerTool(AUDIO_MEME_TOOL_NAME, {
      description,
      selector: () => Boolean(config.enableChatLunaTool),
      authorization: () => true,
      meta: createAudioMemeToolMeta(),
      createTool: () => audioMemeTool,
    })

    disposeTool = typeof dispose === 'function' ? dispose : () => {}
    registeredPlatform = platform
    logger.info('registered ChatLuna native tool: %s', AUDIO_MEME_TOOL_NAME)
  }

  ctx.on('ready', () => register(ctx))

  if (typeof (ctx as Context & { inject?: unknown }).inject === 'function') {
    ;(ctx as Context & { inject: (deps: string[], callback: (innerCtx: Context) => void) => void })
      .inject(['chatluna'], (innerCtx) => {
        register(innerCtx)
        innerCtx.on('dispose', () => {
          if (resolveChatlunaPlatform(innerCtx) === registeredPlatform) {
            disposeCurrentTool()
          }
        })
      })
  }

  ctx.on('dispose', disposeCurrentTool)
}

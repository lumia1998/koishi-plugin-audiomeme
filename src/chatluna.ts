import type { Context, Fragment, Session } from 'koishi'

export interface AudioMemeToolCall {
  name: string
}

export type AudioMemeToolResult = Fragment

export interface AudioMemeToolPayload {
  soundName: string
  result: AudioMemeToolResult
}

export interface AudioMemeToolConfig {
  enableAudioMemeXmlTool: boolean
  injectAudioMemeXmlToolAsReplyTool: boolean
}

export interface InstallChatlunaAudioMemeToolsOptions {
  ctx: Context
  config: AudioMemeToolConfig
  logger: ReturnType<Context['logger']>
  executeToolCall: (session: Session, toolCall: AudioMemeToolCall) => Promise<AudioMemeToolPayload | null>
}

interface AssistantMessageLike {
  _getType?: () => unknown
  type?: unknown
  role?: unknown
  content?: unknown
  text?: unknown
}

interface ChatlunaTempLike {
  completionMessages?: unknown[]
}

interface CharacterReplyToolField {
  name: string
  schema: Record<string, unknown>
  isAvailable?: (ctx: Context, session: Session, config: unknown) => boolean
  invoke?: (ctx: Context, session: Session, value: unknown, config: unknown) => Promise<void> | void
  render?: (ctx: Context, session: Session, value: unknown, config: unknown) => string | string[] | undefined
}

interface ChatlunaCharacterServiceLike {
  getTemp?: (...args: unknown[]) => Promise<ChatlunaTempLike | undefined> | ChatlunaTempLike | undefined
  registerReplyToolField?: (field: CharacterReplyToolField) => () => void
}

interface ContextWithChatlunaCharacter extends Context {
  chatluna_character?: ChatlunaCharacterServiceLike
}

interface MessageSubscription {
  originalPush: (...items: unknown[]) => number
  patchedPush: (...items: unknown[]) => number
}

const TOOL_TAG_PATTERN = /<(audiomeme|memeaudio|audio[_-]?meme)\s+([^>]*?)\s*\/?>(?:\s*<\/\1>)?/gi
const XML_ATTRIBUTE_PATTERN = /([a-zA-Z_][\w:-]*)\s*=\s*"([^"]*)"/g
const XML_ATTR_WITHOUT_EQUALS_PATTERN = /(?:^|\s)([a-zA-Z_][\w:-]*)\s*"([^"]*)"/g
const SUPPORTED_ATTRIBUTES = new Set(['name', 'key', 'sound'])
const TOOL_NAMESPACE = 'koishi-plugin-audiomeme'

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function normalizeToolValue(value: unknown): string {
  return String(value ?? '').trim()
}

function normalizeToolName(value: unknown): string {
  return unescapeXml(normalizeToolValue(value))
}

function escapeXmlAttr(value: unknown): string {
  return normalizeToolValue(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function parseAttributes(rawAttributes: string): Map<string, string> {
  const attributes = new Map<string, string>()

  for (const match of rawAttributes.matchAll(XML_ATTRIBUTE_PATTERN)) {
    const attributeName = normalizeToolValue(match[1]).toLowerCase()
    if (!attributeName) continue
    attributes.set(attributeName, String(match[2] ?? ''))
  }

  for (const match of rawAttributes.matchAll(XML_ATTR_WITHOUT_EQUALS_PATTERN)) {
    const attributeName = normalizeToolValue(match[1]).toLowerCase()
    if (!attributeName || attributes.has(attributeName)) continue
    attributes.set(attributeName, String(match[2] ?? ''))
  }

  return attributes
}

function hasUnsupportedAttributes(attributes: Map<string, string>): boolean {
  for (const attributeName of attributes.keys()) {
    if (!SUPPORTED_ATTRIBUTES.has(attributeName)) return true
  }
  return false
}

export function extractXmlAudioMemeToolCalls(content: string): AudioMemeToolCall[] {
  if (!content) return []

  const toolCalls: AudioMemeToolCall[] = []
  const seenNames = new Set<string>()

  for (const match of content.matchAll(TOOL_TAG_PATTERN)) {
    const attributes = parseAttributes(String(match[2] ?? ''))
    if (hasUnsupportedAttributes(attributes)) continue

    const soundName = normalizeToolName(
      attributes.get('name') ?? attributes.get('key') ?? attributes.get('sound') ?? '',
    )
    if (!soundName) continue

    const signature = soundName.toLowerCase()
    if (seenNames.has(signature)) continue

    seenNames.add(signature)
    toolCalls.push({ name: soundName })
  }

  return toolCalls
}

function getMessageType(message: AssistantMessageLike | null | undefined): string {
  if (!message) return ''
  if (typeof message._getType === 'function') {
    return normalizeToolValue(message._getType()).toLowerCase()
  }
  return normalizeToolValue(message.type || message.role).toLowerCase()
}

function isAssistantMessage(message: AssistantMessageLike | null | undefined): boolean {
  const messageType = getMessageType(message)
  return messageType === 'assistant' || messageType === 'ai'
}

function extractTextContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (Array.isArray(value)) {
    return value.map(item => extractTextContent(item)).join('')
  }
  if (typeof value !== 'object') return ''

  const record = value as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  if (record.content !== undefined && record.content !== value) {
    return extractTextContent(record.content)
  }
  if (Array.isArray(record.children)) {
    return extractTextContent(record.children)
  }
  if (record.attrs && typeof record.attrs === 'object') {
    const attrs = record.attrs as Record<string, unknown>
    if (typeof attrs.content === 'string') return attrs.content
    if (typeof attrs.text === 'string') return attrs.text
  }
  return ''
}

function extractAssistantText(message: AssistantMessageLike | null | undefined): string {
  if (!isAssistantMessage(message)) return ''
  if (!message) return ''
  return extractTextContent(message.content ?? message.text).trim()
}

function resolveSession(args: unknown[]): Session | null {
  const firstArg = args[0]
  return firstArg && typeof firstArg === 'object' ? firstArg as Session : null
}

function resolveCharacterService(ctx: Context): ChatlunaCharacterServiceLike | undefined {
  return (ctx as ContextWithChatlunaCharacter).chatluna_character
}

function parseReplyToolAction(value: unknown): AudioMemeToolCall | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const action = value as Record<string, unknown>
  const soundName = normalizeToolName(action.name ?? action.key ?? action.sound)
  return soundName ? { name: soundName } : null
}

function parseReplyToolActions(value: unknown): AudioMemeToolCall[] {
  if (Array.isArray(value)) {
    return value
      .map(item => parseReplyToolAction(item))
      .filter((item): item is AudioMemeToolCall => Boolean(item))
  }

  const parsed = parseReplyToolAction(value)
  return parsed ? [parsed] : []
}

function renderXmlAction(action: AudioMemeToolCall): string {
  return `<audiomeme name="${escapeXmlAttr(action.name)}" />`
}

function createResponseFingerprint(message: AssistantMessageLike, response: string): string {
  return `${getMessageType(message)}:${response}`
}

function subscribeAssistantResponses(
  messages: unknown[],
  getSession: () => Session | null,
  onResponse: (response: string, session: Session | null) => void,
): () => void {
  const processedMessages = new WeakMap<object, string>()
  const originalPush = messages.push.bind(messages)

  const patchedPush = (...items: unknown[]): number => {
    const result = originalPush(...items)

    for (const item of items) {
      if (!item || typeof item !== 'object') continue

      const message = item as AssistantMessageLike
      const response = extractAssistantText(message)
      if (!response) continue

      const fingerprint = createResponseFingerprint(message, response)
      const previousFingerprint = processedMessages.get(item)
      if (previousFingerprint === fingerprint) continue

      processedMessages.set(item, fingerprint)
      onResponse(response, getSession())
    }

    return result
  }

  const subscription: MessageSubscription = {
    originalPush,
    patchedPush,
  }

  messages.push = subscription.patchedPush

  return () => {
    if (messages.push === subscription.patchedPush) {
      messages.push = subscription.originalPush
    }
  }
}

function registerReplyTool(options: InstallChatlunaAudioMemeToolsOptions): () => void {
  const { ctx, config, logger, executeToolCall } = options
  const service = resolveCharacterService(ctx)

  if (!config.enableAudioMemeXmlTool || !config.injectAudioMemeXmlToolAsReplyTool) {
    return () => {}
  }

  if (!service?.registerReplyToolField) {
    logger.warn('chatluna_character.registerReplyToolField is unavailable, fallback to XML action mode')
    return () => {}
  }

  return service.registerReplyToolField({
    name: 'audiomeme_play',
    schema: {
      type: 'array',
      description: '在本次回复之后播放 meme 音效。数组中的每一项代表一个要播放的音效动作。',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '要播放的音效名称，必须使用 audiomeme list 中存在的名称，例如 bruh。',
          },
        },
        required: ['name'],
      },
    },
    isAvailable() {
      return Boolean(config.enableAudioMemeXmlTool && config.injectAudioMemeXmlToolAsReplyTool)
    },
    async invoke(_, session, value) {
      const actions = parseReplyToolActions(value)
      for (const action of actions) {
        const payload = await executeToolCall(session, action)
        if (!payload) continue

        await session.send(payload.result)
        logger.info('audiomeme=%s, user=%s, guild=%s', payload.soundName, session.userId, session.guildId)
      }
    },
    render(_, __, value) {
      const actions = parseReplyToolActions(value)
      if (!actions.length) return
      return actions.map(action => renderXmlAction(action))
    },
  })
}

export function installChatlunaAudioMemeTools(options: InstallChatlunaAudioMemeToolsOptions): void {
  const { ctx, config, logger, executeToolCall } = options
  const messageSubscriptions = new WeakMap<unknown[], () => void>()
  const sessionByMessages = new WeakMap<unknown[], Session | null>()
  const trackedMessages = new Set<unknown[]>()

  let currentService: ChatlunaCharacterServiceLike | undefined
  let originalGetTemp: ChatlunaCharacterServiceLike['getTemp'] | undefined
  let replyToolDispose: (() => void) | null = null
  let replyToolService: ChatlunaCharacterServiceLike | undefined
  let xmlActionExecutionEnabled = true

  const cleanupMessageSubscriptions = () => {
    for (const messages of Array.from(trackedMessages)) {
      messageSubscriptions.get(messages)?.()
      messageSubscriptions.delete(messages)
      sessionByMessages.delete(messages)
      trackedMessages.delete(messages)
    }
  }

  const cleanupServiceBinding = () => {
    if (currentService && originalGetTemp && currentService.getTemp !== originalGetTemp) {
      currentService.getTemp = originalGetTemp
    }
    originalGetTemp = undefined
    currentService = undefined
  }

  const dispatchXmlToolCalls = async (session: Session | null, content: string) => {
    if (!session || !content || !xmlActionExecutionEnabled) return

    try {
      const toolCalls = extractXmlAudioMemeToolCalls(content)
      for (const toolCall of toolCalls) {
        const payload = await executeToolCall(session, toolCall)
        if (!payload) continue

        await session.send(payload.result)
        logger.info('audiomeme=%s, user=%s, guild=%s', payload.soundName, session.userId, session.guildId)
      }
    } catch (error) {
      logger.warn('audiomeme XML runtime failed: %s', String(error))
    }
  }

  const bindMessages = (temp: ChatlunaTempLike | undefined, session: Session | null) => {
    const messages = temp?.completionMessages
    if (!Array.isArray(messages) || typeof messages.push !== 'function') return

    sessionByMessages.set(messages, session)
    if (messageSubscriptions.has(messages)) return

    const unsubscribe = subscribeAssistantResponses(
      messages,
      () => sessionByMessages.get(messages) ?? null,
      (response, boundSession) => {
        void dispatchXmlToolCalls(boundSession, response)
      },
    )

    trackedMessages.add(messages)
    messageSubscriptions.set(messages, unsubscribe)
  }

  const bindXmlRuntime = (bindCtx: Context) => {
    const service = resolveCharacterService(bindCtx)

    if (!config.enableAudioMemeXmlTool || !service?.getTemp) {
      cleanupServiceBinding()
      cleanupMessageSubscriptions()
      return
    }

    if (service === currentService && originalGetTemp) return

    cleanupServiceBinding()
    cleanupMessageSubscriptions()

    currentService = service
    originalGetTemp = service.getTemp

    service.getTemp = async (...args: unknown[]) => {
      const temp = await originalGetTemp?.apply(service, args)
      bindMessages(temp, resolveSession(args))
      return temp
    }
  }

  const bindReplyTools = (bindCtx: Context) => {
    const service = resolveCharacterService(bindCtx)

    if (replyToolDispose && service === replyToolService) return

    replyToolDispose?.()
    replyToolDispose = null
    replyToolService = undefined
    xmlActionExecutionEnabled = true

    if (!config.enableAudioMemeXmlTool || !config.injectAudioMemeXmlToolAsReplyTool) return

    replyToolDispose = registerReplyTool({ ...options, ctx: bindCtx })
    replyToolService = service
    xmlActionExecutionEnabled = !service?.registerReplyToolField
    if (!xmlActionExecutionEnabled) {
      logger.info('enabled experimental audiomeme reply tool field, XML action execution is disabled')
    }
  }

  const bindAll = (bindCtx: Context) => {
    bindReplyTools(bindCtx)
    bindXmlRuntime(bindCtx)
  }

  ctx.on('ready', () => {
    bindAll(ctx)
  })

  if (typeof (ctx as Context & { inject?: unknown }).inject === 'function') {
    ;(ctx as Context & { inject: (deps: string[], callback: (innerCtx: Context) => void) => void })
      .inject(['chatluna_character'], (innerCtx) => {
        bindAll(innerCtx)
      })
  }

  ctx.on('dispose', () => {
    replyToolDispose?.()
    replyToolDispose = null
    replyToolService = undefined
    xmlActionExecutionEnabled = true
    cleanupServiceBinding()
    cleanupMessageSubscriptions()
  })
}

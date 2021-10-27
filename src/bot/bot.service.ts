import { Inject, Injectable } from '@nestjs/common'
import { ConfigType } from '@nestjs/config'
import { Bot, Context, NextFunction } from 'grammy'
import botConfig from '../config/bot.config'
import {
  MeiliSearchService,
  OptionalTextMessageIndex,
} from '../search/meili-search.service'
import httpConfig from '../config/http.config'
import { PhotoSize, Update, MessageEntity } from '@grammyjs/types'
import Debug = require('debug')
import fetch from 'node-fetch'
import createHttpsProxyAgent = require('https-proxy-agent')
import { SearchResponse } from 'meilisearch'
import { IndexService } from 'src/search/index.service'
import { ImageIndexService } from 'src/search/image-index.service'

const debug = Debug('app:bot:bot.service')

@Injectable()
export class BotService {
  private bot: Bot
  private useWebhook: boolean
  private baseUrl: string
  private updateToken: string
  private agent: any
  private userMap: Map<string, number>

  public constructor(
    @Inject(botConfig.KEY)
    botCfg: ConfigType<typeof botConfig>,
    @Inject(httpConfig.KEY)
    httpCfg: ConfigType<typeof httpConfig>,
    private search: MeiliSearchService,
    private index: IndexService,
    private imageIndex: ImageIndexService,
  ) {
    this.useWebhook = botCfg.webhook
    this.baseUrl = `${httpCfg.baseUrl}${httpCfg.globalPrefix}`
    this.updateToken = botCfg.updateToken || botCfg.token
    this.userMap = new Map<string, number>()

    if (this.useWebhook && !this.baseUrl) {
      throw new Error(
        'You MUST set HTTP_BASE_URL if you have enabled TELEGRAM_WEBHOOK',
      )
    }

    this.agent = getProxyAgent()
    this.bot = new Bot(botCfg.token, {
      client: {
        baseFetchConfig: {
          agent: this.agent,
          compress: true,
        },
      },
    })

    this.bot.on('msg', this.botOnMessage)

    if (botCfg.followEdit) {
      this.bot.on('edit', this.botOnMessage)
    }

    this.bot.command('search', this.botOnSearchCommand)
  }

  public async start() {
    if (this.useWebhook) {
      await this.bot.init()
      return this.setWebhookUrl()
    } else {
      await this.startPolling()
    }
  }

  public async checkIfUserIsMember(userId: number, chatId: string) {
    const id = this.chatId2ApiId(chatId)
    const { status } = await this.bot.api.getChatMember(id, userId)

    return (
      status === 'member' || status === 'creator' || status === 'administrator'
    )
  }

  public chatId2ApiId(chatId: string) {
    return Number(chatId.replace(/^supergroup/, '-100').replace(/^group/, '-'))
  }

  public async getProfilePhoto(userId: number) {
    const { photos } = await this.tryGetPhotos(userId)
    if (photos.length < 1 || photos[0].length < 1) {
      return null
    }

    const { file_id: fileId } = getSmallestPhoto(photos[0])
    return await this.fetchFile(fileId)
  }

  private async fetchFile(fileId: string) {
    const { file_path: filePath } = await this.bot.api.getFile(fileId)
    const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${filePath}`

    const res = await fetch(fileUrl, { agent: this.agent })

    return res
  }

  private botOnMessage = async (ctx: Context, next: NextFunction) => {
    await next()
    const { msg, chat, from } = ctx
    if (!chat || !msg || !from) {
      return
    }

    if (from.username) {
      this.userMap.set(from.username, from.id)
      debug(`Cached user ${from.username} with id ${from.id}`)
    }

    const realId = `${chat.id}`.replace(/^-100/, '')
    const chatId = `${chat.type}${realId}`

    if (chat.type !== 'supergroup') {
      return
    }

    const searchable = msg?.text || msg?.caption
    if (!searchable || searchable.startsWith('/')) {
      return
    }

    const baseMessage: OptionalTextMessageIndex = {
      id: `${chatId}__${msg.message_id}`,
      messageId: msg.message_id,
      chatId,
      fromId: `user${from.id}`,
      fromName: joinNames(from.first_name, from.last_name),
      text: searchable,
      raw: ctx.msg,
      from: 'bot',
      timestamp: msg.date * 1000,
    }

    if (searchable) {
      await this.index.queueMessage({
        ...baseMessage,
        text: searchable,
      })

      debug(
        `Receive message from ${joinNames(
          from.first_name,
          from.last_name,
        )}: ${searchable}`,
      )
    }

    if (msg?.photo?.length) {
      await this.handlePhoto(msg.photo, baseMessage)

      debug(`Receive photo from ${joinNames(from.first_name, from.last_name)}`)
    }
  }

  private async handlePhoto(
    photoSize: PhotoSize[],
    baseMessage: OptionalTextMessageIndex,
  ) {
    const { file_id: fileId } = getLargestPhoto(photoSize)
    const res = await this.fetchFile(fileId)
    const buf = await res.buffer()
    await this.imageIndex.indexImage([buf], baseMessage)
  }

  private botOnSearchCommand = async (ctx: Context) => {
    const { msg, chat, from, match } = ctx
    if (!chat || !msg || !from || !match || typeof match !== 'string') {
      return
    }
    const realId = `${chat.id}`.replace(/^-100/, '')
    const chatId = `${chat.type}${realId}`

    let searchResults: SearchResponse<OptionalTextMessageIndex>
    if (chat.type === 'private') {
      searchResults = await this.search.search(
        match,
        undefined,
        `user${from.id}`,
      )
    } else {
      const mentionUserId = await this.getMentionUserId(ctx)
      if (!mentionUserId) {
        searchResults = await this.search.search(match, chatId)
      } else {
        searchResults = await this.search.search(
          match,
          chatId,
          `user${mentionUserId}`,
        )
      }
    }

    let formattedMessage = searchResults.hits
      .map((hit: any) => {
        const tgUrlChatId = hit.chatId.replace(/[a-zA-Z]+/, '')
        let text = hit.text.replace(/\n/g, ' ').replace(/@/g, '')
        if (text.length > 30) {
          text = text.substring(0, 30) + '...'
        }
        return `*${hit.fromName}*：${text} [跳转](https://t.me/c/${tgUrlChatId}/${hit.messageId})`
      })
      .join('\n')

    if (formattedMessage !== '') {
      formattedMessage = `搜索结果：\n${formattedMessage}`
      await ctx.reply(formattedMessage, {
        parse_mode: 'Markdown',
        reply_to_message_id: msg.message_id,
      })
    } else {
      await ctx.reply('没有找到相关信息', {
        reply_to_message_id: msg.message_id,
      })
    }
  }

  private async tryGetPhotos(userId: number) {
    try {
      return await this.bot.api.getUserProfilePhotos(userId, {
        limit: 1,
      })
    } catch (e: any) {
      if (e.message.includes('user not found')) {
        return { photos: [] }
      } else {
        throw e
      }
    }
  }

  private async getMentionUserId(ctx: Context) {
    const { msg } = ctx
    if (!msg || !msg.text) {
      return undefined
    }

    const textMention = msg.entities?.find(
      (entity) => entity.type === 'text_mention',
    ) as MessageEntity.TextMentionMessageEntity
    if (textMention) {
      debug(`Mentioned user ${textMention.user.id}`)
      return textMention.user.id
    }

    const mention = msg.entities?.find(
      (entity) => entity.type === 'mention',
    ) as MessageEntity.CommonMessageEntity
    if (mention) {
      const mentionUserString = msg.text.substring(
        mention.offset + 1,
        mention.offset + mention.length,
      )
      const mentionUserId = this.userMap.get(mentionUserString)
      if (mentionUserId) {
        debug(`Mentioned user ${mentionUserId}`)
        return mentionUserId
      }
    }
  }

  private async setWebhookUrl() {
    const url = `${this.baseUrl}/bot/webhook/${this.updateToken}/update`
    await this.bot.api.setWebhook(url)
  }

  private async startPolling() {
    void this.bot.start()
  }

  public handleUpdate(update: Update) {
    return this.bot.handleUpdate(update)
  }

  public checkUpdateToken(tokenInput: string) {
    return tokenInput === this.updateToken
  }
}

function joinNames(firstName: string, lastName: string | undefined) {
  return [firstName, lastName].filter((x) => x).join(' ')
}

function getProxyAgent() {
  const proxy = process.env.https_proxy || process.env.http_proxy
  if (!proxy) {
    return
  }

  return createHttpsProxyAgent(proxy)
}

function getSmallestPhoto(photos: PhotoSize[]): PhotoSize {
  const sorted = photos.sort((a, b) => a.width - b.width)
  return sorted[0]
}

function getLargestPhoto(photos: PhotoSize[]): PhotoSize {
  const sorted = photos.sort((a, b) => b.width - a.width)
  return sorted[0]
}

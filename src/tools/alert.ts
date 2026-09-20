import { z } from 'zod'
import { defineTool } from './registry.js'
import { markdownToTelegramHtml } from '../telegram/render.js'

/**
 * send_alert — pushes a message to the admin chat (e.g. from a cron-fired run
 * or a price alert). Non-admin chats get nothing: alerts always go to the owner.
 */
export const sendAlertTool = defineTool({
  name: 'send_alert',
  description: 'Push an urgent alert to the owner via Telegram. Use sparingly — real alerts only.',
  danger: 'write',
  input: z.object({
    message: z.string().describe('the alert text'),
  }),
  execute: async (input, ctx) => {
    const adminChat = ctx.cfg.telegram.adminChatId
    if (adminChat === undefined) return { text: '[error] no admin chat configured for alerts' }
    await ctx.send.send(adminChat, `🚨 ALERT\n${markdownToTelegramHtml(input.message)}`)
    return { text: 'alert delivered' }
  },
})
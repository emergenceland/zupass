import { Menu, MenuRange } from "@grammyjs/menu";
import { getEdDSAPublicKey } from "@pcd/eddsa-pcd";
import { EdDSATicketPCDPackage } from "@pcd/eddsa-ticket-pcd";
import { constructPassportPcdGetRequestUrl } from "@pcd/passport-interface";
import { ArgumentTypeName } from "@pcd/pcd-types";
import { SemaphoreIdentityPCDPackage } from "@pcd/semaphore-identity-pcd";
import {
  EdDSATicketFieldsToReveal,
  ZKEdDSAEventTicketPCD,
  ZKEdDSAEventTicketPCDArgs,
  ZKEdDSAEventTicketPCDPackage
} from "@pcd/zk-eddsa-event-ticket-pcd";
import { Bot, Context, InlineKeyboard } from "grammy";
import { Chat, ChatFromGetChat } from "grammy/types";
import sha256 from "js-sha256";
import { Pool } from "postgres-pool";
import { deleteTelegramEvent } from "../database/queries/telegram/deleteTelegramEvent";
import { deleteTelegramVerification } from "../database/queries/telegram/deleteTelegramVerification";
import { fetchTelegramVerificationStatus } from "../database/queries/telegram/fetchTelegramConversation";
import {
  fetchLinkedPretixAndTelegramEvents,
  fetchTelegramEventByEventId,
  fetchTelegramEventsByChatId
} from "../database/queries/telegram/fetchTelegramEvent";
import {
  insertTelegramEvent,
  insertTelegramVerification
} from "../database/queries/telegram/insertTelegramConversation";
import { ApplicationContext } from "../types";
import { logger } from "../util/logger";
import { isLocalServer, sleep } from "../util/util";
import { RollbarService } from "./rollbarService";

const ALLOWED_EVENT_IDS = [
  { eventId: "3fa6164c-4785-11ee-8178-763dbf30819c", name: "SRW Staging" },
  { eventId: "264b2536-479c-11ee-8153-de1f187f7393", name: "SRW Prod" },
  {
    eventId: "b03bca82-2d63-11ee-9929-0e084c48e15f",
    name: "ProgCrypto (Internal Test)"
  },
  {
    eventId: "ae23e4b4-2d63-11ee-9929-0e084c48e15f",
    name: "AW (Internal Test)"
  }
];

const eventIdIsAllowed = (eventId?: string): boolean => {
  if (!eventId) throw new Error(`No Event Id found for verification`);
  return ALLOWED_EVENT_IDS.map((a) => a.eventId).includes(eventId);
};

export class TelegramService {
  private context: ApplicationContext;
  private bot: Bot;
  private rollbarService: RollbarService | null;
  private fetchLinkMenu: () => Promise<MenuRange<Context>>;

  public constructor(
    context: ApplicationContext,
    rollbarService: RollbarService | null,
    bot: Bot
  ) {
    this.context = context;
    this.rollbarService = rollbarService;
    this.bot = bot;
    this.fetchLinkMenu = async (): Promise<MenuRange<Context>> =>
      new MenuRange();

    this.bot.api.setMyDescription(
      "I'm the ZK Auth Bot! I'm managing fun events with ZKPs. Press START to get started!"
    );

    this.bot.api.setMyShortDescription("ZK Auth Bot manages events using ZKPs");

    const pcdPassMenu = new Menu("pcdpass");
    const eventsMenu = new Menu("events");
    const anonSendMenu = new Menu("anonsend");

    // Uses the dynamic range feature of Grammy menus https://grammy.dev/plugins/menu#dynamic-ranges
    // /link and /unlink are unstable right now, pending fixes
    eventsMenu.dynamic(async () => {
      logger(`[TELEGRAM] calling dynamic events menu...`);
      return await this.fetchLinkMenu();
    });

    pcdPassMenu.dynamic((ctx, range) => {
      const userId = ctx?.from?.id;
      const username = ctx?.from?.username;
      const firstName = ctx?.from?.first_name;
      const name = firstName || username;

      if (userId && name) {
        const proofUrl = this.generateProofUrl(userId.toString());
        range.webApp(`Generate a proof of ticket for ${name} 🚀`, proofUrl);
      } else {
        ctx.reply(
          `Unable to locate your Telegram account. Please try again, or contact passport@0xparc.org`
        );
      }
      return range;
    });

    this.bot.use(eventsMenu);
    this.bot.use(pcdPassMenu);
    this.bot.use(anonSendMenu);

    // Users gain access to gated chats by requesting to join. The bot
    // receives a notification of this, and will approve requests from
    // users who have verified their possession of a matching PCD.
    // Approval of the join request is required even for users with the
    // invite link - see `creates_join_request` parameter on
    // `createChatInviteLink` API invocation below.
    this.bot.on("chat_join_request", async (ctx) => {
      try {
        const chatId = ctx.chatJoinRequest.chat.id;
        const userId = ctx.chatJoinRequest.user_chat_id;

        logger(`[TELEGRAM] Got chat join request for ${chatId} from ${userId}`);

        // Check if this user is verified for the chat in question
        const isVerified = await fetchTelegramVerificationStatus(
          this.context.dbPool,
          userId,
          chatId
        );

        if (isVerified) {
          logger(
            `[TELEGRAM] Approving chat join request for ${userId} to join ${chatId}`
          );
          await this.bot.api.approveChatJoinRequest(chatId, userId);
          const inviteLink = await ctx.createChatInviteLink();
          await this.bot.api.sendMessage(userId, `You're approved.`, {
            reply_markup: new InlineKeyboard().url(
              `Join`,
              inviteLink.invite_link
            )
          });
          await this.bot.api.sendMessage(userId, `Congrats!`);
        }
      } catch (e) {
        logger("[TELEGRAM] chat_join_request error", e);
        this.rollbarService?.reportError(e);
      }
    });

    // When a user joins the channel, remove their verification, so they
    // cannot rejoin without verifying again.
    this.bot.on("chat_member", async (ctx) => {
      try {
        const newMember = ctx.update.chat_member.new_chat_member;
        if (newMember.status === "member") {
          logger(
            `[TELEGRAM] Deleting verification for user ${newMember.user.id} in chat ${ctx.chat.id}`
          );
          await deleteTelegramVerification(
            this.context.dbPool,
            newMember.user.id,
            ctx.chat.id
          );
        }
      } catch (e) {
        logger("[TELEGRAM] chat_member error", e);
        this.rollbarService?.reportError(e);
      }
    });

    // The "start" command initiates the process of invitation and approval.
    this.bot.command("start", async (ctx) => {
      try {
        // Only process the command if it comes as a private message.
        if (ctx.message && ctx.chat.type === "private") {
          await ctx.reply(
            "Welcome! 👋\n\nClick below to ZK prove that you have a ticket to an event, so I can add you to the attendee Telegram group!",
            {
              reply_markup: pcdPassMenu
            }
          );
        }
      } catch (e) {
        logger("[TELEGRAM] start error", e);
        this.rollbarService?.reportError(e);
      }
    });

    // The "link <eventName>" command is a dev utility for associating the channel Id with a given event.
    this.bot.command("link", async (ctx) => {
      try {
        await ctx.reply(`Checking you have permission to link...`);
        if (ctx.chat?.type === "private") {
          await ctx.reply(
            "To get you started, can you please add me as an admin to the telegram channel associated with your event? Once you are done, please ping me again with /setup in the channel."
          );
          return;
        }

        const admins = await ctx.getChatAdministrators();
        const isAdmin = admins.some(
          (admin) => admin.user.id === this.bot.botInfo.id
        );
        if (!isAdmin) {
          await ctx.reply(
            "Please add me as an admin to the telegram channel associated with your event."
          );
          return;
        }

        const channelId = ctx.chat.id;
        this.buildLinkMenu(this.context.dbPool);
        await ctx.reply(
          `Checking linked status of this chat... (id: ${channelId})`
        );

        // await this.loadEvents(this.context.dbPool);
        await ctx.reply("Link options", {
          reply_markup: eventsMenu
        });
      } catch (error) {
        await ctx.reply(`Error linking. Check server logs for details`);
        logger(`[TELEGRAM] ERROR`, error);
      }
    });

    this.bot.command("unlink", async (ctx) => {
      try {
        await ctx.reply(`Checking you have permission to unlink...`);
        if (ctx.chat?.type === "private") {
          await ctx.reply(
            "To get you started, can you please add me as an admin to the telegram channel associated with your event? Once you are done, please ping me again with /setup in the channel."
          );
          return;
        }

        const admins = await ctx.getChatAdministrators();
        const isAdmin = admins.some(
          (admin) => admin.user.id === this.bot.botInfo.id
        );
        if (!isAdmin) {
          await ctx.reply(
            "Please add me as an admin to the telegram channel associated with your event."
          );
          return;
        }
        const unlink = true;
        this.buildLinkMenu(this.context.dbPool, unlink);
        await ctx.reply("Unlink options", {
          reply_markup: eventsMenu
        });
      } catch (error) {
        await ctx.reply(`Error Unlinking. Check server logs for details`);
        logger(`[TELEGRAM] ERROR`, error);
      }
    });

    this.bot.command("help", async (ctx) => {
      await ctx.reply(
        `<b>Help</b>
    
        <b>Users</b>
        <b>/start</b> - join a group with a ZK proof of a ticket
    
        <b>Admins</b>
        <b>/link</b> - Link this group with a ticketed event
        <b>/unlink</b> - Unlink this group with a ticketed event
      `,
        { parse_mode: "HTML" }
      );
    });

    this.bot.command("anonsend", async (ctx) => {
      if (ctx.chat?.type !== "private") {
        const messageThreadId = ctx.message?.message_thread_id;
        const chatId = ctx.chat.id;

        // if there is a message_thread_id or a chat_id, use reply settings.
        const replyOptions = messageThreadId
          ? { message_thread_id: messageThreadId }
          : chatId
          ? {}
          : undefined;

        if (replyOptions) {
          await ctx.reply(
            "To maintain privacy, please message within a private chat.",
            replyOptions
          );
        }
        return;
      }

      const zktgUrl =
        process.env.TELEGRAM_ANON_WEBSITE ?? "https://dev.local:4000/";

      anonSendMenu.webApp("Send anonymous message", zktgUrl);
      await ctx.reply("Click below to anonymously send a message.", {
        reply_markup: anonSendMenu
      });
    });

    this.bot.command("incognito", async (ctx) => {
      const messageThreadId = ctx.message?.message_thread_id;
      if (!messageThreadId) {
        logger("[TELEGRAM] message thread id not found");
        return;
      }

      if (ctx.chat?.type !== "supergroup") {
        await ctx.reply(
          "This command only works in a group with Topics enabled.",
          { message_thread_id: messageThreadId }
        );
      }
      const admins = await ctx.getChatAdministrators();
      const isAdmin = admins.some((admin) => admin.user.id === ctx.from?.id);
      if (!isAdmin) {
        await ctx.reply(
          "Must be an admin to convert a channel to Incognito mode.",
          { message_thread_id: messageThreadId }
        );
        return;
      }

      try {
        const telegramEvents = await fetchTelegramEventsByChatId(
          this.context.dbPool,
          ctx.chat.id
        );
        const hasLinked = telegramEvents.length > 0;
        if (!hasLinked) {
          await ctx.reply(
            "This group is not linked to an event. Please use /link to link this group to an event.",
            { message_thread_id: messageThreadId }
          );
          return;
        } else if (telegramEvents.filter((e) => e.anon_chat_id).length > 0) {
          await ctx.reply(
            `This group has already linked an anonymous channel.`,
            { message_thread_id: messageThreadId }
          );
          return;
        }

        await insertTelegramEvent(
          this.context.dbPool,
          telegramEvents[0].ticket_event_id,
          telegramEvents[0].telegram_chat_id,
          messageThreadId
        );

        await ctx.reply(
          `Successfully linked anonymous channel. DM me with /anonsend to anonymously send a message.`,
          { message_thread_id: messageThreadId }
        );
      } catch (error) {
        logger(`[ERROR] ${error}`);
        await ctx.reply(`Failed to link anonymous chat. Check server logs`, {
          message_thread_id: messageThreadId
        });
      }
    });
  }

  private generateProofUrl(telegramUserId: string): string {
    const fieldsToReveal: EdDSATicketFieldsToReveal = {
      revealTicketId: true,
      revealEventId: true,
      revealProductId: true,
      revealTimestampConsumed: false,
      revealTimestampSigned: false,
      revealAttendeeSemaphoreId: true,
      revealIsConsumed: false,
      revealIsRevoked: false
    };

    const args: ZKEdDSAEventTicketPCDArgs = {
      ticket: {
        argumentType: ArgumentTypeName.PCD,
        pcdType: EdDSATicketPCDPackage.name,
        value: undefined,
        userProvided: true
      },
      identity: {
        argumentType: ArgumentTypeName.PCD,
        pcdType: SemaphoreIdentityPCDPackage.name,
        value: undefined,
        userProvided: true
      },
      fieldsToReveal: {
        argumentType: ArgumentTypeName.ToggleList,
        value: fieldsToReveal,
        userProvided: false
      },
      externalNullifier: {
        argumentType: ArgumentTypeName.BigInt,
        value: undefined,
        userProvided: false
      },
      validEventIds: {
        argumentType: ArgumentTypeName.StringArray,
        value: undefined,
        userProvided: false
      },
      watermark: {
        argumentType: ArgumentTypeName.BigInt,
        value: telegramUserId.toString(),
        userProvided: false
      }
    };

    let passportOrigin = `${process.env.PASSPORT_CLIENT_URL}/`;
    if (passportOrigin === "http://localhost:3000/") {
      // TG bot doesn't like localhost URLs
      passportOrigin = "http://127.0.0.1:3000/";
    }
    const returnUrl = `${process.env.PASSPORT_SERVER_URL}/telegram/verify/${telegramUserId}`;

    const proofUrl = constructPassportPcdGetRequestUrl<
      typeof ZKEdDSAEventTicketPCDPackage
    >(passportOrigin, returnUrl, ZKEdDSAEventTicketPCDPackage.name, args, {
      genericProveScreen: true,
      title: "ZK Ticket Proof",
      description:
        "Generate a zero-knowledge proof that you have a ZK-EdDSA ticket for the research workshop! Select your ticket from the dropdown below."
    });
    return proofUrl;
  }

  private buildLinkMenu(db: Pool, unlink?: boolean): void {
    this.fetchLinkMenu = async (): Promise<MenuRange<Context>> => {
      const range = new MenuRange();
      let events = await fetchLinkedPretixAndTelegramEvents(db);
      for (const event of events) {
        if (!event.configEventID) {
          logger(
            `[TELEGRAM] events lookup failed. Make sure pretix_events_config and devconnect_pretix_items_info are populated.`
          );
          throw new Error(
            `Fetching events failed. Check server logs for more detail.`
          );
        }
        range
          .text(
            {
              text: `${event.telegramChatID ? `✅` : `❌`} ${
                event.eventName
              } id: ${event.telegramChatID}`,
              payload: event.configEventID
            },
            async (ctx) => {
              if (ctx.chat && ctx.chat.id) {
                // Uses Grammy payload property https://grammy.dev/plugins/menu#payloads
                const eventIdFromPayload = ctx.match;
                let updatedOccured = false;
                if (unlink) {
                  if (event?.telegramChatID !== ctx.chat.id.toString()) {
                    ctx.reply(
                      `Chat is not linked with event ${event.eventName}`
                    );
                  } else {
                    await deleteTelegramEvent(db, eventIdFromPayload);
                    updatedOccured = true;
                    ctx.reply(
                      `Unlinked ${event.eventName} with chat ${ctx.chat.id}`
                    );
                  }
                } else {
                  if (event?.telegramChatID === ctx.chat.id.toString()) {
                    ctx.reply(
                      `Chat is already linked with event ${event.eventName}`
                    );
                  } else {
                    await insertTelegramEvent(
                      db,
                      eventIdFromPayload,
                      ctx.chat.id
                    );
                    updatedOccured = true;
                    ctx.reply(
                      `Linked ${event.eventName} with chat ${ctx.chat.id}`
                    );
                  }
                }
                if (updatedOccured) {
                  events = await fetchLinkedPretixAndTelegramEvents(db);
                  ctx.menu.update();
                }
              } else {
                ctx.reply(`Couldn't link chat with event`);
              }
            }
          )
          .row();
      }
      return range;
    };
  }
  /**
   * Telegram does not allow two instances of a bot to be running at once.
   * During deployment, a new instance of the app will be started before the
   * old one is shut down, so we might end up with two instances running at
   * the same time. This method allows us to delay starting the bot by an
   * amount configurable per-environment.
   *
   * Since this function awaits on bot.start(), it will likely be very long-
   * lived.
   */
  public async startBot(): Promise<void> {
    const startDelay = parseInt(process.env.TELEGRAM_BOT_START_DELAY_MS ?? "0");
    if (startDelay > 0) {
      logger(`[TELEGRAM] Delaying bot startup by ${startDelay} milliseconds`);
      await sleep(startDelay);
    }

    logger(`[TELEGRAM] Starting bot`);

    try {
      // This will not resolve while the bot remains running.
      await this.bot.start({
        allowed_updates: [
          "chat_join_request",
          "chat_member",
          "message",
          "callback_query"
        ],
        onStart: (info) => {
          logger(`[TELEGRAM] Started bot '${info.username}' successfully!`);
        }
      });
    } catch (e) {
      logger(`[TELEGRAM] Error starting bot`, e);
      this.rollbarService?.reportError(e);
    }
  }

  public async getBotURL(): Promise<string> {
    const { username } = await this.bot.api.getMe();
    return `https://t.me/${username}`;
  }

  private async verifyZKEdDSAEventTicketPCD(
    serializedZKEdDSATicket: string
  ): Promise<ZKEdDSAEventTicketPCD | null> {
    let pcd: ZKEdDSAEventTicketPCD;

    try {
      pcd = await ZKEdDSAEventTicketPCDPackage.deserialize(
        JSON.parse(serializedZKEdDSATicket).pcd
      );
    } catch (e) {
      throw new Error(`Deserialization error, ${e}`);
    }

    // this is very bad but i am very tired
    // hardcoded eventIDs and signing keys for SRW
    let signerMatch = false;
    let eventIdMatch = false;

    if (!process.env.SERVER_EDDSA_PRIVATE_KEY)
      throw new Error(`Missing server eddsa private key .env value`);

    // This Pubkey value should work for staging + prod as well, but needs to be tested
    const TICKETING_PUBKEY = await getEdDSAPublicKey(
      process.env.SERVER_EDDSA_PRIVATE_KEY
    );

    if (isLocalServer()) {
      eventIdMatch = true;
      signerMatch =
        pcd.claim.signer[0] === TICKETING_PUBKEY[0] &&
        pcd.claim.signer[1] === TICKETING_PUBKEY[1];
    } else if (process.env.PASSPORT_SERVER_URL?.includes("staging")) {
      eventIdMatch = eventIdIsAllowed(pcd.claim.partialTicket.eventId);
      signerMatch =
        pcd.claim.signer[0] === TICKETING_PUBKEY[0] &&
        pcd.claim.signer[1] === TICKETING_PUBKEY[1];
    } else {
      eventIdMatch = eventIdIsAllowed(pcd.claim.partialTicket.eventId);
      signerMatch =
        pcd.claim.signer[0] === TICKETING_PUBKEY[0] &&
        pcd.claim.signer[1] === TICKETING_PUBKEY[1];
    }

    if (
      (await ZKEdDSAEventTicketPCDPackage.verify(pcd)) &&
      eventIdMatch &&
      signerMatch
    ) {
      return pcd;
    } else {
      logger("[TELEGRAM] pcd invalid");
      return null;
    }
  }

  private chatIsGroup(
    chat: ChatFromGetChat
  ): chat is Chat.GroupGetChat | Chat.SupergroupGetChat {
    // Chat must be a group chat of some kind
    return (
      chat?.type === "channel" ||
      chat?.type === "group" ||
      chat?.type === "supergroup"
    );
  }

  private async sendToAnonymousChannel(
    groupId: number,
    anonChatId: number,
    message: string
  ): Promise<void> {
    await this.bot.api.sendMessage(groupId, message, {
      message_thread_id: anonChatId
    });
  }

  private async sendInviteLink(
    userId: number,
    chat: Chat.GroupGetChat | Chat.SupergroupGetChat
  ): Promise<void> {
    // Send the user an invite link. When they follow the link, this will
    // trigger a "join request", which the bot will respond to.
    logger(
      `[TELEGRAM] Creating chat invite link to ${chat.title}(${chat.id}) for ${userId}`
    );
    const inviteLink = await this.bot.api.createChatInviteLink(chat.id, {
      creates_join_request: true,
      name: "test invite link"
    });
    await this.bot.api.sendMessage(
      userId,
      `You've generated a ZK proof! Press this button to send your proof to ${chat.title}`,
      {
        reply_markup: new InlineKeyboard().url(
          `Send ZKP`,
          inviteLink.invite_link
        )
      }
    );
  }

  /**
   * Verify that a PCD relates to an event, and that the event has an
   * associated chat. If so, invite the user to the chat and record them
   * for later approval when they request to join.
   *
   * This is called from the /telegram/verify route.
   */
  public async handleVerification(
    serializedZKEdDSATicket: string,
    telegramUserId: number
  ): Promise<void> {
    // Verify PCD
    const pcd = await this.verifyZKEdDSAEventTicketPCD(serializedZKEdDSATicket);

    if (!pcd) {
      throw new Error(`Could not verify PCD for ${telegramUserId}`);
    }
    const { watermark } = pcd.claim;

    if (!watermark) {
      throw new Error("Verification PCD did not contain watermark");
    }

    if (telegramUserId.toString() !== watermark.toString()) {
      throw new Error(
        `Telegram User id ${telegramUserId} does not match given watermark ${watermark}`
      );
    }

    const { eventId } = pcd.claim.partialTicket;
    if (!eventId) {
      throw new Error(
        `User ${telegramUserId} returned a ZK-ticket with no eventId.`
      );
    }

    logger(`[TELEGRAM] Verified PCD for ${telegramUserId}, event ${eventId}`);

    // Find the event which matches the PCD
    // For this to work, the `telegram_bot_events` table must be populated.

    const event = await fetchTelegramEventByEventId(
      this.context.dbPool,
      eventId
    );
    if (!event) {
      throw new Error(
        `User ${telegramUserId} attempted to use a ticket for event ${eventId}, which has no matching chat`
      );
    }

    // The event is linked to a chat. Make sure we can access it.
    const chatId = event.telegram_chat_id;
    const chat = await this.bot.api.getChat(chatId);
    if (!this.chatIsGroup(chat)) {
      throw new Error(
        `Event ${event.ticket_event_id} is configured with Telegram chat ${event.telegram_chat_id}, which is of incorrect type "${chat.type}"`
      );
    }

    // We've verified that the chat exists, now add the user to our list.
    // This will be important later when the user requests to join.
    await insertTelegramVerification(
      this.context.dbPool,
      telegramUserId,
      event.telegram_chat_id
    );

    // Send invite link
    await this.sendInviteLink(telegramUserId, chat);
  }

  public async handleSendAnonymousMessage(
    serializedZKEdDSATicket: string,
    message: string
  ): Promise<void> {
    logger("[TELEGRAM] Verifying anonymous message");

    const pcd = await this.verifyZKEdDSAEventTicketPCD(serializedZKEdDSATicket);

    if (!pcd) {
      throw new Error("Could not verify PCD for anonymous message");
    }

    const {
      watermark,
      partialTicket: { eventId }
    } = pcd.claim;

    if (!eventId) {
      throw new Error("Anonymous message PCD did not contain eventId");
    }

    if (!watermark) {
      throw new Error("Anonymous message PCD did not contain watermark");
    }

    function getMessageWatermark(message: string): bigint {
      const hashed = sha256.sha256(message).substring(0, 16);
      return BigInt("0x" + hashed);
    }

    if (getMessageWatermark(message).toString() !== watermark.toString()) {
      throw new Error(
        `Anonymous message string ${message} didn't match watermark. got ${watermark} and expected ${getMessageWatermark(
          message
        ).toString()}`
      );
    }

    const event = await fetchTelegramEventByEventId(
      this.context.dbPool,
      eventId
    );
    if (!event) {
      throw new Error(
        `Attempted to use a PCD to send anonymous message for event ${eventId}, which is not available`
      );
    }

    logger(
      `[TELEGRAM] Verified PCD for anonynmous message with event ${eventId}`
    );

    if (event.anon_chat_id == null) {
      throw new Error(`this group doesn't have an anon channel`);
    }

    // The event is linked to a chat. Make sure we can access it.
    const chatId = event.telegram_chat_id;
    const chat = await this.bot.api.getChat(chatId);
    if (!this.chatIsGroup(chat)) {
      throw new Error(
        `Event ${event.ticket_event_id} is configured with Telegram chat ${event.telegram_chat_id}, which is of incorrect type "${chat.type}"`
      );
    }

    await this.sendToAnonymousChannel(chat.id, event.anon_chat_id, message);
  }

  public stop(): void {
    this.bot.stop();
  }
}

export async function startTelegramService(
  context: ApplicationContext,
  rollbarService: RollbarService | null
): Promise<TelegramService | null> {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    logger(
      `[INIT] missing TELEGRAM_BOT_TOKEN, not instantiating Telegram service`
    );
    return null;
  }

  const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
  await bot.init();

  const service = new TelegramService(context, rollbarService, bot);
  // Start the bot, but do not await on the result here.
  service.startBot();

  return service;
}

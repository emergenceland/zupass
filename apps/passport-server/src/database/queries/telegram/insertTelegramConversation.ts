import { Pool } from "postgres-pool";
import { sqlQuery } from "../../sqlQuery";

/**
 * Insert a Telegram conversation into the database.
 */
export async function insertTelegramVerification(
  client: Pool,
  telegramUserId: number,
  telegramChatId: number
): Promise<number> {
  const result = await sqlQuery(
    client,
    `\
insert into telegram_bot_conversations (telegram_user_id, telegram_chat_id, verified)
values ($1, $2, true)
on conflict do nothing;`,
    [telegramUserId, telegramChatId]
  );
  return result.rowCount;
}

export async function insertTelegramEvent(
  client: Pool,
  ticketEventId: string,
  telegramChatId: number,
  anonChatId?: number,
  anonTopicName?: string
): Promise<number> {
  const result = await sqlQuery(
    client,
    `\
insert into telegram_bot_events (ticket_event_id, telegram_chat_id, anon_chat_id, topic_name)
values ($1, $2, $3, $4)
on conflict (ticket_event_id) do update
set telegram_chat_id = $2, anon_chat_id = $3, topic_name = $4;`,
    [ticketEventId, telegramChatId, anonChatId, anonTopicName]
  );
  return result.rowCount;
}

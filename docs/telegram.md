# Telegram capture

Message a bot from your phone and it becomes a note. Kothai long-polls Telegram's API from inside the container — an outbound connection — so nothing needs to be reachable from the internet: no public URL, no certificate, no port forward, and your tailnet doesn't need to be up.

## Set it up

1. Message `@BotFather` on Telegram and send it `/newbot`. Follow the prompts and copy the token it gives you.
2. Paste the token into Settings → **TELEGRAM** and click **Connect**. Kothai checks the token with Telegram before saving it, so a typo is refused on the spot, and the bot starts listening straight away. No restart needed.
3. Pair your chat. Click **Open in Telegram** and tap **Start** in the chat that opens. Or send the bot the six-character code Settings shows, exactly as shown.
4. The bot replies "🔗 Connected. Any link you send here is saved to Kothai.", and Settings switches to **Paired** by itself. From then on, any link you send it is saved.

## What gets saved

Links only: a message whose whole text is one `http(s)://` link. Anything else — plain text, a photo, a file, video, voice note, sticker or GIF — is refused, and once your chat is bound the bot tells you so. A link sent as the caption of an attachment is saved, and the bot replies that the attachment itself was dropped.

## Why the pairing code

A bot's username is public from the moment BotFather creates it, and it's usually easy to guess from the bot's display name. Without a pairing step, whoever messages the bot first — a stranger, a scraper — would bind it to their own chat, gain write access to your archive, and lock you out, silently, since the bot never explains why it isn't responding to you. The pairing code, shown only on your own Settings screen, is what proves the chat binding the bot is the one that set it up. The **Open in Telegram** link carries the same code, and Telegram sends it to the bot as `/start` followed by the code when you tap Start. A bare `/start`, or one with the wrong code, pairs nothing.

## If nothing happens

A chat that isn't bound yet gets silence for anything except the correct pairing code — no reply, no note. A wrong code is met with the same silence. That's deliberate: replying at all, even to reject, would tell a stranger the bot is live and worth attacking. So if you send the code and nothing happens, don't conclude it's broken — check what you typed and send it again.

Once a chat is bound, that silence still protects it from everyone else — messages from any other chat get no reply and create no note. But your own bound chat is different: from that point on it always gets a reply, even when nothing was saved (see "What gets saved" above). If your bound chat goes quiet, the bot itself has likely stopped — see "If capture has stopped" below.

## If capture has stopped

Only one process can long-poll a bot's token at a time. If Telegram sees a second poller — a second Kothai instance pointed at the same bot, for example — it answers with a conflict, and Kothai stops polling for the rest of that run rather than fight the other poller over every message. Settings will show the bot as disconnected even though the token is still saved on disk. Once only one poller is left running, paste the token and click **Connect** again (or restart Kothai) to bring capture back.

## The privacy tradeoff

Kothai's data never leaves your machine unless you say so. Connecting Telegram is you saying so. Chats with a bot are ordinary Telegram cloud chats, not end-to-end encrypted, so anything you send it is stored on Telegram's servers — and stays in the chat history there after Kothai has saved it. Only turn this on if you're fine with Telegram holding a copy of whatever you plan to send it.

## While Kothai is down

Telegram holds unacknowledged updates for you. If Kothai is stopped, restarting, or briefly offline, whatever you send in the meantime isn't lost — it arrives on the next poll, as long as you're within Telegram's retention window. Kothai only acknowledges an update once the note behind it is actually saved, so a crash mid-save redelivers that update rather than dropping it.

## Disconnecting

Clicking **Disconnect** in Settings deletes the saved token and stops the bot listening immediately. Anything sent to it afterwards stays on Telegram's side and is never saved.

## Rotating the token

Revoke the old token in BotFather, paste the new one into Settings, and reconnect. Saving a new token resets the binding — the chat that was bound to the old bot has never spoken to the new one, so there's nothing to carry forward — and issues a fresh pairing code. Pair again as in step 3 above.

## Group chats

Binding is per-chat, not per-person. Add the bot to a group and pair that group, and anyone in it can save to your archive — there's no separate check on who sent the message.

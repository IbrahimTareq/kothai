// TELEGRAM — connect a bot so a message sent to it is captured like anything
// else. Binding needs a pairing code rather than trusting whoever messages
// first, because a bot's username is public the moment BotFather creates it —
// see the rule in server/telegram/ingest.ts, which the code shown here feeds.
import { useEffect, useState } from 'react'
import { SettingsGroup, SettingsRow, RowStatus } from './SettingsRow'
import { API, apiError } from '../../data/api'
import type { TelegramState } from '../../types'
import { writeClipboard } from '../../util/clipboard'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'

// Pairing finishes in Telegram, on another screen — often another device —
// so nothing here would otherwise change when it does. Polled only while a
// code is waiting to be used.
const PAIRING_POLL_MS = 2_000

export function TelegramSection() {
  const [state, setState] = useState<TelegramState | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    API.telegram()
      .then(setState)
      .catch(() => {})
  }, [])

  const pairing = Boolean(state?.connected && state.boundChatId === null)
  useEffect(() => {
    if (!pairing) return
    const id = setInterval(() => {
      API.telegram()
        .then(setState)
        .catch(() => {})
    }, PAIRING_POLL_MS)
    return () => clearInterval(id)
  }, [pairing])

  const run = async (call: () => Promise<TelegramState>, fallback: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    setCopied(false)
    try {
      setState(await call())
      setToken('')
    } catch (e) {
      setError(apiError(e, fallback))
    }
    setBusy(false)
  }

  const connect = () => {
    if (token.trim()) run(() => API.saveTelegram(token), 'Could not connect — check the token and try again.')
  }
  const disconnect = () => run(API.clearTelegram, 'Could not disconnect — check the server and try again.')

  const copy = async () => {
    if (state?.pairingCode) setCopied(await writeClipboard(state.pairingCode))
  }

  const bot = state?.botUsername ? `@${state.botUsername}` : null
  const chatUrl = state?.botUsername ? `https://t.me/${state.botUsername}` : null

  return (
    <SettingsGroup
      label="Telegram"
      sub="Save links from your phone by messaging your own bot. Only links are saved, and whatever you send passes through Telegram's servers on the way."
    >
      <div className="settings-rows">
        {!state?.connected ? (
          <SettingsRow
            key="token"
            title="Bot token"
            desc={
              <>
                Message <code>@BotFather</code> on Telegram, send <code>/newbot</code>, and paste the token it gives
                you.
              </>
            }
            action={
              <span className="telegram-connect">
                <Input
                  type="password"
                  className="wizard-input mono"
                  value={token}
                  placeholder="123456:ABC-DEF…"
                  aria-label="Bot token"
                  disabled={busy || !state}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={e => setToken(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && connect()}
                />
                <Button tone="solid" onClick={connect} disabled={busy || !token.trim()}>
                  {busy ? 'Connecting…' : 'Connect'}
                </Button>
              </span>
            }
          >
            {error && <RowStatus tone="error">{error}</RowStatus>}
          </SettingsRow>
        ) : (
          <SettingsRow
            key="bot"
            title={bot ?? 'Your bot'}
            desc={
              pairing ? (
                'Connected. Pair your chat with it so only you can save through it.'
              ) : (
                <span className="telegram-live">Paired — links you send the bot are saved here.</span>
              )
            }
            action={
              // While pairing, the panel below holds every control, Cancel
              // included — up here a red Disconnect was the first thing on
              // the row, and on a phone a full-width one, above the step the
              // owner had come to take.
              !pairing && (
                <span className="telegram-actions">
                  {chatUrl && (
                    <Button asChild>
                      <a href={chatUrl} target="_blank" rel="noreferrer">
                        Open chat
                      </a>
                    </Button>
                  )}
                  <Button danger onClick={disconnect} disabled={busy}>
                    {busy ? 'Disconnecting…' : 'Disconnect'}
                  </Button>
                </span>
              )
            }
          >
            {pairing && state.pairingCode && (
              <div className="settings-row-extra telegram-pair">
                {chatUrl && (
                  <div className="telegram-pair-step">
                    <Button tone="solid" asChild>
                      <a href={`${chatUrl}?start=${state.pairingCode}`} target="_blank" rel="noreferrer">
                        Open in Telegram
                      </a>
                    </Button>
                    <span className="settings-row-desc">and tap Start.</span>
                  </div>
                )}
                <div className="telegram-pair-step">
                  <span className="settings-row-desc">
                    {chatUrl ? 'Or send it this code:' : 'Send your bot this code:'}
                  </span>
                  <span className="telegram-pairing-code mono">{state.pairingCode}</span>
                  <Button size="xs" tone="ghost" onClick={copy}>
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                <div className="telegram-waiting">
                  <span role="status" aria-live="polite">
                    Waiting for your message…
                  </span>
                  <Button size="xs" tone="ghost" onClick={disconnect} disabled={busy}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            {error && <RowStatus tone="error">{error}</RowStatus>}
          </SettingsRow>
        )}
      </div>
    </SettingsGroup>
  )
}

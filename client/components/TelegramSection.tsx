// TELEGRAM — connect a bot so a message sent to it is captured like anything
// else. Binding needs a pairing code rather than trusting whoever messages
// first, because a bot's username is public the moment BotFather creates it —
// see the rule in server/telegram/ingest.ts, which the code shown here feeds.
import { useEffect, useState } from 'react'
import { SettingsGroup, SettingsRow, RowStatus } from './SettingsRow'
import { API, apiError } from '../data/api'
import type { TelegramState } from '../types'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'

export function TelegramSection() {
  const [state, setState] = useState<TelegramState | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // handleClearTelegram only deletes the config file — the running poll loop
  // still holds the old token and bound chat in its closure and keeps saving
  // until the process restarts, so "disconnected" here is a lie until then.
  // Surfaced at the point of disconnecting, not just in the general restart
  // hint below, because this is the one case where "still running" is a
  // privacy problem rather than a mere inconvenience.
  const [justDisconnected, setJustDisconnected] = useState(false)

  useEffect(() => {
    API.telegram()
      .then(setState)
      .catch(() => {})
  }, [])

  const connect = async () => {
    if (!token.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      setState(await API.saveTelegram(token))
      setToken('')
      setJustDisconnected(false)
    } catch (e) {
      setError(apiError(e, 'Could not connect — check the token and try again.'))
    }
    setBusy(false)
  }

  const disconnect = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      setState(await API.clearTelegram())
      setJustDisconnected(true)
    } catch (e) {
      setError(apiError(e, 'Could not disconnect — check the server and try again.'))
    }
    setBusy(false)
  }

  const desc = !state?.connected
    ? 'Paste the token BotFather gave you when you created the bot.'
    : state.boundChatId !== null
      ? 'Connected — saving to your chat.'
      : 'Connected. Send the pairing code below to the bot to finish binding it to your chat.'

  return (
    <SettingsGroup
      label="TELEGRAM"
      sub={
        <>
          Message a bot to save from your phone. Create one by messaging <code>@BotFather</code> on Telegram and sending
          it <code>/newbot</code>. Only links, plain text and photos are saved — other attachments (files, video, voice
          notes, stickers) are dropped. Whatever you send passes through Telegram's servers before it reaches Kothai.
        </>
      }
    >
      <div className="settings-rows">
        <SettingsRow
          title="Bot"
          desc={desc}
          hint="Takes effect after a restart — polling starts at boot."
          action={
            state?.connected ? (
              <Button danger onClick={disconnect} disabled={busy}>
                {busy ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            ) : (
              <>
                <Input
                  type="password"
                  className="wizard-input mono"
                  value={token}
                  placeholder="Bot token"
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={e => setToken(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && connect()}
                />
                <Button tone="solid" onClick={connect} disabled={busy || !token.trim()}>
                  {busy ? 'Connecting…' : 'Connect'}
                </Button>
              </>
            )
          }
        >
          {state?.connected && state.boundChatId === null && (
            <div className="settings-row-extra">
              <span className="telegram-pairing-code mono">{state.pairingCode}</span>
              <p className="settings-row-desc">Send exactly that, as a message, to the bot to pair it.</p>
            </div>
          )}
          {justDisconnected && !error && (
            <RowStatus tone="ok">Disconnected. The bot keeps saving until you restart Kothai.</RowStatus>
          )}
          {error && <RowStatus tone="error">{error}</RowStatus>}
        </SettingsRow>
      </div>
    </SettingsGroup>
  )
}

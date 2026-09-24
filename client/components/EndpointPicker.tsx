// Provider rows and the key field.
//
// Shared deliberately: first run (views/SetupWizard) and Settings both need
// exactly this, and two copies would drift the moment a provider is added or
// the probe's wording changes.
import { useId, useState } from 'react'
import type { EndpointOption } from '../types'
import { Input } from '../ui/Input'

export interface EndpointChoice {
  providerId: string
  baseUrl: string
  apiKey: string
  defaults: { llm: string; embed: string; vision: string }
}

export function EndpointPicker({
  endpoints,
  preselect,
  keyPlaceholder = 'paste it here',
  onChange,
}: {
  endpoints: EndpointOption[]
  preselect?: string | null
  // Settings already has a key on file, so it says so rather than implying the
  // field is empty because nothing is set.
  keyPlaceholder?: string
  // Fires on every edit, so the parent owns the submit button and its label —
  // "Connect" in first run, "Save" in Settings.
  onChange: (choice: EndpointChoice | null) => void
}) {
  const [picked, setPicked] = useState<EndpointOption | null>(() => endpoints.find(e => e.id === preselect) || null)
  const [key, setKey] = useState('')
  const keyId = useId()

  // Null until the choice could connect: the parent's button stays off
  // without a key rather than letting the server refuse a blank one.
  const publish = (e: EndpointOption, nextKey: string) => {
    const apiKey = e.needsKey ? nextKey.trim() : ''
    onChange(
      e.needsKey && !apiKey ? null : { providerId: e.id, baseUrl: e.baseUrl.trim(), apiKey, defaults: e.defaults },
    )
  }

  // A key belongs to one provider, so switching clears it rather than sending
  // an OpenAI key to OpenRouter.
  const pick = (e: EndpointOption) => {
    setPicked(e)
    setKey('')
    publish(e, '')
  }

  return (
    <>
      {/* Rows with every provider's note showing, not pills that revealed it
          only once picked: the note is what the choice is made on. Drawn as
          the model picker's rows, which is the next thing first run shows. */}
      <div className="wizard-providers">
        {endpoints.map(e => {
          const on = picked?.id === e.id
          return (
            <button
              key={e.id}
              type="button"
              className={`model-row${on ? ' active' : ''}`}
              disabled={!e.available}
              onClick={() => pick(e)}
            >
              <span className="model-radio">{on && <span className="model-radio-dot"></span>}</span>
              <span className="model-main">
                <span className="model-name">{e.label}</span>
                <span className="model-desc">
                  {e.available ? e.note : 'Not on the lite image, which runs nothing on this machine.'}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {picked?.needsKey && (
        <div className="wizard-field">
          <div className="wizard-field-head">
            <label className="wizard-field-label" htmlFor={keyId}>
              {picked.label} API key
            </label>
            {picked.keyUrl && (
              <a className="wizard-key-link" href={picked.keyUrl} target="_blank" rel="noreferrer">
                Get a key ↗
              </a>
            )}
          </div>
          <Input
            id={keyId}
            className="wizard-input mono"
            type="password"
            autoComplete="off"
            value={key}
            placeholder={keyPlaceholder}
            onChange={ev => {
              setKey(ev.target.value)
              publish(picked, ev.target.value)
            }}
          />
          <p className="wizard-field-hint">Kept on this machine only. It never appears in a backup or an export.</p>
        </div>
      )}
    </>
  )
}

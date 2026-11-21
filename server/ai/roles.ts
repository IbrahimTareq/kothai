// The AI roles and the status and error shapes every provider reports them in.

export const ROLES = ['llm', 'embed', 'vision'] as const

// Derived from the list above rather than written out beside it: a second
// spelling of the role set is a second thing to forget. This module owns the
// union — every other module imports it from here.
export type Role = (typeof ROLES)[number]

// Thrown when a role cannot serve a request. The `code` field ends up in API
// error payloads so the client can render a proper disabled state. The
// default cause is the role being off; the remote provider passes an override
// for causes config can fix (bad API key, unknown model name), so routes and
// client keep one error shape to handle.
export class FeatureDisabledError extends Error {
  role: Role
  code: string

  constructor(role: Role, { code, message }: { code?: string; message?: string } = {}) {
    super(message || `The ${role} model is turned off — enable it in Settings.`)
    this.role = role
    this.code = code || `${role}_off`
  }
}

export interface RoleStatus {
  state: 'idle' | 'loading' | 'ready' | 'error' | 'off'
  progress: number
  message: string
  model: string
}

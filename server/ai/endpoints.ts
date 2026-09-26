// Known OpenAI-compatible endpoints — pure data, no imports, in the spirit of
// presets.ts. This is what lets first-run offer "OpenAI" as a tile instead of
// asking for a base URL and three model ids.
//
// `defaults` are SEEDS, not assertions. The endpoint's own /v1/models is the
// source of truth and the wizard fills the fields from it where it can; a
// stale default surfaces as validateModel's existing warning rather than a
// rejection, so a model id that ages out never blocks setup.
//
// `servesEmbeddings` is the one field with teeth. Some hosted endpoints expose
// no /embeddings route at all (see ai/routing.ts), and semantic search needs
// one — so the installer reads this to decide whether a provider can run on the
// lite image or needs the full one, where the embedding role stays on-device.
//
// Every entry here currently serves embeddings, and that is the point: a tile
// on the first-run screen is a recommendation, and recommending an endpoint
// that cannot do half the job is not one. Chat-only services still work — by
// --endpoint, or KOTHAI_AI_BASE_URL, or by typing the model names in Settings —
// they are just not offered as a one-click answer. The field stays because
// resolveRoleProviders still has to handle an endpoint configured that way.
//
// It is a claim about somebody else's product, so check it rather than assume,
// and check the RIGHT list: a provider's chat-model catalogue says nothing
// about whether it serves embeddings. OpenRouter was wrong here for exactly
// that reason — its embedding models are absent from /v1/models and sit behind
// /v1/embeddings/models instead.
//
//   openrouter    curl -s https://openrouter.ai/api/v1/embeddings/models
//   ollama cloud  curl -s https://ollama.com/api/tags      (chat only, checked
//                 2026-09-16; ollama.com/search?c=cloud&c=embedding is empty —
//                 its embedding models are pull-and-run-yourself, not hosted)
//   groq          needs a key even to list models; unverified here.

import type { Role } from './roles.ts'

export interface Endpoint {
  id: string
  label: string
  baseUrl: string
  needsKey: boolean
  servesEmbeddings: boolean
  note: string
  // Where the key is made. The key field is where first run stalls for
  // anyone who has not got one yet, so the tile says where to go.
  keyUrl?: string
  // Runs beside Kothai rather than as a hosted service. Greyed on the lite
  // image, beside first run's own "On this machine": lite is what Railway
  // runs, where there is no machine of the user's beside Kothai to reach.
  onThisMachine?: boolean
  // Only the endpoints whose embedding catalogue lives off /v1/models carry
  // this — see the OpenRouter entry below.
  embeddingsPath?: string
  // A route that answers only to a valid key, for an endpoint whose /models
  // answers anyone — without it the connection check passes any key at all.
  keyCheckPath?: string
  defaults: Record<Role, string>
}

// There was an 'ollama-railway' entry, for an Ollama deployed beside Kothai by
// a Railway template. Retired: Railway has no GPUs, and on its shared CPU
// llama3.2:3b took 41-84s to classify one note against a 60s budget, with
// captioning off entirely. Railway installs use a hosted endpoint; Ollama
// belongs on the user's own hardware. An install that chose it keeps working —
// the base URL lives in its credential file, not here.
export const ENDPOINTS: Endpoint[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    servesEmbeddings: true,
    note: 'Needs API credit — a ChatGPT subscription is a different thing.',
    keyUrl: 'https://platform.openai.com/api-keys',
    // Vision is gpt-4.1-mini, not the llm's gpt-4o-mini: 4o-mini bills an
    // image at 2,833 tokens plus 5,667 per 512px tile, ~25.5k for a 540×960
    // reel cover, and a 1,800-post Instagram import spent ~$4 of a $5 cap on
    // cover frames alone. 4.1-mini bills 32px patches ×1.62: ~830 tokens.
    defaults: { llm: 'gpt-4o-mini', embed: 'text-embedding-3-small', vision: 'gpt-4.1-mini' },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    servesEmbeddings: true,
    note: 'One key for models from many companies, billed in one place.',
    keyUrl: 'https://openrouter.ai/settings/keys',
    // Its embedding models are NOT in GET /v1/models, which lists chat models
    // only; they live behind their own path, which the provider probes as well
    // so the embedding field offers the thirty-odd real answers rather than
    // four hundred wrong ones. Verify with:
    //   curl -s https://openrouter.ai/api/v1/embeddings/models | jq '.data[].id'
    embeddingsPath: '/embeddings/models',
    // /models answers a made-up key with 200; /key answers it with 401.
    //   curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer x' https://openrouter.ai/api/v1/key
    keyCheckPath: '/key',
    // Vision for the same reason as OpenAI's entry above.
    defaults: { llm: 'openai/gpt-4o-mini', embed: 'openai/text-embedding-3-small', vision: 'openai/gpt-4.1-mini' },
  },
  {
    id: 'ollama-local',
    label: 'Ollama on this machine',
    // host.docker.internal resolves to the host from inside the container on
    // Docker Desktop; on Linux the installer adds --add-host for it.
    baseUrl: 'http://host.docker.internal:11434/v1',
    needsKey: false,
    servesEmbeddings: true,
    onThisMachine: true,
    note: 'Nothing leaves your machine, and you manage the models in Ollama.',
    defaults: { llm: 'llama3.2:3b', embed: 'nomic-embed-text', vision: 'llama3.2-vision' },
  },
]

// Nullable on purpose: getAiConfig() reports providerId: null whenever the
// endpoint came from KOTHAI_AI_BASE_URL rather than the first-run wizard, and
// that path must resolve to "no catalogue entry", not throw.
export function findEndpoint(id: string | null | undefined): Endpoint | null {
  return ENDPOINTS.find(e => e.id === id) || null
}

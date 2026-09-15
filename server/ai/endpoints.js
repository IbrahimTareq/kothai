// Known OpenAI-compatible endpoints — pure data, no imports, in the spirit of
// presets.js. This is what lets first-run offer "OpenAI" as a tile instead of
// asking for a base URL and three model ids.
//
// `defaults` are SEEDS, not assertions. The endpoint's own /v1/models is the
// source of truth and the wizard fills the fields from it where it can; a
// stale default surfaces as validateModel's existing warning rather than a
// rejection, so a model id that ages out never blocks setup.
//
// `servesEmbeddings` is the one field with teeth. Some hosted endpoints expose
// no /embeddings route at all (see ai/routing.js), and semantic search needs
// one — so the installer reads this to decide whether a provider can run on the
// lite image or needs the full one, where the embedding role stays on-device.
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

export const ENDPOINTS = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    servesEmbeddings: true,
    note: 'Needs API credit — a ChatGPT subscription is a different thing.',
    defaults: { llm: 'gpt-4o-mini', embed: 'text-embedding-3-small', vision: 'gpt-4o-mini' },
  },
  {
    id: 'ollama-cloud',
    label: 'Ollama Cloud',
    baseUrl: 'https://ollama.com/v1',
    needsKey: true,
    servesEmbeddings: false,
    note: 'Serves no embeddings, so search by meaning needs a model on your machine.',
    defaults: { llm: 'gpt-oss:120b', embed: '', vision: '' },
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    needsKey: true,
    servesEmbeddings: false,
    note: 'Very fast, and serves no embeddings.',
    defaults: { llm: 'llama-3.3-70b-versatile', embed: '', vision: '' },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    servesEmbeddings: true,
    note: 'One key, many models — including embeddings, so nothing runs here.',
    // Its embedding models are NOT in GET /v1/models, which lists chat models
    // only; they live behind their own path, which the provider probes as well
    // so the embedding field offers the thirty-odd real answers rather than
    // four hundred wrong ones. Verify with:
    //   curl -s https://openrouter.ai/api/v1/embeddings/models | jq '.data[].id'
    embeddingsPath: '/embeddings/models',
    defaults: { llm: 'openai/gpt-4o-mini', embed: 'openai/text-embedding-3-small', vision: 'openai/gpt-4o-mini' },
  },
  {
    id: 'ollama-local',
    label: 'Ollama on this machine',
    // host.docker.internal resolves to the host from inside the container on
    // Docker Desktop; on Linux the installer adds --add-host for it.
    baseUrl: 'http://host.docker.internal:11434/v1',
    needsKey: false,
    servesEmbeddings: true,
    note: 'Nothing leaves your machine, and you manage the models in Ollama.',
    defaults: { llm: 'llama3.2:3b', embed: 'nomic-embed-text', vision: 'llama3.2-vision' },
  },
  {
    id: 'other',
    label: 'Something else',
    baseUrl: '',
    needsKey: false,
    servesEmbeddings: true,
    note: 'Any OpenAI-compatible endpoint — llama.cpp server, vLLM, LM Studio.',
    defaults: { llm: '', embed: '', vision: '' },
  },
]

export function findEndpoint(id) {
  return ENDPOINTS.find((e) => e.id === id) || null
}

// Which of an endpoint's models are plausible answers for a given role.
//
// /v1/models is a catalogue of everything the provider sells — OpenAI returns
// about seventy ids, of which roughly four are sensible for any one role. The
// rest are image, audio, moderation and legacy completion models. Offering all
// of them for all three roles is noise, and it is what made the old datalist
// useless in practice.
//
// Matching is on NAME, which is unavoidable: /v1/models reports no
// capabilities, just ids. So this is a heuristic, and it is built to fail in
// the safe direction — anything it cannot classify stays reachable under
// `rest`, and a catalogue it recognises nothing in returns everything as
// `matched` rather than an empty list. It narrows; it never hides.

export type Role = 'llm' | 'embed' | 'vision'

// Never a sensible answer for any of our three roles, whatever the provider.
const NEVER = [
  /(^|[-/])dall-e/i, /(^|[-/])tts(-|$)/i, /whisper/i, /moderation/i,
  /(^|[-/])sora/i, /image-(gen|edit)/i, /^stable-diffusion/i, /(^|[-/])rerank/i,
  /audio|realtime|transcribe|speech/i,
]

const EMBED = [/embed/i, /^text-embedding/i, /(^|[-/])bge(-|$)/i, /(^|[-/])gte(-|$)/i, /e5-(small|base|large)/i]

// Vision is the hardest to infer: most providers fold it into their general
// chat models and say so nowhere in the id. An explicit marker is trusted, and
// otherwise the model families that are multimodal across the board.
const VISION = [/vision/i, /(^|[-/])vl(-|:|$)/i, /multimodal/i, /llava/i, /gpt-4o/i, /gpt-4\.1/i, /claude-3/i, /gemini/i, /pixtral/i]

const anyOf = (patterns: RegExp[], id: string) => patterns.some((re) => re.test(id))

function isCandidate(role: Role, id: string): boolean {
  if (anyOf(NEVER, id)) return false
  const embedding = anyOf(EMBED, id)
  if (role === 'embed') return embedding
  // Language and vision are both chat roles, so an embedding model is wrong
  // for either.
  if (embedding) return false
  if (role === 'vision') return anyOf(VISION, id)
  // Language: anything left that is not obviously something else. Legacy
  // completion-only models are excluded — they cannot hold a conversation.
  return !/^(babbage|davinci|curie|ada)(-|$)/i.test(id)
}

// `matched` is what to show first; `rest` is everything else, kept so the list
// can always be expanded. Splitting rather than filtering is the whole point:
// a heuristic that silently drops the model someone needs is worse than no
// heuristic at all.
export function relevantModels(role: Role, ids: string[]): { matched: string[]; rest: string[] } {
  const matched: string[] = []
  const rest: string[] = []
  for (const id of ids) (isCandidate(role, id) ? matched : rest).push(id)
  // Nothing recognised: the catalogue uses names this rule knows nothing
  // about, so offering all of it beats offering none of it.
  if (!matched.length) return { matched: [...ids], rest: [] }
  return { matched, rest }
}

// Filler for the settings table's NOT NULL llm/embed/vision columns, which
// held the removed on-device provider's model keys and cannot be dropped (see
// the column notes in data/db.ts). Nothing reads these as a model to run.

import type { Role } from './roles.ts'

export const DEFAULTS: Record<Role, string> = {
  llm: 'QWEN3_1_7B_INST_Q4',
  embed: 'EMBEDDINGGEMMA_300M_Q8_0',
  vision: 'QWEN3_5_2B_MULTIMODAL_Q4_K_M',
}

// Curated model presets per role — pure data, no SDK import.
//
// Kept separate from providers/local.js because the settings store needs
// DEFAULTS even in the lite image, where no local provider exists at all
// (the settings table's llm/embed/vision columns are NOT NULL).
//
// `best` marks the sweet spot per device class (Raspberry Pi / Apple
// Silicon). Byte sizes are NOT here — they come from the SDK's registry and
// are resolved by the local provider's presetInfo().

export const PRESETS = {
  llm: [
    { key: 'QWEN3_600M_INST_Q4', label: 'Qwen3 0.6B', desc: 'Tiny and quick — answers in seconds even on a Raspberry Pi 4.', best: ['pi'] },
    { key: 'LLAMA_3_2_1B_INST_Q4_0', label: 'Llama 3.2 1B', desc: 'Light with solid quality — a good Raspberry Pi 5 pick.', best: ['pi'] },
    { key: 'QWEN3_1_7B_INST_Q4', label: 'Qwen3 1.7B', desc: 'Balanced default — usable on a Pi 5, snappy on Apple Silicon.', best: ['pi', 'm2'] },
    { key: 'QWEN3_4B_INST_Q4_K_M', label: 'Qwen3 4B', desc: 'Noticeably smarter classification and answers — recommended on M-series Macs.', best: ['m2'] },
    { key: 'QWEN3_8B_INST_Q4_K_M', label: 'Qwen3 8B', desc: 'Highest quality — wants 16 GB RAM; not for the Pi.', best: [] },
  ],
  embed: [
    { key: 'EMBEDDINGGEMMA_300M_Q4_0', label: 'EmbeddingGemma Q4', desc: 'Smallest footprint for semantic search — Raspberry Pi pick.', best: ['pi'] },
    { key: 'EMBEDDINGGEMMA_300M_Q8_0', label: 'EmbeddingGemma Q8', desc: 'Balanced default — excellent quality for its size.', best: ['pi', 'm2'] },
    { key: 'GTE_LARGE_FP16', label: 'GTE Large', desc: 'Strongest retrieval quality — heavier per-note indexing.', best: ['m2'] },
  ],
  vision: [
    { key: 'SMOLVLM2_500M_MULTIMODAL_Q8_0', proj: 'MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0', label: 'SmolVLM2 0.5B', desc: 'Tiny image captioner — keeps the Raspberry Pi responsive.', best: ['pi'] },
    { key: 'QWEN3_5_2B_MULTIMODAL_Q4_K_M', proj: 'MMPROJ_QWEN3_5_2B_MULTIMODAL_F16', label: 'Qwen3.5-VL 2B', desc: 'Balanced default — newer generation, strong image understanding.', best: ['m2'] },
    { key: 'QWEN3_5_4B_MULTIMODAL_Q4_K_M', proj: 'MMPROJ_QWEN3_5_4B_MULTIMODAL_F16', label: 'Qwen3.5-VL 4B', desc: 'Richest image descriptions — compact enough for Apple Silicon.', best: [] },
  ],
}

export const DEFAULTS = { llm: 'QWEN3_1_7B_INST_Q4', embed: 'EMBEDDINGGEMMA_300M_Q8_0', vision: 'QWEN3_5_2B_MULTIMODAL_Q4_K_M' }

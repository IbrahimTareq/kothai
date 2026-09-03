<script setup lang="ts">
// Every page ends with the brand name set enormous and almost invisible. That
// is the whole footer — no links, no legal line.
//
// The viewBox is "kothai" measured as an ink box in Geist at weight 460 with
// the heading's tracking, so the word scales to the content width without
// stretched letterforms. The glyphs sit 8 units in from the sides and 6 from
// the top and bottom: the ink box is exact, and an exact fit means any
// rounding or a font that renders a hair wide clips the final letter.
</script>

<template>
  <footer class="kt-footer">
    <svg
      class="kt-wordmark"
      viewBox="0 0 531.35 157"
      role="img"
      aria-label="Kothai"
      preserveAspectRatio="xMidYMid meet"
    >
      <text x="-7.43" y="148.6">kothai</text>
    </svg>
  </footer>
</template>

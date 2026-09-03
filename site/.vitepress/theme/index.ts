// The default VitePress theme, reskinned. The only component is the footer —
// everything else is CSS variables plus a handful of structural rules in
// custom.css, which is far less to keep working across upgrades.
import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import Footer from './Footer.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { 'layout-bottom': () => h(Footer) }),
}

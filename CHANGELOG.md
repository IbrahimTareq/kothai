# Changelog

## [2.0.0](https://github.com/IbrahimTareq/kothai/compare/v1.4.0...v2.0.0) (2026-09-26)


### ⚠ BREAKING CHANGES

* POST /api/save refuses anything that is not a link, and the Telegram bot no longer saves text or photos.

### Features

* **ai:** retire the Ollama-on-Railway endpoint; Railway uses a hosted one ([ae6cc44](https://github.com/IbrahimTareq/kothai/commit/ae6cc4427aa97bd0d4dd275f6b1383cf20fa78a6))
* **availability:** check Instagram, X and YouTube, and remove dead links from Everything ([8087ea3](https://github.com/IbrahimTareq/kothai/commit/8087ea3827dff08bd80755c797a364008d2db27a))
* **backup:** back the library up daily to data/backups ([372bc49](https://github.com/IbrahimTareq/kothai/commit/372bc494a1aba760d792e3a66bfc688c7f906379))
* **backup:** copy the daily backup to Google Drive, and restore from it ([4ba1281](https://github.com/IbrahimTareq/kothai/commit/4ba128138ef31639708d619f5fee1d0d1627c065))
* **backup:** restore a backup from Settings, and back up uploads too ([bfd0794](https://github.com/IbrahimTareq/kothai/commit/bfd0794cd0330aab64344db27bb9cd73cd324677))
* **board:** animate a filter change instead of cutting to the new set ([43acdf7](https://github.com/IbrahimTareq/kothai/commit/43acdf7daa73bffda71a08b9d8f24bdb32a8da6d))
* **canvas:** replace columns with Miro-style frames ([a62e209](https://github.com/IbrahimTareq/kothai/commit/a62e209cbeb9c6c52f01e779bd5c793beab007f6))
* **capture:** a save-only token for scripts and Shortcuts ([e3e4db1](https://github.com/IbrahimTareq/kothai/commit/e3e4db1ff4d8a4c3e54daa0e85a547ed961ee4c0))
* **demo:** a public demo mode, read-only apart from links and questions ([8d287ac](https://github.com/IbrahimTareq/kothai/commit/8d287ac54d3af9256899d9b8dcfa8a88dff5f4e2))
* **demo:** let a visitor change what they made ([00feed6](https://github.com/IbrahimTareq/kothai/commit/00feed62430b2c483935d168ba89b4786b49a302))
* **demo:** let a visitor give a new space its smart tags ([cf9fa83](https://github.com/IbrahimTareq/kothai/commit/cf9fa830f21eb4d9af240b7f2364c203fba6f763))
* **demo:** let a visitor make a few spaces of their own ([38c0ccd](https://github.com/IbrahimTareq/kothai/commit/38c0ccdd322d8a8eaa58f00bae442dd89454f183))
* **demo:** put Instagram posts and TikToks in the shared library ([568da04](https://github.com/IbrahimTareq/kothai/commit/568da0405c9fbc9c9ce31a83c0972d71df4bd8a2))
* **demo:** seed the shared library and pick models at boot ([39311a7](https://github.com/IbrahimTareq/kothai/commit/39311a7c241367c59140f862a7f09b38ce8bd0fa))
* **demo:** seed three shared spaces with the library ([60d196a](https://github.com/IbrahimTareq/kothai/commit/60d196aa7cb1e72c892b33330a2cea2a7867dcba))
* **demo:** show the demo in the app, and lock what it refuses ([7766dfb](https://github.com/IbrahimTareq/kothai/commit/7766dfb4718b359c40cb48d0ca9ab9961a93c60d))
* **demo:** suggest questions, and show a shared space's canvas ([aa2dddf](https://github.com/IbrahimTareq/kothai/commit/aa2dddf963569b8af18d4f04c70e107307e811c7))
* **demo:** suggest the library's tags on a new space's draft card ([2191165](https://github.com/IbrahimTareq/kothai/commit/2191165c8407fedc2d6628ff3e287740eea7e00a))
* **demo:** unlock a visitor's own links, spaces and chats in the app ([2aecf3c](https://github.com/IbrahimTareq/kothai/commit/2aecf3c7e835f1b963bd247402e32ab5946a84ba))
* **design:** a /ui playground of every primitive, dev only ([b1c6fe6](https://github.com/IbrahimTareq/kothai/commit/b1c6fe6e74b203c8ff1e91035ad060ba858685de))
* **design:** draw every pick-one control with a Radix Segmented ([905acbe](https://github.com/IbrahimTareq/kothai/commit/905acbe9e3ef56579ac61b7aaaf221eef1cf9043))
* **design:** draw every pill with Chip ([5e11e78](https://github.com/IbrahimTareq/kothai/commit/5e11e785e41a3eb1b9752e9e98ca98b545e0a4d0))
* **design:** give every page one header with PageHeader ([5c4b91a](https://github.com/IbrahimTareq/kothai/commit/5c4b91a9ee6b1b1c3803514d158a50e175c9828a))
* **design:** name every glyph with a Radix Tooltip ([4b0109e](https://github.com/IbrahimTareq/kothai/commit/4b0109e0c59a2e36df5ac9c452dba318696b6c3e))
* **design:** one Confirm for every irreversible action ([f340e82](https://github.com/IbrahimTareq/kothai/commit/f340e82515f573a687e6cf6d3453960a7af815a9))
* **design:** one eyebrow for every small caps label ([d1e3d3d](https://github.com/IbrahimTareq/kothai/commit/d1e3d3de406c853078cb6f70981b8e2bb6d1562b))
* **design:** one field box with Input and Textarea, and ratchet raw fields ([d4ebed8](https://github.com/IbrahimTareq/kothai/commit/d4ebed86b0d0b88d0ae0353d860004f854ca03ca))
* **design:** put line-heights on the leading scale, and ratchet pixel sizes ([cc7d642](https://github.com/IbrahimTareq/kothai/commit/cc7d642a6fc9fb75f57318da6f89ca8e4765f75e))
* **design:** ratchet raw &lt;button&gt; outside client/ui ([52470fc](https://github.com/IbrahimTareq/kothai/commit/52470fcc7a516ae5447a600c006dc4e81b9742d2))
* **design:** replace three hand-built pickers with Radix Menu and Popover ([b54dd71](https://github.com/IbrahimTareq/kothai/commit/b54dd7147e615eeb3718efcbdf25e6767e4f6936))
* **import:** label each Instagram post once, from its caption, and show what's still tagging ([7a50822](https://github.com/IbrahimTareq/kothai/commit/7a50822a8c73ea54440bd074e7a9b4b10fa67d05))
* save links only ([4c6d41f](https://github.com/IbrahimTareq/kothai/commit/4c6d41f3454714844563d3e3b3ebe51b45a58100))
* **spaces:** give the Spaces landing a cover mosaic and an in-place draft card ([0832195](https://github.com/IbrahimTareq/kothai/commit/0832195b28fa76794a11974d4a3488109e816a2c))
* **spaces:** name a space's auto-add tags and give its empty state a way out ([4213b48](https://github.com/IbrahimTareq/kothai/commit/4213b48c8c2cb5e40caa4935cd0655d2b7e97a49))
* **spaces:** refresh and animate the board when a rule tag adds members ([f3c89aa](https://github.com/IbrahimTareq/kothai/commit/f3c89aaf35d64798932eae4cd10f5e7893156b35))
* **telegram:** connect and pair without restarting Kothai ([f45ac70](https://github.com/IbrahimTareq/kothai/commit/f45ac70559afce50300db395f3e69f95c660089e))
* **telegram:** lead each bot reply with an emoji ([e50ceef](https://github.com/IbrahimTareq/kothai/commit/e50ceef256c07a3296987aa4cce0fbad0928f0bb))
* **theme:** crossfade the page when switching light and dark ([3f4ea22](https://github.com/IbrahimTareq/kothai/commit/3f4ea2247756b5434ed90ffd14e8442d8c68cb8c))
* **ui:** give Everything's search the whole header row on phones ([3cc9ca9](https://github.com/IbrahimTareq/kothai/commit/3cc9ca9af3dcfd43ecfa33bda980ab6b5c573b86))


### Bug Fixes

* **a11y:** drop the movement from every animation under reduced motion ([8707721](https://github.com/IbrahimTareq/kothai/commit/8707721b870214fc9bef613ec6691e3648ceac3c))
* **a11y:** make the item view and quick capture real dialogs ([30a299c](https://github.com/IbrahimTareq/kothai/commit/30a299c79fe63a9207c6374bec7cd7fa18fdf21e))
* **a11y:** one monochrome focus ring, and no bare outline:none ([1ea4710](https://github.com/IbrahimTareq/kothai/commit/1ea4710e0d213a55a094ef941072404d7e19df86))
* **ai:** a model one role cannot use no longer takes down the others ([6f2dd0e](https://github.com/IbrahimTareq/kothai/commit/6f2dd0efadc2465c4f379029a59450eb2bfbb669))
* **ai:** describe images with gpt-4.1-mini, not gpt-4o-mini ([062a9db](https://github.com/IbrahimTareq/kothai/commit/062a9dbc84e32c9a62707e10ec7f44f6cd96bf24))
* **availability:** judge each lane on its own, and only offer removal for what is on screen ([423b6ef](https://github.com/IbrahimTareq/kothai/commit/423b6ef34edb3d9b7512188dade6c1c38131cef1))
* **canvas:** sentence-case the frame name and empty hint ([2b04661](https://github.com/IbrahimTareq/kothai/commit/2b046619b615ae84b04cd46025d198276db86e23))
* **capture:** name the quick-capture composer's icon buttons ([feda283](https://github.com/IbrahimTareq/kothai/commit/feda283c2ff490cf718cdda3f70a8759aeb449cd))
* **classify:** drop the filler a model invents from a bare URL ([47d8b87](https://github.com/IbrahimTareq/kothai/commit/47d8b8780bbbdc3508f18977a7816e0fa4a18ff1))
* **demo:** forget a visitor's tags at the nightly reset ([e9a6dba](https://github.com/IbrahimTareq/kothai/commit/e9a6dbafba071124653d1b6ebf3a7ab5ef172628))
* **demo:** make Settings a preview of your own install, not a dead end ([0990678](https://github.com/IbrahimTareq/kothai/commit/09906788124c66cd46b6354981ff39e3a7825974))
* **demo:** say so when there is no prebuilt library ([81ee038](https://github.com/IbrahimTareq/kothai/commit/81ee038f2da79e5a91b3fa31abda8861166415ee))
* **demo:** ten questions a visitor a day, not thirty ([b5784e8](https://github.com/IbrahimTareq/kothai/commit/b5784e813e4871e2088c4f1b475352115bb8a6f8))
* **design:** draw both combobox lists' rows as .menu-item ([07d8107](https://github.com/IbrahimTareq/kothai/commit/07d810759d993f1eba30b436d0138113a037f9e9))
* **design:** one scrim for media controls, and a red that reads on it ([08ef1d6](https://github.com/IbrahimTareq/kothai/commit/08ef1d63ce73c0b12dca02c2d8239deaeec9dce4))
* **enrich:** let the boot sweeps reach Instagram posts without a siteTitle ([f106e94](https://github.com/IbrahimTareq/kothai/commit/f106e9488d4e707aad7ff384b768c1e3d52b33dd))
* **enrich:** settle notes a restart left pending ([9fcfa6d](https://github.com/IbrahimTareq/kothai/commit/9fcfa6d0d0bd55ba3bd55443b98cce3dc0649182))
* **gallery:** hide sort and columns until the library has three items ([d77ebde](https://github.com/IbrahimTareq/kothai/commit/d77ebde26a77792241ff72a0f0b305e763b9bf0f))
* **gallery:** keep filter chip counts in sync on add and remove ([da8bc18](https://github.com/IbrahimTareq/kothai/commit/da8bc18c693f657863d3cfbba4809c4c470cc503))
* **gallery:** stop an older page putting back stale chip counts ([2405578](https://github.com/IbrahimTareq/kothai/commit/2405578727b6adab86eba2aaecaaaa46c2cfb816))
* **import:** recognise a re-downloaded "saved_posts (1).json" ([ec9271e](https://github.com/IbrahimTareq/kothai/commit/ec9271e5a43e4f67c810671d22c7269efbdb7220))
* **lint-shape:** skip tracked files deleted from disk but not yet staged ([226ca82](https://github.com/IbrahimTareq/kothai/commit/226ca828d6268a1bc3a01948c8d74121e8f58fc3))
* **mobile:** bring menu rows and quick capture's buttons to 44px on touch ([a872576](https://github.com/IbrahimTareq/kothai/commit/a8725760d61e7243f6ab77c3a0702ca657fb072a))
* **notes:** re-type notes saved as "image" or "text" before links-only ([ef40555](https://github.com/IbrahimTareq/kothai/commit/ef405553d4d88a211ded5e9dcfaa91210aadcc4e))
* **onboarding:** check an OpenRouter key where OpenRouter checks it ([4f0393c](https://github.com/IbrahimTareq/kothai/commit/4f0393c12b096d200d7eef8953bbc748315ff7c1))
* **onboarding:** grey out "On this machine" on the lite image instead of hiding it ([9530cde](https://github.com/IbrahimTareq/kothai/commit/9530cdefd94bc4e5e8033660d7795f3760e01901))
* **onboarding:** redesign "Connect a service" and check the key before saving ([87d0bba](https://github.com/IbrahimTareq/kothai/commit/87d0bba8563134d34ddaf662082f68982b0c064f))
* **remote:** never retry a request that timed out ([23ee50c](https://github.com/IbrahimTareq/kothai/commit/23ee50ccf9de0e1a07ec64dc3b2a35407d0ddfe6))
* **settings:** clearing an endpoint model name switches that role off ([34aa2c6](https://github.com/IbrahimTareq/kothai/commit/34aa2c6581ed6cd699e59e14f365fabd0e52ea6f))
* **settings:** put the endpoint model list on an anchored Popover ([34f077b](https://github.com/IbrahimTareq/kothai/commit/34f077b0de149fa66ba48561e1817515cc7128ed))
* **spaces:** let the delete confirm stand alone in the space header ([1e24a14](https://github.com/IbrahimTareq/kothai/commit/1e24a143f4f8bb8387ab9daa5ee2f496bfd6b834))
* **ui:** cut the type ladder from twelve steps to seven ([a852383](https://github.com/IbrahimTareq/kothai/commit/a852383c5414df78a8559465e0be076b824fda9c))
* **ui:** give text fields the page's font, so renaming a space keeps its type ([566f3b5](https://github.com/IbrahimTareq/kothai/commit/566f3b5a4f92f6756ff5bcd506cce76bebabf969))
* **ui:** keep a clear band under the page header when scrolled ([7623bf5](https://github.com/IbrahimTareq/kothai/commit/7623bf5b55a197153393f34996a1f49855fc2744))
* **ui:** stop a fresh save reading "scheduled" until a reload ([6eb5a74](https://github.com/IbrahimTareq/kothai/commit/6eb5a74a0d7eb4765bb50478532a3bc1a6c726f7))
* **ui:** two typefaces, two jobs — mono only for literal text ([449b3e9](https://github.com/IbrahimTareq/kothai/commit/449b3e9938e931bfb518560c537487dc18432e97))


### Performance Improvements

* **links:** get a demo's pictures up in seconds, not minutes ([d0d75fa](https://github.com/IbrahimTareq/kothai/commit/d0d75fa59d8071d343cba28bed8a61e745a6784e))

## [1.4.0](https://github.com/IbrahimTareq/kothai/compare/v1.3.0...v1.4.0) (2026-09-24)


### Features

* Add dark logo ([6b0c9f4](https://github.com/IbrahimTareq/kothai/commit/6b0c9f45968355769b6c08c245a0d78a1123fa1d))
* **agent:** move code rules into .claude/clean-code-rules.md ([1f23be9](https://github.com/IbrahimTareq/kothai/commit/1f23be9f418762d75f0c71428383363591385991))
* **governance:** add Stop hook running the suite before a turn can end ([c832158](https://github.com/IbrahimTareq/kothai/commit/c8321589bab19c9f8bb1cf51951ca216a85b7116))
* **governance:** add three project skills (tier 2) ([77b9f5a](https://github.com/IbrahimTareq/kothai/commit/77b9f5a385a7410ab9bb8ab1e53153ec980fc73c))
* **install:** show the wordmark before the installer asks anything ([27099d6](https://github.com/IbrahimTareq/kothai/commit/27099d6c67b25c4a8ce53c630a5a4c94f8466f49))
* **lint:** ratchet file size and export count ([1fca90b](https://github.com/IbrahimTareq/kothai/commit/1fca90b7bd3a8fc8ff08fbe64b428b38b4184344))
* **lint:** turn on Biome's linter and enforce the client/server boundary ([765cbf4](https://github.com/IbrahimTareq/kothai/commit/765cbf4c1af845ecf6d999e1540d61d5ce3954df))
* **server:** add the server's own domain types ([45f7fd6](https://github.com/IbrahimTareq/kothai/commit/45f7fd670787c4daf288a70970c4ae023a9f3df8))
* **server:** turn on checkJs for server/lib, the security floor ([91d9290](https://github.com/IbrahimTareq/kothai/commit/91d92900e6f647b0b7054c9633f8c83ce2ebacab))
* **telegram:** acknowledge updates only after they persist ([4132cf4](https://github.com/IbrahimTareq/kothai/commit/4132cf4c8b395edc179f48b5f86b236eb02aaeea))
* **telegram:** add the bot API client ([b4f2a03](https://github.com/IbrahimTareq/kothai/commit/b4f2a03eae17f6174172d3d34c387773d65da883))
* **telegram:** bind to one chat and drop every other silently ([8029b2f](https://github.com/IbrahimTareq/kothai/commit/8029b2f2b7fd027f9451309653a3f3cf3f463633))
* **telegram:** connect and disconnect the bot from Settings ([6cc40f1](https://github.com/IbrahimTareq/kothai/commit/6cc40f18184d6028ebc48e44511ef3181b20f772))
* **telegram:** start capture at boot when a token is configured ([1f8be51](https://github.com/IbrahimTareq/kothai/commit/1f8be51cd4d893a1cc45d56ced03b5fc175449e1))
* **telegram:** store the bot token outside SQLite ([6d0ca3e](https://github.com/IbrahimTareq/kothai/commit/6d0ca3e5e68c5bace5c547028ca6324835943514))
* Update logo ([c9fc662](https://github.com/IbrahimTareq/kothai/commit/c9fc6625430f344db372fc45cc82655cb11149f7))
* Update README ([a542740](https://github.com/IbrahimTareq/kothai/commit/a542740b1ae2419fb8c8574af272bd35d9a46b15))
* Update README ([3161e5e](https://github.com/IbrahimTareq/kothai/commit/3161e5e708eb1a7fd98d1607e50c2d24001d0aa9))
* Update README ([8f557b1](https://github.com/IbrahimTareq/kothai/commit/8f557b1b281422ea10f6da2f63a8d7a7ff13cd97))


### Bug Fixes

* **ai:** tag what a save is about, not what its cover frame shows ([959a5a8](https://github.com/IbrahimTareq/kothai/commit/959a5a8197bc9e1bb6b3c94a3f572be529338a2f))
* **data:** strip stored &lt;think&gt; blocks from thumbnail descriptions ([69ccf09](https://github.com/IbrahimTareq/kothai/commit/69ccf091cf380cdf36131d5bae6e5eb52262d458))
* **docker:** build the client stage with the bundler, not the full gate ([4af3def](https://github.com/IbrahimTareq/kothai/commit/4af3defe93ac8f5bf07c3a61df6ba13100be9dcb))
* **governance:** close the verify.sh Stop-gate blind spots ([ab1b800](https://github.com/IbrahimTareq/kothai/commit/ab1b800f2904e53af3f970fe6c6974964476b227))
* **governance:** make the governance system govern itself ([abdfd3c](https://github.com/IbrahimTareq/kothai/commit/abdfd3c0e9221fe66cd5de65790bfbddc5746ff8))
* **governance:** stop counting type-only exports in the shape ratchet ([fac60a3](https://github.com/IbrahimTareq/kothai/commit/fac60a3c4bba610d0e12cc648c34bb1d513798e9))
* **install:** make the installer parse again, and keep paths intact on update ([a81b375](https://github.com/IbrahimTareq/kothai/commit/a81b3757165045e8223afa70fad23d8f2e75f050))
* **lint-shape:** stop --update from laundering the growth it should catch ([200ffd6](https://github.com/IbrahimTareq/kothai/commit/200ffd618b82cebc73e76dddee5812150edf0a14))
* **release:** guard against a GITHUB_TOKEN and avoid cancelling releases mid-run ([0cfd1f2](https://github.com/IbrahimTareq/kothai/commit/0cfd1f26e60ee9e2c93efbfb2d94cb8d0b5cb00d))
* replace stale STASH_ env names still shown in Settings ([aec3184](https://github.com/IbrahimTareq/kothai/commit/aec318414657f7d4603a356f55a7235e069408b4))
* **routes:** restore UPLOAD_DIR in both upload-cleanup paths ([52b5ab3](https://github.com/IbrahimTareq/kothai/commit/52b5ab352444505b56a5ab8a26312933d043d343))
* **server:** correct three wrong claims in server/types.ts, and the typecheck docs ([cee1a7f](https://github.com/IbrahimTareq/kothai/commit/cee1a7f367b070b596df9a6a0d97102f69ecc96f))
* **shape:** count uncommitted files, and correct the export total they hid ([e6ca3f0](https://github.com/IbrahimTareq/kothai/commit/e6ca3f03831f5042dd45b7dd07fb3cc77e47760c))
* **tagvocab:** drop a legacy row with an empty vector instead of registering null ([781ff18](https://github.com/IbrahimTareq/kothai/commit/781ff186eafa7eb3e159cbc5c2bcabb8f279f6c6))
* **telegram:** close review findings on bind ordering, retries, and replies ([9beaa7a](https://github.com/IbrahimTareq/kothai/commit/9beaa7a5c8a23f282cdbfcd17feeedd7bb318253))
* **telegram:** require a pairing code to bind, not just first contact ([0caa6b7](https://github.com/IbrahimTareq/kothai/commit/0caa6b78063319db50447f3834eed2a8ada14741))
* **telegram:** stop the API client from throwing on network failure ([b29f32e](https://github.com/IbrahimTareq/kothai/commit/b29f32e39822473f599269ee7e5b48aaac01ba6d))
* **telegram:** unbreak shape ratchet and pin write contract ([05fd967](https://github.com/IbrahimTareq/kothai/commit/05fd9678afc69a8e14edf7da79afb50e5f61f8a9))
* **test:** point the importedAt regression test at the mockRes helper ([39f9c33](https://github.com/IbrahimTareq/kothai/commit/39f9c33a0757d329242cc6c6f3508caf72ae00ed))
* **test:** stop the AI provider retry tests from paying real backoff ([cd3ba06](https://github.com/IbrahimTareq/kothai/commit/cd3ba06fbd0f28fde966a2c3f1d2583e0c8c7ff3))


### Performance Improvements

* **client:** load the Space canvas on first use ([c43736e](https://github.com/IbrahimTareq/kothai/commit/c43736e7240543d5e4e5a91f1a7aa9819790931e))

# Changelog

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

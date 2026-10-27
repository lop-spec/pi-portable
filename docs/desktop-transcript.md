# Desktop transcript presentation

Pi Web uses PI-Desktop 0.21.0's transcript presentation, pinned to `c099b6a4cdb4dcdc3bf467432e36af10fde77080`. It does not replace the application, model runtime, tool execution, or session storage.

`assets/piweb-overlay/desktop-transcript/vendor/provenance.json` identifies each official source file and its original/adapted SHA256. `COPYING`, `COPYING.LESSER` and `NOTICE` accompany the adapted source, also served under `/licenses/pi-desktop/` in the packaged application.

## Behavior

- One process disclosure per turn. Active turns open automatically; untouched completed turns close. Explicit user choices, focus/selection reading protection and search reveals remain authoritative.
- Original nested activity grouping (`fully-folded`), thinking rows, tool rows, structured output, typography, indentation, shimmer, smooth text and code highlighting.
- Tool payloads start collapsed. Opening historical results reads the existing bounded entry endpoints, retaining offsets, cancellation and retry. No full-output eager fetch.
- Available reasoning stays verbatim in every language. Encrypted/unavailable reasoning is never reconstructed or translated.
- Independent Chinese tool excerpts are no longer rendered or computed. Tool images remain visible outside the process disclosure.
- Browser adapters retain existing file-preview callbacks. Electron IPC, native plugin cards and host-owned workspace review snapshots are not imported.
- The original disclosure receives one browser focus correction: reading protection can retain an open level but cannot open a closed title before the first pointer click. No settings or session writes are introduced.

## Refresh and verify

Use an official checkout at the pinned commit. Run `node tools/vendor-pi-desktop-transcript.mjs <desktop-checkout>` followed by `node tools/scope-desktop-transcript-css.mjs <pi-web-source-with-dependencies>`. The latter scopes original style selectors and tokens rather than approximating them.

The final integration stage is `tools/patch-piweb-desktop-transcript.mjs`; its manifest pins all changed outputs, on top of the existing history, stop, ask and project stages. Validate with `PIWEB_SOURCE=<official-pi-web-checkout> node --test tests/piweb-desktop-transcript.mjs tests/patch-piweb-source-contract.mjs tests/patch-piweb-redesign-contract.mjs tests/piweb-history-integration.mjs`, then the integrated TypeScript check. Release artifacts come only from the existing cloud CI workflow.

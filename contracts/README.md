# Web reverse contract snapshots

This directory vendors the exact v1 contract snapshots consumed by this
unified control-plane adapter so its standalone CI does not depend on a parent
checkout. The canonical source remains
`reverse_ENV/contracts/web-reverse/`.

- `browser-session-handoff.v1.schema.json` canonical SHA-256:
  `fc3576c227159e391ad38a06f6c07192909aa8f3228e36108f5e1d2d12e7dae8`
- `evidence-pointer.v1.schema.json` canonical SHA-256:
  `891b19ceefcfff2793490580cc7a5b53d3ddaa59d247d8024f4b622f247e725d`

Handoff v1 supports Cookie import. A Storage pointer is observation-only;
non-empty local/session Storage import is unsupported and consumers must fail
closed. The canonical valid fixture is therefore Cookie-only and never
advertises `storage-import`.

Native Firefox debugger observations use the control-plane contracts
`debugger-observation.v1.schema.json` and `debugger-pointer.v1.schema.json`.
They are deliberately separate from the shared `evidence-pointer.v1` schema:
the `ruyi-debug` plane stores only bounded, redacted metadata and source/value
hashes under `evidence/web/ruyi-debug/<runId>/`.

`scripts/contract_bridge.py` validates both the bundled fixture and a synthetic
`ruyi_export_session` result against these schemas. Both schema digests are
checked so an incomplete vendor sync fails CI. Contract changes must be
landed in the canonical root first, then synchronized here with compatibility
tests in the same commit.

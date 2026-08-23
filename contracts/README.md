# Web reverse contract snapshots

This directory vendors the exact v1 contract snapshots consumed by this
Private control-plane adapter so its standalone CI does not depend on a parent
checkout. The canonical source remains
`reverse_ENV/contracts/web-reverse/`.

- `browser-session-handoff.v1.schema.json` canonical SHA-256:
  `9a759a8a5a9af92ae6958a06975bbd58a0d20f67aeb87543100548f36b9ea240`
- `evidence-pointer.v1.schema.json` canonical SHA-256:
  `53a628dbafa31e0af69a9b9cc5ccf9844f863e7ad0728c8e856b56e84a0eba33`

Handoff v1 supports Cookie import. A Storage pointer is observation-only;
non-empty local/session Storage import is unsupported and consumers must fail
closed. The canonical valid fixture is therefore Cookie-only and never
advertises `storage-import`.

`scripts/contract_bridge.py` validates both the bundled fixture and a synthetic
`ruyi_export_session` result against these schemas. Both schema digests are
checked so an incomplete vendor sync fails CI. Contract changes must be
landed in the canonical root first, then synchronized here with compatibility
tests in the same commit.

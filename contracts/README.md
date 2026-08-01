# Web reverse contract snapshots

This directory vendors the exact v1 contract snapshots consumed by this
Private control-plane adapter so its standalone CI does not depend on a parent
checkout. The canonical source remains
`reverse_ENV/contracts/web-reverse/`.

- `browser-session-handoff.v1.schema.json` canonical SHA-256:
  `6bb05c886be34da5ad83fed5e70eb7921a5840c11458e0b9bb590b2ffc072367`
- `evidence-pointer.v1.schema.json` canonical SHA-256:
  `19eb8ae4965c0396c56c3e470e3d4d54a6991606d3dc12b5f76821edb82ba6ab`

`scripts/contract_bridge.py` validates both the bundled fixture and a synthetic
`ruyi_export_session` result against these schemas. Contract changes must be
landed in the canonical root first, then synchronized here with compatibility
tests in the same commit.

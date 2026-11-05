# Third-party notices

The toolkit's original code is MIT licensed. It is an independent project, not an
official YDB or Yandex product. Dependencies keep their own licenses:

- `@ydbjs/api`, `@ydbjs/auth`, `@ydbjs/core`, `@ydbjs/query`, `@ydbjs/value`:
  Apache-2.0, YDB Team / YANDEX LLC,
  [official SDK](https://github.com/ydb-platform/ydb-js-sdk).
- `@bufbuild/protobuf`: Apache-2.0 AND BSD-3-Clause,
  [protobuf-es](https://github.com/bufbuild/protobuf-es).
- Other transitive dependencies are installed from npm, not vendored into this package.
  Consult their shipped notices before distributing a bundled application.

`archive/ydb-sdk+5.11.1.patch` contains historical SDK source in deleted/context
lines. Those portions remain under the upstream Apache License 2.0, Copyright
2024 YANDEX LLC; see `archive/LICENSE.ydb-sdk`. The patch modifies the distribution
by removing its ESM tree and changing the bundled certificate JSON. It is preserved
as history, excluded from the npm tarball, and never applied by this toolkit.

The MIT license does not relicense upstream SDK code, certificates, or trademarks.

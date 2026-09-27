# Javadoc 25 search-data fixture

Generated from this repository's own `experiments/java/fixture-src/` sources,
using the locally extracted Temurin 25.0.4.1+1 standard doclet. The original
generation process completed with exit 0 (confirmed 2026-09-27). These files
are data-only test inputs, not scripts to execute. A final newline was added
when copying them into the repository; their JSON and wrappers are unchanged.

Command (JDK_HOME denotes that explicitly selected temporary JDK):

```sh
"$JDK_HOME/bin/javadoc" -quiet -notimestamp \
  --module-source-path experiments/java/fixture-src \
  --module dev.crux.fixture -d /path/to/new/fixture-docs
```

The fixture contains 1 module, 1 package, 6 types and 19 members; package/type
indexes additionally contain one navigation-summary record each. It covers
nested types, annotation, interface, enum, record, constructors and overloads.
It is not a copy of OpenJDK platform documentation and proves no full-platform
coverage, legal-resource closure or distribution readiness.

SHA-256 of the checked-in files:

- module: `493cec6b5e66b4b1e1b7172269f105694cc8346de8edf48081a99adacb15d7fd`
- package: `a9cdd5b5848e77fb3d24ab3afeac8d4a062f852f455b8134ea86712f31a75768`
- type: `69beb9b15c3aeb543eec4d76cff87f13d29be7470bbb2aefcac75e4c56042cdb`
- member: `045328c3b2166550a347e238049903874f433caa2e71c46393cb36fc66d7413c`

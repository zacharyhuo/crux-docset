# Javadoc index compatibility probe

`fixture-src/` is repository-owned Java source, not extracted platform API.
It exercises modules, package/type paths, nested classes/interfaces/annotations/
enums/records, constructors, overloaded methods, arrays, varargs and generic
signatures. Generated HTML and JDK downloads stay outside Git.

Use an explicitly selected JDK 25 home and a new, disposable output directory:

```sh
"$JDK_HOME/bin/javadoc" -quiet -notimestamp \
  --module-source-path experiments/java/fixture-src \
  --module dev.crux.fixture -d /absolute/new/output/docs
```

After the generator exits successfully, from the repository root:

```sh
node --input-type=module -e '
  import { readJavadocIndex } from "./src/javadoc/read-index.js";
  const result = await readJavadocIndex(process.argv[1]);
  console.log(JSON.stringify(result, null, 2));
' /absolute/new/output/docs
```

Expected with Temurin 25.0.4.1+1: four search-index files, eight API target pages,
27 API symbols. The two summary navigation entries are excluded. The checked-in
raw index fixtures under `test/fixtures/javadoc25/` match generated output apart
from an added final newline. `npm test` needs no JDK and tests malformed data,
path traversal, missing pages/anchors, symlinks, byte limits and invalid UTF-8.

The reader accepts a completed, immutable local tree. It rejects symlink roots,
intermediate directories and leaf files, checks regular files and uses no-follow
bounded reads. Files are capped at 16 MiB and total bytes read at 1 GiB; exceeding
these budgets fails rather than silently omitting symbols. It is not an OS
sandbox against a hostile process concurrently rewriting ancestor directories.
It does not run page JavaScript, fetch redirects/resources, or change HTML.

This is the indexer's probe only. A complete OpenJDK source build, resource/legal
closure, recipe, icon, docset packaging and Beta/distribution acceptance remain
separate requirements. Spring's reference manuals also require their own adapter;
this shared indexer covers only standard Javadoc API data.

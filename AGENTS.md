# Safety policy for self-supplied docsets

- Until public release, all GUI installation, feed subscription and generated-docset testing must use **Crux Beta** (`com.zacharyhuo.Crux.Beta`), never the production Crux app.
- Never copy generated artifacts into the production Crux container, Application Support directory, custom library, preferences or bookmarks. Do not launch or quit the user's production Crux for tests.
- Headless CruxCore tests may use newly allocated disposable experiment directories only. Never point the smoke harness at an existing user library.
- Keep archives, downloaded upstream source, credentials and build caches out of Git. Repository visibility remains private unless the user explicitly changes it.
- Current development branch: `develop/v1`. Java services belong in `crux-server`; Node CLI/recipes/builds belong here.

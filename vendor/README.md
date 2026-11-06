# Vendored projects

## KiroCrew (`vendor/KiroCrew`)

[KiroCrew](https://github.com/kirodotdev/KiroCrew) is Kiro's persistent, self-hosted agent
workspace. kiro-claude references it **unmodified** as a git submodule so that
`kiro-claude crew setup` builds a known version and runs it on Claude Code, with kiro-claude
acting as KiroCrew's `kiro-cli`.

| | |
| --- | --- |
| Upstream | https://github.com/kirodotdev/KiroCrew.git |
| Pinned commit | `665a0e4e4a6507de0f3e7cffd3160c9359900c7c` |
| Version | kirocrew 0.13.0 |
| License | Apache License 2.0 (see `vendor/KiroCrew/LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES`) |

The submodule is a pointer only; nothing from KiroCrew is copied into `src/`, and the npm
package does not contain it. You do not need to fetch it yourself: `kiro-claude crew setup`
fetches the pinned commit. To fetch it into this checkout:

```sh
git submodule update --init --depth 1 vendor/KiroCrew   # or: npm run crew:fetch
```

### Bumping the pin

Bumping KiroCrew is one commit that changes, together:

1. the gitlink: `git -C vendor/KiroCrew fetch --depth 1 origin <sha> && git -C vendor/KiroCrew checkout <sha> && git add vendor/KiroCrew`;
2. `KIROCREW_PIN` in `src/crew/pin.ts` (commit and version);
3. the table above;
4. the KiroCrew section of `NOTICE`.

`test/crew/pin.test.ts` fails when the gitlink and `src/crew/pin.ts` disagree. After a bump,
rerun the KiroCrew end-to-end checks (`kiro-claude crew doctor`, then a dashboard chat turn).

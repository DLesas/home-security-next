# `@hsn/deployment`: the one configuration point

Everything that depends on the product's name, its domain or its host ([docs/m4-design.md](../../docs/m4-design.md) section 2, D128). Frozen by the joint step 0 ([docs/m3-m4-plan.md](../../docs/m3-m4-plan.md)): the values change when the product owner chooses them; the shape and the rules change only through the step 0 owner.

**Edit `deployment.json`, nothing else.** It is plain JSON so that what cannot load TypeScript reads it directly: Expo's `app.config.ts` under plain Node, and later a firmware header generator. TypeScript users import `DEPLOYMENT` from `src/deployment.ts`, which reads the file, checks its shape and gives the typed object of section 2.

| Key | Holds |
| --- | --- |
| `productName` | The app's display name |
| `domain` | The product's domain. The default relay is `wss://relay.<domain>`, the operated push service `wss://push.<domain>` |
| `hubsDomain` | The registrable domain for per-hub names, apart from the product's (S4). The canary is `rebindtest.<hubsDomain>`, the control name `control.<hubsDomain>` |
| `iosBundleId`, `iosAppGroup` | The iOS app's identifier and app group |
| `iosTeamId` | The Apple team id; `null` until the account's team is set |
| `androidApplicationId` | The Android application id |
| `acmeDirectory` | The certificate authority's ACME directory, overridable by the name service |

The placeholders (`.invalid`, RFC 6761) never reach anyone: while `domain` is one, a hub has no default relay. A release build refuses a placeholder domain or identifier and a null team (`deploymentProblems`); the package's test refuses a key missing, misspelt, extra or of the wrong type (`deploymentFileProblems`). The file holds no secrets, no protocol labels and not the URL scheme `hsn`.

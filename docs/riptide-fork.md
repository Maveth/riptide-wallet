# Riptide wallet branch

`riptide` is this wallet built on Paperclip `main` at `70e31bd` (0.9.2). It is a local branch. It has not been pushed.

## Kept from Paperclip

- 0.9.0 lowered the ordinary recovery allocation and updated the wallet flow.
- 0.9.1 restored setup defaults and fixed the login and action layout.
- 0.9.2 keeps balances readable after a stalled node connection, and shows activity when part of the wallet is unavailable.
- The page keeps Paperclip's settings, connection checks, platform login, and review sheet.

## Added here

- Lightning payments under 1,000 sats use the tab. A payment of 1,000 sats or more stays a coin.
- The wallet reads every tab key and the opt-out flag in one `GetLightningTabs` call.
- A route that cannot be priced is held at the schedule fee. After it pays, the tab keeps the route cost plus 1 sat and returns the rest.
- Withdrawal needs at least 1,000 sats. A smaller tab is topped up first, then withdrawn in full. There is no withdrawal fee.
- A coin is spent with the recovery shape already on that coin. That includes a zero-fee coin, an older 1,000 sat coin, and Paperclip's newer 330 plus 198 sat ordinary transfer when the server offers it.
- The page is named Riptide and shows the tab balance between the Ark balance and the on-chain balance.
- A new wallet defaults to `https://ark-riptide.maveth.ca`. That address answers from the public internet over HTTP/2.

## Left out

- `web/app.js.bak-unlock-20261016T224547` is a backup and is not part of the branch.
- `lib/src/arkoor/combine.rs` is unfinished and is not part of the branch.

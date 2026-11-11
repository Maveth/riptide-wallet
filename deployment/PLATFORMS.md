# Paperclip Wallet on Umbrel and StartOS

Paperclip Wallet supports Linux x86-64 and ARM64. Install the published package
for your platform and back up your complete wallet before updating.

## Sign in

- **Umbrel:** use the app password displayed for Paperclip Wallet in Umbrel.
- **StartOS:** open Paperclip Wallet → Actions → Show wallet access token,
  then paste that token into the wallet.

These credentials grant wallet access. Do not enter your platform account password
or recovery phrase. Existing credentials are preserved during an update.

## Connect your node

New wallets default to `https://ark-riptide.maveth.ca`. Custom server settings are
preserved. Choose an XBT/Blake2b-compatible node; a Bitcoin SHA-256 node cannot be
used for this wallet.

On StartOS, the **Node connection** action can reuse the installed Knots Blake2b
companion's RPC connection and cookie. On Umbrel, **Use installed XBT node** uses
the connection exported by a compatible installed node app. If your app does not
provide that connection, select manual RPC setup. Provider compatibility depends
on the node package; not every community-store combination has been tested.

Use a synchronized transaction index, or configure the bundled private pruned-node
adapter as described in `BUNDLED-PRUNED.md`. Keep RPC on the private service network
or an authenticated encrypted connection. Do not expose RPC or wallet ports to the
public Internet.

## Sync and payment status

You can sign in while your node is syncing or unavailable. Unavailable balances
are labeled rather than shown as zero. Open **Settings → Check connections** for
connection information. A snapshot node may reach the current block while its
historical validation and transaction index are still catching up.

Result screens distinguish completed, failed, pending, and unknown payments.
On-chain submission still needs confirmations. After an interrupted payment,
check Activity and payment status before trying again; the wallet does not resend
a payment automatically.

Lightning uses the connected ASP's service. You do not need to install a local
Lightning node. Available features depend on the ASP's advertised capabilities.

## Keep the wallet online

Automatic VTXO maintenance runs while the wallet service is online, even after
you close the browser. Keep the blockchain backend and ASP reachable and allow
for refresh fees. Stopping the service stops maintenance and BOLT12 offer handling.
Existing manually configured wallets retain their maintenance settings.

## Backup and recovery

Back up the complete app data volume, including the mnemonic, database,
configuration, authentication token, and optional adapter data. Stop the wallet
before a manual file backup. Seed-only recovery does not preserve all Ark state.
Restore to a stopped service and preserve ownership (wallet uid/gid 1000).
Never run two wallet instances from the same backup.

The wallet generates its own keys; the Umbrel seed is not used as a wallet seed.
An authentication mismatch after restoration stops startup rather than silently
replacing the token. Do not downgrade a wallet with state newer binaries created.

## Package development

Build images from the reviewed source using `deployment/Dockerfile`, test both
architectures, then pin the multi-architecture digest. `deployment/package.py umbrel` generates Umbrel packaging. StartOS 0.4 packaging is maintained in
[paperclip-wallet-startos](https://github.com/connorslab/paperclip-wallet-startos).
The generator's `startos` mode is a legacy 0.3.5 wrapper, not a 0.4 release.

Build and unit-test results do not establish device installation, complete backup
restoration, or successful financial settlement. Release notes describe the
checks actually completed. This is beta software and has not been independently
audited.

# Source provenance

Based on Bark by Second and the Bark contributors (MIT).
Original: https://gitlab.com/ark-bitcoin/bark
XBT source: https://github.com/connorslab/bark-xbt
Source commit: `e107d09e7fd173fc5895a2b9eec500082f48d4cd`

The Bark 0.8.1 integration uses upstream commit
`303682063ed7559b06dcf37c5cb37bb7037b943f` (`bark-0.8.1`). It updates
the wallet actions, on-chain wallet, recovery tools, RPC client and payment
parsing while retaining XBT signatures, funded recovery accounting, BOLT12
receiving, failed-payment compensation and the Paperclip browser interface.

Existing wallet checkpoints retain their recovery budgets. Legacy optional
fields remain readable, including pending Lightning payments without a stored
revocation key. Back up the complete wallet before upgrading; a seed alone does
not replace the signed recovery data.

Only the application and its local dependency closure are copied. Shared crates
remain source-compatible and are vendored in each repository. Keep their protocol
changes synchronized. Original copyright and dependency licenses are retained.

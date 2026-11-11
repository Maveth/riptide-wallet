//! The 1,000 sat tab is an Ark payment plus a server ledger.
//! Small Lightning invoices still go through Ark's normal Lightning send.

use anyhow::Context;
use bitcoin::secp256k1::Keypair;
use bitcoin::{Amount, Network};
use server_rpc::protos;

use ark::address::ArkId;
use ark::ProtocolEncoding;
use ark::lightning::{lightning_tab_message, LIGHTNING_TAB_CHUNK_SAT};
use ark::VtxoPolicy;

use crate::vtxo::VtxoState;
use crate::Wallet;

/// Which balance pays a Lightning invoice.
///
/// `Auto` uses the tab only under the dust floor. `Tab` records the spend
/// against the tab when the balance covers it. `Coin` is the normal Ark send
/// and is refused under the floor, where a coin cannot be built.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LightningPaySource {
	Auto,
	Tab,
	Coin,
}

impl LightningPaySource {
	pub fn parse(raw: Option<&str>) -> anyhow::Result<Self> {
		match raw.map(str::trim).filter(|s| !s.is_empty()) {
			None | Some("auto") => Ok(Self::Auto),
			Some("tab") => Ok(Self::Tab),
			Some("coin") => Ok(Self::Coin),
			Some(other) => bail!("payment source must be auto, tab, or coin, not {other}"),
		}
	}
}

pub(crate) fn tab_signature(key: &Keypair, action: &str, payload: &[u8]) -> Vec<u8> {
	ark::SECP.sign_schnorr_no_aux_rand(&lightning_tab_message(action, payload), key)
		.as_ref().to_vec()
}

impl Wallet {
	pub fn lightning_tab_chunk() -> Amount {
		Amount::from_sat(LIGHTNING_TAB_CHUNK_SAT)
	}

	async fn tab_keys(&self) -> anyhow::Result<Vec<Keypair>> {
		let mut keys = vec![self.inner.seed.to_mailbox_keypair()];
		if let Some(last) = self.inner.db.get_last_vtxo_key_index().await? {
			for index in 0..=last {
				if let Ok(key) = self.peek_keypair(index).await {
					if key.public_key() != keys[0].public_key() {
						keys.push(key);
					}
				}
			}
		}
		Ok(keys)
	}

	/// Balance and opt-out from one server call.
	pub async fn lightning_tab_view(&self) -> anyhow::Result<(Amount, bool)> {
		let (balance, opted_out, _) = self.tab_snapshot().await?;
		Ok((balance, opted_out))
	}

	/// One server call for every key. The opt-out flag comes back with the balance.
	async fn tab_snapshot(&self) -> anyhow::Result<(Amount, bool, Vec<(Keypair, Amount)>)> {
		let keys = self.tab_keys().await?;
		let (mut srv, _) = self.require_server().await?;
		let mut tabs = Vec::with_capacity(keys.len());
		for key in &keys {
			tabs.push(self.tab_auth(key, "balance", &[]).await);
		}
		let resp = srv.client.get_lightning_tabs(protos::LightningTabsRequest { tabs })
			.await.context("Lightning tab balance failed")?.into_inner();
		if resp.tabs.len() != keys.len() {
			bail!("Lightning tab reply did not cover every key");
		}
		let accounts = keys.into_iter().zip(resp.tabs).map(|(key, entry)| {
			(key, Amount::from_sat(entry.balance_sat))
		}).collect();
		Ok((Amount::from_sat(resp.balance_sat), resp.opted_out, accounts))
	}

	/// True when any key for this wallet has turned small payments off.
	pub async fn lightning_tab_opted_out(&self) -> anyhow::Result<bool> {
		Ok(self.tab_snapshot().await?.1)
	}

	pub async fn set_lightning_tab_opt_out(&self, opted_out: bool) -> anyhow::Result<Amount> {
		let (mut srv, _) = self.require_server().await?;
		let payload = [u8::from(opted_out)];
		for key in self.tab_keys().await? {
			let signature = tab_signature(&key, "opt", &payload);
			srv.client.set_lightning_tab_opt_out(protos::SetLightningTabOptOutRequest {
				user_pubkey: key.public_key().serialize().to_vec(),
				signature,
				opted_out,
			}).await.context("failed to set the Lightning tab opt-out")?;
		}
		self.lightning_tab_balance().await
	}

	pub async fn settle_lightning_tab_receive(
		&self, hash: ark::lightning::PaymentHash, preimage: ark::lightning::Preimage,
	) -> anyhow::Result<Amount> {
		let key = self.inner.seed.to_mailbox_keypair();
		let (mut srv, _) = self.require_server().await?;
		let resp = srv.client.settle_lightning_tab_receive(protos::SettleLightningTabReceiveRequest {
			payment_hash: hash.as_ref().to_vec(),
			payment_preimage: preimage.as_ref().to_vec(),
			user_pubkey: key.public_key().serialize().to_vec(),
			signature: tab_signature(&key, "receive-settle", hash.as_ref()),
		}).await.context("failed to credit the Lightning tab")?.into_inner();
		Ok(Amount::from_sat(resp.balance_sat))
	}

	async fn tab_auth(&self, key: &Keypair, action: &str, payload: &[u8]) -> protos::LightningTabAuth {
		protos::LightningTabAuth {
			user_pubkey: key.public_key().serialize().to_vec(),
			signature: tab_signature(key, action, payload),
		}
	}

	async fn address_key(&self) -> anyhow::Result<Keypair> {
		self.tab_keys().await?.into_iter().next().context("no tab key")
	}

	pub async fn lightning_address(&self) -> anyhow::Result<String> {
		let key = self.address_key().await?;
		let (mut srv, _) = self.require_server().await?;
		let resp = srv.client.get_lightning_address(self.tab_auth(&key, "balance", &[]).await)
			.await.context("lightning address")?.into_inner();
		Ok(resp.address)
	}

	pub async fn claim_lightning_address(&self, name: &str) -> anyhow::Result<String> {
		let key = self.address_key().await?;
		let (mut srv, _) = self.require_server().await?;
		let resp = srv.client.claim_lightning_address(protos::ClaimLightningAddressRequest {
			auth: Some(self.tab_auth(&key, "name", name.as_bytes()).await),
			name: name.to_string(),
		}).await.context("claim lightning address")?.into_inner();
		Ok(resp.address)
	}

	/// Answer one coin-sized payment to this wallet's lightning address.
	/// A zero amount means nobody asked during this wait.
	pub async fn serve_lightning_address_once(&self) -> anyhow::Result<()> {
		let key = self.address_key().await?;
		let (mut srv, _) = self.require_server().await?;
		let asked = srv.client.wait_lightning_address_coin(self.tab_auth(&key, "balance", &[]).await)
			.await.context("wait for lightning address")?.into_inner();
		if asked.amount_sat == 0 {
			return Ok(());
		}
		let invoice = self.bolt11_invoice(
			Amount::from_sat(asked.amount_sat),
			Some(format!("Riptide {}", asked.amount_sat)),
			None,
		).await?;
		let bolt11 = invoice.to_string();
		let (mut srv, _) = self.require_server().await?;
		srv.client.submit_lightning_address_invoice(protos::SubmitLightningAddressInvoiceRequest {
			auth: Some(self.tab_auth(&key, "name-invoice", bolt11.as_bytes()).await),
			bolt11,
		}).await.context("submit lightning address invoice")?;
		Ok(())
	}

	/// Sum of every funded tab held by a key in this wallet.
	pub async fn lightning_tab_balance(&self) -> anyhow::Result<Amount> {
		Ok(self.tab_snapshot().await?.0)
	}

	/// The key whose tab covers `needed`, if one does.
	pub(crate) async fn tab_pay_key(&self, needed: Amount) -> anyhow::Result<Keypair> {
		let (_, _, accounts) = self.tab_snapshot().await?;
		for (key, balance) in accounts {
			if balance >= needed {
				return Ok(key);
			}
		}
		bail!(
			"Lightning tab does not cover {} sats. Fund another {} sat chunk.",
			needed, LIGHTNING_TAB_CHUNK_SAT,
		);
	}

	/// Send 1,000 sats by Ark payment to the server. Change stays in the wallet.
	/// The server credits the tab when it registers that output.
	pub async fn fund_lightning_tab(&self) -> anyhow::Result<Amount> {
		let (_, info) = self.require_server().await?;
		let network = self.network().await?;
		let address = ark::Address::new(
			network != Network::Bitcoin,
			ArkId::from_server_pubkey(info.server_pubkey),
			VtxoPolicy::new_pubkey(info.server_pubkey),
			Vec::new(),
		);
		self.send_arkoor_payment(&address, Self::lightning_tab_chunk()).await
			.context("failed to fund the Lightning tab")?;
		self.lightning_tab_balance().await
	}

	/// Pay a tab of at least 1,000 sats back into coins.
	///
	/// A smaller tab is refused. Top up 1,000 sats, then withdraw all.
	pub async fn withdraw_lightning_tab(&self) -> anyhow::Result<Amount> {
		let (mut srv, _) = self.require_server().await?;
		let (dest, _index) = self.derive_store_next_keypair().await?;
		let min = Self::lightning_tab_chunk();
		let (_, _, accounts) = self.tab_snapshot().await?;
		let keys: Vec<_> = accounts.into_iter()
			.filter(|(_, balance)| *balance >= min)
			.map(|(key, _)| key)
			.collect();
		if keys.is_empty() {
			bail!(
				"A tab under {} sats cannot be withdrawn. Top up {} sats, then withdraw all.",
				min.to_sat(), min.to_sat(),
			);
		}
		let mut last_err = None;
		for key in keys {
			let resp = srv.client.withdraw_lightning_tab(protos::WithdrawLightningTabRequest {
				user_pubkey: key.public_key().serialize().to_vec(),
				signature: tab_signature(&key, "withdraw", &dest.public_key().serialize()),
				destination_pubkey: dest.public_key().serialize().to_vec(),
			}).await;
			let resp = match resp {
				Ok(resp) => resp.into_inner(),
				Err(err) => {
					let msg = err.message().to_string();
					if msg.contains("not holding") || msg.contains("too small") || msg.contains("difference is too small") || msg.contains("cannot become a coin") {
						last_err = Some(anyhow::anyhow!(msg));
						continue;
					}
					return Err(err).context("Lightning tab return failed");
				},
			};
			let encoded = if resp.vtxos.is_empty() { vec![resp.vtxo] } else { resp.vtxos };
			let mut coins = Vec::with_capacity(encoded.len());
			for bytes in &encoded {
				let vtxo = ark::Vtxo::<ark::vtxo::Full>::deserialize(bytes)
					.context("server returned an unreadable coin")?;
				ensure!(vtxo.policy().user_pubkey() == dest.public_key(), "returned coin is for another key");
				coins.push(vtxo);
			}
			self.store_vtxos(&coins, &VtxoState::Spendable).await?;
			return Ok(Amount::from_sat(resp.amount_sat));
		}
		Err(last_err.unwrap_or_else(|| anyhow::anyhow!("the tab does not cover a coin to return")))
	}

	/// Zero every tab this wallet can sign for. The server already holds the coin.
	pub async fn forfeit_lightning_tab(&self) -> anyhow::Result<Amount> {
		let (mut srv, _) = self.require_server().await?;
		let mut forfeited = Amount::ZERO;
		for key in self.tab_keys().await? {
			let resp = srv.client.forfeit_lightning_tab(self.tab_auth(&key, "forfeit", &[]).await)
				.await.context("Lightning tab forfeit failed")?.into_inner();
			forfeited = forfeited.checked_add(Amount::from_sat(resp.forfeited_sat))
				.context("forfeited tab overflow")?;
		}
		Ok(forfeited)
	}
}

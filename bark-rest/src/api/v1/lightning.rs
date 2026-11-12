use std::str::FromStr;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{debug_handler, Json, Router};
use bitcoin::Amount;
use anyhow::Context;
use utoipa::OpenApi;

use ark::lightning::{Invoice, Offer};
use bark::lnurllib::lightning_address::LightningAddress;
use bark::lnurllib::lnurl::LnUrl;

use crate::error::{self, badarg, ContextExt, HandlerResult};
use crate::ServerState;

#[derive(OpenApi)]
#[openapi(
	paths(
		create_offer,
		get_offer,
		disable_offer,
		generate_invoice,
		generate_invoice_for_address,
		get_receive_status,
		list_receive_statuses,
		cancel_receive,
		pay,
		get_send_status,
	),
	components(schemas(
		bark_json::web::LightningOfferRequest,
		bark_json::web::LightningInvoiceRequest,
		bark_json::web::LightningInvoiceForAddressRequest,
		bark_json::cli::InvoiceInfo,
		bark_json::cli::LightningReceiveInfo,
		bark_json::web::LightningPayRequest,
		bark_json::web::LightningPayResponse,
		bark_json::cli::LightningSendInfo,
	)),
	tags((name = "lightning", description = "Create Lightning invoices and track receives."))
)]
pub struct LightningApiDoc;

pub fn router() -> Router<Arc<ServerState>> {
	Router::new()
		.route("/offers", get(get_offer).post(create_offer).delete(disable_offer))
		.route("/receives/invoice", post(generate_invoice))
		.route("/receives/invoice/for-address", post(generate_invoice_for_address))
		.route("/receives/{identifier}", get(get_receive_status).delete(cancel_receive))
		.route("/receives", get(list_receive_statuses))
		.route("/sends/{identifier}", get(get_send_status))
		.route("/pay", post(pay))
		.route("/address", get(lightning_address).post(claim_lightning_address))
		.route("/tab", get(lightning_tab))
		.route("/tab/activity", get(lightning_tab_activity))
		.route("/tab/fund", post(fund_lightning_tab))
		.route("/tab/return", post(return_lightning_tab))
		.route("/tab/opt", post(set_lightning_tab_opt))
}

#[utoipa::path(
	post,
	path = "/receives/invoice",
	summary = "Create a BOLT11 invoice",
	request_body = bark_json::web::LightningInvoiceRequest,
	responses(
		(status = 200, description = "Returns the created invoice", body = bark_json::cli::InvoiceInfo),
		(status = 500, description = "Internal server error", body = error::InternalServerError)
	),
	description = "Generates a new BOLT11 invoice for the specified amount via the Ark server, \
		creating a pending Lightning receive.",
	tag = "lightning"
)]
#[debug_handler]
pub async fn generate_invoice(
	State(state): State<Arc<ServerState>>,
	Json(body): Json<bark_json::web::LightningInvoiceRequest>,
) -> HandlerResult<Json<bark_json::cli::InvoiceInfo>> {
	let wallet = state.require_wallet()?;

	let amount = Amount::from_sat(body.amount_sat);
	let invoice = wallet.bolt11_invoice(amount, body.description, body.token).await
		.context("Failed to create invoice")?;

	Ok(axum::Json(bark_json::cli::InvoiceInfo {
		invoice: invoice.to_string(),
	}))
}

#[utoipa::path(
	post,
	path = "/receives/invoice/for-address",
	summary = "Create a BOLT11 invoice for an Ark address",
	request_body = bark_json::web::LightningInvoiceForAddressRequest,
	responses(
		(status = 200, description = "Returns the created invoice", body = bark_json::cli::InvoiceInfo),
		(status = 400, description = "Bad request", body = error::BadRequestError),
		(status = 500, description = "Internal server error", body = error::InternalServerError)
	),
	description = "Generates a new BOLT11 invoice. When paid, the wallet claims the Lightning \
		receive and forwards the resulting Ark VTXO to the supplied Ark address mailbox.",
	tag = "lightning"
)]
#[debug_handler]
pub async fn generate_invoice_for_address(
	State(state): State<Arc<ServerState>>,
	Json(body): Json<bark_json::web::LightningInvoiceForAddressRequest>,
) -> HandlerResult<Json<bark_json::cli::InvoiceInfo>> {
	let wallet = state.require_wallet()?;

	let amount = Amount::from_sat(body.amount_sat);
	let address = ark::Address::from_str(&body.address)
		.badarg("address is not a valid Ark address")?;
	wallet.validate_arkoor_address(&address).await
		.badarg("invalid arkoor address")?;
	let invoice = wallet.bolt11_invoice_for_address(amount, address, body.description, None).await
		.context("Failed to create invoice for address")?;

	Ok(axum::Json(bark_json::cli::InvoiceInfo {
		invoice: invoice.to_string(),
	}))
}

#[utoipa::path(
	get,
	path = "/receives/{identifier}",
	summary = "Get receive status",
	params(
		("identifier" = String, Path, description = "Payment hash, invoice string or preimage to search for"),
	),
	responses(
		(status = 200, description = "Returns the Lightning receive status", body = bark_json::cli::LightningReceiveInfo),
		(status = 400, description = "Bad request", body = error::BadRequestError),
		(status = 404, description = "Not found", body = error::NotFoundError),
		(status = 500, description = "Internal server error", body = error::InternalServerError)
	),
	description = "Returns the status of a specified Lightning receive, identified by its \
		payment hash, invoice string, or preimage. The response tracks progress through \
		timestamps: `htlc_vtxos` is populated once HTLCs are created by the Ark server, \
		`preimage_revealed_at` records when the preimage was sent, and `finished_at` \
		indicates the receive has settled or been canceled.",
	tag = "lightning"
)]
#[debug_handler]
pub async fn get_receive_status(
	State(state): State<Arc<ServerState>>,
	Path(identifier): Path<String>,
) -> HandlerResult<Json<bark_json::cli::LightningReceiveInfo>> {
	let wallet = state.require_wallet()?;

	let payment_hash = if let Ok(h) = ark::lightning::PaymentHash::from_str(&identifier) {
		h
	} else if let Ok(i) = ark::lightning::Invoice::from_str(&identifier) {
		i.payment_hash()
	} else if let Ok(p) = ark::lightning::Preimage::from_str(&identifier) {
		p.into()
	} else {
		badarg!("identifier is not a valid payment hash, invoice or preimage");
	};

	let state = wallet.lightning_receive_state(payment_hash).await
		.context("Failed to get lightning receive status")?;
	Ok(axum::Json(bark_json::cli::LightningReceiveInfo::from_state(&state)))
}

#[utoipa::path(
	get,
	path = "/sends/{identifier}",
	summary = "Get send status",
	params(
		("identifier" = String, Path, description = "Payment hash or invoice string to search for"),
	),
	responses(
		(status = 200, description = "Returns the Lightning send status", body = bark_json::cli::LightningSendInfo),
		(status = 400, description = "Bad request", body = error::BadRequestError),
		(status = 500, description = "Internal server error", body = error::InternalServerError)
	),
	description = "Returns the status of a specified outgoing Lightning payment, identified by \
		its payment hash or invoice string. The `state` field tracks the payment lifecycle \
		from `start` through `paid`; the preimage is included once the payment succeeded. \
		If the wallet does not recognize the payment hash, it will return `unknown`. \
		This is a read on the status in the db, so it does not trigger any `sync` before \
		checking the state.",
	tag = "lightning"
)]
#[debug_handler]
pub async fn get_send_status(
	State(state): State<Arc<ServerState>>,
	Path(identifier): Path<String>,
) -> HandlerResult<Json<bark_json::cli::LightningSendInfo>> {
	let wallet = state.require_wallet()?;

	let payment_hash = if let Ok(h) = ark::lightning::PaymentHash::from_str(&identifier) {
		h
	} else if let Ok(i) = ark::lightning::Invoice::from_str(&identifier) {
		i.payment_hash()
	} else {
		badarg!("identifier is not a valid payment hash or invoice");
	};

	let state = wallet.lightning_send_state(payment_hash).await
		.context("Failed to get lightning send status")?;
	Ok(axum::Json(bark_json::cli::LightningSendInfo::from_state(payment_hash, &state)))
}

#[utoipa::path(
	get,
	path = "/receives",
	summary = "List all pending receive statuses",
	responses(
		(status = 200, description = "Returns all pending receive statuses", body = Vec<bark_json::cli::LightningReceiveInfo>),
		(status = 500, description = "Internal server error", body = error::InternalServerError)
	),
	description = "Returns the statuses of all pending Lightning receives, ordered from oldest \
		to newest. A receive is pending until its `finished_at` timestamp is set, indicating \
		it has settled or been canceled.",
	tag = "lightning"
)]
#[debug_handler]
pub async fn list_receive_statuses(
	State(state): State<Arc<ServerState>>,
) -> HandlerResult<Json<Vec<bark_json::cli::LightningReceiveInfo>>> {
	let wallet = state.require_wallet()?;

	let mut receives = wallet.pending_lightning_receives().await
		.context("Failed to get lightning receives")?;
	// receives are ordered from newest to oldest, so we reverse them so last terminal item is newest
	receives.reverse();

	let receives = receives.iter()
		.map(bark_json::cli::LightningReceiveInfo::from).collect::<Vec<_>>();

	Ok(axum::Json(receives))
}

#[utoipa::path(
	delete,
	path = "/receives/{identifier}",
	summary = "Cancel a pending receive",
	params(
		("identifier" = String, Path, description = "Payment hash or invoice string"),
	),
	responses(
		(status = 200, description = "Receive canceled successfully"),
		(status = 400, description = "Bad request", body = error::BadRequestError),
		(status = 404, description = "Not found", body = error::NotFoundError),
		(status = 500, description = "Internal server error", body = error::InternalServerError)
	),
	description = "Cancels a pending Lightning receive identified by its payment hash or \
		invoice string. The server will refuse cancellation if HTLC-recv VTXOs have already \
		been granted. Bark also prevents cancellation when the preimage has been revealed.",
	tag = "lightning"
)]
#[debug_handler]
pub async fn cancel_receive(
	State(state): State<Arc<ServerState>>,
	Path(identifier): Path<String>,
) -> HandlerResult<()> {
	let wallet = state.require_wallet()?;

	let payment_hash = if let Ok(h) = ark::lightning::PaymentHash::from_str(&identifier) {
		h
	} else if let Ok(i) = ark::lightning::Invoice::from_str(&identifier) {
		i.payment_hash()
	} else {
		badarg!("identifier is not a valid payment hash or invoice");
	};

	wallet.cancel_lightning_receive(payment_hash).await
		.context("Failed to cancel lightning receive")?;

	Ok(())
}

#[utoipa::path(
	post,
	path = "/pay",
	summary = "Send a Lightning payment",
	request_body = bark_json::web::LightningPayRequest,
	responses(
		(status = 200, description = "Returns success message, optionally with \
			preimage if payment was immediately settled", body = bark_json::web::LightningPayResponse),
		(status = 400, description = "The provided destination is not a valid \
			BOLT11 or BOLT12 invoice, BOLT12 offer, or Lightning address", body = error::BadRequestError),
		(status = 500, description = "Internal server error", body = error::InternalServerError)
	),
	description = "Sends a payment to a Lightning destination. Accepts a BOLT11 or BOLT12 invoice, \
		BOLT12 offer, or Lightning address. The `amount_sat` field is required for Lightning \
		addresses but optional for invoices and offers. Comments are only supported for \
		Lightning addresses.",
	tag = "lightning"
)]
#[debug_handler]
pub async fn pay(
	State(state): State<Arc<ServerState>>,
	Json(body): Json<bark_json::web::LightningPayRequest>,
) -> HandlerResult<Json<bark_json::web::LightningPayResponse>> {
	let wallet = state.require_wallet()?;

	let amount = body.amount_sat.map(|a| Amount::from_sat(a));
	let source = bark::LightningPaySource::parse(body.source.as_deref())
		.badarg("payment source must be auto, tab, or coin")?;

	let invoice = if let Ok(invoice) = Invoice::from_str(&body.destination) {
		if body.comment.is_some() {
			badarg!("comment is not supported for Lightning invoices");
		}
		wallet.pay_lightning_invoice_sourced(invoice, amount, false, source).await?
	} else if let Ok(offer) = Offer::from_str(&body.destination) {
		if body.comment.is_some() {
			badarg!("comment is not supported for BOLT-12 offers");
		}
		wallet.pay_lightning_offer(offer, amount, false, source).await?
	} else if let Ok(lnaddr) = LightningAddress::from_str(&body.destination) {
		let amount = amount.badarg("amount is required for Lightning addresses")?;
		wallet.pay_lightning_address(&lnaddr, amount, body.comment, false, source).await?
	} else if let Ok(lnurl) = LnUrl::from_str(&body.destination) {
		let amount = amount.badarg("amount is required for LNURL")?;
		wallet.pay_lnurl(&lnurl, amount, body.comment, false, source).await?
	} else {
		badarg!("argument is not a valid BOLT-11 or BOLT-12 invoice, BOLT-12 offer, Lightning address or LNURL");
	};

	Ok(axum::Json(bark_json::web::LightningPayResponse {
		message: "Payment initiated successfully".to_string(),
		payment_hash: Some(invoice.payment_hash()),
	}))
}

#[utoipa::path(post, path = "/offers", request_body = bark_json::web::LightningOfferRequest,
 responses((status = 200, description = "Reusable wallet-owned offer")), tag = "lightning")]
#[debug_handler]
pub async fn create_offer(State(state): State<Arc<ServerState>>, Json(body): Json<bark_json::web::LightningOfferRequest>) -> HandlerResult<Json<serde_json::Value>> {
	let wallet = state.require_wallet()?;
	let offer = wallet.create_lightning_offer(body.description, body.amount_sat).await.context("Failed to create reusable offer")?;
	Ok(Json(serde_json::json!({"offer": offer.offer, "active": offer.active, "description": offer.description, "amount_sat": offer.amount_sat})))
}

#[utoipa::path(get, path = "/offers", responses((status = 200, description = "Current reusable offer or null")), tag = "lightning")]
#[debug_handler]
pub async fn get_offer(State(state): State<Arc<ServerState>>) -> HandlerResult<Json<serde_json::Value>> {
	let wallet = state.require_wallet()?;
	let offer = wallet.lightning_offer().await?;
	Ok(Json(offer.map(|offer| serde_json::json!({"offer": offer.offer, "active": offer.active, "description": offer.description, "amount_sat": offer.amount_sat})).unwrap_or(serde_json::Value::Null)))
}

#[utoipa::path(delete, path = "/offers", responses((status = 200, description = "Offer disabled; issued invoices remain tracked")), tag = "lightning")]
#[debug_handler]
pub async fn disable_offer(State(state): State<Arc<ServerState>>) -> HandlerResult<Json<serde_json::Value>> {
	state.require_wallet()?.disable_lightning_offer().await?;
	Ok(Json(serde_json::json!({"active": false})))
}

#[debug_handler]
pub async fn lightning_address(State(state): State<Arc<ServerState>>) -> HandlerResult<Json<serde_json::Value>> {
	let wallet = state.require_wallet()?;
	let address = wallet.lightning_address().await.context("Failed to read the Lightning address")?;
	Ok(Json(serde_json::json!({ "address": address })))
}

pub async fn claim_lightning_address(
	State(state): State<Arc<ServerState>>,
	Json(body): Json<serde_json::Value>,
) -> HandlerResult<Json<serde_json::Value>> {
	let wallet = state.require_wallet()?;
	let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
	let address = wallet.claim_lightning_address(name).await.context("Failed to claim the Lightning address")?;
	Ok(Json(serde_json::json!({ "address": address })))
}

pub async fn lightning_tab_activity(State(state): State<Arc<ServerState>>) -> HandlerResult<Json<serde_json::Value>> {
	let wallet = state.require_wallet()?;
	let entries = wallet.lightning_tab_activity().await
		.context("Failed to read Lightning tab activity")?;
	let rows = entries.into_iter().map(|entry| serde_json::json!({
		"direction": entry.direction,
		"amount_sat": entry.amount_sat,
		"fee_sat": entry.fee_sat,
		"at": entry.at,
		"payment_hash": entry.payment_hash,
	})).collect::<Vec<_>>();
	Ok(Json(serde_json::Value::Array(rows)))
}

pub async fn lightning_tab(State(state): State<Arc<ServerState>>) -> HandlerResult<Json<serde_json::Value>> {
	let wallet = state.require_wallet()?;
	let (balance, opted_out) = wallet.lightning_tab_view().await
		.context("Failed to read the Lightning tab")?;
	Ok(Json(serde_json::json!({
		"balance_sat": balance.to_sat(),
		"chunk_sat": bark::Wallet::lightning_tab_chunk().to_sat(),
		"opted_out": opted_out,
	})))
}

#[derive(serde::Deserialize)]
pub struct LightningTabOpt {
	pub opted_out: bool,
}

#[debug_handler]
pub async fn set_lightning_tab_opt(
	State(state): State<Arc<ServerState>>,
	Json(body): Json<LightningTabOpt>,
) -> HandlerResult<Json<serde_json::Value>> {
	let wallet = state.require_wallet()?;
	let balance = wallet.set_lightning_tab_opt_out(body.opted_out).await
		.context("Failed to set the Lightning tab opt-out")?;
	Ok(Json(serde_json::json!({
		"balance_sat": balance.to_sat(),
		"chunk_sat": bark::Wallet::lightning_tab_chunk().to_sat(),
		"opted_out": body.opted_out,
	})))
}

#[debug_handler]
pub async fn return_lightning_tab(State(state): State<Arc<ServerState>>) -> HandlerResult<Json<serde_json::Value>> {
	let wallet = state.require_wallet()?;
	let amount = wallet.withdraw_lightning_tab().await.context("Failed to move the tab back into a coin")?;
	let balance = wallet.lightning_tab_balance().await.context("Failed to read the Lightning tab")?;
	Ok(Json(serde_json::json!({
		"amount_sat": amount.to_sat(),
		"balance_sat": balance.to_sat(),
		"chunk_sat": bark::Wallet::lightning_tab_chunk().to_sat(),
	})))
}

#[debug_handler]
pub async fn fund_lightning_tab(State(state): State<Arc<ServerState>>) -> HandlerResult<Json<serde_json::Value>> {
	let wallet = state.require_wallet()?;
	let balance = wallet.fund_lightning_tab().await.context("Failed to fund the Lightning tab")?;
	Ok(Json(serde_json::json!({
		"balance_sat": balance.to_sat(),
		"chunk_sat": bark::Wallet::lightning_tab_chunk().to_sat(),
	})))
}

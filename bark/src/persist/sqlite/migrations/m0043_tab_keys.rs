//! Remember which VTXO keys have a Lightning tab balance.
//!
//! The wallet used to sign every historical key on each tab read. After one
//! scan, only the mailbox key and the keys with a balance are asked again.

use anyhow::Context;
use rusqlite::Transaction;

use super::Migration;

pub struct Migration0043 {}

impl Migration for Migration0043 {
	fn name(&self) -> &str {
		"Remember Lightning tab keys that have a balance"
	}

	fn to_version(&self) -> i64 { 43 }

	fn do_migration(&self, conn: &Transaction) -> anyhow::Result<()> {
		conn.execute(
			"CREATE TABLE bark_tab_key (idx INTEGER PRIMARY KEY)",
			(),
		).context("failed to create bark_tab_key")?;
		conn.execute(
			"CREATE TABLE bark_tab_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				scanned INTEGER NOT NULL
			)",
			(),
		).context("failed to create bark_tab_state")?;
		conn.execute(
			"INSERT INTO bark_tab_state (id, scanned) VALUES (1, 0)",
			(),
		).context("failed to seed bark_tab_state")?;
		Ok(())
	}
}

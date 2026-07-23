//! FreightWire ShippingHub  <->  Aptean Full Circle connector
//!
//! Runs in the background on the L'AGENCE Windows box (the one with the ProvideX/Full Circle
//! ODBC driver installed and the Z: drive mapped). It talks to ShippingHub with OUTBOUND HTTPS
//! ONLY, so nothing needs to be opened on their firewall.
//!
//! Each poll it does two things:
//!   1. Asks ShippingHub whether any scanned pick-tickets are waiting to be pulled.
//!      For each, it reads that order from Full Circle over ODBC and pushes it up.
//!   2. Asks ShippingHub for any new ship-confirmation rows and writes them to the
//!      watched file on the Z: drive (e.g. Z:\ups\fedxucc.csv) for Full Circle to ingest.
//!
//! It also reports a heartbeat so you can see it's alive from ShippingHub — no remote login
//! into this machine required.

use std::{fs, path::Path, thread, time::Duration};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use odbc_api::{Connection, ConnectionOptions, Cursor, Environment, IntoParameter};

#[derive(Deserialize, Clone)]
struct Config {
    /// e.g. https://freightwireship.com
    hub_url: String,
    /// shared secret issued in ShippingHub (admin) for this connector
    hub_key: String,
    /// full ODBC connection string, e.g. "DSN=FullCircle;UID=readonly;PWD=•••"
    odbc_conn: String,
    #[serde(default = "d_table")]
    table: String,
    #[serde(default = "d_drop")]
    drop_path: String,
    #[serde(default = "d_poll")]
    poll_ms: u64,
}
fn d_table() -> String { "asups_UPS_Interface".into() }
fn d_drop() -> String { "Z:\\ups\\fedxucc.csv".into() }
fn d_poll() -> u64 { 4000 }

/// (Full Circle column  ->  ShippingHub order field). This is the parity mapping from the
/// FedEx Ship Manager profile; add/adjust columns here if Full Circle sends more.
const COLS: &[(&str, &str)] = &[
    ("ASU_PICK", "pickTicket"),
    ("ASU_UCC", "invoiceNo"),
    ("ASU_CO", "reference"),
    ("ASU_SHPNAME", "customer"),
    ("ASU_SHPAD1", "address1"),
    ("ASU_SHPAD2", "address2"),
    ("ASU_SHPCTY", "city"),
    ("ASU_SHPSTATE", "state"),
    ("ASU_SHPZIP", "zip"),
    ("ASU_SHPCNTY", "country"),
    ("ASU_PHONE", "phone"),
    ("ASU_SHPVIA", "shippingService"),
    ("ASU_WGHT", "weight"),
];

type R<T> = Result<T, Box<dyn std::error::Error>>;

/// POST an action to ShippingHub's connector endpoint. Outbound HTTPS only.
fn hub(cfg: &Config, action: &str, mut body: Value) -> R<Value> {
    body["action"] = json!(action);
    let url = format!("{}/.netlify/functions/connector", cfg.hub_url.trim_end_matches('/'));
    let resp = reqwest::blocking::Client::new()
        .post(url)
        .header("x-fw-key", &cfg.hub_key)
        .json(&body)
        .send()?
        .json::<Value>()?;
    Ok(resp)
}

/// Read one order from Full Circle by pick-ticket or UCC/invoice.
fn fetch_order(conn: &Connection, table: &str, key: &str) -> R<Option<Value>> {
    let select = COLS.iter().map(|(c, _)| *c).collect::<Vec<_>>().join(", ");
    let sql = format!("SELECT {select} FROM {table} WHERE ASU_UCC = ? OR ASU_PICK = ?");
    let params = (key.into_parameter(), key.into_parameter());

    // NOTE: odbc-api's `execute` is 3-arg (query, params, timeout) on v8+. On older versions it's
    // 2-arg — if `cargo build` complains, drop the trailing `None`.
    match conn.execute(&sql, params, None)? {
        Some(mut cursor) => {
            if let Some(mut row) = cursor.next_row()? {
                let mut map = Map::new();
                let mut buf: Vec<u8> = Vec::new();
                for (i, (_fc, field)) in COLS.iter().enumerate() {
                    buf.clear();
                    let not_null = row.get_text((i as u16) + 1, &mut buf)?;
                    let s = if not_null {
                        String::from_utf8_lossy(&buf).trim().to_string()
                    } else {
                        String::new()
                    };
                    map.insert((*field).to_string(), Value::String(s));
                }
                // conveniences ShippingHub expects
                let cust = map.get("customer").cloned().unwrap_or(Value::String(String::new()));
                map.insert("company".into(), cust);
                let pick = map.get("pickTicket").cloned().unwrap_or(Value::String(String::new()));
                map.insert("name".into(), pick);
                if map.get("country").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
                    map.insert("country".into(), json!("US"));
                }
                Ok(Some(Value::Object(map)))
            } else {
                Ok(None)
            }
        }
        None => Ok(None),
    }
}

fn tick(cfg: &Config, conn: &Connection) -> R<()> {
    // 1) scanned pick-tickets waiting to be pulled from Full Circle
    let q = hub(cfg, "pullQueue", json!({}))?;
    if let Some(keys) = q.get("keys").and_then(|v| v.as_array()) {
        for k in keys {
            if let Some(key) = k.as_str() {
                let order = fetch_order(conn, &cfg.table, key)?;
                let found = order.is_some();
                hub(cfg, "order", json!({ "key": key, "order": order }))?;
                println!("[pull] {key} -> {}", if found { "ok" } else { "not found" });
            }
        }
    }

    // 2) new ship-confirmation rows -> write to the Z: drive for Full Circle to ingest
    let conf = hub(cfg, "confirmations", json!({}))?;
    if let Some(csv) = conf.get("csv").and_then(|v| v.as_str()) {
        if !csv.trim().is_empty() {
            if let Some(parent) = Path::new(&cfg.drop_path).parent() {
                let _ = fs::create_dir_all(parent);
            }
            fs::write(&cfg.drop_path, csv)?; // overwrite the watched file
            let ids = conf.get("ids").cloned().unwrap_or(json!([]));
            hub(cfg, "confirmed", json!({ "ids": ids }))?; // ack so we don't re-drop them
            println!("[drop] wrote {}", cfg.drop_path);
        }
    }

    Ok(())
}

fn main() {
    let cfg: Config = {
        let text = fs::read_to_string("config.toml")
            .expect("config.toml not found next to the exe — copy config.toml.example to config.toml");
        toml::from_str(&text).expect("config.toml is not valid TOML")
    };
    println!(
        "FW connector starting — hub {} · table {} · drop {}",
        cfg.hub_url, cfg.table, cfg.drop_path
    );

    let env = Environment::new().expect("could not init the ODBC environment");
    let conn = env
        .connect_with_connection_string(&cfg.odbc_conn, ConnectionOptions::default())
        .expect("ODBC connect failed — check the DSN / driver / credentials");

    // let ShippingHub know we're online (so you can see health without logging into this box)
    let _ = hub(&cfg, "hello", json!({ "table": cfg.table, "drop": cfg.drop_path }));

    loop {
        if let Err(e) = tick(&cfg, &conn) {
            eprintln!("[err] {e}");
        }
        // heartbeat — best-effort, ignore errors
        let _ = hub(&cfg, "heartbeat", json!({}));
        thread::sleep(Duration::from_millis(cfg.poll_ms));
    }
}

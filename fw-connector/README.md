# FreightWire ShippingHub — Full Circle connector

A tiny background program that runs on the **L'AGENCE Windows box** (the same one that has the
Full Circle / ProvideX **ODBC driver** installed and the **Z: drive** mapped). It bridges Full
Circle's database to ShippingHub.

- **Outbound HTTPS only** — nothing needs to be opened on the firewall, and there is **no remote
  login into this machine**. The connector reaches *out* to ShippingHub; ShippingHub never reaches *in*.
- **Orders in:** when a pick-ticket is scanned in ShippingHub, the connector reads that order from
  Full Circle over ODBC and pushes it up.
- **Confirmation out:** it writes the ship-confirmation file to `Z:\ups\fedxucc.csv` for Full Circle
  to ingest (same file/format Ship Manager uses today).
- **Health:** it reports a heartbeat so you can see it's alive from ShippingHub without logging in here.

## What you need on the machine
1. **Rust** (to build) — https://rustup.rs  (or hand a built `fw-connector.exe` to the site).
2. The **Full Circle ODBC driver** installed, with a **DSN** configured (Aptean provides the driver;
   the DSN needs host, port, database, username, password). Test it with Windows ODBC Data Sources.
3. The **Z: drive** mapped and writable.

## Setup
```powershell
# 1. build (produces target\release\fw-connector.exe)
cargo build --release

# 2. put config next to the exe and fill it in
copy config.toml.example config.toml
notepad config.toml      # set hub_url, hub_key, odbc_conn, drop_path

# 3. run it
target\release\fw-connector.exe
```
You should see `FW connector starting …` and, in ShippingHub, the connector show as online.

## Run it in the background (as a Windows service)
Use **NSSM** (https://nssm.cc) so it starts on boot and restarts if it crashes:
```powershell
nssm install FWConnector "C:\path\to\fw-connector.exe"
nssm set FWConnector AppDirectory "C:\path\to"    # so it finds config.toml
nssm start FWConnector
```

## The ShippingHub side (server endpoint — TO BUILD)
The connector calls one endpoint, `POST /.netlify/functions/connector`, authenticated with the
`x-fw-key` header, using these `action`s:

| action | connector → hub | hub → connector |
|--------|-----------------|-----------------|
| `hello` / `heartbeat` | connector is online | `{ ok: true }` |
| `pullQueue` | "any scanned pick-tickets to fetch?" | `{ keys: ["PT-10432", …] }` |
| `order` | here's the order I read from Full Circle | `{ ok: true }` |
| `confirmations` | "any ship confirmations to drop?" | `{ csv: "<fedxucc bytes>", ids: [...] }` |
| `confirmed` | I wrote those to the Z: drive | `{ ok: true }` |

This `connector` function isn't built yet — it's the last piece and pairs 1:1 with the actions above.

## Notes
- `odbc-api`'s `execute` is 3-arg on v8+ (`query, params, timeout`). If `cargo build` complains,
  drop the trailing `None` in `fetch_order` (older 2-arg form).
- Only `SELECT` is used — the connector never writes to Full Circle's DB. Give it a **read-only**
  DB user.

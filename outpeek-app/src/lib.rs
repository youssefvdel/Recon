//! Outpeek app library: the one-process native app.
//!
//! Two windows, one Slint event loop:
//!
//! * the tracker window — decorated, resizable, taskbar-visible;
//! * the HUD overlay — transparent, topmost, click-through, toolwindow,
//!   created hidden at startup and shown only while VALORANT is focused and
//!   the renderer setting says native.
//!
//! Facts live in memory. One poller reads the Riot Client's loopback API and
//! publishes a [`model::TrackerSnapshot`]; the same event drives both windows
//! through Slint properties, so there is no IPC and no second process.
//!
//! Business logic that already exists is compiled **by path** from
//! `src-tauri/src` (`paths`, `fs_migrate`, `live_facts`, `riot_http`,
//! `overlay_renderer`), exactly like `src-tauri/pure`.
//!
//! Safety: read-only. Loopback GETs with the lockfile credentials; the only
//! remote call is one `/mmr` read on demand (rank is not exposed locally), and
//! it is never on the 2.5 s live tick.

#[path = "../../src-tauri/src/fs_migrate.rs"]
pub mod fs_migrate;
#[path = "../../src-tauri/src/live_facts.rs"]
#[allow(dead_code)]
pub mod live_facts;
#[path = "../../src-tauri/src/overlay_renderer.rs"]
pub mod overlay_renderer;
#[path = "../../src-tauri/src/paths.rs"]
pub mod paths;
#[path = "../../src-tauri/src/riot_http.rs"]
pub mod riot_http;

pub mod hud;
pub mod identity;
pub mod model;
pub mod rank;
pub mod worker;

/// Product name shown in the window title and sidebar.
pub const PRODUCT_NAME: &str = "Outpeek";
/// Version the shell reports (crate version; `bun run bump` keeps it in sync).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

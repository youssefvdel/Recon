//! Windows display stack: shortcut model, display modes, monitor identity, and
//! the registry/SetupAPI helpers that read and write them.
//!
//! Split out of the former `display.rs` by moving code only; every public name
//! is re-exported here so external paths (`display::get_all_monitors`, …) keep
//! resolving unchanged. Registry reads and writes live in separate functions in
//! `registry.rs` / `monitor_enable.rs`; `monitor_switch.rs` owns the writes.
#![allow(dead_code)]
mod hotkey_listener;
mod mode;
mod mode_switch;
mod monitor_enable;
mod monitor_switch;
mod monitors;
mod registry;
mod report;
mod resolution_cache;
mod resolve;
mod shortcut;
pub use hotkey_listener::{start_hotkey_listener, HotkeyController};
pub use mode::{get_all_supported_modes, get_current_display_mode, get_native_resolution, get_primary_device_name, get_supported_refresh_rates_for, DisplayMode};
pub use mode_switch::{apply_display_mode, apply_gpu_scaling_stretched, set_display_scaling_mode};
pub use monitor_enable::set_monitor_device_enabled;
pub use registry::{is_process_elevated};
pub use report::{get_all_monitors, MonitorDevice};
pub use resolve::resolve_display_to_instance_id;
pub use shortcut::{load_saved_hotkey, load_saved_stretched_res, save_saved_hotkey, save_saved_stretched_res, ShortcutBinding};
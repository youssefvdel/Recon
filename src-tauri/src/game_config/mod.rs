//! The VALORANT config editor.
//!
//! Split by concern; `write` owns the read-back rule — every write is verified by
//! re-reading, never by assuming the setter worked.
//!
//! Public names are re-exported here so `crate::game_config::…` call sites and
//! the command layer did not move with the code.

mod apply;
mod discover;
mod ini;
mod model;
mod sections;
mod write;

#[cfg(test)]
mod tests;

pub use apply::{apply_to_all_configs_verbose, verify_all_configs};
pub use discover::find_valorant_configs;
pub use model::{ApplyResult, ConfigFileInfo, CustomOptions, VerifyResult};
pub use sections::{
    get_all_sections, is_letterbox_disabled_in_configs, read_config_raw, set_config_value,
    set_letterbox_all, SectionInfo, SettingRow,
};
pub use write::{update_config, update_config_custom};

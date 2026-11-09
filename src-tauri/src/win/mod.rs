//! Window construction and window-scoped behaviour.
//!
//! Named `win`, not `windows`: a root `mod windows` shadows the windows-rs
//! crate for every `windows::Win32::…` path in this crate.

pub(crate) mod overlay;
pub(crate) mod tray;
